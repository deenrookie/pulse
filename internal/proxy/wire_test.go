package proxy

import (
	"bufio"
	"bytes"
	"strings"
	"testing"

	"pulse/internal/store"
)

func TestReadRequestHeadOrderAndDups(t *testing.T) {
	in := "POST /path?a=1 HTTP/1.1\r\nHost: h.example\r\nX-A: one\r\nX-A: two\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\nBODY"
	head, err := readRequestHead(bufio.NewReader(strings.NewReader(in)))
	if err != nil {
		t.Fatalf("readRequestHead: %v", err)
	}
	if head.method != "POST" || head.target != "/path?a=1" || head.version != "HTTP/1.1" {
		t.Fatalf("head = %+v", head)
	}
	want := []store.Header{
		{Name: "Host", Value: "h.example"},
		{Name: "X-A", Value: "one"},
		{Name: "X-A", Value: "two"},
		{Name: "Set-Cookie", Value: "a=1"},
		{Name: "Set-Cookie", Value: "b=2"},
	}
	if len(head.headers) != len(want) {
		t.Fatalf("headers = %+v", head.headers)
	}
	for i, h := range want {
		if head.headers[i] != h {
			t.Fatalf("header[%d] = %+v, want %+v", i, head.headers[i], h)
		}
	}
}

func TestReadBodyChunked(t *testing.T) {
	in := "POST / HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWiki\r\n5\r\npedia\r\n0\r\nX-Trailer: v\r\n\r\nNEXT"
	br := bufio.NewReader(strings.NewReader(in))
	head, err := readRequestHead(br)
	if err != nil {
		t.Fatalf("head: %v", err)
	}
	body, trunc, err := readBody(br, head.headers, 1<<20, false, 0)
	if err != nil {
		t.Fatalf("readBody: %v", err)
	}
	if string(body) != "Wikipedia" || trunc {
		t.Fatalf("body=%q trunc=%v", body, trunc)
	}
	rest, _ := readLine(br)
	if rest != "NEXT" {
		t.Fatalf("framing desync: next line = %q", rest)
	}
}

func TestReadBodyTruncation(t *testing.T) {
	payload := strings.Repeat("x", 10)
	in := "POST / HTTP/1.1\r\nHost: h\r\nContent-Length: 10\r\n\r\n" + payload
	br := bufio.NewReader(strings.NewReader(in))
	head, _ := readRequestHead(br)
	body, trunc, err := readBody(br, head.headers, 4, false, 0)
	if err != nil {
		t.Fatalf("readBody: %v", err)
	}
	if len(body) != 4 || !trunc {
		t.Fatalf("body len=%d trunc=%v", len(body), trunc)
	}
	if br.Buffered() != 0 {
		t.Fatal("remainder not drained")
	}
}

func TestWriteRequestHead(t *testing.T) {
	req := &store.Request{
		Method: "POST", URL: "http://example.com:8080/api/x?y=2", HTTPVersion: "HTTP/1.1",
		Headers: []store.Header{
			{Name: "Host", Value: "example.com:8080"},
			{Name: "Proxy-Connection", Value: "keep-alive"},
			{Name: "Transfer-Encoding", Value: "chunked"},
			{Name: "X-Keep", Value: "yes"},
		},
		Body: []byte("abc"),
	}
	var buf bytes.Buffer
	if err := writeRequestHead(&buf, req); err != nil {
		t.Fatalf("writeRequestHead: %v", err)
	}
	out := buf.String()
	if !strings.HasPrefix(out, "POST /api/x?y=2 HTTP/1.1\r\n") {
		t.Fatalf("request line wrong: %q", out)
	}
	if !strings.Contains(out, "Host: example.com:8080\r\n") {
		t.Fatalf("Host missing: %q", out)
	}
	if !strings.Contains(out, "Content-Length: 3\r\n") {
		t.Fatalf("Content-Length missing: %q", out)
	}
	if strings.Contains(out, "Proxy-Connection") || strings.Contains(out, "Transfer-Encoding") {
		t.Fatalf("hop-by-hop leaked: %q", out)
	}
	if !strings.Contains(out, "X-Keep: yes\r\n") {
		t.Fatalf("end-to-end header dropped: %q", out)
	}
}

func TestWriteRequestHeadUpgradePassthrough(t *testing.T) {
	req := &store.Request{
		Method: "GET", URL: "http://h.example/chat", HTTPVersion: "HTTP/1.1",
		Headers: []store.Header{
			{Name: "Host", Value: "h.example"},
			{Name: "Upgrade", Value: "websocket"},
			{Name: "Connection", Value: "Upgrade"},
			{Name: "Sec-WebSocket-Key", Value: "k"},
		},
	}
	var buf bytes.Buffer
	if err := writeRequestHead(&buf, req); err != nil {
		t.Fatalf("writeRequestHead: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "Upgrade: websocket\r\n") || !strings.Contains(out, "Connection: Upgrade\r\n") {
		t.Fatalf("upgrade headers not passed through: %q", out)
	}
	if strings.Contains(out, "Content-Length") {
		t.Fatalf("unexpected Content-Length on upgrade: %q", out)
	}
}

func TestWriteResponseToClient(t *testing.T) {
	resp := &store.Response{
		StatusCode: 200, Reason: "OK", HTTPVersion: "HTTP/1.1",
		Headers: []store.Header{
			{Name: "Content-Type", Value: "application/json"},
			{Name: "Transfer-Encoding", Value: "chunked"},
			{Name: "Connection", Value: "keep-alive"},
		},
		Body: []byte(`{"ok":true}`),
	}
	var buf bytes.Buffer
	if err := writeResponseToClient(&buf, resp, true); err != nil {
		t.Fatalf("writeResponseToClient: %v", err)
	}
	out := buf.String()
	if !strings.HasPrefix(out, "HTTP/1.1 200 OK\r\n") {
		t.Fatalf("status line wrong: %q", out)
	}
	if !strings.Contains(out, "Content-Length: 11\r\n") {
		t.Fatalf("re-framed Content-Length missing: %q", out)
	}
	if strings.Contains(out, "Transfer-Encoding") {
		t.Fatalf("TE leaked: %q", out)
	}
	if !bytes.HasSuffix(buf.Bytes(), resp.Body) {
		t.Fatal("body not written")
	}
}

func TestRequestTargetAndHostOf(t *testing.T) {
	cases := []struct{ url, target, host string }{
		{"https://a.example:8443/p/q?z=1", "/p/q?z=1", "a.example:8443"},
		{"http://b.example", "/", "b.example"},
		{"https://u:p@c.example/x", "/x", "c.example"},
	}
	for _, c := range cases {
		if got := requestTarget(c.url); got != c.target {
			t.Fatalf("requestTarget(%s) = %s, want %s", c.url, got, c.target)
		}
		if got := hostOf(c.url); got != c.host {
			t.Fatalf("hostOf(%s) = %s, want %s", c.url, got, c.host)
		}
	}
}
