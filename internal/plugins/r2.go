// R2 hook-run control: a single-owner event loop per VM run, plus the
// ctx.respond / ctx.drop terminal actions and the onComplete hook.
package plugins

import (
	"fmt"
	"time"

	"github.com/dop251/goja"

	"pulse/internal/store"
)

// runControl carries the per-run terminal decision out of the VM.
type runControl struct {
	// respond set: serve this response locally, skip the upstream send
	respond *store.Response
	// drop set: terminate the transaction (client gets a 502), plugin-attributed
	drop bool
	dropReason string
	// onComplete payload: run read-only analysis after the flow completes
	completeVal any
}

// Respawned returns the local response ctx.respond produced (nil if none).
func (c *runControl) Respawned() *store.Response { return c.respond }

// IsDrop reports ctx.drop usage.
func (c *runControl) IsDrop() bool { return c.drop }

// DropReasonText returns the optional drop reason.
func (c *runControl) DropReasonText() string { return c.dropReason }

// ControlResp exposes the respond decision cross-package.
func (res RunResult) ControlResp() *store.Response { return res.Ctrl.Respawned() }

// ControlDrop exposes the drop decision cross-package.
func (res RunResult) ControlDrop() bool { return res.Ctrl.IsDrop() }

// ControlDropReason exposes the drop reason cross-package.
func (res RunResult) ControlDropReason() string { return res.Ctrl.DropReasonText() }

// ApplyRequestR2 is the engine-facing R2 entry: returns changed plus a
// terminal-action view (resp/drop) without exporting internals.
func (r *Runtime) ApplyRequestR2(req *store.Request, sender HTTPSender) (bool, *TerminalAction) {
	return r.ApplyRequestSender(req, sender)
}

// TerminalAction is the exported view of ctx.respond / ctx.drop.
type TerminalAction struct {
	Resp       *store.Response
	Drop       bool
	DropReason string
}

// Respawn maps runControl into the exported TerminalAction.
func (c *runControl) Respawn() *TerminalAction {
	if c == nil {
		return nil
	}
	return &TerminalAction{Resp: c.respond, Drop: c.drop, DropReason: c.dropReason}
}

// RunResult extends the classic (changed, logs, err) with R2 control.
type RunResult struct {
	Changed bool
	Logs    []string
	Err     error
	Ctrl    *runControl
}

