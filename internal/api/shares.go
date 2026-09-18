package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"pulse/internal/store"
)

type trafficShare struct {
	ID        string    `json:"id"`
	URL       string    `json:"url"`
	FlowID    string    `json:"flowId"`
	ExpiresAt time.Time `json:"expiresAt"`
	CreatedAt time.Time `json:"createdAt"`
}

type sharePayload struct {
	Share trafficShare `json:"share"`
	Flow  *store.Flow  `json:"flow"`
}

type shareStore struct {
	mu    sync.Mutex
	dir   string
	items map[string]trafficShare
}

func validShareToken(id string) bool {
	if len(id) != 48 {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil && id == strings.ToLower(id)
}

// Keep only metadata in memory. Complete payloads live in individual files;
// share count and payload size have no application quota.
func openShares(dataDir string) (*shareStore, error) {
	s := &shareStore{dir: filepath.Join(dataDir, "shares"), items: map[string]trafficShare{}}
	if err := os.MkdirAll(s.dir, 0700); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if !entry.IsDir() || !validShareToken(entry.Name()) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(s.dir, entry.Name(), "metadata.json"))
		if err != nil {
			return nil, fmt.Errorf("share %s: %w", entry.Name(), err)
		}
		var meta trafficShare
		if err := json.Unmarshal(data, &meta); err != nil {
			return nil, fmt.Errorf("share metadata: %w", err)
		}
		if meta.ID != entry.Name() {
			return nil, fmt.Errorf("share metadata ID does not match directory")
		}
		s.items[meta.ID] = meta
	}
	s.expireLocked()
	return s, nil
}

// Expiry is enforced on every public read. Reclaim disk on reads, listing,
// creation and startup without retaining a timer per share.
func (s *shareStore) expireLocked() {
	for id, item := range s.items {
		if !time.Now().Before(item.ExpiresAt) {
			if os.RemoveAll(filepath.Join(s.dir, id)) == nil {
				delete(s.items, id)
			}
		}
	}
}

func validShareIP(value string) bool {
	ip := net.ParseIP(value)
	return ip != nil && !ip.IsUnspecified() && !ip.IsMulticast() && !ip.Equal(net.IPv4bcast)
}

func (s *Server) shareBase() (string, error) {
	s.set.mu.Lock()
	ip := s.set.ShareIP
	s.set.mu.Unlock()
	if !validShareIP(ip) {
		return "", fmt.Errorf("set a reachable IP in Settings → Temporary sharing first")
	}
	host, port, err := net.SplitHostPort(s.UIAddr)
	if err != nil || port == "" {
		return "", fmt.Errorf("UI listener has no usable port")
	}
	if !isWildcard(host) && host != ip {
		return "", fmt.Errorf("UI listener is bound to %s; restart Pulse with --ui 0.0.0.0:%s (IPv6: [::]:%s) to use another IP", host, port, port)
	}
	return "http://" + net.JoinHostPort(ip, port), nil
}

type shareInput struct {
	FlowID     string `json:"flowId"`
	RepeaterID string `json:"repeaterId"`
	HistoryAt  string `json:"historyAt"`
	TTLMinutes int    `json:"ttlMinutes"`
}

func (s *Server) shareSnapshot(in shareInput) (*store.Flow, error) {
	if (in.FlowID == "") == (in.RepeaterID == "") {
		return nil, fmt.Errorf("provide either flowId or repeaterId")
	}
	if in.RepeaterID != "" {
		tab, ok := s.rep.Get(in.RepeaterID)
		if !ok {
			return nil, fmt.Errorf("Repeater tab no longer exists")
		}
		if in.HistoryAt == "" {
			return &store.Flow{ID: tab.ID, Req: tab.Request, State: store.StatePending}, nil
		}
		for i := len(tab.History) - 1; i >= 0; i-- {
			h := tab.History[i]
			if in.HistoryAt != "" && h.At.Format(time.RFC3339Nano) != in.HistoryAt {
				continue
			}
			if h.Request == nil {
				return nil, fmt.Errorf("this older send has no saved request; send it again to share a matching request and response")
			}
			state := store.StateComplete
			if h.Err != "" {
				state = store.StateError
			}
			return &store.Flow{ID: h.Request.ID, Req: *h.Request, Resp: h.Resp, Error: h.Err, State: state}, nil
		}
		return nil, fmt.Errorf("send this Repeater request first, or select an available history entry")
	}
	fl, ok := s.st.Get(in.FlowID)
	if !ok {
		return nil, fmt.Errorf("flow no longer exists")
	}
	return fl, nil // No redaction, filtering, body omission or size truncation.
}

