package api_test

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"pulse/internal/api"
	"pulse/internal/plugins"
	"pulse/internal/store"
)

func shareFixture(t *testing.T, e *testEnv) string {
	t.Helper()
	id := e.st.NewID()
	err := e.st.Add(&store.Flow{ID: id, State: store.StateComplete, Error: "private failure detail",
		Req: store.Request{ID: id, Method: "POST", URL: "https://user:password@api.test/v1?q=secret&token=private#hidden", HTTPVersion: "HTTP/1.1",
			Headers: []store.Header{{Name: "Authorization", Value: "Bearer secret"}, {Name: "x-Custom-Credential", Value: "private"}, {Name: "Content-Type", Value: "application/json"}}, Body: []byte("private-request")},
		Resp:       &store.Response{StatusCode: 200, Headers: []store.Header{{Name: "Set-Cookie", Value: "secret-cookie"}}, Body: []byte("<script>alert('secret')</script>")},
		WSMessages: []store.WSMessage{{Data: []byte("secret-websocket")}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func createTestShare(t *testing.T, e *testEnv, id string, bodies bool) map[string]any {
	t.Helper()
	r, data := e.do(t, "POST", "/api/shares", map[string]any{"flowId": id, "includeBodies": bodies, "ttlMinutes": 1})
	if r.StatusCode != 201 {
		t.Fatalf("create: %d %s", r.StatusCode, data)
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { e.do(t, "DELETE", "/api/shares/"+out["id"].(string), nil) })
	return out
}

func TestShareCompleteSnapshotAndRevocation(t *testing.T) {
	e := newEnv(t)
	id := shareFixture(t, e)
	e.do(t, "PUT", "/api/settings", map[string]any{"shareIP": "127.0.0.1"})
	fl, _ := e.st.Get(id)
	fl.Req.Body = []byte{0, 255, 1, 13, 10}
	fl.Req.Headers = append(fl.Req.Headers, store.Header{Name: "Cookie", Value: "token=original"}, store.Header{Name: "X-Dup", Value: "first"}, store.Header{Name: "X-Dup", Value: "second"})
	e.st.Update(fl)
	share := createTestShare(t, e, id, false)
	path := "/share/" + share["id"].(string)
	r, data := e.do(t, "GET", path+"/data", nil)
	var out struct{ Flow store.Flow }
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	if r.StatusCode != 200 || !reflect.DeepEqual(&out.Flow, fl) {
		t.Fatalf("snapshot changed original: %d %s", r.StatusCode, data)
	}
	if r.Header.Get("Cache-Control") != "no-store" || r.Header.Get("Referrer-Policy") != "no-referrer" {
		t.Fatal("missing response protections")
	}
	r, _ = e.do(t, "GET", path, nil)
	if r.StatusCode != 200 || strings.Contains(r.Header.Get("Content-Security-Policy"), "script-src 'unsafe-inline'") {
		t.Fatal("invalid public shell")
	}
	r, _ = e.do(t, "GET", path+"/data?download", nil)
	if !strings.Contains(r.Header.Get("Content-Disposition"), "attachment") {
		t.Fatal("missing download")
	}
	if !strings.HasPrefix(share["url"].(string), e.ts.URL+"/share/") {
		t.Fatal("wrong share host")
	}
	original, _ := e.st.Get(id)
	if !reflect.DeepEqual(original, fl) {
		t.Fatal("original changed")
	}
	e.st.Delete(id)
	r, _ = e.do(t, "GET", path+"/data", nil)
	if r.StatusCode != 200 {
		t.Fatal("share depended on live flow")
	}
	e.do(t, "DELETE", "/api/shares/"+share["id"].(string), nil)
	for _, suffix := range []string{"", "/data", "/data?download"} {
		r, _ = e.do(t, "GET", path+suffix, nil)
		if r.StatusCode != 404 {
			t.Fatal("revoked accessible", suffix)
		}
	}
	for _, method := range []string{"POST", "PUT", "DELETE"} {
		r, _ = e.do(t, method, path+"/data", nil)
		if r.StatusCode != 405 {
			t.Fatal("public write accepted")
		}
	}
}

func TestShareSettingsAndLimits(t *testing.T) {
	e := newEnv(t)
	id := shareFixture(t, e)
	r, _ := e.do(t, "POST", "/api/shares", map[string]any{"flowId": id})
	if r.StatusCode != 400 {
		t.Fatal("share allowed before configuration")
	}
	for _, ip := range []string{"0.0.0.0", "::", "http://127.0.0.1:8787", "evil.test", "224.0.0.1", "255.255.255.255"} {
		r, _ = e.do(t, "PUT", "/api/settings", map[string]any{"shareIP": ip})
		if r.StatusCode != 400 {
			t.Fatal("bad IP accepted", ip)
		}
	}
	e.do(t, "PUT", "/api/settings", map[string]any{"shareIP": "192.0.2.1"})
	r, _ = e.do(t, "POST", "/api/shares", map[string]any{"flowId": id})
	if r.StatusCode != 400 {
		t.Fatal("unreachable loopback listener accepted")
	}
	e.do(t, "PUT", "/api/settings", map[string]any{"shareIP": "127.0.0.1"})
	r, _ = e.do(t, "PUT", "/api/settings", map[string]any{"shareIP": "192.0.2.2", "responseTimeoutSec": -1})
	if r.StatusCode != 400 {
		t.Fatal("invalid settings accepted")
	}
	saved, err := api.LoadSettings(e.dir)
	if err != nil || saved.ShareIP != "127.0.0.1" {
		t.Fatal("share IP persistence mismatch", err)
	}
	for _, ttl := range []int{-1, 525601} {
		r, _ = e.do(t, "POST", "/api/shares", map[string]any{"flowId": id, "ttlMinutes": ttl})
		if r.StatusCode != 400 {
			t.Fatal("invalid TTL accepted")
		}
	}
	r, _ = e.do(t, "POST", "/api/shares", map[string]any{"flowId": "missing"})
	if r.StatusCode != 400 {
		t.Fatal("missing flow accepted")
	}
	fl, _ := e.st.Get(id)
	fl.State = store.StatePending
	fl.Resp = nil
	e.st.Update(fl)
	r, data := e.do(t, "POST", "/api/shares", map[string]any{"flowId": id})
	if r.StatusCode != 201 {
		t.Fatal("request-only pending flow rejected")
	}
	var requestOnly map[string]any
	json.Unmarshal(data, &requestOnly)
	_, data = e.do(t, "GET", "/share/"+requestOnly["id"].(string)+"/data", nil)
	var requestOnlyPayload struct{ Flow store.Flow }
	json.Unmarshal(data, &requestOnlyPayload)
	if requestOnlyPayload.Flow.Resp != nil || requestOnlyPayload.Flow.Req.URL != fl.Req.URL {
		t.Fatal("request-only share changed request or invented a response")
	}
	e.do(t, "DELETE", "/api/shares/"+requestOnly["id"].(string), nil)
	fl.State = store.StateComplete
	fl.Req.Body = bytes.Repeat([]byte("a"), 3<<20)
	e.st.Update(fl)
	share := createTestShare(t, e, id, true)
	r, data = e.do(t, "GET", "/share/"+share["id"].(string)+"/data", nil)
	var out struct{ Flow store.Flow }
	json.Unmarshal(data, &out)
	if r.StatusCode != 200 || !bytes.Equal(out.Flow.Req.Body, fl.Req.Body) {
		t.Fatal("large body filtered")
	}
	fl.Req.Body = []byte("small")
	e.st.Update(fl)
	for i := 0; i < 40; i++ {
		createTestShare(t, e, id, false)
	}
	r, data = e.do(t, "POST", "/api/shares", map[string]any{"flowId": id, "ttlMinutes": 525600})
	if r.StatusCode != 201 {
		t.Fatalf("year share rejected: %d %s", r.StatusCode, data)
	}
	var long map[string]any
	json.Unmarshal(data, &long)
	expires, _ := time.Parse(time.RFC3339Nano, long["expiresAt"].(string))
	if time.Until(expires) < 364*24*time.Hour {
		t.Fatal("long expiry shortened")
	}
	e.do(t, "DELETE", "/api/shares/"+long["id"].(string), nil)
}

func TestShareControlAccessAndSkillDownload(t *testing.T) {
	t.Setenv("PULSE_KEY", "control-key")
	e := newEnv(t)
	id := shareFixture(t, e)
	e.do(t, "PUT", "/api/settings", map[string]any{"shareIP": "127.0.0.1"})
	share := createTestShare(t, e, id, false)
	serve := func(method, path, key string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, nil)
		req.RemoteAddr = "192.0.2.3:4567"
		req.Host = strings.TrimPrefix(e.ts.URL, "http://")
		if key != "" {
			req.Header.Set("X-Pulse-Key", key)
		}
		w := httptest.NewRecorder()
		e.ts.Config.Handler.ServeHTTP(w, req)
		return w
	}
	for _, path := range []string{"/api/shares", "/api/settings", "/api/flows", "/api/plugins/skill", "/api/plugins/skill/download"} {
		if w := serve("GET", path, share["id"].(string)); w.Code != 401 {
			t.Fatal("share grants control", path, w.Code)
		}
	}
	if w := serve("DELETE", "/api/shares/"+share["id"].(string), ""); w.Code != 401 {
		t.Fatal("unauthorized revoke")
	}
	if w := serve("GET", "/share/"+share["id"].(string), ""); w.Code != 200 {
		t.Fatal("public share not accessible", w.Code)
	}
	if w := serve("GET", "/api/shares", "control-key"); w.Code != 200 {
		t.Fatal("keyed owner denied")
	}
	r, data := e.do(t, "GET", "/api/plugins/skill/download", nil)
	if r.StatusCode != 200 || r.Header.Get("Content-Type") != "application/zip" {
		t.Fatal("download failed")
	}
	z, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{}
	for _, f := range z.File {
		rd, _ := f.Open()
		b, _ := io.ReadAll(rd)
		rd.Close()
		files[f.Name] = string(b)
	}
	if files["pulse-plugin-dev/SKILL.md"] != plugins.PluginSkill() || files["pulse-plugin-dev/assets/pulse.d.ts"] != plugins.SDKDTS() {
		t.Fatal("kit differs from runtime")
	}
	for _, name := range []string{"scripts/check_plugin.py", "assets/scoped-header.js", "assets/header-fixture.json", "assets/unrelated-fixture.json", "agents/openai.yaml"} {
		if files["pulse-plugin-dev/"+name] == "" {
			t.Fatal("missing kit file", name)
		}
	}
	src := files["pulse-plugin-dev/assets/scoped-header.js"]
	for _, fx := range []string{"header-fixture.json", "unrelated-fixture.json"} {
		var payload map[string]any
		json.Unmarshal([]byte(files["pulse-plugin-dev/assets/"+fx]), &payload)
		payload["src"] = src
		_, data = e.do(t, "POST", "/api/plugins/test", payload)
		var out map[string]any
		json.Unmarshal(data, &out)
		if out["error"] != "" || out["changed"] != (fx == "header-fixture.json") {
			t.Fatalf("kit runtime mismatch: %s", data)
		}
	}
}

func TestShareParallelCreation(t *testing.T) {
	e := newEnv(t)
	id := shareFixture(t, e)
	e.do(t, "PUT", "/api/settings", map[string]any{"shareIP": "127.0.0.1"})
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); createTestShare(t, e, id, false) }()
	}
	wg.Wait()
	_, data := e.do(t, "GET", "/api/shares", nil)
	var out struct{ Shares []map[string]any }
	json.Unmarshal(data, &out)
	seen := map[string]bool{}
	for _, s := range out.Shares {
		seen[s["id"].(string)] = true
	}
	if len(seen) != 16 {
		t.Fatal("concurrent shares lost or reused tokens")
	}
}

