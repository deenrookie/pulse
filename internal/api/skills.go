package api

import (
	"net/http"
	"pulse/internal/plugins"
	"strings"
)

func (s *Server) handlePluginSkill(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	if strings.HasSuffix(r.URL.Path, "/download") {
		data, err := plugins.PluginSkillArchive()
		if err != nil {
			writeErr(w, 500, "could not package plugin skill")
			return
		}
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", "attachment; filename=pulse-plugin-dev.zip")
		w.Write(data)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"name": "pulse-plugin-dev", "content": plugins.PluginSkill()})
}
