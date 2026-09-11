package api_test

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pulse/internal/api"
	"pulse/internal/certs"
	"pulse/internal/events"
	"pulse/internal/plugins"
	"pulse/internal/proxy"
	"pulse/internal/repeater"
	"pulse/internal/rewrite"
	"pulse/internal/store"
)

type testEnv struct {
	ts      *httptest.Server
	st      *store.Store
	eng     *proxy.Engine
	rep     *repeater.Manager
	proxyAddr string
	dir     string
}

func newEnv(t *testing.T) *testEnv {
	t.Helper()
	dir := t.TempDir()
	auth, err := certs.LoadOrCreate(dir)
	if err != nil {
		t.Fatalf("certs: %v", err)
	}
	st, err := store.Open(filepath.Join(dir, "flows.jsonl"))
	if err != nil {
		t.Fatalf("store: %v", err)
	}
	rep, err := repeater.Open(filepath.Join(dir, "repeater.json"))
	if err != nil {
		t.Fatalf("repeater: %v", err)
	}
	bus := events.NewBus()
	rw, err := rewrite.Open(filepath.Join(dir, "match-replace.json"))
	if err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	plug, err := plugins.Open(filepath.Join(dir, "plugins"), filepath.Join(dir, "plugins.json"))
	if err != nil {
		t.Fatalf("plugins: %v", err)
	}
	eng := proxy.New(auth, st, bus, plug, rw, "test")

	pln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("proxy listen: %v", err)
	}
	go eng.Serve(pln)

	uln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("ui listen: %v", err)
	}
	uiAddr := uln.Addr().String()
	apiSrv, err := api.New(st, eng, rep, auth, bus, rw, plug, "test", pln.Addr().String(), uiAddr, dir)
	if err != nil {
		t.Fatalf("api.New: %v", err)
	}
	ts := httptest.NewUnstartedServer(apiSrv.Handler())
	ts.Listener = uln
	ts.Start()

	t.Cleanup(func() {
		ts.Close()
		eng.Close()
		st.Close()
	})
	return &testEnv{ts: ts, st: st, eng: eng, rep: rep, proxyAddr: pln.Addr().String(), dir: dir}
}

func (e *testEnv) do(t *testing.T, method, path string, body any) (*http.Response, []byte) {
	t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, e.ts.URL+path, rd)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp, data
}

func proxiedClient(proxyAddr string) *http.Client {
	u, _ := url.Parse("http://" + proxyAddr)
	return &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(u)}, Timeout: 10 * time.Second}
}

func waitFlows(t *testing.T, e *testEnv, n int) bool {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		var out struct {
			Items []store.FlowMeta `json:"items"`
		}
		_, data := e.do(t, "GET", "/api/flows", nil)
		json.Unmarshal(data, &out)
		if len(out.Items) >= n {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

func TestHealthAndStatus(t *testing.T) {
	e := newEnv(t)
	resp, data := e.do(t, "GET", "/api/health", nil)
	if resp.StatusCode != 200 || !strings.Contains(string(data), `"ok":true`) {
		t.Fatalf("health = %d %s", resp.StatusCode, data)
	}
	resp, data = e.do(t, "GET", "/api/status", nil)
	if resp.StatusCode != 200 || !strings.Contains(string(data), `"proxyAddr":"`+e.proxyAddr+`"`) {
		t.Fatalf("status = %d %s", resp.StatusCode, data)
	}
	if !strings.Contains(string(data), "caFingerprint") {
		t.Fatalf("status missing CA fingerprint: %s", data)
	}
}

func TestHostHeaderValidation(t *testing.T) {
	e := newEnv(t)
	req, _ := http.NewRequest("GET", e.ts.URL+"/api/health", nil)
	req.Host = "evil.example:" + portOf(e.ts.URL)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("unexpected host accepted: %d", resp.StatusCode)
	}
}

func TestFlowsListDetailAndDelete(t *testing.T) {
	e := newEnv(t)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "hi %s", r.URL.Path)
	}))
	defer up.Close()

	if _, err := proxiedClient(e.proxyAddr).Get(up.URL + "/one"); err != nil {
		t.Fatalf("proxied get: %v", err)
	}
	if !waitFlows(t, e, 1) {
		t.Fatal("flow never appeared")
	}

	_, data := e.do(t, "GET", "/api/flows?q=one", nil)
	var list struct {
		Total int              `json:"total"`
		Items []store.FlowMeta `json:"items"`
	}
	json.Unmarshal(data, &list)
	if list.Total != 1 || len(list.Items) != 1 {
		t.Fatalf("list = %+v", list)
	}
	if list.Items[0].Host == "" || list.Items[0].Path != "/one" {
		t.Fatalf("meta = %+v", list.Items[0])
	}
	id := list.Items[0].ID

	_, data = e.do(t, "GET", "/api/flows/"+id, nil)
	var fl store.Flow
	json.Unmarshal(data, &fl)
	if fl.ID != id || fl.Req.Method != "GET" {
		t.Fatalf("detail = %+v", fl)
	}
	if fl.Resp == nil || !strings.Contains(string(fl.Resp.Body), "hi /one") {
		t.Fatalf("detail response = %+v", fl.Resp)
	}

	resp, _ := e.do(t, "DELETE", "/api/flows/"+id, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("delete = %d", resp.StatusCode)
	}
	_, data = e.do(t, "GET", "/api/flows", nil)
	json.Unmarshal(data, &list)
	if len(list.Items) != 0 {
		t.Fatalf("after delete items = %d", len(list.Items))
	}
}

