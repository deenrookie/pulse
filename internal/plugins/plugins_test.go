package plugins

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pulse/internal/store"
)

const addHeaderSrc = `
plugin = { name: "Add Header", version: "1.0" };
function onRequest(ctx) {
  ctx.request.headers.push({ name: "X-Plugin", value: "injected" });
  ctx.request.body = "plugin-was-here:" + ctx.request.body;
  pulse.log("seen " + ctx.request.method + " " + ctx.request.url);
}
`

const rewriteRespSrc = `
function onResponse(ctx) {
  if (ctx.response.body.indexOf("original") >= 0) {
    ctx.response.body = ctx.response.body.replace("original", "pluginified");
  }
}
`

func newRuntime(t *testing.T, files map[string]string) *Runtime {
	t.Helper()
	dir := t.TempDir()
	for name, src := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(src), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	rt, err := Open(dir, filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	return rt
}

func headerValue(hs []store.Header, name string) string {
	for _, h := range hs {
		if strings.EqualFold(h.Name, name) {
			return h.Value
		}
	}
	return ""
}

func TestRequestHookModifiesRequest(t *testing.T) {
	rt := newRuntime(t, map[string]string{"add-header.js": addHeaderSrc})
	req := &store.Request{
		Method:  "POST",
		URL:     "http://h.example/api",
		Headers: []store.Header{{Name: "Host", Value: "h.example"}},
		Body:    []byte("orig"),
	}
	if !rt.ApplyRequest(req) {
		t.Fatal("expected modification")
	}
	if headerValue(req.Headers, "X-Plugin") != "injected" {
		t.Fatalf("header missing: %+v", req.Headers)
	}
	if string(req.Body) != "plugin-was-here:orig" {
		t.Fatalf("body = %s", req.Body)
	}
	list := rt.List()
	if list[0].Name != "Add Header" || list[0].Version != "1.0" {
		t.Fatalf("metadata = %+v", list[0])
	}
	if list[0].Hits != 1 {
		t.Fatalf("hits = %d", list[0].Hits)
	}
	if len(list[0].Log) == 0 || !strings.Contains(list[0].Log[0], "seen POST") {
		t.Fatalf("log = %v", list[0].Log)
	}
}

func TestResponseHookModifiesBody(t *testing.T) {
	rt := newRuntime(t, map[string]string{"resp.js": rewriteRespSrc})
	req := &store.Request{URL: "http://h/"}
	resp := &store.Response{StatusCode: 200, Body: []byte("the original content")}
	if !rt.ApplyResponse(req, resp) {
		t.Fatal("expected modification")
	}
	if string(resp.Body) != "the pluginified content" {
		t.Fatalf("body = %s", resp.Body)
	}
}

func TestBrokenPluginsAreIsolated(t *testing.T) {
	rt := newRuntime(t, map[string]string{
		"syntax.js":  "function ( { this is not javascript",
		"throws.js":  "function onRequest(ctx) { throw new Error('boom'); }",
		"addhead.js": addHeaderSrc,
	})
	req := &store.Request{Method: "GET", URL: "http://h/", Headers: []store.Header{}}
	if !rt.ApplyRequest(req) {
		t.Fatal("healthy plugin should still run")
	}
	if headerValue(req.Headers, "X-Plugin") != "injected" {
		t.Fatal("healthy plugin did not apply")
	}
	for _, p := range rt.List() {
		if p.File == "throws.js" && p.Error == "" {
			t.Fatal("runtime error not recorded")
		}
		if p.File == "syntax.js" && p.Error == "" {
			t.Fatal("compile error not recorded")
		}
	}
}

func TestInfiniteLoopIsInterrupted(t *testing.T) {
	rt := newRuntime(t, map[string]string{"loop.js": "function onRequest(ctx) { while (true) { } }"})
	rt.SetTimeout(150 * time.Millisecond)
	req := &store.Request{Method: "GET", URL: "http://h/", Headers: []store.Header{}}
	done := make(chan struct{})
	go func() {
		rt.ApplyRequest(req)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("infinite-loop plugin was not interrupted")
	}
	if got := len(req.Headers); got != 0 {
		t.Fatalf("request unexpectedly modified: %+v", req.Headers)
	}
	if !strings.Contains(rt.List()[0].Error, "timeout") {
		t.Fatalf("error = %q", rt.List()[0].Error)
	}
}

func TestDisableAndReload(t *testing.T) {
	rt := newRuntime(t, map[string]string{"add-header.js": addHeaderSrc})
	if !rt.SetEnabled("add-header.js", false) {
		t.Fatal("SetEnabled failed")
	}
	req := &store.Request{Method: "GET", URL: "http://h/", Headers: []store.Header{}}
	if rt.ApplyRequest(req) {
		t.Fatal("disabled plugin ran")
	}

	// drop in a new plugin and reload
	if err := os.WriteFile(filepath.Join(rt.Dir(), "resp.js"), []byte(rewriteRespSrc), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := rt.Reload(); err != nil {
		t.Fatal(err)
	}
	resp := &store.Response{Body: []byte("original")}
	rt.ApplyResponse(&store.Request{URL: "http://h/"}, resp)
	if string(resp.Body) != "pluginified" {
		t.Fatalf("reloaded plugin not effective: %s", resp.Body)
	}
	// disable state survives reload
	req2 := &store.Request{Method: "GET", URL: "http://h/", Headers: []store.Header{}}
	if rt.ApplyRequest(req2) {
		t.Fatal("disabled state lost after reload")
	}
}
