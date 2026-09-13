package api

import (
	"fmt"
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
	found, err := s.plug.SetEnabled(file, *body.Enabled)
	if !found {
		writeErr(w, http.StatusNotFound, "no such plugin: "+file)
		return
	}
	if err != nil {
		// the in-memory toggle worked but the state file did not persist:
		// a restart would revert it — surface that instead of claiming ok
		writeErr(w, http.StatusInternalServerError, "toggled in memory, but persisting the state failed: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handlePluginsSamples: GET the embedded showcase sources for the Samples tab.
func (s *Server) handlePluginsSamples(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"samples": plugins.Samples()})
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

// handlePluginConfig: GET describe (secrets never echo values), PUT validate
// and persist. Path: /api/plugins/config/{file}.
func (s *Server) handlePluginConfig(w http.ResponseWriter, r *http.Request) {
	file := strings.TrimPrefix(r.URL.Path, "/api/plugins/config/")
	if file == "" || strings.ContainsAny(file, `/\`) {
		http.NotFound(w, r)
		return
	}
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{"file": file, "fields": s.plug.ConfigFields(file)})
	case http.MethodPut:
		var body struct {
			Values map[string]any `json:"values"`
		}
		if !readJSON(w, r, &body, 1<<20) || body.Values == nil {
			writeErr(w, http.StatusBadRequest, "missing \"values\"")
			return
		}
		if err := s.plug.SetConfigValues(file, body.Values); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"file": file, "fields": s.plug.ConfigFields(file)})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// pluginFlows bypass the plugin chain and rewrites (no recursion) and are
// recorded with source "plugin" so Live Traffic can filter them.

// handlePluginHTTPRoundTrip: internal relay used by the plugins package's
// production sender — not a public route; wired via SetPluginTransport.
func (s *Server) pluginFlowTransport(req *plugins.PluginHTTPRequest) (*plugins.PluginHTTPResponse, error) {
	storeReq := &store.Request{
		Method: req.Method, URL: req.URL, HTTPVersion: "HTTP/1.1",
		Source: "plugin", Timestamp: time.Now(),
	}
	for _, h := range req.Headers {
		storeReq.Headers = append(storeReq.Headers, store.Header{Name: h[0], Value: h[1]})
	}
	storeReq.Body = []byte(req.Body)
	fl := s.eng.RoundTripPlugin(storeReq)
	if fl.State == store.StateError {
		return nil, fmt.Errorf("%s", fl.Error)
	}
	out := &plugins.PluginHTTPResponse{Status: 200, Reason: "OK", Source: "plugin", FlowID: fl.ID}
	if fl.Resp != nil {
		out.Status = fl.Resp.StatusCode
		out.Reason = fl.Resp.Reason
		out.Body = string(fl.Resp.Body)
		for _, h := range fl.Resp.Headers {
			out.Headers = append(out.Headers, [2]string{h.Name, h.Value})
		}
	}
	return out, nil
}

// handlePluginAction: POST run a declared action against a stored flow.
// Path: /api/plugins/action/{file}/{actionId}; body {flowId}.
func (s *Server) handlePluginAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/api/plugins/action/")
	file, actionID, ok := strings.Cut(rest, "/")
	if !ok || file == "" || actionID == "" {
		http.NotFound(w, r)
		return
	}
	var body struct {
		FlowID string `json:"flowId"`
	}
	if !readJSON(w, r, &body, 1<<10) || body.FlowID == "" {
		writeErr(w, http.StatusBadRequest, "missing \"flowId\"")
		return
	}
	fl, ok := s.st.Get(body.FlowID)
	if !ok {
		writeErr(w, http.StatusNotFound, "no such flow: "+body.FlowID)
		return
	}
	out := s.plug.RunAction(file, actionID, fl, plugins.HTTPSenderFunc(s.pluginFlowTransport))
	writeJSON(w, http.StatusOK, out)
}

// handlePluginsTestMock: POST run a hook with Mock network mode — every
// pulse.http.send to an unmocked URL rejects with "unmocked network request";
// mocks are declared per run and never touch the real network.
func (s *Server) handlePluginsTestMock(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Src      string               `json:"src"`
		Hook     string               `json:"hook"`
		Request  testMessage          `json:"request"`
		Response *testMessage         `json:"response"`
		Mocks    map[string]struct {
			Status  int              `json:"status"`
			Body    string           `json:"body"`
			Headers [][2]string      `json:"headers"`
			DelayMs int64            `json:"delayMs"`
		} `json:"mocks"`
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
		resp = testMessage{}.toResponse()
	}
	hookName := "onRequest"
	if hook == "response" {
		hookName = "onResponse"
	}
	mocks := map[string]plugins.MockResponse{}
	for url, m := range body.Mocks {
		mocks[url] = plugins.MockResponse{Status: m.Status, Body: m.Body, Headers: m.Headers, DelayMs: m.DelayMs}
	}
	out := s.plug.TestRunWithSender(body.Src, hookName, req, resp, 2*time.Second, plugins.MockSender(mocks))
	writeJSON(w, http.StatusOK, map[string]any{
		"logs": out.Logs, "error": out.Error, "changed": out.Changed, "mocked": out.Mocked,
		"request": requestToTestMessage(*out.Request), "response": respOut(out),
	})
}

// handlePluginsApply: POST run a plugin's request hook against a raw request
// (Repeater "Apply plugin" preview): returns the transformed request without
// sending anything. Path: /api/plugins/apply.
func (s *Server) handlePluginsApply(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		File    string      `json:"file"`
		Request testMessage `json:"request"`
	}
	if !readJSON(w, r, &body, 2<<20) || body.File == "" {
		writeErr(w, http.StatusBadRequest, "missing \"file\" or \"request\"")
		return
	}
	out := s.plug.ApplyToRequest(body.File, body.Request.toRequest())
	writeJSON(w, http.StatusOK, map[string]any{
		"logs": out.Logs, "error": out.Error, "changed": out.Changed,
		"request": requestToTestMessage(*out.Request),
	})
}
