// Package proxy implements the Pulse MITM proxy engine: listener, HTTPS
// interception, intercept queue integration, flow recording and tunneling.
package proxy

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"strings"
	"sync"
	"time"

	"pulse/internal/certs"
	"pulse/internal/events"
	"pulse/internal/plugins"
	"pulse/internal/rewrite"
	"pulse/internal/store"
)

// Engine owns the proxy listener and the request pipeline.
type Engine struct {
	auth    *certs.Authority
	store   *store.Store
	bus     *events.Bus
	Inter   *Intercept
	client  *Client
	Plugins *plugins.Runtime
	Rewrite *rewrite.Engine
	mu      sync.Mutex
	ln      net.Listener
	ctx     context.Context
	cancel  context.CancelFunc
	version string
}

func New(auth *certs.Authority, st *store.Store, bus *events.Bus, rt *plugins.Runtime, rw *rewrite.Engine, version string) *Engine {
	ctx, cancel := context.WithCancel(context.Background())
	e := &Engine{
		auth:    auth,
		store:   st,
		bus:     bus,
		Inter:   NewIntercept(),
		client:  NewClient(),
		Plugins: rt,
		Rewrite: rw,
		ctx:     ctx,
		cancel:  cancel,
		version: version,
	}
	e.Inter.OnChange = func() {
		e.publish(events.Event{Name: "intercept", Data: mustJSON(map[string]any{
			"enabled": e.Inter.Enabled(),
			"pending": len(e.Inter.Pending()),
		})})
	}
	return e
}

// SetUpstreamTLS overrides upstream TLS verification (used by tests).
func (e *Engine) SetUpstreamTLS(cfg *tls.Config) { e.client.UpstreamTLS = cfg }

// CAPool exposes the interception CA pool (used by tests and the API).
func (e *Engine) CAPool() *x509.CertPool { return e.auth.CAPool() }

// ListenAndServe starts the proxy listener and blocks serving it.
// SetTimeout configures the upstream response timeout (seconds).
func (e *Engine) SetTimeout(seconds int) { e.client.SetTimeout(seconds) }

func (e *Engine) ListenAndServe(addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("proxy listen %s: %w", addr, err)
	}
	e.mu.Lock()
	e.ln = ln
	e.mu.Unlock()
	return e.Serve(ln)
}

func (e *Engine) Serve(ln net.Listener) error {
	for {
		conn, err := ln.Accept()
		if err != nil {
			select {
			case <-e.ctx.Done():
				return nil
			default:
				return err
			}
		}
		go e.handleConn(conn)
	}
}

// Close stops accepting and releases held intercepts.
func (e *Engine) Close() {
	e.cancel()
	e.mu.Lock()
	if e.ln != nil {
		e.ln.Close()
	}
	e.mu.Unlock()
}

func (e *Engine) handleConn(conn net.Conn) {
	defer conn.Close()
	br := bufio.NewReader(conn)
	e.serveLoop(conn, br, "")
}

// serveLoop reads requests until the connection dies. connectHost != ""
// means we are inside a MITM TLS session: targets are origin-form and are
// turned into absolute https URLs for that host:port.
func (e *Engine) serveLoop(conn net.Conn, br *bufio.Reader, connectHost string) {
	for {
		_ = conn.SetReadDeadline(time.Now().Add(15 * time.Minute))
		head, err := readRequestHead(br)
		if err != nil {
			return
		}
		_ = conn.SetReadDeadline(time.Time{})

		if head.method == "CONNECT" && connectHost == "" {
			e.handleConnect(conn, br, head.target)
			return
		}

		url := head.target
		if connectHost != "" {
			url = "https://" + connectHost + requestTarget(head.target)
		}
		if url == "" || url == ":" {
			return
		}

		body, truncated, err := readBody(br, head.headers, e.client.maxBody(), false, 0)
		if err != nil {
			return
		}
		req := &store.Request{
			Method:      head.method,
			URL:         url,
			HTTPVersion: head.version,
			Headers:     head.headers,
			Body:        body,
			Truncated:   truncated,
			Timestamp:   time.Now(),
			Source:      "proxy",
		}
		if !e.process(conn, br, req) {
			return
		}
	}
}

