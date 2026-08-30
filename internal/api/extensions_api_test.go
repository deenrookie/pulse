package api_test

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pulse/internal/plugins"
	"pulse/internal/rewrite"
	"pulse/internal/store"
)

func TestRewriteCRUDAndEffect(t *testing.T) {
	e := newEnv(t)
	var sawUA string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawUA = r.Header.Get("User-Agent")
		w.Write([]byte("body-ok"))
	}))
	defer up.Close()

	// create a rule via API
	resp, data := e.do(t, "POST", "/api/rewrite", map[string]any{
		"enabled": true, "zone": "request_header",
		"match": "curl", "replace": "pulse-agent", "regex": false,
	})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create = %d %s", resp.StatusCode, data)
	}
	var rule rewrite.Rule
	json.Unmarshal(data, &rule)
	if rule.ID == "" {
		t.Fatal("rule id missing")
	}

	// it takes effect on proxied traffic
	client := proxiedClient(e.proxyAddr)
	req, _ := http.NewRequest("GET", up.URL+"/rw", nil)
	req.Header.Set("User-Agent", "curl/7.87")
	if _, err := client.Do(req); err != nil {
		t.Fatalf("proxied get: %v", err)
	}
	if sawUA != "pulse-agent/7.87" {
		t.Fatalf("upstream UA = %q", sawUA)
	}

	// list + update (disable) + delete
	_, data = e.do(t, "GET", "/api/rewrite", nil)
	var list struct {
		Rules []rewrite.Rule `json:"rules"`
	}
	json.Unmarshal(data, &list)
	if len(list.Rules) != 1 || list.Rules[0].Hits < 1 {
		t.Fatalf("rules = %+v", list.Rules)
	}
	resp, _ = e.do(t, "PUT", "/api/rewrite/"+rule.ID, map[string]any{
		"enabled": false, "zone": "request_header", "match": "curl", "replace": "x",
	})
	if resp.StatusCode != 200 {
		t.Fatalf("update = %d", resp.StatusCode)
	}
	resp, _ = e.do(t, "DELETE", "/api/rewrite/"+rule.ID, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("delete = %d", resp.StatusCode)
	}
	resp, _ = e.do(t, "DELETE", "/api/rewrite/"+rule.ID, nil)
	if resp.StatusCode != 404 {
		t.Fatalf("second delete = %d", resp.StatusCode)
	}
}

func TestPluginsAPIAndLiveEffect(t *testing.T) {
	e := newEnv(t)
	var sawHeader string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawHeader = r.Header.Get("X-Live-Plugin")
		w.Write([]byte("pluggable"))
	}))
	defer up.Close()

	// write a plugin into the runtime's directory, then reload via API
	dir := filepath.Join(e.dir, "plugins")
	src := `plugin = { name: "Live", version: "0.1" };
	function onRequest(ctx) { ctx.request.headers.push({ name: "X-Live-Plugin", value: "yes" }); }`
	if err := os.WriteFile(filepath.Join(dir, "live.js"), []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	resp, data := e.do(t, "POST", "/api/plugins/reload", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("reload = %d %s", resp.StatusCode, data)
	}
	var reloaded struct {
		Plugins []plugins.Plugin `json:"plugins"`
	}
	json.Unmarshal(data, &reloaded)
	if len(reloaded.Plugins) != 1 || reloaded.Plugins[0].Name != "Live" {
		t.Fatalf("plugins after reload = %+v", reloaded.Plugins)
	}

	if _, err := proxiedClient(e.proxyAddr).Get(up.URL+"/p"); err != nil {
		t.Fatalf("proxied get: %v", err)
	}
	if sawHeader != "yes" {
		t.Fatalf("live plugin header not seen: %q", sawHeader)
	}

	// disable → effect gone
	e.do(t, "PUT", "/api/plugins/live.js", map[string]bool{"enabled": false})
	if _, err := proxiedClient(e.proxyAddr).Get(up.URL+"/p2"); err != nil {
		t.Fatalf("proxied get 2: %v", err)
	}
	if sawHeader != "" {
		t.Fatalf("disabled plugin still applied: %q", sawHeader)
	}
}

