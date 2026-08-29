package api

import (
	"net/http"
	"strconv"
	"strings"
)

// handleFlows: GET list (q/limit/offset), DELETE clear all.
func (s *Server) handleFlows(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		q := r.URL.Query().Get("q")
		limit := clampInt(queryInt(r, "limit", 200), 1, 1000)
		offset := clampInt(queryInt(r, "offset", 0), 0, 1<<40)
		items, total := s.st.List(q)
		start, end := offset, offset+limit
		if start > len(items) {
			start = len(items)
		}
		if end > len(items) {
			end = len(items)
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"total": total,
			"items": items[start:end],
		})
	case http.MethodDelete:
		if err := s.st.Clear(); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleFlow: GET/DELETE /api/flows/{id}, GET /api/flows/{id}/render.
func (s *Server) handleFlow(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/flows/")
	id, action, hasAction := strings.Cut(rest, "/")
	if id == "" || (hasAction && action != "render") {
		http.NotFound(w, r)
		return
	}
	if hasAction && action == "render" {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		s.handleFlowRender(w, r, id)
		return
	}
	switch r.Method {
	case http.MethodGet:
		fl, ok := s.st.Get(id)
		if !ok {
			writeErr(w, http.StatusNotFound, "no such flow: "+id)
			return
		}
		writeJSON(w, http.StatusOK, fl)
	case http.MethodDelete:
		if !s.st.Delete(id) {
			writeErr(w, http.StatusNotFound, "no such flow: "+id)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleFlowRender serves the captured response body in the browser with its
// original content type ("show response in browser").
func (s *Server) handleFlowRender(w http.ResponseWriter, r *http.Request, id string) {
	fl, ok := s.st.Get(id)
	if !ok {
		writeErr(w, http.StatusNotFound, "no such flow: "+id)
		return
	}
	if fl.Resp == nil {
		http.Error(w, "response not captured yet", http.StatusNoContent)
		return
	}
	ct := "text/plain; charset=utf-8"
	for _, h := range fl.Resp.Headers {
		if strings.EqualFold(h.Name, "Content-Type") {
			ct = h.Value
			break
		}
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Write(fl.Resp.Body)
}

func queryInt(r *http.Request, name string, def int) int {
	v := r.URL.Query().Get(name)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
