package plugins

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"pulse/internal/store"
)

// R1 SDK: headers/url/query/cookies/body/encoding/crypto all operate on the
// live message draft the hooks see.
func TestSDKMessageHelpers(t *testing.T) {
	src := `function onRequest(ctx) {
	var r = ctx.request;
	pulse.headers.set(r, "X-One", "first");
	pulse.headers.append(r, "X-Dup", "a");
	pulse.headers.append(r, "X-Dup", "b");
	if (pulse.headers.get(r, "x-one") !== "first") throw new Error("get case-insensitive");
	if (pulse.headers.getAll(r, "X-DUP").join(",") !== "a,b") throw new Error("getAll keeps order");
	pulse.headers.set(r, "X-One", "replaced"); // dedupe to one
	var u = pulse.url.parse(r.url);
	if (u.scheme !== "http" || u.host !== "h" || u.path !== "/api") throw new Error("url.parse " + JSON.stringify(u));
	pulse.query.set(r, "token", "a b&c=d");   // value encoded, + stays literal
	pulse.query.append(r, "tag", "1");
	pulse.query.append(r, "tag", "2");        // repeats preserved
	if (pulse.query.getAll(r, "tag").join(",") !== "1,2") throw new Error("query repeats");
	pulse.query.remove(r, "gone");
	pulse.cookies.set(r, "session", "s1");
	pulse.cookies.set(r, "theme", "dark");
	if (pulse.cookies.get(r, "session") !== "s1") throw new Error("cookie get");
	pulse.cookies.remove(r, "theme");
	var body = { hello: "world", n: 2 };
	pulse.body.setJSON(r, body);
	var back = pulse.body.json(r);
	if (back.hello !== "world" || back.n !== 2) throw new Error("body json roundtrip");
	pulse.body.setText(r, "plain");
	var b64 = pulse.encoding.base64("hi");
	if (b64 !== "aGk=") throw new Error("base64");
	if (pulse.encoding.hex("hi") !== "6869") throw new Error("hex");
	if (pulse.crypto.sha256("hi").length !== 64) throw new Error("sha256");
	if (pulse.crypto.hmacSha256("key", "data").length !== 64) throw new Error("hmac");
	pulse.log("sdk ok " + b64);
}`
	rt := newRuntime(t, map[string]string{"sdk.js": src})
	req := &store.Request{Method: "GET", URL: "http://h/api?gone=1&token=old", Headers: []store.Header{{Name: "X-One", Value: "stale"}}}
	if !rt.ApplyRequest(req) {
		t.Fatal("expected modification")
	}
	hv := func(name string) string { return headerValue(req.Headers, name) }
	if hv("X-One") != "replaced" {
		t.Fatalf("X-One = %q (dedupe failed)", hv("X-One"))
	}
	if countHeaders(req.Headers, "X-One") != 1 {
		t.Fatal("set must collapse duplicates")
	}
	if hv("X-Dup") != "a" {
		t.Fatal("append lost")
	}
	if req.URL != "http://h/api?tag=1&tag=2&token=a+b%26c%3Dd" {
		t.Fatalf("url = %q", req.URL)
	}
	if hv("Cookie") != "session=s1" {
		t.Fatalf("cookie = %q", hv("Cookie"))
	}
	if string(req.Body) != "plain" {
		t.Fatalf("body = %q", req.Body)
	}
}

func countHeaders(hs []store.Header, name string) int {
	n := 0
	for _, h := range hs {
		if h.Name == name {
			n++
		}
	}
	return n
}

