package api

import (
	"net/http"
	"strings"

	"pulse/internal/rewrite"
)

// handleRewrite: GET list rules, POST create.
func (s *Server) handleRewrite(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{"rules": s.rw.List()})
	case http.MethodPost:
		var rule rewrite.Rule
		if !readJSON(w, r, &rule, 1<<20) {
			return
		}
		created, err := s.rw.Add(rule)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, created)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleRewriteID: PUT update, DELETE remove.
func (s *Server) handleRewriteID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/rewrite/")
	if id == "" || strings.Contains(id, "/") {
		http.NotFound(w, r)
		return
	}
	switch r.Method {
	case http.MethodPut:
		var rule rewrite.Rule
		if !readJSON(w, r, &rule, 1<<20) {
			return
		}
		updated, ok, err := s.rw.Update(id, rule)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		if !ok {
			writeErr(w, http.StatusNotFound, "no such rule: "+id)
			return
		}
		writeJSON(w, http.StatusOK, updated)
	case http.MethodDelete:
		if !s.rw.Delete(id) {
			writeErr(w, http.StatusNotFound, "no such rule: "+id)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}
