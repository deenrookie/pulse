// Package proxy implements the Pulse MITM proxy engine: listener, HTTPS
// interception, intercept queue integration, flow recording and tunneling.
package proxy

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
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
	// repTimeout bounds Repeater sends (0 = client default 30s).
	repTimeout time.Duration
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
// SetRepeaterTimeout bounds Repeater sends only; proxied traffic keeps the
// standard response-head timeout (Burp-like fixed default).
func (e *Engine) SetRepeaterTimeout(seconds int) { e.repTimeout = time.Duration(seconds) * time.Second }

func (e *Engine) ListenAndServe(addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("proxy listen %s: %w", addr, err)
	}
	return e.ServeListener(ln)
}

// ServeListener adopts an already-bound listener (main binds synchronously
// so api.New can safely compare against Addr() and rebind if settings ask).
func (e *Engine) ServeListener(ln net.Listener) error {
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
			}
			e.mu.Lock()
			cur := e.ln
			e.mu.Unlock()
			if cur != ln {
				return nil // listener was swapped out by Relisten
			}
			return err
		}
		go e.handleConn(conn)
	}
}

// Relisten swaps the proxy listener to a new address without stopping the
// engine: the new socket is bound first, then the old one closes. A failed
// bind leaves the current listener untouched.
func (e *Engine) Relisten(addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("proxy listen %s: %w", addr, err)
	}
	e.mu.Lock()
	old := e.ln
	e.ln = ln
	e.mu.Unlock()
	if old != nil {
		old.Close() // its Serve loop exits quietly via the swap check
	}
	go e.Serve(ln)
	return nil
}

// Addr reports the address the proxy listener is currently bound to.
func (e *Engine) Addr() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.ln == nil {
		return ""
	}
	return e.ln.Addr().String()
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
		NextProtos: []string{"h2", "http/1.1"},
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
	if tlsConn.ConnectionState().NegotiatedProtocol == "h2" {
		e.serveHTTP2(tlsConn, target)
		return
	}
	e.serveLoop(tlsConn, bufio.NewReader(tlsConn), target)
}

// respondFunc delivers the pipeline outcome to the client transport: either
// the final response or a gateway error (nil resp). Both HTTP/1 (conn
// writer) and HTTP/2 (ResponseWriter) paths provide one.
type respondFunc func(resp *store.Response, gwErr error) error

var errDroppedByInterceptor = errors.New("request dropped by interceptor")

// executeRequest runs the capture pipeline shared by every transport:
// record → plugins → match&replace → intercept → upstream → response hooks.
// It returns the upstream Result (Upgraded set only for HTTP/1 upgrades —
// the caller then owns the raw tunnel and the already-finalized flow), the
// flow, and whether the client connection may serve another request.
func (e *Engine) executeRequest(req *store.Request, respond respondFunc) (*Result, *store.Flow, bool) {
	req.ID = e.store.NewID()
	fl := &store.Flow{ID: req.ID, Req: *req, State: store.StatePending}
	if err := e.store.Add(fl); err != nil {
		log.Printf("store add: %v", err)
	}
	e.publishFlow("flow", fl)

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
				return nil, nil, false
			}
			// dropped by user or client vanished
			fl.State = store.StateDropped
			_ = e.store.Update(fl)
			e.publishFlow("flow_update", fl)
			_ = respond(nil, errDroppedByInterceptor)
			return nil, fl, false
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
		_ = respond(nil, err)
		return nil, fl, false
	}
	if res.Upgraded {
		fl.Resp = res.Resp
		fl.State = store.StateComplete
		_ = e.store.Update(fl)
		e.publishFlow("flow_update", fl)
		return res, fl, false // caller tunnels the raw connection
	}
	if e.Plugins != nil && e.Plugins.ApplyResponse(req, res.Resp) {
		fl.Resp = res.Resp
	}
	if e.Rewrite != nil && e.Rewrite.ApplyResponse(res.Resp) {
		fl.Resp = res.Resp
	}
	_ = respond(res.Resp, nil)
	// memory guard: the client already received the full payload — strip
	// oversized media/binary bodies before they are stored so they never
	// stay resident (the flow keeps its metadata plus a drop notice)
	if ct, ok := headerValue(res.Resp.Headers, "Content-Type"); ok {
		if e.store.ShouldDropBody(ct, len(res.Resp.Body)) {
			res.Resp.DroppedSize = len(res.Resp.Body)
			res.Resp.BodyDropped = true
			res.Resp.Body = []byte{}
			res.Resp.Truncated = false
		}
	}
	fl.Resp = res.Resp
	fl.State = store.StateComplete
	_ = e.store.Update(fl)
	e.publishFlow("flow_update", fl)
	return res, fl, true
}

// process runs the pipeline for one HTTP/1 request on a client connection
// and returns whether the connection may serve another request.
func (e *Engine) process(conn net.Conn, br *bufio.Reader, req *store.Request) bool {
	keepAlive := wantsKeepAlive(req)
	res, fl, alive := e.executeRequest(req, func(resp *store.Response, gwErr error) error {
		if gwErr != nil {
			return writeGatewayError(conn, "Pulse: "+gwErr.Error())
		}
		return writeResponseToClient(conn, resp, keepAlive)
	})
	if res != nil && res.Upgraded {
		_ = writeRawResponseHead(conn, respHeadOf(res.Resp))
		if isWebSocketUpgrade(req, res.Resp) {
			// parse-and-forward relay: frames recorded into fl.WSMessages
			e.relayWS(conn, br, res.Raw, res.RawBR, fl)
		} else {
			tunnel(conn, br, res.Raw, res.RawBR)
		}
		return false
	}
	return alive && keepAlive && res != nil && !res.Resp.Truncated
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
	res, err := e.client.DoWithTimeout(req, e.repTimeout)
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
		if ct, ok := headerValue(res.Resp.Headers, "Content-Type"); ok {
			if e.store.ShouldDropBody(ct, len(res.Resp.Body)) {
				res.Resp.DroppedSize = len(res.Resp.Body)
				res.Resp.BodyDropped = true
				res.Resp.Body = []byte{}
				res.Resp.Truncated = false
			}
		}
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