func (s *Server) handleShares(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodGet && r.URL.Path == "/api/shares" {
		s.shares.mu.Lock()
		defer s.shares.mu.Unlock()
		s.shares.expireLocked()
		out := make([]trafficShare, 0, len(s.shares.items))
		for _, meta := range s.shares.items {
			if time.Now().Before(meta.ExpiresAt) {
				out = append(out, meta)
			}
		}
		sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
		writeJSON(w, 200, map[string]any{"shares": out})
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var in shareInput
	if !readJSON(w, r, &in, 4096) {
		return
	}
	if in.TTLMinutes == 0 {
		in.TTLMinutes = 7 * 24 * 60
	}
	if in.TTLMinutes < 1 || in.TTLMinutes > 365*24*60 {
		writeErr(w, 400, "ttlMinutes must be 1..525600 (up to one year)")
		return
	}
	fl, err := s.shareSnapshot(in)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if r.URL.Path == "/api/shares/preview" {
		writeJSON(w, 200, fl)
		return
	}
	base, err := s.shareBase()
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	key := make([]byte, 24)
	if _, err := rand.Read(key); err != nil {
		writeErr(w, 500, "could not create share token")
		return
	}
	id := hex.EncodeToString(key)
	meta := trafficShare{ID: id, URL: base + "/share/" + id, FlowID: fl.ID, CreatedAt: time.Now(), ExpiresAt: time.Now().Add(time.Duration(in.TTLMinutes) * time.Minute)}
	temp, err := os.MkdirTemp(s.shares.dir, ".pending-")
	if err != nil {
		writeErr(w, 500, "could not store share: "+err.Error())
		return
	}
	defer os.RemoveAll(temp)
	// Stage both files, then publish with one rename. Never return a URL
	// before its complete payload is safely written.
	err = writeShareJSON(filepath.Join(temp, "snapshot.json"), sharePayload{Share: meta, Flow: fl})
	if err == nil {
		err = writeShareJSON(filepath.Join(temp, "metadata.json"), meta)
	}
	if err != nil {
		writeErr(w, 500, "could not store share: "+err.Error())
		return
	}
	s.shares.mu.Lock()
	defer s.shares.mu.Unlock()
	s.shares.expireLocked()
	if err := os.Rename(temp, filepath.Join(s.shares.dir, id)); err != nil {
		writeErr(w, 500, "could not publish share: "+err.Error())
		return
	}
	s.shares.items[id] = meta
	writeJSON(w, http.StatusCreated, meta)
}

func writeShareJSON(path string, value any) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	err = json.NewEncoder(f).Encode(value)
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	return err
}

func (s *Server) handleShareDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		w.WriteHeader(405)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/shares/")
	if !validShareToken(id) {
		writeErr(w, 400, "invalid share ID")
		return
	}
	s.shares.mu.Lock()
	defer s.shares.mu.Unlock()
	if err := os.RemoveAll(filepath.Join(s.shares.dir, id)); err != nil {
		writeErr(w, 500, "could not revoke share: "+err.Error())
		return
	}
	delete(s.shares.items, id)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// Only this token's payload and read-only shell bypass the control gate.
func (s *Server) handlePublicShare(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'")
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(405)
		return
	}
	id, action, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/share/"), "/")
	if !validShareToken(id) || (action != "" && action != "data" && action != "decode") {
		http.NotFound(w, r)
		return
	}
	s.shares.mu.Lock()
	meta, ok := s.shares.items[id]
	if !ok || !time.Now().Before(meta.ExpiresAt) {
		s.shares.expireLocked()
		s.shares.mu.Unlock()
		http.Error(w, "This share has expired, was revoked, or is unavailable.", 404)
		return
	}
	if action == "" {
		s.shares.mu.Unlock()
		s.handleStatic(w, r)
		return
	}
	f, err := os.Open(filepath.Join(s.shares.dir, id, "snapshot.json"))
	s.shares.mu.Unlock()
	if err != nil {
		writeErr(w, 500, "share data unavailable")
		return
	}
	defer f.Close()
	if action == "decode" {
		defer f.Close()
		var payload sharePayload
		if err := json.NewDecoder(f).Decode(&payload); err != nil || payload.Flow == nil {
			writeErr(w, 500, "share data unavailable")
			return
		}
		var body []byte
		var headers []store.Header
		switch r.URL.Query().Get("side") {
		case "request":
			body, headers = payload.Flow.Req.Body, payload.Flow.Req.Headers
		case "response":
			if payload.Flow.Resp == nil {
				writeErr(w, 404, "share has no response")
				return
			}
			body, headers = payload.Flow.Resp.Body, payload.Flow.Resp.Headers
		default:
			writeErr(w, 400, "side must be request or response")
			return
		}
		encoding := ""
		for _, header := range headers {
			if strings.EqualFold(header.Name, "Content-Encoding") {
				encoding = header.Value
				break
			}
		}
		decoded, err := decodeBodyBytes(body, encoding)
		if err != nil {
			writeErr(w, 422, "decode failed: "+err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"body": decoded, "bytes": len(decoded), "encoding": encoding})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if r.URL.Query().Has("download") {
		w.Header().Set("Content-Disposition", "attachment; filename=pulse-share.json")
	}
	http.ServeContent(w, r, "snapshot.json", time.Time{}, f)
}
