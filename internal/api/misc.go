package api

import (
	"net/http"
)

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": s.Version})
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"version":       s.Version,
		"proxyAddr":     s.ProxyAddr,
		"uiAddr":        s.UIAddr,
		"dataDir":       s.DataDir,
		"caFingerprint": s.auth.Fingerprint(),
		"flows":         map[string]int{"total": s.st.Count(), "pending": s.st.CountPending()},
		"intercept":     map[string]any{"enabled": s.eng.Inter.Enabled(), "pending": len(s.eng.Inter.Pending())},
		"pluginsDir":    s.plug.Dir(),
	})
}

func (s *Server) handleCert(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/x-pem-file")
	w.Header().Set("Content-Disposition", `attachment; filename="pulse-ca.pem"`)
	w.Write(s.auth.PEM())
}
