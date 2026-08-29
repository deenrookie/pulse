package api

import (
	"net/http"
	"strings"

	"pulse/internal/store"
)

// handleIntercept: GET state+queue summary, PUT toggle.
func (s *Server) handleIntercept(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, s.interceptSummary())
	case http.MethodPut:
		var body struct {
			Enabled *bool `json:"enabled"`
		}
		if !readJSON(w, r, &body, 1<<20) {
			return
		}
		if body.Enabled == nil {
			writeErr(w, http.StatusBadRequest, "missing \"enabled\" field")
			return
		}
		s.eng.Inter.SetEnabled(*body.Enabled)
		writeJSON(w, http.StatusOK, s.interceptSummary())
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) interceptSummary() map[string]any {
	pending := s.eng.Inter.Pending()
	metas := make([]map[string]any, 0, len(pending))
	for _, req := range pending {
		metas = append(metas, map[string]any{
			"id": req.ID, "method": req.Method, "url": req.URL,
		})
	}
	return map[string]any{
		"enabled":  s.eng.Inter.Enabled(),
		"capacity": 50,
		"pending":  metas,
	}
}

// handleInterceptID: GET /{id} full held request, POST /{id}/forward|drop.
func (s *Server) handleInterceptID(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/intercept/")
	id, action, found := strings.Cut(rest, "/")
	if id == "" {
		http.NotFound(w, r)
		return
	}
	switch {
	case r.Method == http.MethodGet && !found:
		for _, req := range s.eng.Inter.Pending() {
			if req.ID == id {
				writeJSON(w, http.StatusOK, req)
				return
			}
		}
		writeErr(w, http.StatusNotFound, "no such held request: "+id)
	case r.Method == http.MethodPost && action == "forward":
		var body struct {
			Request *store.Request `json:"request"`
		}
		if !readJSON(w, r, &body, 32<<20) {
			return
		}
		if body.Request != nil && !parseEditableRequest(w, body.Request) {
			return
		}
		if !s.eng.Inter.Forward(id, body.Request) {
			writeErr(w, http.StatusNotFound, "no such held request: "+id)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case r.Method == http.MethodPost && action == "drop":
		if !s.eng.Inter.Drop(id) {
			writeErr(w, http.StatusNotFound, "no such held request: "+id)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}
