package api

import (
	"net/http"
	"strings"
)

// handlePlugins: GET list.
func (s *Server) handlePlugins(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"plugins": s.plug.List(),
		"dir":     s.plug.Dir(),
	})
}

// handlePluginsReload: POST rescan the plugins directory.
func (s *Server) handlePluginsReload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := s.plug.Reload(); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"plugins": s.plug.List(), "dir": s.plug.Dir()})
}

// handlePluginFile: PUT enable/disable a plugin.
func (s *Server) handlePluginFile(w http.ResponseWriter, r *http.Request) {
	file := strings.TrimPrefix(r.URL.Path, "/api/plugins/")
	if file == "" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPut {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	if !readJSON(w, r, &body, 1<<20) || body.Enabled == nil {
		writeErr(w, http.StatusBadRequest, "missing \"enabled\"")
		return
	}
	if !s.plug.SetEnabled(file, *body.Enabled) {
		writeErr(w, http.StatusNotFound, "no such plugin: "+file)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