func TestShareSettingsWriteFailure(t *testing.T) {
	e := newEnv(t)
	e.do(t, "PUT", "/api/settings", map[string]any{"shareIP": "127.0.0.1"})
	if err := os.Mkdir(filepath.Join(e.dir, "settings.json.tmp"), 0700); err != nil {
		t.Fatal(err)
	}
	r, _ := e.do(t, "PUT", "/api/settings", map[string]any{"shareIP": "192.0.2.1"})
	if r.StatusCode != 500 {
		t.Fatal("save failure hidden")
	}
	_, data := e.do(t, "GET", "/api/settings", nil)
	var settings api.Settings
	json.Unmarshal(data, &settings)
	if settings.ShareIP != "127.0.0.1" {
		t.Fatal("failed save changed share IP")
	}
}

func TestShareWriteFailureDoesNotPublish(t *testing.T) {
	e := newEnv(t)
	id := shareFixture(t, e)
	e.do(t, "PUT", "/api/settings", map[string]any{"shareIP": "127.0.0.1"})
	dir := filepath.Join(e.dir, "shares")
	if err := os.Remove(dir); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dir, []byte("blocks directory"), 0600); err != nil {
		t.Fatal(err)
	}
	r, _ := e.do(t, "POST", "/api/shares", map[string]any{"flowId": id})
	if r.StatusCode != 500 {
		t.Fatal("write failure hidden")
	}
	_, data := e.do(t, "GET", "/api/shares", nil)
	if !strings.Contains(string(data), "[]") {
		t.Fatal("failed share published")
	}
}

