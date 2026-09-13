// R2 actions: plugins declare manual actions in plugin.actions; the host
// surfaces them in flow context menus and runs them against a copy of the
// selected flow. Actions are pure functions of their input — the selected
// history record is never modified.
package plugins

import (
	"fmt"
	"time"

	"github.com/dop251/goja"

	"pulse/internal/store"
)

const actionTimeout = 10 * time.Second

func actionTimer(vm *goja.Runtime) func() {
	t := time.AfterFunc(actionTimeout, func() { vm.Interrupt("action timeout") })
	return func() { t.Stop() }
}

// ActionDef is one declared manual action.
type ActionDef struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Hint     string `json:"hint,omitempty"`
	Applies  string `json:"applies,omitempty"` // request | response | flow (default flow)
}

func extractActions(vm *goja.Runtime) []ActionDef {
	v := vm.Get(metadataVar)
	if v == nil || v == goja.Undefined() || v == goja.Null() {
		return nil
	}
	obj, ok := v.(*goja.Object)
	if !ok {
		return nil
	}
	av := obj.Get("actions")
	if av == nil || av == goja.Undefined() || av == goja.Null() {
		return nil
	}
	arr, ok := av.(*goja.Object)
	if !ok || arr.ClassName() != "Array" {
		return nil
	}
	var out []ActionDef
	for i := 0; ; i++ {
		item := arr.Get(fmt.Sprintf("%d", i))
		if item == nil || item == goja.Undefined() {
			break
		}
		o, ok := item.(*goja.Object)
		if !ok {
			continue
		}
		var def ActionDef
		def.ID, _ = objString(o, "id")
		def.Label, _ = objString(o, "label")
		def.Hint, _ = objString(o, "hint")
		def.Applies, _ = objString(o, "applies")
		if def.ID == "" {
			continue
		}
		// the action function must exist: actions.<id>(ctx)
		if fns, ok := vm.Get("actions").(*goja.Object); ok {
			if fn := fns.Get(def.ID); fn == nil || fn == goja.Undefined() {
				continue
			}
		}
		if def.Label == "" {
			def.Label = def.ID
		}
		out = append(out, def)
	}
	return out
}

// ActionOutcome is the result of running a manual action.
type ActionOutcome struct {
	Logs   []string `json:"logs"`
	Error  string   `json:"error,omitempty"`
	Result string   `json:"result,omitempty"` // JSON/text the action returned
	UsedHTTP bool   `json:"usedHttp"`
}

// RunAction executes actions.<id>(ctx) against a copy of the flow. ctx
// carries {flowId, request, response, result(text or json)} and the full
// pulse SDK; stores are the plugin's live stores.
func (r *Runtime) RunAction(file, actionID string, fl *store.Flow, sender HTTPSender) ActionOutcome {
	out := ActionOutcome{Logs: []string{}}
	r.mu.RLock()
	var p *Plugin
	for _, cand := range r.plugins {
		if cand.File == file {
			p = cand
			break
		}
	}
	r.mu.RUnlock()
	if p == nil || p.prog == nil {
		out.Error = "plugin not loaded: " + file
		return out
	}

	vm := goja.New()
	timer := actionTimer(vm)
	defer timer()
	if _, err := vm.RunProgram(p.prog); err != nil {
		out.Error = "load: " + err.Error()
		return out
	}
	var logs []string
	pulseObj := vm.NewObject()
	_ = pulseObj.Set("version", "0.3.0")
	_ = pulseObj.Set("log", func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) > 0 {
			logs = append(logs, call.Argument(0).String())
		}
		return goja.Undefined()
	})
	sdk(vm, pulseObj)
	buildStoresAPI(vm, pulseObj, r.memoryStore(p.File), r.localStore(p.File))
	buildFilesAPI(vm, pulseObj, p.File, r.files)
	events := make(chan func(), 64)
	buildHTTPAPI(vm, pulseObj, sender, events, actionTimeout)
	vm.Set("pulse", pulseObj)

	ctx := vm.NewObject()
	reqCopy := fl.Req
	_ = ctx.Set("flowId", fl.ID)
	_ = ctx.Set("request", exportRequest(vm, &reqCopy))
	if fl.Resp != nil {
		_ = ctx.Set("response", exportResponse(vm, fl.Resp))
	}
	_ = ctx.Set("config", vm.ToValue(r.configs.snapshot(p.File, p.Config)))

	fns, ok := vm.Get("actions").(*goja.Object)
	if !ok {
		out.Error = "plugin defines no actions"
		return out
	}
	fn, ok := goja.AssertFunction(fns.Get(actionID))
	if !ok {
		out.Error = "no such action: " + actionID
		return out
	}
	ret, err := fn(goja.Undefined(), ctx)
	for err == nil && len(events) > 0 {
		ev := <-events
		ev()
		_, err = vm.RunString("")
	}
	out.Logs = logs
	if err != nil {
		out.Error = err.Error()
		return out
	}
	if ret != nil && !ret.Equals(goja.Undefined()) && !ret.Equals(goja.Null()) {
		if s, ok := ret.Export().(string); ok {
			out.Result = s
		} else {
			out.Result = ret.String()
		}
	}
	return out
}