// bufferedConn lets a TLS server consume bytes already sitting in a
// bufio.Reader (e.g. a peeked ClientHello).
type bufferedConn struct {
	net.Conn
	br *bufio.Reader
}

func (c bufferedConn) Read(p []byte) (int, error) { return c.br.Read(p) }

// handleConnect answers a CONNECT tunnel. TLS traffic (any port, detected by
// sniffing the first bytes) gets MITM'd; anything else is a blind tunnel.
func (e *Engine) handleConnect(conn net.Conn, br *bufio.Reader, target string) {
	host, _, err := net.SplitHostPort(target)
	if err != nil {
		writeGatewayError(conn, "Pulse: malformed CONNECT target")
		return
	}
	if _, err := io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}

	// Sniff for a TLS ClientHello (record type 0x16, version 0x03xx).
	_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	head, err := br.Peek(3)
	if err != nil || head[0] != 0x16 || head[1] != 0x03 {
		// not TLS (or silent): blind bidirectional tunnel
		up, derr := net.DialTimeout("tcp", target, dialTimeout)
		if derr != nil {
			return
		}
		tunnel(conn, br, up, bufio.NewReader(up))
		return
	}

	tlsConn := tls.Server(bufferedConn{conn, br}, &tls.Config{
		GetCertificate: func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
			name := hello.ServerName
			if name == "" {
				name = host
			}
			return e.auth.Leaf(name)
		},
	})
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
	if err := tlsConn.HandshakeContext(e.ctx); err != nil {
		return // pinned client or TLS failure: nothing more we can do
	}
	_ = conn.SetDeadline(time.Time{})
	defer tlsConn.Close()
	e.serveLoop(tlsConn, bufio.NewReader(tlsConn), target)
}

// process runs the pipeline for one request on a client connection and
// returns whether the connection may serve another request. Pipeline order:
// record → plugins → match&replace → intercept → upstream; the response runs
// plugins → match&replace before reaching the client. The stored flow always
// reflects what was actually sent and received.
func (e *Engine) process(conn net.Conn, br *bufio.Reader, req *store.Request) bool {
	req.ID = e.store.NewID()
	fl := &store.Flow{ID: req.ID, Req: *req, State: store.StatePending}
	if err := e.store.Add(fl); err != nil {
		log.Printf("store add: %v", err)
	}
	e.publishFlow("flow", fl)

	keepAlive := wantsKeepAlive(req)

	if e.Plugins != nil && e.Plugins.ApplyRequest(req) {
		fl.Req = *req
		_ = e.store.Update(fl)
		e.publishFlow("flow_update", fl)
	}
	if e.Rewrite != nil && e.Rewrite.ApplyRequest(req) {
		fl.Req = *req
		_ = e.store.Update(fl)
		e.publishFlow("flow_update", fl)
	}

	// interception
	if e.Inter.Enabled() {
		fl.State = store.StateIntercepted
		_ = e.store.Update(fl)
		e.publishFlow("flow_update", fl)
		held, ok := e.Inter.Hold(e.ctx, req)
		if !ok {
			if e.ctx.Err() != nil {
				return false
			}
			// dropped by user or client vanished
			fl.State = store.StateDropped
			_ = e.store.Update(fl)
			e.publishFlow("flow_update", fl)
			writeGatewayError(conn, "Pulse: request dropped by interceptor")
			return false
		}
		if held != req {
			req = held
			fl.Req = *held
		}
		fl.State = store.StatePending
		_ = e.store.Update(fl)
		e.publishFlow("flow_update", fl)
	}

	res, err := e.client.Do(req)
	if err != nil {
		fl.State = store.StateError
		fl.Error = err.Error()
		_ = e.store.Update(fl)
		e.publishFlow("flow_update", fl)
		writeGatewayError(conn, fl.Error)
		return false
	}
	if res.Upgraded {
		_ = writeRawResponseHead(conn, respHeadOf(res.Resp))
		fl.Resp = res.Resp
		fl.State = store.StateComplete
		_ = e.store.Update(fl)
		e.publishFlow("flow_update", fl)
		if isWebSocketUpgrade(req, res.Resp) {
			// parse-and-forward relay: frames recorded into fl.WSMessages
			e.relayWS(conn, br, res.Raw, res.RawBR, fl)
		} else {
			tunnel(conn, br, res.Raw, res.RawBR)
		}
		return false
	}
	if e.Plugins != nil && e.Plugins.ApplyResponse(req, res.Resp) {
		fl.Resp = res.Resp
	}
	if e.Rewrite != nil && e.Rewrite.ApplyResponse(res.Resp) {
		fl.Resp = res.Resp
	}
	if err := writeResponseToClient(conn, res.Resp, keepAlive); err != nil {
		log.Printf("write response to client: %v", err)
	}
	fl.Resp = res.Resp
	fl.State = store.StateComplete
	_ = e.store.Update(fl)
	e.publishFlow("flow_update", fl)
	return keepAlive && !res.Resp.Truncated
}

