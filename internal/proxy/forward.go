package proxy

import (
	"bufio"
	"crypto/tls"
	"fmt"
	"net"
	"strings"
	"time"

	"pulse/internal/store"
)

const (
	DefaultMaxBody     = 10 << 20 // 10 MiB capture cap per message
	dialTimeout        = 10 * time.Second
	responseHeadTimout = 30 * time.Second
)

// Client sends captured requests upstream and captures the response.
// It dials manually (instead of http.Transport) so 101-upgraded connections
// can be handed back for raw tunneling.
type Client struct {
	MaxBody     int64
	DialTimeout time.Duration
	// UpstreamTLS overrides the upstream TLS config (tests inject a trust
	// pool here). nil means system roots with SNI.
	UpstreamTLS *tls.Config
}

func NewClient() *Client {
	return &Client{MaxBody: DefaultMaxBody, DialTimeout: dialTimeout}
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
func (c *Client) Do(req *store.Request) (*Result, error) {
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
	_ = conn.SetReadDeadline(time.Now().Add(responseHeadTimout))
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
