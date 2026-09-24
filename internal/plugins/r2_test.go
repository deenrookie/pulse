package plugins

import (
	"strings"
	"testing"
	"time"

	"pulse/internal/store"
)

// R2: pulse.http.send resolves through the host event loop within the hook
// budget; the VM stays single-owner (responses delivered via the events
// channel drained by the owning goroutine).
func TestHTTPSendMockResolve(t *testing.T) {
	src := `async function onRequest(ctx) {
	const r = await pulse.http.send({ method: "GET", url: "https://tokens.test/refresh" });
	ctx.state.set("status", r.status);
	pulse.headers.set(ctx.request, "Authorization", "Bearer " + r.body);
}
function onResponse(ctx) {
	pulse.headers.set(ctx.response, "X-Got", "" + ctx.state.get("status"));
}`
	rt := newRuntime(t, map[string]string{"http.js": src})
	sender := MockSender(map[string]MockResponse{
		"https://tokens.test/refresh": {Status: 200, Body: "tok-123"},
	})
	req := &store.Request{Method: "GET", URL: "http://h/a", Headers: []store.Header{}, ID: "f1"}
	resp := &store.Response{StatusCode: 200, Headers: []store.Header{}}
	rt.ApplyRequestSender(req, sender)
	rt.ApplyResponseSender(req, resp, sender)
	if hv := headerValue(req.Headers, "Authorization"); hv != "Bearer tok-123" {
		t.Fatalf("Authorization = %q (async result not applied)", hv)
	}
	if hv := headerValue(resp.Headers, "X-Got"); hv != "200" {
		t.Fatalf("X-Got = %q (cross-hook state lost)", hv)
	}
}

// Unmocked URLs reject with the canonical error — mock mode can never
// silently reach the real network.
func TestHTTPSendUnmockedRejects(t *testing.T) {
	src := `async function onRequest(ctx) {
	try {
		await pulse.http.send({ url: "https://real.network/api" });
		pulse.log("SENT — should not happen");
	} catch (e) {
		pulse.log("rejected: " + e.message);
	}
}`
	rt := newRuntime(t, map[string]string{"m.js": src})
	req := &store.Request{Method: "GET", URL: "http://h/", Headers: []store.Header{}}
	rt.ApplyRequestSender(req, MockSender(nil))
	p := rt.List()[0]
	joined := strings.Join(p.Log, "\n")
	if !strings.Contains(joined, "unmocked network request") {
		t.Fatalf("log = %q", joined)
	}
	if strings.Contains(joined, "SENT") {
		t.Fatal("unmocked request was sent")
	}
}

// Per-request timeouts propagate as Promise rejections inside the budget.
func TestHTTPSendTimeoutRejects(t *testing.T) {
	src := `async function onRequest(ctx) {
	try {
		await pulse.http.send({ url: "https://slow.test/x", timeoutMs: 50 });
		pulse.log("no timeout — bad");
	} catch (e) {
		pulse.log("timeout hit");
	}
}`
	rt := newRuntime(t, map[string]string{"t.js": src})
	rt.SetTimeout(3 * time.Second)
	req := &store.Request{Method: "GET", URL: "http://h/", Headers: []store.Header{}}
	start := time.Now()
	rt.ApplyRequestSender(req, MockSender(map[string]MockResponse{
		"https://slow.test/x": {Status: 200, Body: "late", DelayMs: 5000},
	}))
	if time.Since(start) > 2*time.Second {
		t.Fatal("per-request timeout did not bound the wait")
	}
	if !strings.Contains(strings.Join(rt.List()[0].Log, "\n"), "timeout hit") {
		t.Fatalf("log = %q", strings.Join(rt.List()[0].Log, "\n"))
	}
}

// ctx.respond terminates the transaction with a local response.
func TestCtxRespond(t *testing.T) {
	src := `function onRequest(ctx) {
	if (ctx.request.url.indexOf("/mocked") < 0) return;
	ctx.respond({ status: 203, headers: [{ name: "X-Mock", value: "yes" }], body: "mocked body" });
}`
	rt := newRuntime(t, map[string]string{"r.js": src})
	req := &store.Request{Method: "GET", URL: "http://h/mocked", Headers: []store.Header{}, ID: "f1"}
	changed, act := rt.ApplyRequestR2(req, nil)
	_ = changed
	if act == nil || act.Resp == nil {
		t.Fatal("no terminal respond action")
	}
	if act.Resp.StatusCode != 203 || string(act.Resp.Body) != "mocked body" {
		t.Fatalf("resp = %+v", act.Resp)
	}
	if hv := headerValue(act.Resp.Headers, "X-Mock"); hv != "yes" {
		t.Fatalf("X-Mock = %q", hv)
	}
	if hv := headerValue(act.Resp.Headers, "Content-Length"); hv != "11" {
		t.Fatalf("Content-Length = %q (must be recomputed)", hv)
	}
}

