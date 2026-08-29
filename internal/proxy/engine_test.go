package proxy

import (
	"bufio"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"pulse/internal/certs"
	"pulse/internal/events"
	"pulse/internal/store"
)

// newTestEngine starts an engine on an ephemeral port and returns it with its
// store and proxy address.
func newTestEngine(t *testing.T) (*Engine, *store.Store, string) {
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
	bus := events.NewBus()
	eng := New(auth, st, bus, "test")
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go eng.Serve(ln)
	t.Cleanup(func() {
		eng.Close()
		st.Close()
	})
	return eng, st, ln.Addr().String()
}

func proxiedClient(proxyAddr string, tlsCfg *tls.Config) *http.Client {
	proxyURL, _ := url.Parse("http://" + proxyAddr)
	tr := &http.Transport{Proxy: http.ProxyURL(proxyURL)}
	if tlsCfg != nil {
		tr.TLSClientConfig = tlsCfg
	}
	return &http.Client{Transport: tr, Timeout: 15 * time.Second}
}

func waitFor(t *testing.T, timeout time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

func latestFlow(t *testing.T, st *store.Store) *store.Flow {
	t.Helper()
	items, _ := st.List("")
	if len(items) == 0 {
		return nil
	}
	fl, _ := st.Get(items[len(items)-1].ID)
	return fl
}

func TestProxyPlainHTTPGetPost(t *testing.T) {
	var mu sync.Mutex
	var lastBody string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		lastBody = string(b)
		mu.Unlock()
		w.Header().Set("X-Upstream", "yes")
		w.WriteHeader(200)
		w.Write([]byte("hello from upstream"))
	}))
	defer up.Close()

	eng, st, addr := newTestEngine(t)
	_ = eng
	client := proxiedClient(addr, nil)

	resp, err := client.Get(up.URL + "/abc?x=1")
	if err != nil {
		t.Fatalf("GET via proxy: %v", err)
	}
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(got) != "hello from upstream" || resp.Header.Get("X-Upstream") != "yes" {
		t.Fatalf("GET body=%q headers=%v", got, resp.Header)
	}
	if !waitFor(t, 3*time.Second, func() bool {
		fl := latestFlow(t, st)
		return fl != nil && fl.State == store.StateComplete
	}) {
		t.Fatal("flow never completed")
	}
	fl := latestFlow(t, st)
	if fl.Req.Method != "GET" || fl.Req.URL != up.URL+"/abc?x=1" {
		t.Fatalf("flow req = %+v", fl.Req)
	}
	if fl.Resp.StatusCode != 200 || string(fl.Resp.Body) != "hello from upstream" {
		t.Fatalf("flow resp = %+v", fl.Resp)
	}
	if fl.Resp.DurationMs < 0 {
		t.Fatal("negative duration")
	}

	resp, err = client.Post(up.URL+"/echo", "application/json", strings.NewReader(`{"a":1}`))
	if err != nil {
		t.Fatalf("POST via proxy: %v", err)
	}
	resp.Body.Close()
	mu.Lock()
	body := lastBody
	mu.Unlock()
	if body != `{"a":1}` {
		t.Fatalf("upstream saw body %q", body)
	}
	if !waitFor(t, 3*time.Second, func() bool {
		fl := latestFlow(t, st)
		return fl != nil && fl.Req.Method == "POST" && string(fl.Req.Body) == `{"a":1}`
	}) {
		t.Fatal("POST flow body not captured")
	}
}

func TestProxyHTTPSIntercepted(t *testing.T) {
	up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("secure payload"))
	}))
	defer up.Close()

	eng, st, addr := newTestEngine(t)
	// trust the self-signed upstream cert
	upPool := x509.NewCertPool()
	upPool.AddCert(up.Certificate())
	eng.SetUpstreamTLS(&tls.Config{RootCAs: upPool})

	// the client trusts only the Pulse CA for the intercepted session
	client := proxiedClient(addr, &tls.Config{RootCAs: eng.CAPool()})

	resp, err := client.Get(up.URL + "/secret?token=abc")
	if err != nil {
		t.Fatalf("HTTPS GET via MITM proxy: %v", err)
	}
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(got) != "secure payload" {
		t.Fatalf("body = %q", got)
	}
	if !waitFor(t, 3*time.Second, func() bool {
		fl := latestFlow(t, st)
		return fl != nil && fl.State == store.StateComplete && strings.HasPrefix(fl.Req.URL, "https://")
	}) {
		t.Fatal("HTTPS flow never completed")
	}
	fl := latestFlow(t, st)
	if !strings.Contains(fl.Req.URL, "/secret?token=abc") || string(fl.Resp.Body) != "secure payload" {
		t.Fatalf("intercepted flow incomplete: %+v", fl)
	}
}

func TestInterceptForwardModified(t *testing.T) {
	var mu sync.Mutex
	sawHeader, sawBody := "", ""
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		sawHeader, sawBody = r.Header.Get("X-Injected"), string(b)
		mu.Unlock()
		w.WriteHeader(204)
	}))
	defer up.Close()

	eng, st, addr := newTestEngine(t)
	eng.Inter.SetEnabled(true)
	client := proxiedClient(addr, nil)

	errCh := make(chan error, 1)
	go func() {
		resp, err := client.Post(up.URL+"/held", "text/plain", strings.NewReader("original"))
		if err != nil {
			errCh <- err
			return
		}
		resp.Body.Close()
		errCh <- nil
	}()

	if !waitFor(t, 3*time.Second, func() bool { return len(eng.Inter.Pending()) == 1 }) {
		t.Fatal("request was not held")
	}
	pending := eng.Inter.Pending()[0]
	if pending.URL != up.URL+"/held" {
		t.Fatalf("held url = %s", pending.URL)
	}
	mod := *pending
	mod.Headers = append(mod.Headers, store.Header{Name: "X-Injected", Value: "by-pulse"})
	mod.Body = []byte("modified-body")
	if !eng.Inter.Forward(pending.ID, &mod) {
		t.Fatal("Forward failed")
	}
	if err := <-errCh; err != nil {
		t.Fatalf("held request errored: %v", err)
	}
	mu.Lock()
	h, b := sawHeader, sawBody
	mu.Unlock()
	if h != "by-pulse" || b != "modified-body" {
		t.Fatalf("upstream saw header=%q body=%q", h, b)
	}
	if !waitFor(t, 3*time.Second, func() bool {
		fl := latestFlow(t, st)
		return fl != nil && fl.State == store.StateComplete
	}) {
		t.Fatal("modified flow never completed")
	}
	fl := latestFlow(t, st)
	if string(fl.Req.Body) != "modified-body" {
		t.Fatalf("stored flow body = %q", fl.Req.Body)
	}
}

