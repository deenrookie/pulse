package api

import (
	"net/http"
	"strings"
	"time"

	"pulse/internal/plugins"
	"pulse/internal/store"
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

// handlePluginsSource: GET read a plugin's source, PUT save it (then rescan),
// DELETE remove the file. Path: /api/plugins/source/{file}.
func (s *Server) handlePluginsSource(w http.ResponseWriter, r *http.Request) {
	file := strings.TrimPrefix(r.URL.Path, "/api/plugins/source/")
	if file == "" || strings.ContainsAny(file, `/\`) {
		http.NotFound(w, r)
		return
	}
	switch r.Method {
	case http.MethodGet:
		src, ok := s.plug.Source(file)
		if !ok {
			writeErr(w, http.StatusNotFound, "no such plugin: "+file)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"file": file, "src": src})
	case http.MethodPut:
		var body struct {
			Src string `json:"src"`
		}
		if !readJSON(w, r, &body, 4<<20) {
			return
		}
		if err := s.plug.Write(file, body.Src); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		// compile errors are reported, not rejected: the file is on disk and
		// the plugin list carries the error for the UI to show inline.
		var compileErr string
		for _, p := range s.plug.List() {
			if p.File == file && p.Error != "" {
				compileErr = p.Error
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"file": file, "error": compileErr,
			"plugins": s.plug.List(), "dir": s.plug.Dir(),
		})
	case http.MethodDelete:
		if !s.plug.Delete(file) {
			writeErr(w, http.StatusNotFound, "no such plugin: "+file)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "plugins": s.plug.List(), "dir": s.plug.Dir()})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handlePluginsValidate: POST dry-compile source without writing anything.
func (s *Server) handlePluginsValidate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Src string `json:"src"`
	}
	if !readJSON(w, r, &body, 4<<20) {
		return
	}
	writeJSON(w, http.StatusOK, plugins.Inspect(body.Src))
}

// testMessage mirrors store.Request/Response with plain-string bodies so the
// UI can round-trip test fixtures as JSON.
type testMessage struct {
	Method      string         `json:"method,omitempty"`
	URL         string         `json:"url,omitempty"`
	HTTPVersion string         `json:"httpVersion,omitempty"`
	Status      int            `json:"status,omitempty"`
	Reason      string         `json:"reason,omitempty"`
	Headers     []store.Header `json:"headers,omitempty"`
	Body        string         `json:"body,omitempty"`
}

func (m testMessage) toRequest() *store.Request {
	return &store.Request{
		Method: orDefault(m.Method, "GET"), URL: m.URL,
		HTTPVersion: orDefault(m.HTTPVersion, "HTTP/1.1"),
		Headers: m.Headers, Body: []byte(m.Body),
	}
}

func (m testMessage) toResponse() *store.Response {
	return &store.Response{
		StatusCode: orDefaultInt(m.Status, 200), Reason: orDefault(m.Reason, "OK"),
		HTTPVersion: orDefault(m.HTTPVersion, "HTTP/1.1"),
		Headers: m.Headers, Body: []byte(m.Body),
	}
}

func requestToTestMessage(r store.Request) testMessage {
	return testMessage{Method: r.Method, URL: r.URL, HTTPVersion: r.HTTPVersion, Headers: r.Headers, Body: string(r.Body)}
}

func responseToTestMessage(v store.Response) testMessage {
	return testMessage{Status: v.StatusCode, Reason: v.Reason, HTTPVersion: v.HTTPVersion, Headers: v.Headers, Body: string(v.Body)}
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

func orDefaultInt(n, def int) int {
	if n == 0 {
		return def
	}
	return n
}

// handlePluginsTest: POST run a hook against caller-supplied messages in the
// same isolated VM the proxy uses — a dry run with zero traffic. Returns
// captured pulse.log output, any error, and the transformed messages.
func (s *Server) handlePluginsTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Src      string      `json:"src"`
		Hook     string      `json:"hook"` // "request" | "response" | "onRequest" | "onResponse"
		Request  testMessage `json:"request"`
		Response *testMessage `json:"response"`
	}
	if !readJSON(w, r, &body, 4<<20) {
		return
	}
	hook := strings.TrimPrefix(strings.TrimSpace(body.Hook), "on")
	if hook == "" {
		hook = "request"
	}
	if hook != "request" && hook != "response" {
		writeErr(w, http.StatusBadRequest, "hook must be request or response")
		return
	}
	req := body.Request.toRequest()
	var resp *store.Response
	if body.Response != nil {
		resp = body.Response.toResponse()
	} else if hook == "response" {
		resp = testMessage{}.toResponse() // sensible default so ctx.response exists
	}
	hookName := "onRequest"
	if hook == "response" {
		hookName = "onResponse"
	}
	out := plugins.TestRun(body.Src, hookName, req, resp, 2*time.Second)
	writeJSON(w, http.StatusOK, map[string]any{
		"logs": out.Logs, "error": out.Error, "changed": out.Changed,
		"request": requestToTestMessage(*out.Request), "response": respOut(out),
	})
}

func respOut(out plugins.TestOutcome) any {
	if out.Resp == nil {
		return nil
	}
	return responseToTestMessage(*out.Resp)
}