func TestSSEEvents(t *testing.T) {
	e := newEnv(t)
	// client timeout bounds the whole stream so a missing event fails fast
	client := &http.Client{Timeout: 6 * time.Second}
	resp, err := client.Get(e.ts.URL + "/api/events")
	if err != nil {
		t.Fatalf("sse connect: %v", err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Fatalf("content-type = %s", ct)
	}

	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer up.Close()
	go proxiedClient(e.proxyAddr).Get(up.URL + "/sse")

	eventsSeen := map[string]bool{}
	br := bufio.NewReader(resp.Body)
	for !eventsSeen["flow"] {
		name, data, err := readSSE(br)
		if err != nil {
			break // stream ended (timeout) before seeing everything
		}
		eventsSeen[name] = true
		if name == "hello" && !strings.Contains(data, "interceptEnabled") {
			t.Fatalf("hello payload = %s", data)
		}
	}
	if !eventsSeen["hello"] || !eventsSeen["flow"] {
		t.Fatalf("events seen = %v", eventsSeen)
	}
}

func TestInterceptAPIForwardWithModification(t *testing.T) {
	e := newEnv(t)
	var gotBody string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(200)
	}))
	defer up.Close()

	resp, data := e.do(t, "PUT", "/api/intercept", map[string]bool{"enabled": true})
	if resp.StatusCode != 200 || !strings.Contains(string(data), `"enabled":true`) {
		t.Fatalf("enable = %d %s", resp.StatusCode, data)
	}

	go proxiedClient(e.proxyAddr).Post(up.URL+"/i", "text/plain", strings.NewReader("orig"))

	deadline := time.Now().Add(3 * time.Second)
	var pendingID string
	for time.Now().Before(deadline) && pendingID == "" {
		_, data := e.do(t, "GET", "/api/intercept", nil)
		var sum struct {
			Pending []struct {
				ID string `json:"id"`
			} `json:"pending"`
		}
		json.Unmarshal(data, &sum)
		if len(sum.Pending) > 0 {
			pendingID = sum.Pending[0].ID
		} else {
			time.Sleep(20 * time.Millisecond)
		}
	}
	if pendingID == "" {
		t.Fatal("no pending request appeared")
	}

	_, data = e.do(t, "GET", "/api/intercept/"+pendingID, nil)
	var held store.Request
	json.Unmarshal(data, &held)
	if held.URL != up.URL+"/i" {
		t.Fatalf("held = %+v", held)
	}

	resp, _ = e.do(t, "POST", "/api/intercept/"+pendingID+"/forward", map[string]any{
		"request": map[string]any{
			"method":      "POST",
			"url":         up.URL + "/i",
			"httpVersion": "HTTP/1.1",
			"headers":     []store.Header{{Name: "Host", Value: hostPort(up.URL)}},
			"body":        []byte("changed-via-api"),
		},
	})
	if resp.StatusCode != 200 {
		t.Fatalf("forward = %d", resp.StatusCode)
	}
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && gotBody == "" {
		time.Sleep(20 * time.Millisecond)
	}
	if gotBody != "changed-via-api" {
		t.Fatalf("upstream body = %q", gotBody)
	}
}

