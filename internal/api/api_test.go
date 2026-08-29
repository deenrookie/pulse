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
	"pulse/internal/proxy"
	"pulse/internal/repeater"
	"pulse/internal/store"
)

type testEnv struct {
	ts      *httptest.Server
	st      *store.Store
	eng     *proxy.Engine
	rep     *repeater.Manager
	proxyAddr string
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
	eng := proxy.New(auth, st, bus, "test")

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
	ts := httptest.NewUnstartedServer(api.New(st, eng, rep, auth, bus, "test", pln.Addr().String(), uiAddr, dir).Handler())
	ts.Listener = uln
	ts.Start()

	t.Cleanup(func() {
		ts.Close()
		eng.Close()
		st.Close()
	})
	return &testEnv{ts: ts, st: st, eng: eng, rep: rep, proxyAddr: pln.Addr().String()}
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
