package api

import (
	"fmt"
	"net/http"
	"time"
)

// handleEvents streams server-sent events: hello on connect, then flow /
// flow_update / intercept notifications plus heartbeat comments.
func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)

	send := func(name string, data []byte) bool {
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, data); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	send("hello", []byte(fmt.Sprintf(`{"interceptEnabled":%t,"pendingCount":%d}`,
		s.eng.Inter.Enabled(), len(s.eng.Inter.Pending()))))

	ch, cancel := s.bus.Subscribe()
	defer cancel()
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case ev, ok := <-ch:
			if !ok {
				return
			}
			if !send(ev.Name, ev.Data) {
				return
			}
		case <-heartbeat.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
