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
