// HTTP/2 tests: inbound (browser ↔ MITM proxy over h2) and outbound
// (proxy ↔ origin over h2 with HTTP/1.1 fallback).
package proxy

import (
	"bufio"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/net/http2"

	"pulse/internal/store"
)

// h2ProxiedClient returns an HTTP/2 client that tunnels through the proxy:
// DialTLS issues a CONNECT, then performs the MITM TLS handshake offering
// only h2 — exactly what an ALPN-negotiating browser does.
func h2ProxiedClient(proxyAddr string, roots *x509.CertPool) *http.Client {
	tr := &http2.Transport{
		DialTLS: func(network, addr string, cfg *tls.Config) (net.Conn, error) {
			conn, err := net.DialTimeout("tcp", proxyAddr, 5*time.Second)
			if err != nil {
				return nil, err
			}
			if _, err := fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", addr, addr); err != nil {
				conn.Close()
				return nil, err
			}
			br := bufio.NewReader(conn)
			status, err := br.ReadString('\n')
			if err != nil || !strings.Contains(status, "200") {
				conn.Close()
				return nil, fmt.Errorf("CONNECT status %q err %v", status, err)
			}
			for {
				line, err := br.ReadString('\n')
				if err != nil {
					conn.Close()
					return nil, err
				}
				if strings.TrimRight(line, "\r\n") == "" {
					break
				}
			}
			host, _, _ := net.SplitHostPort(addr)
			tc := tls.Client(bufferedConn{conn, br}, &tls.Config{
				ServerName: host,
				RootCAs:    roots,
				NextProtos: []string{"h2"},
			})
			if err := tc.Handshake(); err != nil {
				conn.Close()
				return nil, err
			}
			if tc.ConnectionState().NegotiatedProtocol != "h2" {
				tc.Close()
				return nil, fmt.Errorf("proxy did not negotiate h2 (got %q)", tc.ConnectionState().NegotiatedProtocol)
			}
			return tc, nil
		},
		// upstreams in tests are httptest hosts; skip TLS verification there
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}
	return &http.Client{Transport: tr, Timeout: 20 * time.Second}
}

// trustUpstream wires the engine to trust an httptest TLS upstream.
func trustUpstream(eng *Engine, ts *httptest.Server) {
	pool := x509.NewCertPool()
	pool.AddCert(ts.Certificate())
	eng.SetUpstreamTLS(&tls.Config{RootCAs: pool})
}

func TestH2InboundBasicGetPost(t *testing.T) {
	var mu sync.Mutex
	var lastBody string
	up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		lastBody = string(b)
		mu.Unlock()
		w.Header().Set("X-Upstream", "h1-origin")
		w.Write([]byte("h2 client payload"))
	}))
	defer up.Close()

	eng, st, addr := newTestEngine(t, nil, nil)
	trustUpstream(eng, up)
	client := h2ProxiedClient(addr, eng.CAPool())

	resp, err := client.Get(up.URL + "/h2get?q=1")
	if err != nil {
		t.Fatalf("h2 GET via proxy: %v", err)
	}
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(got) != "h2 client payload" || resp.Header.Get("X-Upstream") != "h1-origin" {
		t.Fatalf("h2 GET body=%q headers=%v", got, resp.Header)
	}
	if resp.ProtoMajor != 2 {
		t.Fatalf("client proto = %s, want HTTP/2", resp.Proto)
	}
	if !waitFor(t, 3*time.Second, func() bool {
		fl := latestFlow(t, st)
		return fl != nil && fl.State == store.StateComplete
	}) {
		t.Fatal("h2 flow never completed")
	}
	fl := latestFlow(t, st)
	if fl.Req.HTTPVersion != "HTTP/2.0" {
		t.Fatalf("stored request version = %s, want HTTP/2.0", fl.Req.HTTPVersion)
	}
	if !strings.HasPrefix(fl.Req.URL, "https://") || !strings.Contains(fl.Req.URL, "/h2get?q=1") {
		t.Fatalf("stored URL = %s", fl.Req.URL)
	}
	if fl.Resp.StatusCode != 200 || string(fl.Resp.Body) != "h2 client payload" {
		t.Fatalf("stored resp = %+v", fl.Resp)
	}

	resp, err = client.Post(up.URL+"/h2post", "application/json", strings.NewReader(`{"h2":true}`))
	if err != nil {
		t.Fatalf("h2 POST via proxy: %v", err)
	}
	resp.Body.Close()
	mu.Lock()
	body := lastBody
	mu.Unlock()
	if body != `{"h2":true}` {
		t.Fatalf("upstream saw body %q", body)
	}
	if !waitFor(t, 3*time.Second, func() bool {
		fl := latestFlow(t, st)
		return fl != nil && fl.Req.Method == "POST" && string(fl.Req.Body) == `{"h2":true}`
	}) {
		t.Fatal("h2 POST flow body not captured")
	}
}

