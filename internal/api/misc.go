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
	proxy := s.eng.Addr() // live value — Relisten (Settings page) swaps it
	if proxy == "" {
		proxy = s.ProxyAddr
	}
	resp := map[string]any{
		"memory": map[string]any{
			// Sys is "ever obtained from the OS" and never shrinks; subtract
			// HeapReleased so the number reflects memory actually held —
			// clearing history (FreeOSMemory) visibly drops it
			"sysMB":     (ms.Sys - ms.HeapReleased) / 1048576,
			"heapMB":    ms.HeapAlloc / 1048576,
			"goroutine": runtime.NumGoroutine(),
		},
		"version":       s.Version,
		"proxyAddr":     proxy,
		"uiAddr":        s.UIAddr,
		"dataDir":       s.DataDir,
		"caFingerprint": s.auth.Fingerprint(),
		"flows":         map[string]int{"total": s.st.Count(), "pending": s.st.CountPending()},
		"intercept":     map[string]any{"enabled": s.eng.Inter.Enabled(), "pending": len(s.eng.Inter.Pending())},
		"pluginsDir":    s.plug.Dir(),
	}
	// the key is only shown to the local console user, never over the network
	if remoteIsLoopback(r.RemoteAddr) {
		resp["accessKey"] = s.AccessKey
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleCert(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/x-pem-file")
	w.Header().Set("Content-Disposition", `attachment; filename="pulse-ca.pem"`)
	w.Write(s.auth.PEM())
}