// runHookAsync executes one hook with the R2 event loop: waits for pending
// pulse.http.send promises (single-owner scheduler), enforces one overall
// budget via vm.Interrupt, and reports terminal actions.
func (r *Runtime) runHookAsync(p *Plugin, hook string, req *store.Request, resp *store.Response, timeout time.Duration, txKey string, sender HTTPSender) RunResult {
	if timeout <= 0 {
		timeout = hookTimeout
	}
	res := RunResult{Ctrl: &runControl{}}
	vm := goja.New()
	timer := time.AfterFunc(timeout, func() { vm.Interrupt("plugin timeout") })
	defer timer.Stop()

	if _, err := vm.RunProgram(p.prog); err != nil {
		res.Err = fmt.Errorf("load: %w", err)
		return res
	}

	var logs []string
	pulseObj := vm.NewObject()
	_ = pulseObj.Set("version", "0.3.0")
	_ = pulseObj.Set("log", func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) > 0 {
			logs = append(logs, call.Argument(0).String())
			if len(logs) > logTailLines {
				logs = logs[len(logs)-logTailLines:]
			}
		}
		return goja.Undefined()
	})
	sdk(vm, pulseObj)
	buildStoresAPI(vm, pulseObj, r.memoryStore(p.File), r.localStore(p.File))
	// events is drained on this goroutine only — the VM stays single-owner
	events := make(chan func(), 64)
	var pendingSends atomicI64
	buildHTTPAPIWithPending(vm, pulseObj, sender, events, timeout, &pendingSends)
	vm.Set("pulse", pulseObj)

	// transaction state (same semantics as the sync path)
	txMap := r.tx.get(txKey, p.File)
	if txMap == nil {
		txMap = map[string]any{}
	}
	syncTx := func(m map[string]any) { r.tx.put(txKey, p.File, m) }

	txObj := vm.NewObject()
	_ = txObj.Set("get", func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) < 1 {
			return goja.Undefined()
		}
		if v, ok := txMap[call.Argument(0).String()]; ok {
			return vm.ToValue(v)
		}
		return goja.Undefined()
	})
	_ = txObj.Set("set", func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) >= 2 {
			txMap[call.Argument(0).String()] = call.Argument(1).Export()
			syncTx(txMap)
		}
		return goja.Undefined()
	})
	_ = txObj.Set("delete", func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) >= 1 {
			delete(txMap, call.Argument(0).String())
			syncTx(txMap)
		}
		return goja.Undefined()
	})
	_ = txObj.Set("keys", func(call goja.FunctionCall) goja.Value {
		out := make([]string, 0, len(txMap))
		for k := range txMap {
			out = append(out, k)
		}
		return vm.ToValue(out)
	})

	ctx := vm.NewObject()
	_ = ctx.Set("request", exportRequest(vm, req))
	if resp != nil {
		_ = ctx.Set("response", exportResponse(vm, resp))
	}
	_ = ctx.Set("flowId", txKey)
	_ = ctx.Set("state", txObj)
	_ = ctx.Set("config", vm.ToValue(r.configs.snapshot(p.File, p.Config)))

	// terminal actions (request phase)
	_ = ctx.Set("respond", func(call goja.FunctionCall) goja.Value {
		if hook != requestHook {
			panic(vm.NewGoError(fmt.Errorf("ctx.respond is only available in onRequest")))
		}
		if res.Ctrl.respond != nil || res.Ctrl.drop {
			panic(vm.NewGoError(fmt.Errorf("the transaction already has a terminal action")))
		}
		arg, ok := call.Argument(0).(*goja.Object)
		if !ok {
			panic(vm.NewGoError(fmt.Errorf("ctx.respond wants {status, headers, body}")))
		}
		local := &store.Response{StatusCode: 200, Reason: "OK", HTTPVersion: "HTTP/1.1", Headers: []store.Header{}, Timestamp: time.Now()}
		if v := arg.Get("status"); v != nil && v != goja.Undefined() {
			local.StatusCode = int(v.ToInteger())
			local.Reason = reasonOrDefault(local.StatusCode)
		}
		if hs, ok := arg.Get("headers").(*goja.Object); ok && hs.ClassName() == "Array" {
			for i := 0; ; i++ {
				item := hs.Get(fmt.Sprintf("%d", i))
				if item == nil || item == goja.Undefined() {
					break
				}
				if o, ok := item.(*goja.Object); ok {
					n, _ := objString(o, "name")
					val, _ := objString(o, "value")
					if n != "" {
						local.Headers = append(local.Headers, store.Header{Name: n, Value: val})
					}
				}
			}
		}
		if s, ok := objString(arg, "body"); ok {
			local.Body = []byte(s)
		}
		local.Headers = append(local.Headers, store.Header{Name: "Content-Length", Value: fmt.Sprintf("%d", len(local.Body))})
		res.Ctrl.respond = local
		pulseLogf(&logs, "ctx.respond: serving a local %d response", local.StatusCode)
		return goja.Undefined()
	})
	_ = ctx.Set("drop", func(call goja.FunctionCall) goja.Value {
		if res.Ctrl.respond != nil || res.Ctrl.drop {
			panic(vm.NewGoError(fmt.Errorf("the transaction already has a terminal action")))
		}
		res.Ctrl.drop = true
		if len(call.Arguments) > 0 {
			arg := call.Argument(0)
			if o, ok := arg.(*goja.Object); ok {
				if rs, ok2 := objString(o, "reason"); ok2 {
					res.Ctrl.dropReason = rs
				} else {
					res.Ctrl.dropReason = o.String()
				}
			} else if arg != goja.Undefined() && arg != goja.Null() {
				res.Ctrl.dropReason = arg.String()
			}
		}
		pulseLogf(&logs, "ctx.drop: transaction blocked (%s)", res.Ctrl.dropReason)
		return goja.Undefined()
	})

	fn, ok := goja.AssertFunction(vm.Get(hook))
	if !ok || fn == nil {
		res.Logs = logs
		return res
	}

	// run the hook; because it may return a Promise, wait for every pending
	// pulse.http.send to settle (delivery + microtask flush), bounded by the
	// remaining budget — the interrupt timer guards pathological loops
	ret, err := fn(goja.Undefined(), ctx)
	if err == nil {
		_, err = vm.RunString("") // flush microtasks
	}
	// settle condition: the hook's own Promise resolved/rejected, or (sync
	// hooks) no network sends outstanding
	var hookPromise *goja.Promise
	if o, ok := ret.(*goja.Object); ok {
		hookPromise, _ = o.Export().(*goja.Promise)
	}
	settled := func() bool {
		if hookPromise != nil {
			return hookPromise.State() != goja.PromiseStatePending
		}
		return pendingSends.Load() == 0 && len(events) == 0
	}
	deadline := time.Now().Add(timeout)
	for err == nil && !settled() {
		remain := time.Until(deadline)
		if remain <= 0 {
			err = fmt.Errorf("plugin timeout waiting for network")
			break
		}
		select {
		case ev := <-events:
			ev()
			_, err = vm.RunString("") // flush microtasks after delivery
		case <-time.After(remain):
			err = fmt.Errorf("plugin timeout waiting for network")
		}
	}
	res.Logs = logs
	if err != nil {
		res.Err = fmt.Errorf("%s: %w", hook, err)
		return res
	}

	// message writeback (skipped for terminal actions — respond/drop own it)
	if res.Ctrl.respond == nil && !res.Ctrl.drop {
		res.Changed = applyBackRequest(ctx.Get("request"), req)
		if resp != nil {
			if applyBackResponse(ctx.Get("response"), resp) {
				res.Changed = true
			}
			if txKey != "" {
				r.tx.drop(txKey)
			}
		}
	}
	if res.Ctrl.drop {
		// drop captures its own view of the request for the record
		res.Changed = true
	}
	return res
}

