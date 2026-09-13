package plugins

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pulse/internal/store"
)

// R0: a source that stops loading must not take the plugin down with it —
// the runtime keeps executing the last good revision, and a restart
// recovers it from the persisted revisions directory.
func TestBrokenSourceRunsLastGoodRevision(t *testing.T) {
	good := addHeaderSrc
	broken := "function ( { this is not javascript"

	dir := t.TempDir()
	state := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(filepath.Join(dir, "add-header.js"), []byte(good), 0o644); err != nil {
		t.Fatal(err)
	}
	rt, err := Open(dir, state)
	if err != nil {
		t.Fatal(err)
	}
	req := &store.Request{Method: "GET", URL: "http://h/", Headers: []store.Header{}}
	if !rt.ApplyRequest(req) || headerValue(req.Headers, "X-Plugin") != "injected" {
		t.Fatal("baseline: good plugin did not apply")
	}

	// break the source on disk and reload
	if err := os.WriteFile(filepath.Join(dir, "add-header.js"), []byte(broken), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := rt.Reload(); err != nil {
		t.Fatal(err)
	}
	p := rt.List()[0]
	if p.Error == "" || !strings.Contains(p.Error, "running last good revision") {
		t.Fatalf("error = %q, want fallback note", p.Error)
	}
	if !p.RunningLastGood {
		t.Fatal("RunningLastGood not set")
	}
	// the editor still sees the broken source
	if src, _ := rt.Source("add-header.js"); src != broken {
		t.Fatalf("source = %q, want the broken current source", src)
	}
	req2 := &store.Request{Method: "GET", URL: "http://h/", Headers: []store.Header{}}
	if !rt.ApplyRequest(req2) || headerValue(req2.Headers, "X-Plugin") != "injected" {
		t.Fatal("fallback: last good revision did not apply")
	}

	// restart: a fresh Open must recover the same last-good revision
	rt2, err := Open(dir, state)
	if err != nil {
		t.Fatal(err)
	}
	p2 := rt2.List()[0]
	if !p2.RunningLastGood || p2.Error == "" {
		t.Fatalf("after restart: %+v", p2)
	}
	req3 := &store.Request{Method: "GET", URL: "http://h/", Headers: []store.Header{}}
	if !rt2.ApplyRequest(req3) || headerValue(req3.Headers, "X-Plugin") != "injected" {
		t.Fatal("restart: last good revision did not apply")
	}

	// repairing the source clears the fallback
	if err := rt2.Write("add-header.js", good); err != nil {
		t.Fatal(err)
	}
	p3 := rt2.List()[0]
	if p3.RunningLastGood || p3.Error != "" {
		t.Fatalf("after repair: %+v", p3)
	}
}

// R0: top-level `while (true)` at init must be interrupted — it used to run
// outside the interrupt budget and could wedge a load forever.
func TestInfiniteTopLevelIsInterrupted(t *testing.T) {
	start := time.Now()
	rt := newRuntime(t, map[string]string{"spin.js": "while (true) { }\nfunction onRequest(ctx) {}"})
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("init spin took %v — not interrupted", elapsed)
	}
	p := rt.List()[0]
	if p.Error == "" || !strings.Contains(p.Error, "load:") {
		t.Fatalf("error = %q, want load failure", p.Error)
	}
	if p.prog != nil {
		t.Fatal("spin plugin must not have a running program")
	}
}

// R0: a later success must not erase the failure history (LastError sticky),
// and counters separate attempts/hits/modified/errors.
func TestCountersAndStickyLastError(t *testing.T) {
	src := `function onRequest(ctx) {
	var fail = ctx.request.headers.some(function (h) { return h.name === "X-Fail"; });
	if (fail) throw new Error("first run fails");
	ctx.request.headers.push({ name: "X-Run", value: "ok" });
}`
	rt := newRuntime(t, map[string]string{"flaky.js": src})
	r1 := &store.Request{Method: "GET", URL: "http://h/", Headers: []store.Header{{Name: "X-Fail", Value: "1"}}}
	rt.ApplyRequest(r1) // run 1: throws
	r2 := &store.Request{Method: "GET", URL: "http://h/", Headers: []store.Header{}}
	rt.ApplyRequest(r2) // run 2: succeeds and modifies

	p := rt.List()[0]
	if p.Attempts != 2 || p.Hits != 1 || p.Errors != 1 || p.Modified != 1 {
		t.Fatalf("counters = attempts %d hits %d errors %d modified %d", p.Attempts, p.Hits, p.Errors, p.Modified)
	}
	if !strings.Contains(p.LastError, "first run fails") {
		t.Fatalf("LastError = %q — success erased it", p.LastError)
	}
	if p.LastErrorAt == "" {
		t.Fatal("LastErrorAt not recorded")
	}
}

// R0: response-phase plugins may still rewrite ctx.request (v1 behavior
// preserved), while httpVersion/reason writes stay inert — documented,
// tested, not silently changed.
func TestV1FieldSemantics(t *testing.T) {
	src := `function onResponse(ctx) {
	ctx.request.headers.push({ name: "X-After", value: "yes" });
	ctx.request.httpVersion = "HTTP/9.9";   // documented read-only
	ctx.response.reason = "Custom Reason";  // documented read-only
	ctx.response.status = 201;
}`
	rt := newRuntime(t, map[string]string{"v1.js": src})
	req := &store.Request{Method: "GET", URL: "http://h/", HTTPVersion: "HTTP/1.1", Headers: []store.Header{}}
	resp := &store.Response{StatusCode: 200, Reason: "OK", HTTPVersion: "HTTP/1.1", Headers: []store.Header{}}
	if !rt.ApplyResponse(req, resp) {
		t.Fatal("expected modification")
	}
	if headerValue(req.Headers, "X-After") != "yes" {
		t.Fatal("v1: response-phase request writeback dropped")
	}
	if req.HTTPVersion != "HTTP/1.1" {
		t.Fatalf("httpVersion writeback = %q, want untouched", req.HTTPVersion)
	}
	if resp.Reason != "OK" {
		t.Fatalf("reason writeback = %q, want untouched", resp.Reason)
	}
	if resp.StatusCode != 201 {
		t.Fatal("status writeback lost")
	}
}