func TestH2InboundConcurrentStreams(t *testing.T) {
	up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "stream-%s", r.URL.Query().Get("id"))
	}))
	defer up.Close()

	eng, st, addr := newTestEngine(t, nil, nil)
	trustUpstream(eng, up)
	client := h2ProxiedClient(addr, eng.CAPool())

	const n = 8
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			resp, err := client.Get(fmt.Sprintf("%s/parallel?id=%d", up.URL, i))
			if err != nil {
				errs <- err
				return
			}
			got, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if want := fmt.Sprintf("stream-%d", i); string(got) != want {
				errs <- fmt.Errorf("body %q, want %q", got, want)
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent h2 stream: %v", err)
	}
	if !waitFor(t, 3*time.Second, func() bool {
		items, _ := st.List("")
		return len(items) >= n
	}) {
		t.Fatal("not all concurrent h2 flows recorded")
	}
}

func TestH2InboundInterceptForwardModified(t *testing.T) {
	var mu sync.Mutex
	sawHeader := ""
	up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		sawHeader = r.Header.Get("X-H2-Injected")
		mu.Unlock()
		w.WriteHeader(204)
	}))
	defer up.Close()

	eng, _, addr := newTestEngine(t, nil, nil)
	trustUpstream(eng, up)
	eng.Inter.SetEnabled(true)
	client := h2ProxiedClient(addr, eng.CAPool())

	errCh := make(chan error, 1)
	go func() {
		resp, err := client.Get(up.URL + "/held-h2")
		if err != nil {
			errCh <- err
			return
		}
		resp.Body.Close()
		errCh <- nil
	}()

	if !waitFor(t, 3*time.Second, func() bool { return len(eng.Inter.Pending()) == 1 }) {
		t.Fatal("h2 request was not held")
	}
	pending := eng.Inter.Pending()[0]
	if !strings.HasSuffix(pending.URL, "/held-h2") || pending.HTTPVersion != "HTTP/2.0" {
		t.Fatalf("held request = %+v", pending)
	}
	mod := *pending
	mod.Headers = append(mod.Headers, store.Header{Name: "X-H2-Injected", Value: "yes"})
	if !eng.Inter.Forward(pending.ID, &mod) {
		t.Fatal("Forward failed")
	}
	if err := <-errCh; err != nil {
		t.Fatalf("held h2 request errored: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if sawHeader != "yes" {
		t.Fatalf("upstream saw injected header %q", sawHeader)
	}
}

func TestH2InboundInterceptDrop(t *testing.T) {
	up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("dropped h2 request reached upstream")
	}))
	defer up.Close()

	eng, _, addr := newTestEngine(t, nil, nil)
	trustUpstream(eng, up)
	eng.Inter.SetEnabled(true)
	client := h2ProxiedClient(addr, eng.CAPool())

	type result struct {
		code int
		err  error
	}
	resCh := make(chan result, 1)
	go func() {
		resp, err := client.Get(up.URL + "/dropped-h2")
		if err != nil {
			resCh <- result{err: err}
			return
		}
		resCh <- result{code: resp.StatusCode}
		resp.Body.Close()
	}()
	if !waitFor(t, 3*time.Second, func() bool { return len(eng.Inter.Pending()) == 1 }) {
		t.Fatal("h2 request was not held")
	}
	eng.Inter.Drop(eng.Inter.Pending()[0].ID)
	res := <-resCh
	if res.err != nil {
		t.Fatalf("client error: %v", res.err)
	}
	if res.code != http.StatusBadGateway {
		t.Fatalf("client status = %d, want 502", res.code)
	}
}

func TestH2OutboundPrefersOriginH2(t *testing.T) {
	var protoMajor = 0
	up := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		protoMajor = r.ProtoMajor
		w.Header().Set("X-Origin", "speaks-h2")
		w.Write([]byte("via h2 origin"))
	}))
	up.EnableHTTP2 = true
	up.StartTLS()
	defer up.Close()

	eng, st, addr := newTestEngine(t, nil, nil)
	trustUpstream(eng, up)
	// plain HTTP/1.1 proxied client is enough — this exercises OUTBOUND h2
	client := proxiedClient(addr, &tls.Config{RootCAs: eng.CAPool()})

	resp, err := client.Get(up.URL + "/out")
	if err != nil {
		t.Fatalf("GET to h2 origin via proxy: %v", err)
	}
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(got) != "via h2 origin" || resp.Header.Get("X-Origin") != "speaks-h2" {
		t.Fatalf("body=%q headers=%v", got, resp.Header)
	}
	if protoMajor != 2 {
		t.Fatalf("origin saw HTTP/%d, want 2", protoMajor)
	}
	if !waitFor(t, 3*time.Second, func() bool {
		fl := latestFlow(t, st)
		return fl != nil && fl.State == store.StateComplete
	}) {
		t.Fatal("flow never completed")
	}
	fl := latestFlow(t, st)
	if fl.Resp.HTTPVersion != "HTTP/2.0" {
		t.Fatalf("stored response version = %s, want HTTP/2.0", fl.Resp.HTTPVersion)
	}
}