// RunOnComplete executes the plugin's onComplete(ctx) against a completed
// flow — read-only: request/response exported, no writeback.
func (r *Runtime) RunOnComplete(p *Plugin, fl *store.Flow, sender HTTPSender) RunResult {
	if !hasHook(p, "complete") {
		return RunResult{Ctrl: &runControl{}}
	}
	// reuse runHookAsync with a synthesized response-phase call, then drop writeback
	res := r.runHookAsync(p, "onComplete", &fl.Req, fl.Resp, hookTimeout, fl.ID, sender)
	return res
}

func reasonOrDefault(status int) string {
	if reason := httpReason(status); reason != "" {
		return reason
	}
	return "Status"
}

func pulseLogf(logs *[]string, format string, args ...any) {
	*logs = append(*logs, fmt.Sprintf(format, args...))
}

func httpReason(status int) string {
	return map[int]string{
		200: "OK", 201: "Created", 202: "Accepted", 204: "No Content",
		301: "Moved Permanently", 302: "Found", 304: "Not Modified",
		400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
		405: "Method Not Allowed", 409: "Conflict", 418: "I'm a teapot",
		429: "Too Many Requests", 500: "Internal Server Error",
		502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
	}[status]
}

// TestRunWithSender runs a sandbox hook with an explicit HTTP sender (mock
// network by default in tests). State is isolated per run.
func (r *Runtime) TestRunWithSender(src, hook string, req *store.Request, resp *store.Response, timeout time.Duration, sender HTTPSender) TestOutcome {
	out := TestOutcome{Logs: []string{}, Request: req}
	if hook != requestHook && hook != responseHook {
		out.Error = "hook must be onRequest or onResponse"
		return out
	}
	p := &Plugin{File: "test.js", Enabled: true, src: src}
	compile(p, timeout)
	if p.Error != "" {
		out.Error = p.Error
		return out
	}
	internal := "request"
	if hook == responseHook {
		internal = "response"
	}
	if !hasHook(p, internal) {
		out.Error = "plugin does not define " + hook + "(ctx)"
		return out
	}
	rt := &Runtime{timeout: timeout, memories: map[string]*pluginStore{}, locals: map[string]*persistentStore{}, configs: &configManager{data: map[string]map[string]any{}}, tx: newTxStates()}
	res := rt.runHookAsync(p, hook, req, resp, timeout, "", sender)
	if res.Logs != nil {
		out.Logs = res.Logs
	}
	out.Changed = res.Changed
	if resp != nil {
		out.Resp = resp
	}
	if res.Ctrl != nil && res.Ctrl.respond != nil {
		out.Mocked = true
		out.Resp = res.Ctrl.respond
	}
	if res.Err != nil {
		out.Error = res.Err.Error()
	}
	return out
}

// ProductionSender returns the transport plugins get in the live proxy: a
// chain-bypassing round trip recorded with source "plugin". Set by the
// engine package to avoid an import cycle through a function value.
var ProductionSender func(interface{}) HTTPSender

// RunComplete runs every enabled plugin's onComplete for a finished flow.
// The sender may be nil when no production transport is wired (tests).
func (r *Runtime) RunComplete(fl *store.Flow, sender HTTPSender) {
	r.mu.RLock()
	var list []*Plugin
	for _, p := range r.plugins {
		if p.Enabled && p.prog != nil && hasHook(p, "complete") {
			list = append(list, p)
		}
	}
	r.mu.RUnlock()
	for _, p := range list {
		res := r.runHookAsync(p, "onComplete", &fl.Req, fl.Resp, hookTimeout, fl.ID, sender)
		if res.Err != nil {
			r.recordError(p, res.Err, "onComplete")
			continue
		}
		r.recordSuccess(p, res.Logs, res.Changed)
	}
}

// ApplyToRequest runs the plugin's onRequest against a copy of the given
// request (Repeater preview) — no traffic, no terminal actions applied.
func (r *Runtime) ApplyToRequest(file string, req *store.Request) TestOutcome {
	out := TestOutcome{Logs: []string{}, Request: req}
	r.mu.RLock()
	var p *Plugin
	for _, cand := range r.plugins {
		if cand.File == file {
			p = cand
			break
		}
	}
	r.mu.RUnlock()
	if p == nil {
		out.Error = "no such plugin: " + file
		return out
	}
	if p.prog == nil {
		out.Error = "plugin not loaded: " + file
		return out
	}
	res := r.runHookAsync(p, requestHook, req, nil, hookTimeout, "", nil)
	out.Logs = res.Logs
	out.Changed = res.Changed
	out.Error = ""
	if res.Err != nil {
		out.Error = res.Err.Error()
	}
	return out
}
