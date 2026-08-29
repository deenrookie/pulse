// Package plugins runs JavaScript plugins (goja) that can observe and modify
// traffic passing through the proxy. Each plugin file is loaded from the
// plugins directory and executed in a fresh, isolated VM per request with a
// hard timeout, so a broken plugin can never take the proxy down.
package plugins

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dop251/goja"

	"pulse/internal/store"
)

const (
	hookTimeout  = 2 * time.Second
	logTailLines = 60
	metadataVar  = "plugin"
	requestHook  = "onRequest"
	responseHook = "onResponse"
)

// Plugin describes a loaded plugin file.
type Plugin struct {
	Name    string   `json:"name"`
	Version string   `json:"version"`
	File    string   `json:"file"`
	Enabled bool     `json:"enabled"`
	Hooks   []string `json:"hooks"`
	Hits    int64    `json:"hits"`
	Error   string   `json:"error,omitempty"`
	Log     []string `json:"log,omitempty"`

	src  string
	prog *goja.Program
}

// Runtime manages the plugin directory and applies hooks to traffic.
type Runtime struct {
	mu        sync.RWMutex
	dir       string
	plugins   []*Plugin
	statePath string
	timeout   time.Duration
}

func Open(dir, statePath string) (*Runtime, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create plugins dir: %w", err)
	}
	rt := &Runtime{dir: dir, statePath: statePath, timeout: hookTimeout}
	if err := rt.load(); err != nil {
		return nil, err
	}
	return rt, nil
}

// SetTimeout overrides the per-hook budget (tests).
func (r *Runtime) SetTimeout(d time.Duration) { r.mu.Lock(); r.timeout = d; r.mu.Unlock() }

func (r *Runtime) load() error {
	enabled := map[string]bool{}
	if data, err := os.ReadFile(r.statePath); err == nil {
		json.Unmarshal(data, &enabled)
	}
	entries, err := os.ReadDir(r.dir)
	if err != nil {
		return fmt.Errorf("read plugins dir: %w", err)
	}
	var list []*Plugin
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".js") {
			continue
		}
		src, err := os.ReadFile(filepath.Join(r.dir, e.Name()))
		if err != nil {
			continue
		}
		p := &Plugin{File: e.Name(), Enabled: true, src: string(src)}
		if v, ok := enabled[e.Name()]; ok {
			p.Enabled = v
		}
		r.compile(p)
		list = append(list, p)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].File < list[j].File })
	r.plugins = list
	return r.saveState()
}

func (r *Runtime) saveState() error {
	state := map[string]bool{}
	for _, p := range r.plugins {
		state[p.File] = p.Enabled
	}
	data, _ := json.MarshalIndent(state, "", "  ")
	tmp := r.statePath + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, r.statePath)
}

// compile builds the program and extracts metadata; failures are recorded on
// the plugin instead of aborting the load.
func (r *Runtime) compile(p *Plugin) {
	p.Error = ""
	p.Hooks = nil
	prog, err := goja.Compile(p.File, p.src, false)
	if err != nil {
		p.Error = "compile: " + err.Error()
		return
	}
	vm := goja.New()
	if _, err := vm.RunProgram(prog); err != nil {
		p.Error = "load: " + err.Error()
		return
	}
	if m := vm.Get(metadataVar); m != nil && !m.SameAs(goja.Undefined()) && !m.SameAs(goja.Null()) {
		var meta struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		}
		if b, err := json.Marshal(m.Export()); err == nil {
			json.Unmarshal(b, &meta)
			if meta.Name != "" {
				p.Name = meta.Name
			}
			p.Version = meta.Version
		}
	}
	if p.Name == "" {
		p.Name = strings.TrimSuffix(p.File, ".js")
	}
	if fn, ok := goja.AssertFunction(vm.Get(requestHook)); ok && fn != nil {
		p.Hooks = append(p.Hooks, "request")
	}
	if fn, ok := goja.AssertFunction(vm.Get(responseHook)); ok && fn != nil {
		p.Hooks = append(p.Hooks, "response")
	}
	p.prog = prog
}

// Reload rescans the plugins directory (pick up new/changed files).
func (r *Runtime) Reload() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	oldLogs := map[string][]string{}
	for _, p := range r.plugins {
		oldLogs[p.File] = p.Log
	}
	if err := r.load(); err != nil {
		return err
	}
	for _, p := range r.plugins {
		if log, ok := oldLogs[p.File]; ok {
			p.Log = log
		}
	}
	return nil
}

