package proxy

import (
	"crypto/tls"
	"crypto/x509"
	"net"
	"sync/atomic"
	"testing"

	"pulse/internal/certs"
	"pulse/internal/store"
)

// A gateway that rejects the first (ECDHE-leading) hello with a fatal
// handshake_failure alert must be reached by the plain-RSA retry.
func TestTLSLegacyRetry(t *testing.T) {
	auth, err := certs.LoadOrCreate(t.TempDir())
	if err != nil {
		t.Fatalf("certs: %v", err)
	}
	leaf, err := auth.Leaf("127.0.0.1")
	if err != nil {
		t.Fatalf("leaf: %v", err)
	}

	var conns atomic.Int32
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			if conns.Add(1) == 1 {
				// reject the first hello exactly like a no-ECDHE gateway:
				// a fatal handshake_failure alert, then close
				c.Write([]byte{0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28})
				c.Close()
				continue
			}
			tc := tls.Server(c, &tls.Config{
				Certificates: []tls.Certificate{*leaf},
				MinVersion:   tls.VersionTLS12,
			})
			if err := tc.Handshake(); err != nil {
				c.Close()
				continue
			}
			tc.Write([]byte("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"))
			tc.Close()
		}
	}()

	pool := x509.NewCertPool()
	pool.AddCert(auth.CACert())
	c := NewClient()
	c.UpstreamTLS = &tls.Config{RootCAs: pool}

	res, err := c.Do(&store.Request{
		Method: "GET", URL: "https://" + ln.Addr().String() + "/", HTTPVersion: "HTTP/1.1",
		Headers: []store.Header{{Name: "Host", Value: ln.Addr().String()}},
	})
	if err != nil {
		t.Fatalf("Do with legacy retry: %v", err)
	}
	if res.Resp.StatusCode != 200 || string(res.Resp.Body) != "ok" {
		t.Fatalf("resp = %d %q", res.Resp.StatusCode, res.Resp.Body)
	}
	if got := conns.Load(); got != 2 {
		t.Fatalf("connections = %d, want 2 (one rejected + one legacy retry)", got)
	}
}