// GET /api/intercept/{id} on a held-response id ("<reqID>-r") returns the
// response with its request context for the details panel.
func TestHeldResponseDetail(t *testing.T) {
	e := newEnv(t)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("detail-body"))
	}))
	defer up.Close()

	e.do(t, "PUT", "/api/intercept", map[string]bool{"respEnabled": true})

	go proxiedClient(e.proxyAddr).Get(up.URL + "/detail")

	deadline := time.Now().Add(3 * time.Second)
	var heldID string
	for time.Now().Before(deadline) && heldID == "" {
		_, data := e.do(t, "GET", "/api/intercept", nil)
		var sum struct {
			PendingResp []struct {
				ID string `json:"id"`
			} `json:"pendingResp"`
		}
		json.Unmarshal(data, &sum)
		if len(sum.PendingResp) > 0 {
			heldID = sum.PendingResp[0].ID
		} else {
			time.Sleep(20 * time.Millisecond)
		}
	}
	if heldID == "" {
		t.Fatal("no held response appeared")
	}

	resp, data := e.do(t, "GET", "/api/intercept/"+heldID, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("detail = %d", resp.StatusCode)
	}
	var detail struct {
		ID  string `json:"id"`
		Req struct {
			Method string `json:"method"`
			URL    string `json:"url"`
		} `json:"request"`
		Resp struct {
			StatusCode int    `json:"statusCode"`
			Body       []byte `json:"body"`
		} `json:"response"`
	}
	json.Unmarshal(data, &detail)
	if detail.ID != heldID || detail.Req.Method != "GET" || detail.Req.URL != up.URL+"/detail" {
		t.Fatalf("detail = %s", data)
	}
	if detail.Resp.StatusCode != 200 || string(detail.Resp.Body) != "detail-body" {
		t.Fatalf("response = %+v", detail.Resp)
	}

	resp, _ = e.do(t, "GET", "/api/intercept/req-nope-r", nil)
	if resp.StatusCode != 404 {
		t.Fatalf("unknown id = %d", resp.StatusCode)
	}

	// release the held response so the proxied client unblocks
	e.do(t, "POST", "/api/intercept/"+heldID+"/drop", nil)
}

// The hosted panel (pulsesec.vercel.app) may call the local API cross-origin;
// every other origin gets no CORS headers.
func TestCORS(t *testing.T) {
	e := newEnv(t)
	const allowed = "https://pulsesec.vercel.app"

	do := func(origin string, method, acrm string) *http.Response {
		t.Helper()
		req, err := http.NewRequest(method, e.ts.URL+"/api/status", nil)
		if err != nil {
			t.Fatalf("new request: %v", err)
		}
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if acrm != "" {
			req.Header.Set("Access-Control-Request-Method", acrm)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, origin, err)
		}
		resp.Body.Close()
		return resp
	}

	// allowed origin: echoed back on normal responses
	resp := do(allowed, "GET", "")
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != allowed {
		t.Fatalf("allow-origin = %q", got)
	}
	// preflight from the allowed origin: 204 + method/header grants
	resp = do(allowed, "OPTIONS", "PUT")
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("preflight = %d", resp.StatusCode)
	}
	if m := resp.Header.Get("Access-Control-Allow-Methods"); !strings.Contains(m, "PUT") || !strings.Contains(m, "DELETE") {
		t.Fatalf("allow-methods = %q", m)
	}
	if h := resp.Header.Get("Access-Control-Allow-Headers"); !strings.Contains(h, "Content-Type") {
		t.Fatalf("allow-headers = %q", h)
	}
	// any other origin: no CORS headers at all
	resp = do("https://evil.example", "GET", "")
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("evil origin got allow-origin %q", got)
	}
	resp = do("https://evil.example", "OPTIONS", "PUT")
	if got := resp.Header.Get("Access-Control-Allow-Methods"); got != "" {
		t.Fatalf("evil preflight got allow-methods %q", got)
	}
	// same-origin requests (no Origin header): untouched
	resp = do("", "GET", "")
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("no-origin request got allow-origin %q", got)
	}
}