// ctx.drop terminates with a reason; repeated terminal actions error.
func TestCtxDropAndDoubleTerminal(t *testing.T) {
	src := `function onRequest(ctx) {
	ctx.drop({ reason: "blocked host" });
	ctx.respond({ status: 200 }); // second terminal action must fail
}`
	rt := newRuntime(t, map[string]string{"d.js": src})
	req := &store.Request{Method: "GET", URL: "http://h/x", Headers: []store.Header{}, ID: "f1"}
	changed, act := rt.ApplyRequestR2(req, nil)
	_ = changed
	if act == nil || !act.Drop {
		t.Fatal("drop action missing")
	}
	if act.DropReason != "blocked host" {
		t.Fatalf("reason = %q", act.DropReason)
	}
	joined := strings.Join(rt.List()[0].Log, "\n")
	if !strings.Contains(joined, "already has a terminal action") {
		t.Fatalf("double terminal not reported: %q", joined)
	}
}

// onComplete runs read-only after completion and can use stores.
func TestOnComplete(t *testing.T) {
	src := `function onComplete(ctx) {
	pulse.store.memory.increment("finished");
	pulse.log("done " + ctx.response.status + " flow=" + (ctx.flowId || "?"));
}`
	rt := newRuntime(t, map[string]string{"c.js": src})
	fl := &store.Flow{ID: "f9", Req: store.Request{Method: "GET", URL: "http://h/"}, Resp: &store.Response{StatusCode: 201}}
	rt.RunComplete(fl, nil, nil)
	mem := rt.MemoryStateSnapshot("c.js")
	if mem["finished"] != int64(1) {
		t.Fatalf("finished = %v", mem["finished"])
	}
	if !strings.Contains(strings.Join(rt.List()[0].Log, "\n"), "done 201 flow=f9") {
		t.Fatalf("log = %q", strings.Join(rt.List()[0].Log, "\n"))
	}
}

// Actions: declared in plugin.actions, run against a flow copy, full SDK +
// mock network available, string results returned.
func TestActions(t *testing.T) {
	src := `plugin = {
	name: "Acts", version: "1.0",
	actions: [
		{ id: "sign", label: "Compute signature" },
		{ id: "nope" }
	]
};
var actions = {
	sign: function (ctx) {
		return ctx.request.method + " " + pulse.crypto.sha256(ctx.request.url).slice(0, 8);
	}
};`
	rt := newRuntime(t, map[string]string{"a.js": src})
	p := rt.List()[0]
	if len(p.Actions) != 1 || p.Actions[0].ID != "sign" {
		t.Fatalf("actions = %+v (nope must be dropped: no function)", p.Actions)
	}
	fl := &store.Flow{ID: "f1", Req: store.Request{Method: "POST", URL: "http://h/sign-me"}}
	out := rt.RunAction("a.js", "sign", fl, nil)
	if out.Error != "" {
		t.Fatalf("action error: %s", out.Error)
	}
	if !strings.HasPrefix(out.Result, "POST ") || len(out.Result) != 13 {
		t.Fatalf("result = %q", out.Result)
	}
	// unknown action id errors
	if out := rt.RunAction("a.js", "nope", fl, nil); out.Error == "" {
		t.Fatal("nope must error")
	}
}

// Hook-level infinite loop still interrupted with the async runtime.
func TestAsyncLoopStillInterrupted(t *testing.T) {
	rt := newRuntime(t, map[string]string{"loop.js": "async function onRequest(ctx) { while (true) { } }"})
	rt.SetTimeout(150 * time.Millisecond)
	req := &store.Request{Method: "GET", URL: "http://h/", Headers: []store.Header{}}
	done := make(chan struct{})
	go func() {
		rt.ApplyRequestSender(req, nil)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("loop not interrupted")
	}
}

// ctx.highlight colors the flow row; unsupported colors throw into the hook
// error path instead of leaking arbitrary values into the UI.
func TestCtxHighlight(t *testing.T) {
	ok := `function onResponse(ctx) { ctx.highlight("RED "); }`
	rt := newRuntime(t, map[string]string{"h.js": ok})
	req := &store.Request{Method: "GET", URL: "http://h/", Headers: []store.Header{}, ID: "f1"}
	resp := &store.Response{StatusCode: 200, Headers: []store.Header{}}
	_, hl := rt.ApplyResponse(req, resp)
	if hl != "red" {
		t.Fatalf("highlight = %q, want red", hl)
	}

	bad := `function onRequest(ctx) { ctx.highlight("purple</td>"); }`
	rt2 := newRuntime(t, map[string]string{"b.js": bad})
	req2 := &store.Request{Method: "GET", URL: "http://h/", Headers: []store.Header{}, ID: "f2"}
	_, act := rt2.ApplyRequestR2(req2, nil)
	if act != nil {
		t.Fatalf("invalid color must not produce an action, got %+v", act)
	}
	if rt2.List()[0].Errors == 0 {
		t.Fatal("invalid color must surface as a hook error")
	}
}
