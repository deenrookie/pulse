package api

import (
	"net/http"
	"strings"

	"pulse/internal/store"
)

// handleRepeater: GET tabs, POST create from flowId or raw request.
func (s *Server) handleRepeater(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{"tabs": s.rep.List()})
	case http.MethodPost:
		var body struct {
			FlowID  string          `json:"flowId"`
			Request *store.Request `json:"request"`
		}
		if !readJSON(w, r, &body, 32<<20) {
			return
		}
		var req store.Request
		switch {
		case body.Request != nil:
			req = *body.Request
			if !parseEditableRequest(w, &req) {
				return
			}
		case body.FlowID != "":
			fl, ok := s.st.Get(body.FlowID)
			if !ok {
				writeErr(w, http.StatusNotFound, "no such flow: "+body.FlowID)
				return
			}
			req = fl.Req
		default:
			writeErr(w, http.StatusBadRequest, "provide \"flowId\" or \"request\"")
			return
		}
		tab, err := s.rep.CreateFromRequest(&req)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, tab)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleRepeaterID: PUT save, DELETE remove, POST /send.
func (s *Server) handleRepeaterID(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/repeater/")
	id, action, _ := strings.Cut(rest, "/")
	if id == "" {
		http.NotFound(w, r)
		return
	}
	switch {
	case r.Method == http.MethodPut && action == "":
		var body struct {
			Request *store.Request `json:"request"`
		}
		if !readJSON(w, r, &body, 32<<20) {
			return
		}
		if body.Request == nil {
			writeErr(w, http.StatusBadRequest, "missing \"request\"")
			return
		}
		if !parseEditableRequest(w, body.Request) {
			return
		}
		tab, ok, err := s.rep.Update(id, body.Request)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		if !ok {
			writeErr(w, http.StatusNotFound, "no such tab: "+id)
			return
		}
		writeJSON(w, http.StatusOK, tab)
	case r.Method == http.MethodDelete && action == "":
		if !s.rep.Delete(id) {
			writeErr(w, http.StatusNotFound, "no such tab: "+id)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case r.Method == http.MethodPost && action == "send":
		var body struct {
			Request *store.Request `json:"request"`
		}
		if !readJSON(w, r, &body, 32<<20) {
			return
		}
		tab, ok := s.rep.Get(id)
		if !ok {
			writeErr(w, http.StatusNotFound, "no such tab: "+id)
			return
		}
		req := tab.Request
		if body.Request != nil {
			if !parseEditableRequest(w, body.Request) {
				return
			}
			req = *body.Request
			if updated, ok, err := s.rep.Update(id, body.Request); err == nil && ok {
				tab = updated
			}
		}
		req.Source = "repeater"
		fl := s.eng.RoundTrip(&req)
		if fl.Resp != nil {
			respCopy := *fl.Resp
			s.rep.SetLastResponse(id, &respCopy)
		}
		writeJSON(w, http.StatusOK, map[string]any{"flow": fl})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}