// Non-loopback API access requires the access key (header or query);
// loopback stays keyless; preflights pass; static assets stay open.
func TestAccessKey(t *testing.T) {
	t.Setenv("PULSE_KEY", "test-key")
	e := newEnv(t)

	// serve through the real handler chain with a forged non-loopback peer
	serve := func(method, target string, headers map[string]string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, target, nil)
		req.RemoteAddr = "192.168.1.9:54321"
		req.Host = strings.TrimPrefix(e.ts.URL, "http://")
		for k, v := range headers {
			if k == "Host" {
				req.Host = v
				continue
			}
			req.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		e.ts.Config.Handler.ServeHTTP(w, req)
		return w
	}

	// loopback via the real server: still keyless
	resp, _ := e.do(t, "GET", "/api/status", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("loopback status = %d", resp.StatusCode)
	}

	if w := serve("GET", "/api/status", nil); w.Code != 401 {
		t.Fatalf("non-loopback without key = %d, want 401", w.Code)
	}
	if w := serve("GET", "/api/status", map[string]string{"X-Pulse-Key": "wrong"}); w.Code != 401 {
		t.Fatalf("non-loopback wrong key = %d, want 401", w.Code)
	}
	if w := serve("GET", "/api/status", map[string]string{"X-Pulse-Key": "test-key"}); w.Code != 200 {
		t.Fatalf("non-loopback with key header = %d, want 200", w.Code)
	}
	if w := serve("GET", "/api/status?key=test-key", nil); w.Code != 200 {
		t.Fatalf("non-loopback with key query = %d, want 200", w.Code)
	}
	// the CA certificate is public material — downloadable without a key
	if w := serve("GET", "/api/cert", nil); w.Code != 200 || !strings.HasPrefix(w.Body.String(), "-----BEGIN CERTIFICATE-----") {
		t.Fatalf("cert download without key = %d", w.Code)
	}
	// preflight carries no credentials by design — must pass for CORS to work
	if w := serve("OPTIONS", "/api/intercept", map[string]string{
		"Origin": "https://pulsesec.vercel.app", "Access-Control-Request-Method": "PUT",
	}); w.Code != 204 {
		t.Fatalf("preflight = %d, want 204", w.Code)
	}
	// keyed access may use any Host (LAN hostnames), the key is the auth
	req := httptest.NewRequest("GET", "/api/status", nil)
	req.RemoteAddr = "192.168.1.9:54321"
	req.Host = "pulse.lan:8787"
	req.Header.Set("X-Pulse-Key", "test-key")
	w := httptest.NewRecorder()
	e.ts.Config.Handler.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("keyed access with lan host = %d, want 200", w.Code)
	}
	// static assets carry no secrets (same code ships to the hosted panel);
	// browsing a LAN-bound instance by its IP loads the shell (API stays
	// keyed), while a hostname that isn't this listener still fails
	_, uiPort, _ := net.SplitHostPort(strings.TrimPrefix(e.ts.URL, "http://"))
	if w := serve("GET", "/", map[string]string{"Host": "192.168.1.5:" + uiPort}); w.Code != 200 {
		t.Fatalf("static from lan IP = %d, want 200", w.Code)
	}
	if w := serve("GET", "/", map[string]string{"Host": "rebind.evil:" + uiPort}); w.Code != 403 {
		t.Fatalf("static from rebind hostname = %d, want 403", w.Code)
	}
	// the key itself is only exposed to loopback requests
	var stLoop map[string]any
	_, data := e.do(t, "GET", "/api/status", nil)
	json.Unmarshal(data, &stLoop)
	if _, ok := stLoop["accessKey"]; !ok {
		t.Fatal("loopback status should include accessKey")
	}
	var stRemote map[string]any
	json.Unmarshal(serve("GET", "/api/status", map[string]string{"X-Pulse-Key": "test-key"}).Body.Bytes(), &stRemote)
	if _, ok := stRemote["accessKey"]; ok {
		t.Fatal("keyed non-loopback status must not include accessKey")
	}
}

