// R2 async runtime: pulse.http.send with a host-owned event loop per hook
// run. goja cannot be touched from other goroutines, so HTTP responses are
// delivered back onto the VM's own goroutine through a channel the
// RunWithControl loop drains; vm.Interrupt covers the whole execution
// including pending awaits. Plugin-initiated requests bypass the plugin
// chain and rewrites (no recursion), are recorded with source "plugin" and
// the parent flow id, and enforce a per-request timeout.
package plugins

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/dop251/goja"
)

// HTTPSender abstracts who performs plugin HTTP requests (production: real
// transport with flow recording; tests/sandbox: mock mode).
type HTTPSender interface {
	// Send performs the request described by req and calls done exactly
	// once. It may run on any goroutine; the VM loop handles delivery.
	Send(req *PluginHTTPRequest, done func(*PluginHTTPResponse, error))
}

// PluginHTTPRequest is the parsed pulse.http.send({...}) argument.
type PluginHTTPRequest struct {
	Method     string
	URL        string
	Headers    [][2]string
	Body       string
	TimeoutMs  int64
	Redirects  string // "follow" (default) | "manual"
	FlowParent string // recorded as the originating flow when known
}

// PluginHTTPResponse is what the VM sees.
type PluginHTTPResponse struct {
	Status  int
	Reason  string
	Headers [][2]string
	Body    string
	Source  string // always "plugin"
	FlowID  string // id of the recorded flow (production sender)
}

// realSender performs requests through the engine's round-trip recorder.
type realSender struct {
	rt func(*PluginHTTPRequest) (*PluginHTTPResponse, error)
}

func (s realSender) Send(req *PluginHTTPRequest, done func(*PluginHTTPResponse, error)) {
	go func() {
		resp, err := s.rt(req)
		done(resp, err)
	}()
}

// mockSender implements Mock network mode: only URLs with a configured mock
// answer; anything else fails with "unmocked network request" — a test run
// can never silently reach the real network.
type mockEntry struct {
	status  int
	body    string
	headers [][2]string
	delayMs int64
}

type mockSender struct {
	mocks map[string]mockEntry // exact URL match
}

func (m mockSender) Send(req *PluginHTTPRequest, done func(*PluginHTTPResponse, error)) {
	go func() {
		entry, ok := m.mocks[req.URL]
		if !ok {
			done(nil, fmt.Errorf("unmocked network request: %s %s (configure a mock or use a live test)", req.Method, req.URL))
			return
		}
		if entry.delayMs > 0 {
			time.Sleep(time.Duration(entry.delayMs) * time.Millisecond)
		}
		done(&PluginHTTPResponse{
			Status: entry.status, Reason: http.StatusText(entry.status),
			Headers: entry.headers, Body: entry.body, Source: "plugin",
		}, nil)
	}()
}

// buildHTTPAPI wires pulse.http.send. The Promise resolves/rejects when the
// hook run's event loop delivers the response.
func buildHTTPAPI(vm *goja.Runtime, pulseObj *goja.Object, sender HTTPSender, events chan func(), budget time.Duration) {
	h := vm.NewObject()
	_ = h.Set("send", func(call goja.FunctionCall) goja.Value {
		arg, ok := call.Argument(0).(*goja.Object)
		if !ok {
			return vm.NewGoError(fmt.Errorf("pulse.http.send wants an options object"))
		}
		req := &PluginHTTPRequest{Method: "GET", Redirects: "follow"}
		if s, ok := objString(arg, "method"); ok && s != "" {
			req.Method = strings.ToUpper(s)
		}
		if s, ok := objString(arg, "url"); ok {
			req.URL = s
		}
		if req.URL == "" {
			return vm.NewGoError(fmt.Errorf("pulse.http.send: url is required"))
		}
		if v := arg.Get("headers"); v != nil && v != goja.Undefined() && v != goja.Null() {
			if arr, ok := v.(*goja.Object); ok && arr.ClassName() == "Array" {
				for i := 0; ; i++ {
					item := arr.Get(fmt.Sprintf("%d", i))
					if item == nil || item == goja.Undefined() {
						break
					}
					if o, ok := item.(*goja.Object); ok {
						n, _ := objString(o, "name")
						val, _ := objString(o, "value")
						if n != "" {
							req.Headers = append(req.Headers, [2]string{n, val})
						}
					}
				}
			}
		}
		if s, ok := objString(arg, "body"); ok {
			req.Body = s
		}
		if v := arg.Get("timeoutMs"); v != nil && !v.Equals(goja.Undefined()) {
			req.TimeoutMs = int64(v.ToFloat())
		}
		if s, ok := objString(arg, "redirects"); ok && (s == "manual" || s == "follow") {
			req.Redirects = s
		}

		promise, resolve, reject := vm.NewPromise()
		deadline := budget
		if req.TimeoutMs > 0 && time.Duration(req.TimeoutMs)*time.Millisecond < deadline {
			deadline = time.Duration(req.TimeoutMs) * time.Millisecond
		}
		timer := time.AfterFunc(deadline, func() {
			events <- func() {
				reject(vm.NewGoError(fmt.Errorf("pulse.http.send: timeout after %s", deadline)))
			}
		})
		sender.Send(req, func(resp *PluginHTTPResponse, err error) {
			events <- func() {
				timer.Stop()
				if err != nil {
					reject(vm.NewGoError(err))
					return
				}
				resolve(respToVM(vm, resp))
			}
		})
		return vm.ToValue(promise)
	})
	pulseObj.Set("http", h)
}

