package proxy

import (
	"crypto/tls"
	"crypto/x509"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"pulse/internal/store"
)

// TestMemoryGuardDropsLargeBinaryResponses: with a tiny budget configured,
// a >drop-size binary response is recorded without its body while a text
// response of the same size is stored intact.
func TestMemoryGuardDropsLargeBinaryResponses(t *testing.T) {
	big := strings.Repeat("B", 2<<20) // 2 MB
	up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/video") {
			w.Header().Set("Content-Type", "video/mp4")
		} else {
			w.Header().Set("Content-Type", "text/html")
		}
		w.Write([]byte(big))
	}))
	defer up.Close()

	eng, st, addr := newTestEngine(t, nil, nil)
	pool := x509.NewCertPool()
	pool.AddCert(up.Certificate())
	eng.SetUpstreamTLS(&tls.Config{RootCAs: pool})
	st.SetMemoryGuard(1, 1) // 1 MB budget, drop binaries over 1 MB
	// push the store past its budget so the guard is armed
	st.Add(&store.Flow{
		ID:    "req-seed",
		Req:   store.Request{ID: "req-seed", Timestamp: time.Now()},
		Resp:  &store.Response{Body: make([]byte, 2<<20)},
		State: store.StateComplete,
	})
	client := proxiedClient(addr, &tls.Config{RootCAs: eng.CAPool()})

	// binary response: delivered to the client in full, dropped from storage
	resp, err := client.Get(up.URL + "/video")
	if err != nil {
		t.Fatalf("GET video: %v", err)
	}
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if len(got) != len(big) {
		t.Fatalf("client received %d bytes, want full %d", len(got), len(big))
	}
	if !waitFor(t, 3*time.Second, func() bool {
		fl := latestFlow(t, st)
		return fl != nil && fl.State == store.StateComplete
	}) {
		t.Fatal("video flow never completed")
	}
	fl := latestFlow(t, st)
	if len(fl.Resp.Body) != 0 || !fl.Resp.Truncated {
		t.Fatalf("video body must be dropped (len=%d truncated=%v)", len(fl.Resp.Body), fl.Resp.Truncated)
	}

	// same size, text content type: stored intact
	resp, err = client.Get(up.URL + "/page")
	if err != nil {
		t.Fatalf("GET page: %v", err)
	}
	io.ReadAll(resp.Body)
	resp.Body.Close()
	if !waitFor(t, 3*time.Second, func() bool {
		fl := latestFlow(t, st)
		return fl != nil && fl.State == store.StateComplete && strings.HasSuffix(fl.Req.URL, "/page")
	}) {
		t.Fatal("page flow never completed")
	}
	fl = latestFlow(t, st)
	if len(fl.Resp.Body) != len(big) || fl.Resp.Truncated {
		t.Fatalf("text body must be kept (len=%d truncated=%v)", len(fl.Resp.Body), fl.Resp.Truncated)
	}
}

// TestMemoryGuardIdleBelowBudget: with the default-sized budget (500 MB),
// ordinary traffic stores everything as before.
func TestMemoryGuardIdleBelowBudget(t *testing.T) {
	up := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write([]byte(strings.Repeat("x", 64<<10)))
	}))
	defer up.Close()

	eng, st, addr := newTestEngine(t, nil, nil)
	pool := x509.NewCertPool()
	pool.AddCert(up.Certificate())
	eng.SetUpstreamTLS(&tls.Config{RootCAs: pool})
	st.SetMemoryGuard(500, 3) // defaults
	client := proxiedClient(addr, &tls.Config{RootCAs: eng.CAPool()})

	resp, err := client.Get(up.URL + "/blob")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	resp.Body.Close()
	if !waitFor(t, 3*time.Second, func() bool {
		fl := latestFlow(t, st)
		return fl != nil && fl.State == store.StateComplete
	}) {
		t.Fatal("flow never completed")
	}
	fl := latestFlow(t, st)
	if len(fl.Resp.Body) != 64<<10 {
		t.Fatalf("below budget the body must be stored (len=%d)", len(fl.Resp.Body))
	}
}
