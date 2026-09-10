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
			Enabled    *bool `json:"enabled"`
			RespEnabled *bool `json:"respEnabled"`
		}
		if !readJSON(w, r, &body, 1<<20) {
			return
		}
		if body.Enabled == nil && body.RespEnabled == nil {
			writeErr(w, http.StatusBadRequest, "missing \"enabled\" / \"respEnabled\" field")
			return
		}
		if body.Enabled != nil {
			s.eng.Inter.SetEnabled(*body.Enabled)
		}
		if body.RespEnabled != nil {
			s.eng.Inter.SetRespEnabled(*body.RespEnabled)
		}
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
	respHeld := s.eng.Inter.PendingResp()
	respMetas := make([]map[string]any, 0, len(respHeld))
	for _, h := range respHeld {
		respMetas = append(respMetas, map[string]any{
			"id": h.ID, "method": h.Req.Method, "url": h.Req.URL,
			"status": h.Resp.StatusCode, "reason": h.Resp.Reason,
			"contentType": headerValueOf(h.Resp.Headers, "Content-Type"),
		})
	}
	return map[string]any{
		"enabled":     s.eng.Inter.Enabled(),
		"respEnabled": s.eng.Inter.RespEnabled(),
		"capacity":    50,
		"pending":     metas,
		"pendingResp": respMetas,
	}
}

func headerValueOf(headers []store.Header, name string) string {
	for _, h := range headers {
		if strings.EqualFold(h.Name, name) {
			return h.Value
		}
	}
	return ""
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
