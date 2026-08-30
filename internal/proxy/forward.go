package proxy

import (
	"sort"
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/http2"

	"pulse/internal/store"
)

const (
	DefaultMaxBody     = 10 << 20 // 10 MiB capture cap per message
	dialTimeout        = 10 * time.Second
	responseHeadTimout = 30 * time.Second
)

// Client sends captured requests upstream and captures the response.
// It dials manually (instead of http.Transport) so 101-upgraded connections
// can be handed back for raw tunneling. HTTPS requests that are not upgrades
// are first attempted over HTTP/2 (ALPN); anything that fails there falls
// back to the hand-rolled HTTP/1.1 path.
type Client struct {
	MaxBody     int64
	DialTimeout time.Duration
	// ResponseTimeout bounds reading the response head (SetTimeout updates).
	ResponseTimeout time.Duration
	// UpstreamTLS overrides the upstream TLS config (tests inject a trust
	// pool here). nil means system roots with SNI.
	UpstreamTLS *tls.Config

	h2mu  sync.Mutex
	h2tr  *http2.Transport
	h2tls *tls.Config // the UpstreamTLS the transport was built from
}

func NewClient() *Client {
	return &Client{MaxBody: DefaultMaxBody, DialTimeout: dialTimeout, ResponseTimeout: responseHeadTimout}
}

// SetTimeout configures the upstream response timeout (seconds). Values
// below 1 are ignored.
func (c *Client) SetTimeout(seconds int) {
	if seconds < 1 {
		return
	}
	c.ResponseTimeout = time.Duration(seconds) * time.Second
}

// Result carries the captured response. For 101 upgrades Raw is the live
// upstream connection (response head already consumed) for tunneling.
type Result struct {
	Resp     *store.Response
	Upgraded bool
	Raw      net.Conn
	RawBR    *bufio.Reader
}

func (c *Client) maxBody() int64 {
	if c.MaxBody <= 0 {
		return DefaultMaxBody
	}
	return c.MaxBody
}

// Do executes req against the origin server named in its URL.
// DoWithTimeout sends like Do but bounds the response-head read with the
// given timeout (0 = the client default). Used by Repeater sends.
func (c *Client) DoWithTimeout(req *store.Request, timeout time.Duration) (*Result, error) {
	saved := c.ResponseTimeout
	if timeout > 0 {
		c.ResponseTimeout = timeout
	}
	res, err := c.Do(req)
	c.ResponseTimeout = saved
	return res, err
}

func (c *Client) Do(req *store.Request) (*Result, error) {
	if strings.HasPrefix(strings.ToLower(req.URL), "https://") && !hasHeader(req.Headers, "Upgrade") {
		// HTTP/2 first: multiplexed, and most modern origins speak it. Any
		// failure (no h2 on ALPN, dial, stream error) falls through to the
		// HTTP/1.1 path below, which re-dials a fresh connection.
		if res, ok, err := c.doH2(req); ok {
			return res, err
		}
	}
	return c.doHTTP1(req)
}

// h2Transport lazily builds the HTTP/2 round tripper; rebuilt when tests
// swap UpstreamTLS after the client was constructed.
func (c *Client) h2Transport() *http2.Transport {
	c.h2mu.Lock()
	defer c.h2mu.Unlock()
	if c.h2tr == nil || c.h2tls != c.UpstreamTLS {
		cfg := &tls.Config{}
		if c.UpstreamTLS != nil {
			cfg = c.UpstreamTLS.Clone()
		}
		c.h2tr = &http2.Transport{TLSClientConfig: cfg}
		c.h2tls = c.UpstreamTLS
	}
	return c.h2tr
}

// doH2 sends req over HTTP/2. ok=false means "not handled — use HTTP/1.1"
// (the origin declined h2 or the transport failed before a usable stream).
func (c *Client) doH2(req *store.Request) (*Result, bool, error) {
	out, err := http.NewRequest(req.Method, req.URL, nil)
	if err != nil {
		return nil, false, nil
	}
	for _, h := range req.Headers {
		name := http.CanonicalHeaderKey(h.Name)
		if name == "Host" {
			continue // expressed via URL
		}
		if hopByHop(h.Name) || name == "Content-Length" || name == "Connection" {
			continue // illegal in HTTP/2 framing
		}
		out.Header.Add(name, h.Value)
	}
	if len(req.Body) > 0 {
		out.Body = io.NopCloser(bytes.NewReader(req.Body))
		out.ContentLength = int64(len(req.Body))
	}
	respTimeout := c.ResponseTimeout
	if respTimeout <= 0 {
		respTimeout = responseHeadTimout
	}
	ctx, cancel := context.WithTimeout(context.Background(), respTimeout)
	defer cancel()
	out = out.WithContext(ctx)

	hr, err := c.h2Transport().RoundTrip(out)
	if err != nil {
		// no h2 (or the stream died): let the HTTP/1.1 path retry
		return nil, false, nil
	}
	defer hr.Body.Close()

	body, truncated, err := readLimited(hr.Body, c.maxBody())
	if err != nil {
		hr.Body.Close()
		return nil, true, fmt.Errorf("read h2 response body: %w", err)
	}
	_ = hr.Body.Close()
	// hr.Status is "200 OK" — keep only the phrase for the stored reason
	reason := hr.Status
	if i := strings.IndexByte(hr.Status, ' '); i >= 0 {
		reason = hr.Status[i+1:]
	}
	resp := &store.Response{
		StatusCode:  hr.StatusCode,
		Reason:      reason,
		HTTPVersion: "HTTP/2.0",
		Headers:     headersFromHTTP(hr.Header),
		Body:        body,
		Truncated:   truncated,
		Timestamp:   time.Now(),
	}
	return &Result{Resp: resp}, true, nil
}