// List snapshots plugin metadata (with log tails).
func (r *Runtime) List() []Plugin {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Plugin, 0, len(r.plugins))
	for _, p := range r.plugins {
		cp := *p
		out = append(out, cp)
	}
	return out
}

// SetEnabled toggles a plugin without reloading.
func (r *Runtime) SetEnabled(file string, enabled bool) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, p := range r.plugins {
		if p.File == file {
			p.Enabled = enabled
			_ = r.saveState()
			return true
		}
	}
	return false
}

// Dir returns the plugins directory (for the UI hint).
func (r *Runtime) Dir() string { return r.dir }

func (r *Runtime) log(p *Plugin, lines []string) {
	if len(lines) == 0 {
		return
	}
	p.Log = append(p.Log, lines...)
	if len(p.Log) > logTailLines {
		p.Log = p.Log[len(p.Log)-logTailLines:]
	}
}

func (r *Runtime) recordError(p *Plugin, err error, hook string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	p.Error = err.Error()
	r.log(p, []string{hook + " error: " + err.Error()})
}

func (r *Runtime) recordSuccess(p *Plugin, logs []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	p.Error = ""
	p.Hits++
	r.log(p, logs)
}

// ApplyRequest runs every enabled plugin's onRequest hook against req.
// Errors are recorded on the plugin and never propagated to the proxy.
func (r *Runtime) ApplyRequest(req *store.Request) bool {
	r.mu.RLock()
	timeout := r.timeout
	plugins := make([]*Plugin, 0, len(r.plugins))
	for _, p := range r.plugins {
		if p.Enabled && p.prog != nil && hasHook(p, "request") {
			plugins = append(plugins, p)
		}
	}
	r.mu.RUnlock()

	changed := false
	for _, p := range plugins {
		ok, logs, err := r.runHook(p, requestHook, req, nil, timeout)
		if err != nil {
			r.recordError(p, err, requestHook)
			continue
		}
		r.recordSuccess(p, logs)
		if ok {
			changed = true
		}
	}
	return changed
}

// ApplyResponse runs every enabled plugin's onResponse hook.
func (r *Runtime) ApplyResponse(req *store.Request, resp *store.Response) bool {
	r.mu.RLock()
	timeout := r.timeout
	plugins := make([]*Plugin, 0, len(r.plugins))
	for _, p := range r.plugins {
		if p.Enabled && p.prog != nil && hasHook(p, "response") {
			plugins = append(plugins, p)
		}
	}
	r.mu.RUnlock()

	changed := false
	for _, p := range plugins {
		ok, logs, err := r.runHook(p, responseHook, req, resp, timeout)
		if err != nil {
			r.recordError(p, err, responseHook)
			continue
		}
		r.recordSuccess(p, logs)
		if ok {
			changed = true
		}
	}
	return changed
}

func hasHook(p *Plugin, name string) bool {
	for _, h := range p.Hooks {
		if h == name {
			return true
		}
	}
	return false
}

// runHook executes one plugin in a fresh VM within the given budget. It
// returns whether the message was modified, captured pulse.log lines, and an
// error.
func (r *Runtime) runHook(p *Plugin, hook string, req *store.Request, resp *store.Response, timeout time.Duration) (bool, []string, error) {
	vm := goja.New()
	if _, err := vm.RunProgram(p.prog); err != nil {
		return false, nil, fmt.Errorf("load: %w", err)
	}
	var logs []string
	pulseObj := vm.NewObject()
	_ = pulseObj.Set("version", "0.3.0")
	_ = pulseObj.Set("log", func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) > 0 {
			logs = append(logs, call.Arguments[0].String())
			if len(logs) > logTailLines {
				logs = logs[len(logs)-logTailLines:]
			}
		}
		return goja.Undefined()
	})
	vm.Set("pulse", pulseObj)

	ctx := vm.NewObject()
	_ = ctx.Set("request", exportRequest(vm, req))
	if resp != nil {
		_ = ctx.Set("response", exportResponse(vm, resp))
	}

	fn, ok := goja.AssertFunction(vm.Get(hook))
	if !ok || fn == nil {
		return false, logs, nil
	}

	timer := time.AfterFunc(timeout, func() { vm.Interrupt("plugin timeout") })
	defer timer.Stop()
	if _, err := fn(goja.Undefined(), ctx); err != nil {
		return false, logs, fmt.Errorf("%s: %w", hook, err)
	}

	changed := applyBackRequest(ctx.Get("request"), req)
	if resp != nil {
		if applyBackResponse(ctx.Get("response"), resp) {
			changed = true
		}
	}
	return changed, logs, nil
}

