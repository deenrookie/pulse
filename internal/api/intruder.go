// Intruder: persisted attack definitions (raw template with §position§
// markers + payload list). Firing is done one request at a time by the
// console via /fire — the engine's RoundTrip does the actual work, so an
// attack is just a plan; results are collected client-side.
package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
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
	Mode        string           `json:"mode"`
	TargetURL   string           `json:"targetURL"`
	ID          string           `json:"id"`
	Raw         string           `json:"raw"`                   // request template, §payload§ marks positions
	Payloads    string           `json:"payloads"`              // single set: one per line
	PayloadSets []string         `json:"payloadSets,omitempty"` // pitchfork: one set (one per line) per §position§
	Grep        string           `json:"grep"`                  // match keywords, one per line — hits become result columns
	Results     []IntruderResult `json:"results,omitempty"`
	LastRunAt   *time.Time       `json:"lastRunAt,omitempty"`
	CreatedAt   time.Time        `json:"createdAt"`
	UpdatedAt   time.Time        `json:"updatedAt"`
}

type IntruderResult struct {
	Payload    string   `json:"payload"`
	Position   string   `json:"position,omitempty"`
	StatusCode int      `json:"statusCode"`
	Reason     string   `json:"reason"`
	Length     int      `json:"length"`
	Ms         int64    `json:"ms"`
	FlowID     string   `json:"flowId,omitempty"`
	GrepHits   []string `json:"grepHits"`
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

func (s *intruderStore) save() error {
	data, err := json.MarshalIndent(s.attacks, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
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

func (s *intruderStore) put(id string, input IntruderAttack) (*IntruderAttack, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if input.Mode == "" {
		input.Mode = "battering-ram"
		if len(input.PayloadSets) > 0 {
			input.Mode = "pitchfork"
		}
	}
	if input.Mode != "sniper" && input.Mode != "battering-ram" && input.Mode != "pitchfork" {
		return nil, fmt.Errorf("invalid attack mode")
	}
	if strings.TrimSpace(input.Raw) == "" {
		return nil, fmt.Errorf("request template is required")
	}
	if input.TargetURL != "" {
		u, err := url.Parse(input.TargetURL)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
			return nil, fmt.Errorf("targetURL must be an HTTP or HTTPS URL")
		}
	}
	input.UpdatedAt = time.Now()
	old := s.attacks
	next := append([]*IntruderAttack(nil), s.attacks...)
	if id == "" {
		input.ID = "atk-" + strconv.Itoa(s.nextID)
		input.CreatedAt = input.UpdatedAt
		next = append(next, &input)
	} else {
		found := false
		for i, a := range next {
			if a.ID == id {
				input.Results = a.Results
				input.LastRunAt = a.LastRunAt
				input.ID = id
				input.CreatedAt = a.CreatedAt
				next[i] = &input
				found = true
				break
			}
		}
		if !found {
			return nil, os.ErrNotExist
		}
	}
	s.attacks = next
	if err := s.save(); err != nil {
		s.attacks = old
		return nil, err
	}
	if id == "" {
		s.nextID++
	}
	return &input, nil
}

func (s *intruderStore) saveResults(id string, results []IntruderResult) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, attack := range s.attacks {
		if attack.ID != id {
			continue
		}
		oldResults, oldRun := attack.Results, attack.LastRunAt
		now := time.Now()
		attack.Results = append([]IntruderResult(nil), results...)
		attack.LastRunAt = &now
		if err := s.save(); err != nil {
			attack.Results, attack.LastRunAt = oldResults, oldRun
			return err
		}
		return nil
	}
	return os.ErrNotExist
}

func (s *intruderStore) delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, a := range s.attacks {
		if a.ID == id {
			old := s.attacks
			next := append([]*IntruderAttack(nil), old[:i]...)
			s.attacks = append(next, old[i+1:]...)
			if err := s.save(); err != nil {
				s.attacks = old
				return err
			}
			return nil
		}
	}
	return os.ErrNotExist
}

// handleIntruder: GET list / POST create / PUT+DELETE /api/intruder/{id} and
// POST /api/intruder/fire — one templated request sent upstream, nothing kept.
func (s *Server) handleIntruder(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, "/api/intruder"), "/")
	id, action, _ := strings.Cut(rest, "/")
	if action != "" && action != "results" {
		http.NotFound(w, r)
		return
	}

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
	if action == "results" {
		if r.Method != http.MethodPut {
			http.Error(w, "method not allowed", 405)
			return
		}
		var body struct {
			Results []IntruderResult `json:"results"`
		}
		if !readJSON(w, r, &body, 32<<20) {
			return
		}
		if body.Results == nil {
			body.Results = []IntruderResult{}
		}
		if err := s.intr.saveResults(id, body.Results); err != nil {
			code := 500
			if os.IsNotExist(err) {
				code = 404
			}
			writeErr(w, code, err.Error())
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
		return
	}

	switch {
	case r.Method == http.MethodGet && id == "":
		writeJSON(w, http.StatusOK, map[string]any{"attacks": s.intr.list()})
	case (r.Method == http.MethodPost && id == "") || (r.Method == http.MethodPut && id != ""):
		var input IntruderAttack
		if !readJSON(w, r, &input, 4<<20) {
			return
		}
		a, err := s.intr.put(id, input)
		if err != nil {
			code := http.StatusBadRequest
			if os.IsNotExist(err) {
				code = http.StatusNotFound
			} else if _, ok := err.(*os.PathError); ok {
				code = http.StatusInternalServerError
			}
			writeErr(w, code, err.Error())
			return
		}
		code := http.StatusOK
		if id == "" {
			code = http.StatusCreated
		}
		writeJSON(w, code, a)
	case r.Method == http.MethodDelete && id != "":
		if err := s.intr.delete(id); err != nil {
			code := 500
			if os.IsNotExist(err) {
				code = 404
			}
			writeErr(w, code, err.Error())
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	default:
		http.Error(w, "method not allowed", 405)
	}
}
