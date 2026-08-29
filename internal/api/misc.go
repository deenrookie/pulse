package api

import (
	"net/http"
	"runtime"
)

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": s.Version})
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	writeJSON(w, http.StatusOK, map[string]any{
		"memory": map[string]any{
			"sysMB":     ms.Sys / 1048576,     // total obtained from the OS
			"heapMB":    ms.HeapAlloc / 1048576,
			"goroutine": runtime.NumGoroutine(),
		},
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
