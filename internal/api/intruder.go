// Intruder: persisted attack definitions (raw template with §position§
// markers + payload list). Firing is done one request at a time by the
// console via /fire — the engine's RoundTrip does the actual work, so an
// attack is just a plan; results are collected client-side.
package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"pulse/internal/store"
)

// IntruderAttack is one saved attack plan.
type IntruderAttack struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Raw       string    `json:"raw"`      // request template, §payload§ marks positions
	Payloads   string   `json:"payloads"`           // single set: one per line
	PayloadSets []string `json:"payloadSets,omitempty"` // pitchfork: one set (one per line) per §position§
	Grep      string    `json:"grep"`     // match keywords, one per line — hits become result columns
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type intruderStore struct {
	mu      sync.Mutex
	attacks []*IntruderAttack
	nextID  int
	path    string // data-dir/attacks.json — plans survive restarts
}

func newIntruderStore(dataDir string) *intruderStore {
	s := &intruderStore{nextID: 1, path: filepath.Join(dataDir, "attacks.json")}
	s.load()
	return s
}

func (s *intruderStore) load() {
	data, err := os.ReadFile(s.path)
	if err != nil {
		return // fresh install — nothing saved yet
	}
	var attacks []*IntruderAttack
	if json.Unmarshal(data, &attacks) != nil {
		return
	}
	s.attacks = attacks
	for _, a := range attacks {
		if n, err := strconv.Atoi(strings.TrimPrefix(a.ID, "atk-")); err == nil && n >= s.nextID {
			s.nextID = n + 1
		}
	}
}

func (s *intruderStore) save() {
	data, err := json.MarshalIndent(s.attacks, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(s.path, data, 0o644)
}

func (s *intruderStore) list() []IntruderAttack {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]IntruderAttack, 0, len(s.attacks))
	for i := len(s.attacks) - 1; i >= 0; i-- { // newest first
		out = append(out, *s.attacks[i])
	}
	return out
}

func (s *intruderStore) get(id string) (*IntruderAttack, bool) {
	for _, a := range s.attacks {
		if a.ID == id {
			return a, true
		}
	}
	return nil, false
}

func (s *intruderStore) create(title, raw, payloads string, payloadSets []string, grep string) *IntruderAttack {
	s.mu.Lock()
	defer s.mu.Unlock()
	a := &IntruderAttack{
		ID:        "atk-" + strconv.Itoa(s.nextID),
		Title:       title,
		Raw:         raw,
		Payloads:    payloads,
		PayloadSets: payloadSets,
		Grep:        grep,
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
	s.nextID++
	s.attacks = append(s.attacks, a)
	s.save()
	return a
}

func (s *intruderStore) update(id, title, raw, payloads string, payloadSets []string, grep string) (*IntruderAttack, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, ok := s.get(id)
	if !ok {
		return nil, false
	}
	if title != "" {
		a.Title = title
	}
	a.Raw, a.Payloads, a.PayloadSets, a.Grep, a.UpdatedAt = raw, payloads, payloadSets, grep, time.Now()
	s.save()
	return a, true
}

func (s *intruderStore) delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, a := range s.attacks {
		if a.ID == id {
			s.attacks = append(s.attacks[:i], s.attacks[i+1:]...)
			s.save()
			return true
		}
	}
	return false
}

// handleIntruder: GET list / POST create / PUT+DELETE /api/intruder/{id} and
// POST /api/intruder/fire — one templated request sent upstream, nothing kept.
func (s *Server) handleIntruder(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/intruder/")
	id, action, _ := strings.Cut(rest, "/")
	_ = action

	// POST /api/intruder/fire — one templated request sent upstream ("fire"
	// can't collide with attack ids, which are atk-N)
	if id == "fire" {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			Request *store.Request `json:"request"`
		}
		if !readJSON(w, r, &body, 32<<20) || body.Request == nil {
			writeErr(w, http.StatusBadRequest, "missing \"request\"")
			return
		}
		if !parseEditableRequest(w, body.Request) {
			return
		}
		req := *body.Request
		req.Source = "intruder"
		fl := s.eng.RoundTrip(&req)
		writeJSON(w, http.StatusOK, map[string]any{"flow": fl})
		return
	}

	switch {
	case r.Method == http.MethodGet && id == "":
		writeJSON(w, http.StatusOK, map[string]any{"attacks": s.intr.list()})
	case r.Method == http.MethodPost && id == "":
		var body struct {
			Title    string `json:"title"`
			Raw      string `json:"raw"`
			Payloads    string   `json:"payloads"`
			PayloadSets []string `json:"payloadSets"`
			Grep        string   `json:"grep"`
		}
		if !readJSON(w, r, &body, 4<<20) || strings.TrimSpace(body.Raw) == "" {
			writeErr(w, http.StatusBadRequest, "missing \"raw\" request template")
			return
		}
		writeJSON(w, http.StatusCreated, s.intr.create(strings.TrimSpace(body.Title), body.Raw, body.Payloads, body.PayloadSets, body.Grep))
	case r.Method == http.MethodPut && id != "":
		var body struct {
			Title    string `json:"title"`
			Raw      string `json:"raw"`
			Payloads    string   `json:"payloads"`
			PayloadSets []string `json:"payloadSets"`
			Grep        string   `json:"grep"`
		}
		if !readJSON(w, r, &body, 4<<20) {
			return
		}
		a, ok := s.intr.update(id, body.Title, body.Raw, body.Payloads, body.PayloadSets, body.Grep)
		if !ok {
			writeErr(w, http.StatusNotFound, "no such attack: "+id)
			return
		}
		writeJSON(w, http.StatusOK, a)
	case r.Method == http.MethodDelete && id != "":
		if !s.intr.delete(id) {
			writeErr(w, http.StatusNotFound, "no such attack: "+id)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}