func TestPluginEditorAPI(t *testing.T) {
	e := newEnv(t)
	var sawHeader string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawHeader = r.Header.Get("X-Editor-Plugin")
		w.Write([]byte("ok"))
	}))
	defer up.Close()

	// validate: good source reports hooks; bad source reports the error
	good := `plugin = { name: "Ed", version: "2.0" };
function onRequest(ctx) { ctx.request.headers.push({ name: "X-Editor-Plugin", value: "on" }); pulse.log("hi " + ctx.request.method); }`
	resp, data := e.do(t, "POST", "/api/plugins/validate", map[string]any{"src": good})
	if resp.StatusCode != 200 {
		t.Fatalf("validate good = %d %s", resp.StatusCode, data)
	}
	var insp plugins.Inspection
	json.Unmarshal(data, &insp)
	if insp.Error != "" || insp.Name != "Ed" || len(insp.Hooks) != 1 || insp.Hooks[0] != "request" {
		t.Fatalf("validate good = %+v", insp)
	}
	_, data = e.do(t, "POST", "/api/plugins/validate", map[string]any{"src": "function ("})
	json.Unmarshal(data, &insp)
	if insp.Error == "" {
		t.Fatalf("validate bad src should error, got %+v", insp)
	}

	// write via API → plugin live on proxied traffic, source readable back
	resp, data = e.do(t, "PUT", "/api/plugins/source/edited.js", map[string]any{"src": good})
	if resp.StatusCode != 200 {
		t.Fatalf("save = %d %s", resp.StatusCode, data)
	}
	var saved struct {
		Error   string          `json:"error"`
		Plugins []plugins.Plugin `json:"plugins"`
	}
	json.Unmarshal(data, &saved)
	if saved.Error != "" || len(saved.Plugins) != 1 {
		t.Fatalf("save result error=%q plugins=%+v", saved.Error, saved.Plugins)
	}
	_, data = e.do(t, "GET", "/api/plugins/source/edited.js", nil)
	var got struct {
		Src string `json:"src"`
	}
	json.Unmarshal(data, &got)
	if got.Src != good {
		t.Fatalf("source round-trip failed: %q", got.Src)
	}
	if _, err := proxiedClient(e.proxyAddr).Get(up.URL + "/e"); err != nil {
		t.Fatalf("proxied get: %v", err)
	}
	if sawHeader != "on" {
		t.Fatalf("edited plugin not applied: %q", sawHeader)
	}

	// writing broken source succeeds on disk but surfaces the compile error
	resp, data = e.do(t, "PUT", "/api/plugins/source/edited.js", map[string]any{"src": "function ("})
	if resp.StatusCode != 200 {
		t.Fatalf("save broken = %d %s", resp.StatusCode, data)
	}
	json.Unmarshal(data, &saved)
	if saved.Error == "" {
		t.Fatal("broken source should report a compile error")
	}

	// invalid file names are rejected
	resp, _ = e.do(t, "PUT", "/api/plugins/source/..%2Fescape.js", map[string]any{"src": "x"})
	if resp.StatusCode == 200 {
		t.Fatal("path traversal should be rejected")
	}

	// delete → gone
	resp, _ = e.do(t, "DELETE", "/api/plugins/source/edited.js", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("delete = %d", resp.StatusCode)
	}
	resp, _ = e.do(t, "GET", "/api/plugins/source/edited.js", nil)
	if resp.StatusCode != 404 {
		t.Fatalf("get after delete = %d", resp.StatusCode)
	}
}

func TestPluginTestRun(t *testing.T) {
	e := newEnv(t)
	src := `function onRequest(ctx) {
  ctx.request.headers.push({ name: "X-Test", value: "1" });
  pulse.log("url=" + ctx.request.url);
  pulse.log("missing=" + ctx.request.nope.deep); // throws
}`
	resp, data := e.do(t, "POST", "/api/plugins/test", map[string]any{
		"src": src, "hook": "request",
		"request": map[string]any{
			"method": "GET", "url": "http://example.com/x",
			"headers": []map[string]string{{"name": "Host", "value": "example.com"}},
			"body":    "",
		},
	})
	if resp.StatusCode != 200 {
		t.Fatalf("test = %d %s", resp.StatusCode, data)
	}
	var out struct {
		Logs    []string `json:"logs"`
		Error   string   `json:"error"`
		Changed bool     `json:"changed"`
		Request struct {
			Headers []store.Header `json:"headers"`
		} `json:"request"`
	}
	json.Unmarshal(data, &out)
	if len(out.Logs) != 1 || out.Logs[0] != "url=http://example.com/x" {
		t.Fatalf("logs = %+v", out.Logs)
	}
	if out.Error == "" {
		t.Fatal("runtime error should be reported")
	}
	if out.Changed {
		t.Fatal("throwing hook must not count as changed")
	}

	// happy path: response hook sees and rewrites the body
	src2 := `function onResponse(ctx) {
  ctx.response.body = ctx.response.body.replace("secret", "[REDACTED]");
  pulse.log("redacted");
}`
	_, data = e.do(t, "POST", "/api/plugins/test", map[string]any{
		"src": src2, "hook": "response",
		"request":  map[string]any{"method": "GET", "url": "http://example.com/x"},
		"response": map[string]any{"status": 200, "body": "a secret here"},
	})
	json.Unmarshal(data, &out)
	if out.Error != "" || !out.Changed {
		t.Fatalf("response test error=%q changed=%v logs=%v", out.Error, out.Changed, out.Logs)
	}
	var out2 struct {
		Response struct {
			Body string `json:"body"`
		} `json:"response"`
		Logs []string `json:"logs"`
	}
	json.Unmarshal(data, &out2)
	if out2.Response.Body != "a [REDACTED] here" || len(out2.Logs) != 1 {
		t.Fatalf("response body = %q logs = %v", out2.Response.Body, out2.Logs)
	}
}