// headersFromHTTP flattens a net/http Header (a map — iteration order is
// randomized) into a stable, alphabetically ordered slice so the same
// response always renders identically.
func headersFromHTTP(h http.Header) []store.Header {
	names := make([]string, 0, len(h))
	for name := range h {
		names = append(names, name)
	}
	sort.Strings(names)
	out := make([]store.Header, 0, len(h))
	for _, name := range names {
		for _, v := range h[name] {
			out = append(out, store.Header{Name: name, Value: v})
		}
	}
	return out
}

func (c *Client) doHTTP1(req *store.Request) (*Result, error) {
	scheme := "http"
	rest := req.URL
	if i := strings.Index(rest, "://"); i >= 0 {
		scheme = strings.ToLower(rest[:i])
		rest = rest[i+3:]
	}
	if i := strings.IndexAny(rest, "/?#"); i >= 0 {
		rest = rest[:i]
	}
	if i := strings.LastIndexByte(rest, '@'); i >= 0 {
		rest = rest[i+1:]
	}
	if rest == "" {
		return nil, fmt.Errorf("request URL %q has no host", req.URL)
	}
	hostport := rest
	if !hasPort(hostport) {
		if scheme == "https" {
			hostport = net.JoinHostPort(hostport, "443")
		} else {
			hostport = net.JoinHostPort(hostport, "80")
		}
	}

	timeout := c.DialTimeout
	if timeout <= 0 {
		timeout = dialTimeout
	}
	raw, err := net.DialTimeout("tcp", hostport, timeout)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", hostport, err)
	}
	var conn net.Conn = raw
	if scheme == "https" {
		cfg := c.upstreamTLSConfig(hostport)
		tc := tls.Client(conn, cfg)
		_ = raw.SetDeadline(time.Now().Add(timeout))
		if err := tc.Handshake(); err != nil {
			conn.Close()
			return nil, fmt.Errorf("tls handshake with %s: %w", hostport, err)
		}
		_ = raw.SetDeadline(time.Time{})
		conn = tc
	}

	if err := writeRequestHead(conn, req); err != nil {
		conn.Close()
		return nil, fmt.Errorf("write request: %w", err)
	}
	if len(req.Body) > 0 {
		if _, err := conn.Write(req.Body); err != nil {
			conn.Close()
			return nil, fmt.Errorf("write request body: %w", err)
		}
	}

	br := bufio.NewReader(conn)
	respTimeout := c.ResponseTimeout
	if respTimeout <= 0 {
		respTimeout = responseHeadTimout
	}
	_ = conn.SetReadDeadline(time.Now().Add(respTimeout))
	head, err := readResponseHead(br)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("read response: %w", err)
	}
	_ = conn.SetReadDeadline(time.Time{})

	if head.code == 101 {
		return &Result{
			Upgraded: true,
			Raw:      conn,
			RawBR:    br,
			Resp: &store.Response{
				StatusCode:  head.code,
				Reason:      head.reason,
				HTTPVersion: head.version,
				Headers:     head.headers,
				Body:        []byte{},
				Timestamp:   time.Now(),
			},
		}, nil
	}

	body, truncated, err := readBody(br, head.headers, c.maxBody(), true, head.code)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("read response body: %w", err)
	}
	// Upstream connection pooling is future work; v0.1 closes per request.
	conn.Close()
	resp := &store.Response{
		StatusCode:  head.code,
		Reason:      head.reason,
		HTTPVersion: head.version,
		Headers:     head.headers,
		Body:        body,
		Truncated:   truncated,
		Timestamp:   time.Now(),
	}
	return &Result{Resp: resp}, nil
}

func (c *Client) upstreamTLSConfig(hostport string) *tls.Config {
	if c.UpstreamTLS != nil {
		cfg := c.UpstreamTLS.Clone()
		cfg.NextProtos = []string{"http/1.1"}
		if cfg.ServerName == "" {
			host, _, err := net.SplitHostPort(hostport)
			if err == nil {
				cfg.ServerName = host
			}
		}
		return cfg
	}
	host, _, err := net.SplitHostPort(hostport)
	if err != nil {
		host = hostport
	}
	return &tls.Config{ServerName: host, NextProtos: []string{"http/1.1"}}
}

func hasPort(host string) bool {
	_, _, err := net.SplitHostPort(host)
	return err == nil
}