func TestRepeaterSharePairsSentRequest(t *testing.T) {
	e := newEnv(t)
	e.do(t, "PUT", "/api/settings", map[string]any{"shareIP": "127.0.0.1"})
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(r.URL.Path)) }))
	defer up.Close()
	_, data := e.do(t, "POST", "/api/repeater", map[string]any{"request": map[string]any{"method": "GET", "url": up.URL + "/first"}})
	var tab struct{ ID string }
	json.Unmarshal(data, &tab)
	e.do(t, "POST", "/api/repeater/"+tab.ID+"/send", nil)
	e.do(t, "POST", "/api/repeater/"+tab.ID+"/send", map[string]any{"request": map[string]any{"method": "GET", "url": up.URL + "/second"}})
	e.do(t, "PUT", "/api/repeater/"+tab.ID, map[string]any{"request": map[string]any{"method": "GET", "url": up.URL + "/unsent"}})
	saved, _ := e.rep.Get(tab.ID)
	e.st.Clear()
	// No history timestamp means share the currently saved request. It may
	// have never been sent, so the snapshot must not invent a response.
	r, data := e.do(t, "POST", "/api/shares", map[string]any{"repeaterId": tab.ID})
	if r.StatusCode != 201 {
		t.Fatalf("share unsent repeater request: %d %s", r.StatusCode, data)
	}
	var unsentMeta map[string]any
	json.Unmarshal(data, &unsentMeta)
	_, data = e.do(t, "GET", "/share/"+unsentMeta["id"].(string)+"/data", nil)
	var unsent struct{ Flow store.Flow }
	json.Unmarshal(data, &unsent)
	if unsent.Flow.Req.URL != up.URL+"/unsent" || unsent.Flow.Resp != nil {
		t.Fatal("unsent Repeater share was paired with a response", string(data))
	}
	e.do(t, "DELETE", "/api/shares/"+unsentMeta["id"].(string), nil)
	for i, suffix := range []string{"/first", "/second"} {
		r, data := e.do(t, "POST", "/api/shares", map[string]any{"repeaterId": tab.ID, "historyAt": saved.History[i].At.Format(time.RFC3339Nano)})
		if r.StatusCode != 201 {
			t.Fatalf("share repeater: %d %s", r.StatusCode, data)
		}
		var meta map[string]any
		json.Unmarshal(data, &meta)
		_, data = e.do(t, "GET", "/share/"+meta["id"].(string)+"/data", nil)
		var out struct{ Flow store.Flow }
		json.Unmarshal(data, &out)
		if out.Flow.Req.URL != up.URL+suffix || string(out.Flow.Resp.Body) != suffix {
			t.Fatal("request/response pairing wrong", string(data))
		}
		e.do(t, "DELETE", "/api/shares/"+meta["id"].(string), nil)
	}
}