func TestPluginsDirChange(t *testing.T) {
	e := newEnv(t)

	// change the directory via settings
	newDir := filepath.Join(e.dir, "custom-plugins")
	resp, data := e.do(t, "PUT", "/api/settings", map[string]any{"pluginsDir": newDir})
	if resp.StatusCode != 200 {
		t.Fatalf("set dir = %d %s", resp.StatusCode, data)
	}
	var set struct {
		PluginsDir string `json:"pluginsDir"`
	}
	json.Unmarshal(data, &set)
	if set.PluginsDir != newDir {
		t.Fatalf("pluginsDir = %q", set.PluginsDir)
	}
	if _, err := os.Stat(newDir); err != nil {
		t.Fatalf("new dir not created: %v", err)
	}

	// a plugin written there goes live
	src := `function onRequest(ctx) { ctx.request.headers.push({ name: "X-Dir", value: "custom" }); }`
	resp, _ = e.do(t, "PUT", "/api/plugins/source/in-new-dir.js", map[string]any{"src": src})
	if resp.StatusCode != 200 {
		t.Fatalf("write to new dir = %d", resp.StatusCode)
	}
	_, data = e.do(t, "GET", "/api/plugins", nil)
	var list struct {
		Dir     string          `json:"dir"`
		Plugins []plugins.Plugin `json:"plugins"`
	}
	json.Unmarshal(data, &list)
	if list.Dir != newDir || len(list.Plugins) != 1 || list.Plugins[0].File != "in-new-dir.js" {
		t.Fatalf("after dir change: dir=%q plugins=%+v", list.Dir, list.Plugins)
	}

	// the setting survives a settings GET (live value) and an unwritable path
	// is rejected without being persisted
	_, data = e.do(t, "GET", "/api/settings", nil)
	var cur struct {
		PluginsDir string `json:"pluginsDir"`
	}
	json.Unmarshal(data, &cur)
	if cur.PluginsDir != newDir {
		t.Fatalf("settings pluginsDir = %q", cur.PluginsDir)
	}
	bad := filepath.Join(e.dir, "file.txt", "sub") // a file blocks MkdirAll
	os.WriteFile(filepath.Join(e.dir, "file.txt"), []byte("x"), 0o644)
	resp, data = e.do(t, "PUT", "/api/settings", map[string]any{"pluginsDir": bad})
	if resp.StatusCode != 400 {
		t.Fatalf("bad dir should 400, got %d %s", resp.StatusCode, data)
	}
	_, data = e.do(t, "GET", "/api/settings", nil)
	json.Unmarshal(data, &cur)
	if cur.PluginsDir != newDir {
		t.Fatalf("bad dir persisted: %q", cur.PluginsDir)
	}
}

func TestFlowRenderEndpoint(t *testing.T) {
	e := newEnv(t)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, "<h1>rendered</h1>")
	}))
	defer up.Close()
	if _, err := proxiedClient(e.proxyAddr).Get(up.URL+"/page"); err != nil {
		t.Fatal(err)
	}
	if !waitFlows(t, e, 1) {
		t.Fatal("flow never appeared")
	}
	_, data := e.do(t, "GET", "/api/flows", nil)
	var list struct {
		Items []store.FlowMeta `json:"items"`
	}
	json.Unmarshal(data, &list)
	id := list.Items[len(list.Items)-1].ID

	resp, err := http.Get(e.ts.URL + "/api/flows/" + id + "/render")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("content-type = %s", ct)
	}
	if string(body) != "<h1>rendered</h1>" {
		t.Fatalf("body = %s", body)
	}
}