func exportRequest(vm *goja.Runtime, req *store.Request) goja.Value {
	o := vm.NewObject()
	_ = o.Set("method", req.Method)
	_ = o.Set("url", req.URL)
	_ = o.Set("httpVersion", req.HTTPVersion)
	_ = o.Set("headers", headerMaps(vm, req.Headers))
	_ = o.Set("body", string(req.Body))
	return o
}

func exportResponse(vm *goja.Runtime, resp *store.Response) goja.Value {
	o := vm.NewObject()
	_ = o.Set("status", resp.StatusCode)
	_ = o.Set("reason", resp.Reason)
	_ = o.Set("httpVersion", resp.HTTPVersion)
	_ = o.Set("headers", headerMaps(vm, resp.Headers))
	_ = o.Set("body", string(resp.Body))
	return o
}

func headerMaps(vm *goja.Runtime, headers []store.Header) goja.Value {
	maps := make([]map[string]any, 0, len(headers))
	for _, h := range headers {
		maps = append(maps, map[string]any{"name": h.Name, "value": h.Value})
	}
	return vm.ToValue(maps)
}

func applyBackRequest(v goja.Value, req *store.Request) bool {
	obj, ok := v.(*goja.Object)
	if !ok {
		return false
	}
	changed := false
	if s, ok := getString(obj, "method"); ok && s != req.Method {
		req.Method = s
		changed = true
	}
	if s, ok := getString(obj, "url"); ok && s != req.URL {
		req.URL = s
		changed = true
	}
	if s, ok := getString(obj, "body"); ok && s != string(req.Body) {
		req.Body = []byte(s)
		changed = true
	}
	if headers, ok := readHeaders(obj); ok && !headersEqual(headers, req.Headers) {
		req.Headers = headers
		changed = true
	}
	return changed
}

func applyBackResponse(v goja.Value, resp *store.Response) bool {
	obj, ok := v.(*goja.Object)
	if !ok {
		return false
	}
	changed := false
	if s, ok := getString(obj, "body"); ok && s != string(resp.Body) {
		resp.Body = []byte(s)
		changed = true
	}
	if headers, ok := readHeaders(obj); ok && !headersEqual(headers, resp.Headers) {
		resp.Headers = headers
		changed = true
	}
	if n, ok := getInt(obj, "status"); ok && n != resp.StatusCode {
		resp.StatusCode = n
		changed = true
	}
	return changed
}

func getString(obj *goja.Object, key string) (string, bool) {
	v := obj.Get(key)
	if v == nil || v.SameAs(goja.Undefined()) || v.SameAs(goja.Null()) {
		return "", false
	}
	s, ok := v.Export().(string)
	return s, ok
}

func getInt(obj *goja.Object, key string) (int, bool) {
	v := obj.Get(key)
	if v == nil {
		return 0, false
	}
	switch n := v.Export().(type) {
	case int:
		return n, true
	case int64:
		return int(n), true
	case float64:
		return int(n), true
	}
	return 0, false
}

func readHeaders(obj *goja.Object) ([]store.Header, bool) {
	v := obj.Get("headers")
	if v == nil || v.SameAs(goja.Undefined()) || v.SameAs(goja.Null()) {
		return nil, false
	}
	// goja exports Go-backed arrays as typed slices and pure-JS arrays as
	// []any; normalize both through reflection.
	rv := reflect.ValueOf(v.Export())
	if !rv.IsValid() || rv.Kind() != reflect.Slice && rv.Kind() != reflect.Array {
		return nil, false
	}
	out := make([]store.Header, 0, rv.Len())
	for i := 0; i < rv.Len(); i++ {
		item := rv.Index(i).Interface()
		if item == nil {
			continue
		}
		b, err := json.Marshal(item)
		if err != nil {
			continue
		}
		var h store.Header
		if err := json.Unmarshal(b, &h); err != nil || h.Name == "" {
			continue
		}
		out = append(out, h)
	}
	return out, true
}

func headersEqual(a, b []store.Header) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