func TestH2OutboundFallsBackToHTTP1(t *testing.T) {
	var protoMajor = 0
	up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		protoMajor = r.ProtoMajor
		w.Write([]byte("h1 only origin"))
	}))
	defer up.Close()

	eng, _, addr := newTestEngine(t, nil, nil)
	trustUpstream(eng, up)
	client := proxiedClient(addr, &tls.Config{RootCAs: eng.CAPool()})

	resp, err := client.Get(up.URL + "/fallback")
	if err != nil {
		t.Fatalf("GET to h1-only origin via proxy: %v", err)
	}
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(got) != "h1 only origin" {
		t.Fatalf("body=%q", got)
	}
	if protoMajor != 1 {
		t.Fatalf("origin saw HTTP/%d, want 1 (fallback)", protoMajor)
	}
}

func TestH2LargeBodies(t *testing.T) {
	const respSize = 2 << 20 // 2 MiB
	payload := strings.Repeat("A", respSize)
	up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		if len(b) != respSize {
			t.Errorf("origin saw %d body bytes, want %d", len(b), respSize)
		}
		w.Write([]byte(payload))
	}))
	defer up.Close()

	eng, st, addr := newTestEngine(t, nil, nil)
	trustUpstream(eng, up)
	client := h2ProxiedClient(addr, eng.CAPool())

	resp, err := client.Post(up.URL+"/big", "application/octet-stream", strings.NewReader(payload))
	if err != nil {
		t.Fatalf("h2 large POST via proxy: %v", err)
	}
	got, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		t.Fatalf("read large body: %v", err)
	}
	if len(got) != respSize {
		t.Fatalf("client got %d bytes, want %d", len(got), respSize)
	}
	if !waitFor(t, 3*time.Second, func() bool {
		fl := latestFlow(t, st)
		return fl != nil && fl.State == store.StateComplete && len(fl.Resp.Body) == respSize
	}) {
		t.Fatal("large h2 flow not captured intact")
	}
}

func TestH2ResponseHeadersPreserved(t *testing.T) {
	up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Multi", "one")
		w.Header().Add("X-Multi", "two")
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("headers"))
	}))
	defer up.Close()

	eng, st, addr := newTestEngine(t, nil, nil)
	trustUpstream(eng, up)
	client := h2ProxiedClient(addr, eng.CAPool())

	resp, err := client.Get(up.URL + "/headers")
	if err != nil {
		t.Fatalf("h2 GET: %v", err)
	}
	resp.Body.Close()
	if len(resp.Header.Values("X-Multi")) != 2 {
		t.Fatalf("repeated header lost: %v", resp.Header)
	}
	if !waitFor(t, 3*time.Second, func() bool {
		fl := latestFlow(t, st)
		return fl != nil && fl.State == store.StateComplete
	}) {
		t.Fatal("flow never completed")
	}
	fl := latestFlow(t, st)
	count := 0
	for _, h := range fl.Resp.Headers {
		if h.Name == "X-Multi" {
			count++
		}
	}
	if count != 2 {
		t.Fatalf("stored repeated header count = %d, want 2 (%v)", count, fl.Resp.Headers)
	}
}

// sanity: both transports coexist — an inbound-h2 client and an inbound-h1
// client work against the same h2-capable origin.
func TestH2AndH1ClientsCoexist(t *testing.T) {
	up := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "proto-%d", r.ProtoMajor)
	}))
	up.EnableHTTP2 = true
	up.StartTLS()
	defer up.Close()

	eng, _, addr := newTestEngine(t, nil, nil)
	trustUpstream(eng, up)

	h2c := h2ProxiedClient(addr, eng.CAPool())
	h1c := proxiedClient(addr, &tls.Config{RootCAs: eng.CAPool()})

	r2, err := h2c.Get(up.URL + "/a")
	if err != nil {
		t.Fatalf("h2 client: %v", err)
	}
	b2, _ := io.ReadAll(r2.Body)
	r2.Body.Close()

	r1, err := h1c.Get(up.URL + "/b")
	if err != nil {
		t.Fatalf("h1 client: %v", err)
	}
	b1, _ := io.ReadAll(r1.Body)
	r1.Body.Close()

	// inbound protocol follows each client; outbound is h2 for both
	if r2.ProtoMajor != 2 || string(b2) != "proto-2" {
		t.Fatalf("h2 leg: proto=%d body=%s", r2.ProtoMajor, b2)
	}
	if r1.ProtoMajor != 1 || string(b1) != "proto-2" {
		t.Fatalf("h1 leg: proto=%d body=%s (want outbound h2)", r1.ProtoMajor, b1)
	}
}