// R1 state: ctx.state spans one transaction (request→response of one flow);
// memory store spans requests; persistent store survives restarts.
func TestStateSemantics(t *testing.T) {
	dir := t.TempDir()
	statePath := filepath.Join(t.TempDir(), "state.json")
	src := `function onRequest(ctx) {
	ctx.state.set("phase", "req");
	pulse.store.memory.set("seen:" + ctx.request.url, true);
	pulse.store.memory.increment("count");
	ctx.state.set("token", "tok-" + pulse.store.memory.increment("n"));
}
function onResponse(ctx) {
	ctx.request.headers.push({ name: "X-Phase", value: "" + ctx.state.get("phase") });
	ctx.request.headers.push({ name: "X-Token", value: "" + ctx.state.get("token") });
	pulse.store.local.set("last-status", ctx.response.status);
}`
	if err := os.WriteFile(filepath.Join(dir, "stateful.js"), []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	rt, err := Open(dir, statePath)
	if err != nil {
		t.Fatal(err)
	}
	req := &store.Request{Method: "GET", URL: "http://h/a", ID: "f1", Headers: []store.Header{}}
	rt.ApplyRequest(req)
	resp := &store.Response{StatusCode: 200, Headers: []store.Header{}}
	rt.ApplyResponse(req, resp)
	if headerValue(req.Headers, "X-Phase") != "req" {
		t.Fatal("tx state did not span request→response")
	}
	if headerValue(req.Headers, "X-Token") != "tok-1" {
		t.Fatalf("increment result: %q", headerValue(req.Headers, "X-Token"))
	}

	// second request: memory persists, tx state is fresh
	req2 := &store.Request{Method: "GET", URL: "http://h/b", ID: "f2", Headers: []store.Header{}}
	rt.ApplyRequest(req2)
	resp2 := &store.Response{StatusCode: 201, Headers: []store.Header{}}
	rt.ApplyResponse(req2, resp2)
	if headerValue(req2.Headers, "X-Token") != "tok-2" {
		t.Fatalf("memory across requests: %q", headerValue(req2.Headers, "X-Token"))
	}
	mem := rt.MemoryStateSnapshot("stateful.js")
	if mem["count"] != int64(2) {
		t.Fatalf("memory count = %v", mem["count"])
	}

	// restart: memory lost, persistent kept
	rt2, err := Open(dir, statePath)
	if err != nil {
		t.Fatal(err)
	}
	if m := rt2.MemoryStateSnapshot("stateful.js"); len(m) != 0 {
		t.Fatalf("memory survived restart: %v", m)
	}
	req3 := &store.Request{Method: "GET", URL: "http://h/c", ID: "f3", Headers: []store.Header{}}
	resp3 := &store.Response{StatusCode: 202, Headers: []store.Header{}}
	rt2.ApplyRequest(req3)
	rt2.ApplyResponse(req3, resp3)
	if headerValue(req3.Headers, "X-Token") != "tok-1" {
		t.Fatalf("memory reset after restart: %q", headerValue(req3.Headers, "X-Token"))
	}
	p := rt2.localStore("stateful.js")
	v, _ := p.get("last-status")
	switch n := v.(type) {
	case float64:
		if n != 202 {
			t.Fatalf("persistent store = %v", v)
		}
	case int64:
		if n != 202 {
			t.Fatalf("persistent store = %v", v)
		}
	default:
		t.Fatalf("persistent store type %T = %v", v, v)
	}
}

// R1 config: schema declared in plugin.config, values validated + persisted,
// injected as ctx.config snapshots; secrets never appear in describe().
func TestConfigLifecycle(t *testing.T) {
	dir := t.TempDir()
	statePath := filepath.Join(t.TempDir(), "state.json")
	src := `plugin = {
	name: "Cfg", version: "1.0",
	config: {
		token: { type: "secret", label: "API token", required: true },
		prefix: { type: "string", default: "Bearer" },
		mode: { type: "select", options: ["test", "live"], default: "test" },
		retries: { type: "number", default: 2 }
	}
};
function onRequest(ctx) {
	ctx.request.headers.push({ name: "Authorization", value: (ctx.config.prefix || "none") + " " + (ctx.config.token || "unset") + "/" + ctx.config.mode + "/" + ctx.config.retries });
}`
	if err := os.WriteFile(filepath.Join(dir, "cfg.js"), []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	rt, err := Open(dir, statePath)
	if err != nil {
		t.Fatal(err)
	}
	p := rt.List()[0]
	if p.Config == nil || p.Config["token"].Type != "secret" || p.Config["mode"].Options[0] != "test" {
		t.Fatalf("schema = %+v", p.Config)
	}

	// defaults injected without any user config
	req := &store.Request{Method: "GET", URL: "http://h/", Headers: []store.Header{}}
	rt.ApplyRequest(req)
	if hv := headerValue(req.Headers, "Authorization"); hv != "Bearer unset/test/2" {
		t.Fatalf("defaults: %q", hv)
	}

	// set user values (secret + select + number)
	if err := rt.SetConfigValues("cfg.js", map[string]any{"token": "SECRET123", "mode": "live", "retries": float64(5)}); err != nil {
		t.Fatal(err)
	}
	req2 := &store.Request{Method: "GET", URL: "http://h/", Headers: []store.Header{}}
	rt.ApplyRequest(req2)
	if hv := headerValue(req2.Headers, "Authorization"); hv != "Bearer SECRET123/live/5" {
		t.Fatalf("configured: %q", hv)
	}

	// secrets never echo values; wrong select rejected
	for _, f := range rt.ConfigFields("cfg.js") {
		if f.Name == "token" {
			if !f.Set || f.Value != nil {
				t.Fatalf("secret describe = %+v (value must not echo)", f)
			}
		}
	}
	if err := rt.SetConfigValues("cfg.js", map[string]any{"mode": "nope"}); err == nil {
		t.Fatal("invalid select accepted")
	}
	if err := rt.SetConfigValues("cfg.js", map[string]any{"unknown": "x"}); err == nil {
		t.Fatal("unknown key accepted")
	}

	// config survives restart
	rt2, err := Open(dir, statePath)
	if err != nil {
		t.Fatal(err)
	}
	req3 := &store.Request{Method: "GET", URL: "http://h/", Headers: []store.Header{}}
	rt2.ApplyRequest(req3)
	if hv := headerValue(req3.Headers, "Authorization"); hv != "Bearer SECRET123/live/5" {
		t.Fatalf("config after restart: %q", hv)
	}
}

// concurrent memory-store increments must not lose updates.
func TestMemoryIncrementConcurrency(t *testing.T) {
	s := newPluginStore()
	done := make(chan struct{}, 50)
	for i := 0; i < 50; i++ {
		go func() {
			s.increment("n", 1)
			done <- struct{}{}
		}()
	}
	for i := 0; i < 50; i++ {
		<-done
	}
	if v, _ := s.get("n"); v != int64(50) {
		t.Fatalf("n = %v, want 50", v)
	}
}

// memory TTL expiry.
func TestMemoryTTL(t *testing.T) {
	s := newPluginStore()
	s.set("k", "v", 30*time.Millisecond)
	if _, ok := s.get("k"); !ok {
		t.Fatal("value gone before TTL")
	}
	time.Sleep(60 * time.Millisecond)
	if _, ok := s.get("k"); ok {
		t.Fatal("value survived TTL")
	}
}
