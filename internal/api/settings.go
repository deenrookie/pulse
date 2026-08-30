// Persisted user settings (settings.json in the data dir) with a small
// REST surface: GET /api/settings, PUT /api/settings. Timeouts and other
// knobs live here so they survive restarts.
package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sync"
)

const defaultResponseTimeoutSec = 30

type Settings struct {
	mu sync.Mutex
	path string
	// ResponseTimeoutSec bounds reading upstream response heads (>=1).
	ResponseTimeoutSec int `json:"responseTimeoutSec"`
}

func LoadSettings(dataDir string) (*Settings, error) {
	s := &Settings{path: filepath.Join(dataDir, "settings.json"), ResponseTimeoutSec: defaultResponseTimeoutSec}
	data, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		if err := s.save(); err != nil {
			return nil, err
		}
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, s); err != nil {
		return nil, err
	}
	if s.ResponseTimeoutSec < 1 {
		s.ResponseTimeoutSec = defaultResponseTimeoutSec
	}
	return s, nil
}

func (s *Settings) save() error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// handleSettings: GET returns the settings, PUT updates them (applying
// the new timeout to the live engine immediately).
func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.set.handleGet(w, r)
	case http.MethodPut:
		s.set.handlePut(w, r)
		if s.set.ResponseTimeoutSec > 0 {
			s.eng.SetTimeout(s.set.ResponseTimeoutSec)
		}
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Settings) handleGet(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"responseTimeoutSec": s.ResponseTimeoutSec})
}

func (s *Settings) handlePut(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ResponseTimeoutSec *int `json:"responseTimeoutSec"`
	}
	if !readJSON(w, r, &body, 1<<16) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if body.ResponseTimeoutSec != nil {
		if *body.ResponseTimeoutSec < 1 || *body.ResponseTimeoutSec > 600 {
			writeErr(w, http.StatusBadRequest, "responseTimeoutSec must be 1..600")
			return
		}
		s.ResponseTimeoutSec = *body.ResponseTimeoutSec
	}
	if err := s.save(); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"responseTimeoutSec": s.ResponseTimeoutSec})
}