func TestRepeaterLifecycle(t *testing.T) {
	e := newEnv(t)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("tab response"))
	}))
	defer up.Close()

	if _, err := proxiedClient(e.proxyAddr).Get(up.URL + "/src"); err != nil {
		t.Fatalf("proxied get: %v", err)
	}
	if !waitFlows(t, e, 1) {
		t.Fatal("flow never appeared")
	}
	_, data := e.do(t, "GET", "/api/flows", nil)
	var list struct {
		Items []store.FlowMeta `json:"items"`
	}
	json.Unmarshal(data, &list)
	flowID := list.Items[0].ID

	resp, data := e.do(t, "POST", "/api/repeater", map[string]string{"flowId": flowID})
	if resp.StatusCode != 201 {
		t.Fatalf("create tab = %d %s", resp.StatusCode, data)
	}
	var tab repeater.Tab
	json.Unmarshal(data, &tab)
	if tab.ID == "" || tab.Request.URL != up.URL+"/src" {
		t.Fatalf("tab = %+v", tab)
	}

	resp, data = e.do(t, "POST", "/api/repeater/"+tab.ID+"/send", map[string]any{
		"request": map[string]any{
			"method":      "GET",
			"url":         up.URL + "/edited",
			"httpVersion": "HTTP/1.1",
			"headers":     []store.Header{{Name: "Host", Value: hostPort(up.URL)}},
		},
	})
	if resp.StatusCode != 200 {
		t.Fatalf("send = %d %s", resp.StatusCode, data)
	}
	var sent struct {
		Flow store.Flow `json:"flow"`
	}
	json.Unmarshal(data, &sent)
	if sent.Flow.State != store.StateComplete || string(sent.Flow.Resp.Body) != "tab response" {
		t.Fatalf("sent flow = %+v", sent.Flow)
	}
	if sent.Flow.Req.Source != "repeater" {
		t.Fatalf("source = %s", sent.Flow.Req.Source)
	}

	_, data = e.do(t, "GET", "/api/repeater", nil)
	var tabs struct {
		Tabs []repeater.Tab `json:"tabs"`
	}
	json.Unmarshal(data, &tabs)
	if len(tabs.Tabs) != 1 || tabs.Tabs[0].LastResponse == nil {
		t.Fatalf("tabs after send = %+v", tabs.Tabs)
	}

	resp, _ = e.do(t, "DELETE", "/api/repeater/"+tab.ID, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("delete tab = %d", resp.StatusCode)
	}
}

func TestStaticServesIndex(t *testing.T) {
	e := newEnv(t)
	resp, err := http.Get(e.ts.URL + "/")
	if err != nil {
		t.Fatalf("get /: %v", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || !strings.Contains(strings.ToLower(string(data)), "<html") {
		t.Fatalf("index = %d %.80s", resp.StatusCode, data)
	}
}

func TestCertDownload(t *testing.T) {
	e := newEnv(t)
	resp, err := http.Get(e.ts.URL + "/api/cert")
	if err != nil {
		t.Fatalf("cert: %v", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || !bytes.HasPrefix(data, []byte("-----BEGIN CERTIFICATE-----")) {
		t.Fatalf("cert = %d %.40s", resp.StatusCode, data)
	}
}

// --- helpers ---

func readSSE(br *bufio.Reader) (name string, data string, err error) {
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return "", "", err
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "event: ") {
			name = strings.TrimPrefix(line, "event: ")
		} else if strings.HasPrefix(line, "data: ") {
			data = strings.TrimPrefix(line, "data: ")
			return name, data, nil
		}
	}
}

func portOf(rawURL string) string {
	u, _ := url.Parse(rawURL)
	return u.Port()
}

func hostPort(rawURL string) string {
	u, _ := url.Parse(rawURL)
	return u.Host
}