func respToVM(vm *goja.Runtime, r *PluginHTTPResponse) *goja.Object {
	o := vm.NewObject()
	_ = o.Set("status", r.Status)
	_ = o.Set("reason", r.Reason)
	var hdrs []map[string]any
	for _, h := range r.Headers {
		hdrs = append(hdrs, map[string]any{"name": h[0], "value": h[1]})
	}
	_ = o.Set("headers", hdrs)
	_ = o.Set("body", r.Body)
	_ = o.Set("source", r.Source)
	_ = o.Set("flowId", r.FlowID)
	return o
}

// pluginBodyReader adapts a string body for the shared transport.
func drainBody(rc io.ReadCloser, max int64) string {
	defer rc.Close()
	b, _ := io.ReadAll(io.LimitReader(rc, max))
	return string(b)
}

// sendViaHTTPClient is the concrete transport used by the production sender
// (the api layer records the flow around it).
func sendViaHTTPClient(r *PluginHTTPRequest) (*PluginHTTPResponse, error) {
	ctx := context.Background()
	if r.TimeoutMs > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(r.TimeoutMs)*time.Millisecond)
		defer cancel()
	}
	var body io.Reader
	if r.Body != "" {
		body = bytes.NewReader([]byte(r.Body))
	}
	req, err := http.NewRequestWithContext(ctx, r.Method, r.URL, body)
	if err != nil {
		return nil, err
	}
	for _, h := range r.Headers {
		req.Header.Add(h[0], h[1])
	}
	client := &http.Client{}
	if r.Redirects == "manual" {
		client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	out := &PluginHTTPResponse{
		Status: resp.StatusCode, Reason: resp.Status, Source: "plugin",
		Body: drainBody(resp.Body, 10<<20),
	}
	for name, vals := range resp.Header {
		for _, v := range vals {
			out.Headers = append(out.Headers, [2]string{name, v})
		}
	}
	return out, nil
}

// HTTPSenderFunc adapts a function into a sender.
type HTTPSenderFunc func(*PluginHTTPRequest) (*PluginHTTPResponse, error)

func (f HTTPSenderFunc) Send(req *PluginHTTPRequest, done func(*PluginHTTPResponse, error)) {
	realSender{rt: f}.Send(req, done)
}

// MockResponse is one configured mock answer.
type MockResponse struct {
	Status  int
	Body    string
	Headers [][2]string
	DelayMs int64
}

// MockSender builds a sender over exact-URL mocks.
func MockSender(mocks map[string]MockResponse) HTTPSender {
	entries := map[string]mockEntry{}
	for url, m := range mocks {
		entries[url] = mockEntry{status: m.Status, body: m.Body, headers: m.Headers, delayMs: m.DelayMs}
	}
	return mockSender{mocks: entries}
}

// SendDirect performs a plugin HTTP request without any engine coupling:
// direct transport, no plugin chain, no rewrites, no interception. The
// api layer's transport (which also records the flow) wraps this when a
// server is present; the engine's default uses it standalone.
func SendDirect(r *PluginHTTPRequest) (*PluginHTTPResponse, error) {
	return sendViaHTTPClient(r)
}

// atomicI64 is a tiny counter (int64 atomics without importing sync/atomic
// types everywhere).
type atomicI64 struct{ n int64 }

func (a *atomicI64) Add(d int64) int64 { return atomicAddInt64(&a.n, d) }
func (a *atomicI64) Load() int64       { return atomicLoadInt64(&a.n) }

// buildHTTPAPIWithPending wraps buildHTTPAPI counting outstanding sends so
// the run loop knows when the Promise graph has settled.
func buildHTTPAPIWithPending(vm *goja.Runtime, pulseObj *goja.Object, sender HTTPSender, events chan func(), budget time.Duration, pending *atomicI64) {
	wrapped := wrapSender(sender, pending)
	buildHTTPAPI(vm, pulseObj, wrapped, events, budget)
}

type countingSender struct {
	inner   HTTPSender
	pending *atomicI64
}

func (c countingSender) Send(req *PluginHTTPRequest, done func(*PluginHTTPResponse, error)) {
	c.pending.Add(1)
	c.inner.Send(req, func(resp *PluginHTTPResponse, err error) {
		done(resp, err)
		c.pending.Add(-1)
	})
}

func wrapSender(sender HTTPSender, pending *atomicI64) HTTPSender {
	if sender == nil {
		return nil
	}
	return countingSender{inner: sender, pending: pending}
}

func atomicAddInt64(p *int64, d int64) int64 { return atomic.AddInt64(p, d) }
func atomicLoadInt64(p *int64) int64         { return atomic.LoadInt64(p) }
