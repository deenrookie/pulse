package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"pulse/internal/plugins"
	"pulse/internal/rewrite"
	"pulse/internal/store"
)

// TestExtensionsPipeline verifies the documented order plugins → rewrite on
// both directions: the upstream must observe every request mutation, and the
// client must observe response mutations.
func TestExtensionsPipeline(t *testing.T) {
	dir := t.TempDir()
	pluginSrc := `
plugin = { name: "Pipeline Test", version: "1.0" };
function onRequest(ctx) {
  ctx.request.headers.push({ name: "X-Plugin", value: "on" });
  ctx.request.body = ctx.request.body + "+plugin";
}
function onResponse(ctx) {
  if (ctx.response.body.indexOf("upstream-body") >= 0) {
    ctx.response.body = ctx.response.body + "+plugin";
  }
}
`
	plugDir := filepath.Join(dir, "plugins")
	os.MkdirAll(plugDir, 0o755)
	if err := os.WriteFile(filepath.Join(plugDir, "pipe.js"), []byte(pluginSrc), 0o644); err != nil {
		t.Fatal(err)
	}
	plug, err := plugins.Open(plugDir, filepath.Join(dir, "plugins.json"))
	if err != nil {
		t.Fatal(err)
	}
	rw, err := rewrite.Open(filepath.Join(dir, "mr.json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rw.Add(rewrite.Rule{
		Enabled: true, Zone: rewrite.ZoneRequestBody, Match: "orig", Replace: "rewritten",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := rw.Add(rewrite.Rule{
		Enabled: true, Zone: rewrite.ZoneRespBody, Match: "upstream-body", Replace: "upstream-body+rule",
	}); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var gotPath, gotBody, gotPluginHeader string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		gotPath, gotBody, gotPluginHeader = r.URL.Path, string(b), r.Header.Get("X-Plugin")
		mu.Unlock()
		w.Write([]byte("upstream-body"))
	}))
	defer up.Close()

	eng, st, addr := newTestEngine(t, plug, rw)
	_ = eng

	client := proxiedClient(addr, nil)
	resp, err := client.Post(up.URL+"/api/orig", "text/plain", strings.NewReader("orig"))
	if err != nil {
		t.Fatalf("post via proxy: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	// upstream observed plugin + rewrite (rewrite ran last on the body)
	mu.Lock()
	path, reqBody, pluginHeader := gotPath, gotBody, gotPluginHeader
	mu.Unlock()
	if path != "/api/orig" {
		t.Fatalf("path = %s", path)
	}
	if pluginHeader != "on" {
		t.Fatalf("plugin header not seen upstream: %q", pluginHeader)
	}
	if reqBody != "rewritten+plugin" {
		t.Fatalf("upstream body = %q (want rewritten+plugin: rewrite replaced orig, plugin appended)", reqBody)
	}

	// client observed plugin + rewrite on the response (plugin ran first, rule second)
	if string(body) != "upstream-body+rule+plugin" {
		t.Fatalf("client body = %q", body)
	}

	// history records the final sent/received messages
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		fl := latestFlow(t, st)
		if fl != nil && fl.State == store.StateComplete {
			if string(fl.Req.Body) != "rewritten+plugin" {
				t.Fatalf("stored request body = %q", fl.Req.Body)
			}
			if string(fl.Resp.Body) != "upstream-body+rule+plugin" {
				t.Fatalf("stored response body = %q", fl.Resp.Body)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("flow never completed")
}