// RoundTrip executes a request outside the proxy path (Repeater): records the
// flow, sends it and returns the resulting flow. Upgrade responses are
// reported as errors since there is no client connection to tunnel into.
func (e *Engine) RoundTrip(req *store.Request) *store.Flow {
	req.ID = e.store.NewID()
	if req.Source == "" {
		req.Source = "repeater"
	}
	req.Timestamp = time.Now()
	fl := &store.Flow{ID: req.ID, Req: *req, State: store.StatePending}
	if err := e.store.Add(fl); err != nil {
		log.Printf("store add: %v", err)
	}
	e.publishFlow("flow", fl)

	start := time.Now()
	res, err := e.client.Do(req)
	dur := time.Since(start).Milliseconds()
	switch {
	case err != nil:
		fl.State = store.StateError
		fl.Error = err.Error()
	case res.Upgraded:
		res.Raw.Close()
		fl.State = store.StateError
		fl.Error = "101 protocol upgrade is not supported in Repeater"
	default:
		fl.Resp = res.Resp
		fl.Resp.DurationMs = dur
		fl.State = store.StateComplete
	}
	_ = e.store.Update(fl)
	e.publishFlow("flow_update", fl)
	return fl
}

func wantsKeepAlive(req *store.Request) bool {
	if v, ok := headerValue(req.Headers, "Connection"); ok {
		for _, tok := range strings.Split(v, ",") {
			switch strings.ToLower(strings.TrimSpace(tok)) {
			case "close":
				return false
			case "keep-alive":
				return true
			}
		}
	}
	return req.HTTPVersion != "HTTP/1.0"
}

// tunnel splices two connections that may have buffered bytes on either
// side. The first direction to end tears down both sides.
func tunnel(a net.Conn, abr *bufio.Reader, b net.Conn, bbr *bufio.Reader) {
	defer a.Close()
	defer b.Close()
	done := make(chan struct{}, 2)
	go func() {
		spool(b, abr) // client-side reader → upstream
		done <- struct{}{}
	}()
	go func() {
		spool(a, bbr) // upstream-side reader → client
		done <- struct{}{}
	}()
	<-done
	a.Close()
	b.Close()
}

// spool copies buffered bytes first (they never reach io.Copy), then the rest.
func spool(dst io.Writer, src *bufio.Reader) {
	if n := src.Buffered(); n > 0 {
		chunk, _ := src.Peek(n)
		if len(chunk) > 0 {
			if _, err := dst.Write(chunk); err != nil {
				return
			}
		}
	}
	io.Copy(dst, src)
}

func respHeadOf(resp *store.Response) respHead {
	return respHead{version: resp.HTTPVersion, code: resp.StatusCode, reason: resp.Reason, headers: resp.Headers}
}

func (e *Engine) publishFlow(name string, fl *store.Flow) {
	e.publish(events.Event{Name: name, Data: mustJSON(fl)})
}

func (e *Engine) publish(ev events.Event) {
	e.bus.Publish(ev)
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte("{}")
	}
	return b
}
