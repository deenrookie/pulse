// Self-update endpoints: check the latest GitHub release, download and
// swap the binary in place, and restart onto the new version.
package api

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"pulse/internal/update"
)

func (s *Server) handleUpdateCheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	res, err := update.Check(ctx, s.Version)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "update check failed: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleUpdateApply(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// large download: allow a generous window, the UI shows a spinner
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	res, err := update.Apply(ctx, s.Version)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "update failed: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleUpdateRestart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := update.Restart(1500 * time.Millisecond); err != nil {
		writeErr(w, http.StatusBadGateway, "restart failed: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"restarting": true})
	// let the response flush, then exit so the detached child can bind
	go func() {
		time.Sleep(300 * time.Millisecond)
		log.Printf("update: restarting onto the new binary")
		os.Exit(0)
	}()
}