func TestInterceptDrop(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("dropped request reached upstream")
	}))
	defer up.Close()

	eng, _, addr := newTestEngine(t)
	eng.Inter.SetEnabled(true)
	client := proxiedClient(addr, nil)

	type result struct {
		code int
		err  error
	}
	resCh := make(chan result, 1)
	go func() {
		resp, err := client.Get(up.URL + "/dropped")
		if err != nil {
			resCh <- result{err: err}
			return
		}
		resCh <- result{code: resp.StatusCode}
		resp.Body.Close()
	}()
	if !waitFor(t, 3*time.Second, func() bool { return len(eng.Inter.Pending()) == 1 }) {
		t.Fatal("request was not held")
	}
	pending := eng.Inter.Pending()[0]
	if !eng.Inter.Drop(pending.ID) {
		t.Fatal("Drop failed")
	}
	res := <-resCh
	if res.err != nil {
		t.Fatalf("client error: %v", res.err)
	}
	if res.code != http.StatusBadGateway {
		t.Fatalf("client status = %d, want 502", res.code)
	}
}

func TestUpgradeTunnelBidirectional(t *testing.T) {
	upLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go func() {
		for {
			c, err := upLn.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				br := bufio.NewReader(c)
				for {
					line, err := br.ReadString('\n')
					if err != nil {
						return
					}
					if strings.TrimRight(line, "\r\n") == "" {
						break
					}
				}
				io.WriteString(c, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
				// server speaks first: proves the upstream→client direction
				io.WriteString(c, "SERVER-GREETING")
				buf := make([]byte, 64)
				for {
					n, err := br.Read(buf)
					if n > 0 {
						io.WriteString(c, strings.ToUpper(string(buf[:n]))) // proves client→upstream
					}
					if err != nil {
						return
					}
				}
			}(c)
		}
	}()
	defer upLn.Close()

	_, st, addr := newTestEngine(t)

	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		t.Fatalf("dial proxy: %v", err)
	}
	defer conn.Close()
	req := "GET http://127.0.0.1:" + portOf(upLn.Addr().String()) + "/chat HTTP/1.1\r\n" +
		"Host: 127.0.0.1:" + portOf(upLn.Addr().String()) + "\r\n" +
		"Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n"
	if _, err := io.WriteString(conn, req); err != nil {
		t.Fatalf("write upgrade request: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	br := bufio.NewReader(conn)
	status, err := br.ReadString('\n')
	if err != nil {
		t.Fatalf("read status: %v", err)
	}
	if !strings.Contains(status, "101") {
		t.Fatalf("status = %q, want 101", status)
	}
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			t.Fatalf("read headers: %v", err)
		}
		if strings.TrimRight(line, "\r\n") == "" {
			break
		}
	}
	// upstream→client: the greeting must arrive through the tunnel
	greeting := make([]byte, len("SERVER-GREETING"))
	if _, err := io.ReadFull(br, greeting); err != nil {
		t.Fatalf("read greeting: %v", err)
	}
	if string(greeting) != "SERVER-GREETING" {
		t.Fatalf("greeting = %q", greeting)
	}
	// client→upstream: the server must transform our bytes
	if _, err := conn.Write([]byte("tunnel-payload")); err != nil {
		t.Fatalf("write tunnel bytes: %v", err)
	}
	echo := make([]byte, len("TUNNEL-PAYLOAD"))
	if _, err := io.ReadFull(br, echo); err != nil {
		t.Fatalf("read transformed echo: %v", err)
	}
	if string(echo) != "TUNNEL-PAYLOAD" {
		t.Fatalf("echo = %q", echo)
	}
	if !waitFor(t, 3*time.Second, func() bool {
		items, _ := st.List("")
		return len(items) > 0
	}) {
		t.Fatal("upgrade flow not recorded")
	}
}

func TestEngineRoundTripForRepeater(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("repeater reply"))
	}))
	defer up.Close()

	eng, st, _ := newTestEngine(t)
	req := &store.Request{
		Method: "GET", URL: up.URL + "/rt", HTTPVersion: "HTTP/1.1",
		Headers: []store.Header{{Name: "Host", Value: hostOf(up.URL)}},
		Source:  "repeater",
	}
	fl := eng.RoundTrip(req)
	if fl.State != store.StateComplete || fl.Resp == nil || string(fl.Resp.Body) != "repeater reply" {
		t.Fatalf("roundtrip flow = %+v", fl)
	}
	if fl.Req.Source != "repeater" {
		t.Fatalf("source = %s", fl.Req.Source)
	}
	got, ok := st.Get(fl.ID)
	if !ok || got.State != store.StateComplete {
		t.Fatalf("roundtrip flow not stored")
	}
}

func portOf(addr string) string {
	_, port, _ := net.SplitHostPort(addr)
	return port
}
