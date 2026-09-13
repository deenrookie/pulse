package proxy

import (
	"bytes"
	"strings"
	"testing"

	"pulse/internal/store"
)

func TestStripDefaultPort(t *testing.T) {
	cases := map[string]string{
		"https://host:443/x?q=1": "https://host/x?q=1",
		"http://host:80/x":       "http://host/x",
		"https://host:8443/x":    "https://host:8443/x",
		"http://host:8080/x":     "http://host:8080/x",
		"https://host/x":         "https://host/x",
		"https://host:443":       "https://host",
		"https://h:443/p#f":      "https://h/p#f",
		"not-a-url":              "not-a-url",
		"https://user@h:443/x":   "https://user@h/x",
	}
	for in, want := range cases {
		if got := stripDefaultPort(in); got != want {
			t.Errorf("stripDefaultPort(%q) = %q, want %q", in, got, want)
		}
	}
}

// The synthesized Host header must not carry a scheme-default port — browsers
// never send one and risk-control frontends (bilibili's 412) reject it.
func TestOutboundHostHeaderHasNoDefaultPort(t *testing.T) {
	var b bytes.Buffer
	req := &store.Request{
		Method: "GET", URL: "https://security.bilibili.com:443/static/js/app.js",
		HTTPVersion: "HTTP/1.1",
		Headers:     []store.Header{{Name: "User-Agent", Value: "Pulse"}},
	}
	if err := writeRequestHead(&b, req); err != nil {
		t.Fatal(err)
	}
	out := b.String()
	if !strings.Contains(out, "Host: security.bilibili.com\r\n") {
		t.Fatalf("Host header keeps the default port or is missing:\n%s", out)
	}
	if strings.Contains(out, ":443") {
		t.Fatalf(":443 leaked into the outbound request:\n%s", out)
	}

	// an explicit Host header is preserved verbatim (user intent wins)
	b.Reset()
	req.Headers = append(req.Headers, store.Header{Name: "Host", Value: "custom.example:8443"})
	if err := writeRequestHead(&b, req); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(b.String(), "Host: custom.example:8443\r\n") {
		t.Fatalf("explicit Host header must be preserved:\n%s", b.String())
	}
}
