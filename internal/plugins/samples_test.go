package plugins

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"pulse/internal/store"
)

// Every embedded sample must compile clean — the Samples tab shows sources
// that are supposed to work out of the box.
func TestSamplesAllCompile(t *testing.T) {
	for _, s := range Samples() {
		if insp := Inspect(s.Src); insp.Error != "" {
			t.Errorf("sample %s does not compile: %s", s.File, insp.Error)
		}
	}
	if len(Samples()) < 4 {
		t.Fatalf("expected at least 4 samples, got %d", len(Samples()))
	}
}

// The flagship demo must read AND rewrite every part of a message:
// request path, query params, request headers, POST body, response
// headers, response body — with replacements applied on both directions.
func TestDemoSampleReadsAndRewritesEverything(t *testing.T) {
	src, ok := SampleSource("demo-read-rewrite.js")
	if !ok {
		t.Fatal("demo sample missing")
	}

	req := &store.Request{
		Method:      "POST",
		URL:         "http://api.example.com/v1/users?user=deen&verbose=1",
		HTTPVersion: "HTTP/1.1",
		Headers: []store.Header{
			{Name: "Host", Value: "api.example.com"},
			{Name: "User-Agent", Value: "curl/8.0"},
			{Name: "Content-Type", Value: "application/json"},
		},
		Body: []byte(`{"username":"bob"}`),
	}

	out := TestRun(src, "onRequest", req, nil, 2*time.Second)
	if out.Error != "" {
		t.Fatalf("request hook error: %s", out.Error)
	}
	logs := strings.Join(out.Logs, "\n")

	// --- 读取断言 ---
	for _, want := range []string{
		"[req] POST /v1/users",             // 获取请求路径
		"[req] query user=deen verbose=1",  // 获取请求参数
		"[req] User-Agent: curl/8.0",       // 获取请求 headers
		`[req] body: {"username":"bob"}`,   // 获取 POST body
	} {
		if !strings.Contains(logs, want) {
			t.Errorf("logs missing %q\nlogs:\n%s", want, logs)
		}
	}

	// --- 改写断言：请求头被替换 ---
	if v := headerValue(out.Request.Headers, "User-Agent"); v != "Pulse-Demo/1.0" {
		t.Errorf("request User-Agent = %q, want Pulse-Demo/1.0", v)
	}
	// --- 改写断言：请求 body 被注入字段 ---
	var payload map[string]any
	if err := json.Unmarshal(out.Request.Body, &payload); err != nil {
		t.Fatalf("rewritten body is not JSON: %v (%s)", err, out.Request.Body)
	}
	if payload["username"] != "bob" || payload["injected_by"] != "pulse-demo" {
		t.Errorf("rewritten body = %v", payload)
	}
	if !out.Changed {
		t.Error("request hook should report changed=true")
	}

	// ---- 响应方向 ----
	req2 := &store.Request{Method: "GET", URL: "http://api.example.com/v1/profile", HTTPVersion: "HTTP/1.1"}
	resp := &store.Response{
		StatusCode:  200,
		Reason:      "OK",
		HTTPVersion: "HTTP/1.1",
		Headers:     []store.Header{{Name: "Content-Type", Value: "application/json"}},
		Body:        []byte(`{"greeting":"hello {{username}}"}`),
	}
	out2 := TestRun(src, "onResponse", req2, resp, 2*time.Second)
	if out2.Error != "" {
		t.Fatalf("response hook error: %s", out2.Error)
	}
	logs2 := strings.Join(out2.Logs, "\n")
	for _, want := range []string{
		"[resp] 200 /v1/profile",                  // 响应状态 + 请求路径
		"[resp] Content-Type: application/json",   // 获取响应 headers
		"[resp] body:",                            // 获取响应 body
	} {
		if !strings.Contains(logs2, want) {
			t.Errorf("resp logs missing %q\nlogs:\n%s", want, logs2)
		}
	}
	// --- 改写断言：响应头被替换、body 模板被替换 ---
	if v := headerValue(out2.Resp.Headers, "X-Served-By"); v != "pulse-demo" {
		t.Errorf("response X-Served-By = %q, want pulse-demo", v)
	}
	if !strings.Contains(string(out2.Resp.Body), "hello pulse-user") || strings.Contains(string(out2.Resp.Body), "{{username}}") {
		t.Errorf("response body not rewritten: %s", out2.Resp.Body)
	}
	if !out2.Changed {
		t.Error("response hook should report changed=true")
	}
}
