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
	"regexp"
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

// Plugin describes a loaded plugin file. Counters are separated so health is
// answerable: Attempts counts every hook invocation, Hits successful ones,
// Modified those that changed the message, Errors/Timeouts failures. LastError
// is sticky — a later success does not erase it.
type Plugin struct {
	Name    string   `json:"name"`
	Version string   `json:"version"`
	File    string   `json:"file"`
	Enabled bool     `json:"enabled"`
	Hooks   []string `json:"hooks"`
	Attempts int64   `json:"attempts"`
	Hits    int64    `json:"hits"`
	Modified int64   `json:"modified"`
	Errors  int64    `json:"errors"`
	Timeouts int64   `json:"timeouts"`
	LastError string `json:"lastError,omitempty"`
	LastErrorAt string `json:"lastErrorAt,omitempty"`
	Error   string   `json:"error,omitempty"`
	// RunningLastGood: the current source fails to load and the running
	// program comes from the last good revision.
	RunningLastGood bool `json:"runningLastGood,omitempty"`
	// Config: the plugin's declared configuration schema (no values).
	Config map[string]ConfigField `json:"configSchema,omitempty"`
	// Actions: declared manual actions (R2), runnable from flow menus.
	Actions []ActionDef `json:"actions,omitempty"`
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
	goodDir   string
	storesDir string
	timeout   time.Duration

	memories map[string]*pluginStore          // file -> memory store
	locals   map[string]*persistentStore      // file -> persistent store
	configs  *configManager
	tx       *txStates
}

func Open(dir, statePath string) (*Runtime, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create plugins dir: %w", err)
	}
	storesDir := storesDirFor(statePath)
	if err := os.MkdirAll(storesDir, 0o755); err != nil {
		return nil, fmt.Errorf("create plugin stores dir: %w", err)
	}
	rt := &Runtime{
		dir: dir, statePath: statePath, goodDir: statePath + "-good", storesDir: storesDir,
		timeout: hookTimeout,
		memories: map[string]*pluginStore{},
		locals:   map[string]*persistentStore{},
		configs:  openConfigs(configPathFor(statePath)),
		tx:       newTxStates(),
	}
	if err := os.MkdirAll(rt.goodDir, 0o755); err != nil {
		return nil, fmt.Errorf("create plugin revisions dir: %w", err)
	}
	if err := rt.load(); err != nil {
		return nil, err
	}
	return rt, nil
}

// memoryStore returns (creating on demand) the plugin's in-memory store.
func (r *Runtime) memoryStore(file string) *pluginStore {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.memories[file] == nil {
		r.memories[file] = newPluginStore()
	}
	return r.memories[file]
}

// localStore returns (creating on demand) the plugin's persistent store.
func (r *Runtime) localStore(file string) *persistentStore {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.locals[file] == nil {
		r.locals[file] = openPersistentStore(r.storesDir, file)
	}
	return r.locals[file]
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
		compile(p, r.timeout)
		if p.prog == nil {
			// The source on disk is broken. Keep the proxy working by
			// running the last revision that loaded, if there is one.
			if goodSrc, ok := r.readLastGood(e.Name()); ok {
				gp := &Plugin{File: e.Name(), Enabled: p.Enabled, src: goodSrc}
				compile(gp, r.timeout)
				if gp.prog != nil {
					broken := p.Error
					*p = *gp
					p.src = string(src) // the editor shows the current source
					p.Error = broken + " — running last good revision"
					p.RunningLastGood = true
				}
			}
		} else {
			r.writeLastGood(e.Name(), string(src))
		}
		list = append(list, p)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].File < list[j].File })
	r.plugins = list
	return r.saveState()
}

// readLastGood returns the newest source revision that compiled, if any.
func (r *Runtime) readLastGood(file string) (string, bool) {
	if !fileRe.MatchString(file) {
		return "", false
	}
	b, err := os.ReadFile(filepath.Join(r.goodDir, file))
	if err != nil {
		return "", false
	}
	return string(b), true
}

// writeLastGood persists a known-good revision (atomic, skipped when the
// content already matches).
func (r *Runtime) writeLastGood(file, src string) {
	if !fileRe.MatchString(file) {
		return
	}
	dst := filepath.Join(r.goodDir, file)
	if cur, err := os.ReadFile(dst); err == nil && string(cur) == src {
		return
	}
	tmp := dst + ".tmp"
	if err := os.WriteFile(tmp, []byte(src), 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, dst)
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
// the plugin instead of aborting the load. Top-level execution (init) runs
// under the same interrupt budget as hooks, so a `while (true)` at the top of
// a file cannot wedge a load.
func compile(p *Plugin, timeout time.Duration) {
	if timeout <= 0 {
		timeout = hookTimeout
	}
	p.Error = ""
	p.Hooks = nil
	prog, err := goja.Compile(p.File, p.src, false)
	if err != nil {
		p.Error = "compile: " + err.Error()
		return
	}
	vm := goja.New()
	timer := time.AfterFunc(timeout, func() { vm.Interrupt("plugin timeout") })
	_, err = vm.RunProgram(prog)
	timer.Stop()
	if err != nil {
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
	p.Config = extractConfig(vm)
	if fn, ok := goja.AssertFunction(vm.Get(requestHook)); ok && fn != nil {
		p.Hooks = append(p.Hooks, "request")
	}
	if fn, ok := goja.AssertFunction(vm.Get(responseHook)); ok && fn != nil {
		p.Hooks = append(p.Hooks, "response")
	}
	if fn, ok := goja.AssertFunction(vm.Get("onComplete")); ok && fn != nil {
		p.Hooks = append(p.Hooks, "complete")
	}
	p.Actions = extractActions(vm)
	p.prog = prog
}

// Reload rescans the plugins directory (pick up new/changed files).
func (r *Runtime) Reload() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.loadPreservingLogs()
}

// loadPreservingLogs rescans and keeps each plugin's log tail across reloads.
// Callers must hold r.mu.
func (r *Runtime) loadPreservingLogs() error {
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

// SetEnabled toggles a plugin without reloading. The bool reports whether the
// plugin exists; the error reports persistence failure so the UI can say the
// toggle will not survive a restart instead of silently succeeding.
func (r *Runtime) SetEnabled(file string, enabled bool) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, p := range r.plugins {
		if p.File == file {
			p.Enabled = enabled
			return true, r.saveState()
		}
	}
	return false, nil
}

// SetDir switches the plugins directory at runtime, rescanning it.
func (r *Runtime) SetDir(dir string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if dir == r.dir {
		return nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create plugins dir: %w", err)
	}
	r.dir = dir
	return r.loadPreservingLogs()
}

// Source returns the on-disk source of a loaded plugin.
func (r *Runtime) Source(file string) (string, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, p := range r.plugins {
		if p.File == file {
			return p.src, true
		}
	}
	return "", false
}

var fileRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*\.js$`)

// Write saves a plugin file into the directory (atomic replace) and rescans.
// Compile failures are not rejected here — the file is written and the load
// error is reported on the plugin so the UI can show it inline.
func (r *Runtime) Write(file, src string) error {
	if !fileRe.MatchString(file) {
		return fmt.Errorf("invalid plugin file name (want name.js, no path separators)")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	tmp := filepath.Join(r.dir, file+".tmp")
	if err := os.WriteFile(tmp, []byte(src), 0o644); err != nil {
		return fmt.Errorf("write plugin: %w", err)
	}
	if err := os.Rename(tmp, filepath.Join(r.dir, file)); err != nil {
		return fmt.Errorf("rename plugin: %w", err)
	}
	return r.loadPreservingLogs()
}

// Delete removes a plugin file and rescans.
func (r *Runtime) Delete(file string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !fileRe.MatchString(file) {
		return false
	}
	if err := os.Remove(filepath.Join(r.dir, file)); err != nil {
		return false
	}
	_ = r.loadPreservingLogs()
	return true
}

// Inspection is the result of compiling plugin source without side effects.
type Inspection struct {
	Name    string   `json:"name"`
	Version string   `json:"version"`
	Hooks   []string `json:"hooks"`
	Error   string   `json:"error,omitempty"`
}

// Inspect compiles src in a throwaway VM and reports metadata, detected hooks
// and any compile/load error — used by the editor's Check action.
func Inspect(src string) Inspection {
	var in Inspection
	p := &Plugin{File: "check.js", Enabled: true, src: src}
	compile(p, hookTimeout)
	in.Error = p.Error
	in.Name = p.Name
	in.Version = p.Version
	in.Hooks = p.Hooks
	return in
}

// TestOutcome is a sandbox hook run against caller-supplied messages.
type TestOutcome struct {
	Logs    []string        `json:"logs"`
	Error   string          `json:"error,omitempty"`
	Changed bool            `json:"changed"`
	Request *store.Request  `json:"request"`
	Resp    *store.Response `json:"response,omitempty"`
	/** ctx.respond was used: Resp carries the local response */
	Mocked  bool            `json:"mocked,omitempty"`
}

// TestRun compiles src and runs the named hook against copies of req/resp in
// the same isolated VM the proxy uses, returning logs, errors and the
// transformed messages — a dry run with zero traffic.
func TestRun(src, hook string, req *store.Request, resp *store.Response, timeout time.Duration) TestOutcome {
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
	changed, logs, err := (&Runtime{timeout: timeout, memories: map[string]*pluginStore{}, locals: map[string]*persistentStore{}, configs: openConfigs(filepath.Join(os.TempDir(), "pulse-test-config-" + fmt.Sprint(os.Getpid()) + ".json")), tx: newTxStates()}).runHook(p, hook, req, resp, timeout)
	if logs != nil {
		out.Logs = logs
	}
	out.Changed = changed
	if resp != nil {
		out.Resp = resp
	}
	if err != nil {
		out.Error = err.Error()
	}
	return out
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
	p.Attempts++
	p.Errors++
	if strings.Contains(err.Error(), "timeout") || strings.Contains(err.Error(), "interrupted") {
		p.Timeouts++
	}
	p.LastError = err.Error()
	p.LastErrorAt = time.Now().Format(time.RFC3339)
	r.log(p, []string{hook + " error: " + err.Error()})
}

func (r *Runtime) recordSuccess(p *Plugin, logs []string, modified bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	p.Attempts++
	p.Hits++
	if modified {
		p.Modified++
	}
	// LastError stays: a later success must not erase the failure history.
	r.log(p, logs)
}

// ApplyRequest runs every enabled plugin's onRequest hook against req.
// Errors are recorded on the plugin and never propagated to the proxy.
func (r *Runtime) ApplyRequest(req *store.Request) bool {
	changed, _ := r.ApplyRequestSender(req, nil)
	return changed
}

// ApplyResponse runs every enabled plugin's onResponse hook (R2: async
// scheduler with pulse.http support).
func (r *Runtime) ApplyResponse(req *store.Request, resp *store.Response) bool {
	return r.ApplyResponseSender(req, resp, nil)
}

// ApplyResponseSender is ApplyResponse with an explicit HTTP sender (tests
// inject a mock; nil means no network in this runtime yet).
func (r *Runtime) ApplyResponseSender(req *store.Request, resp *store.Response, sender HTTPSender) bool {
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
		res := r.runHookAsync(p, responseHook, req, resp, timeout, req.ID, sender)
		if res.Err != nil {
			r.recordError(p, res.Err, responseHook)
			continue
		}
		r.recordSuccess(p, res.Logs, res.Changed)
		if res.Changed {
			changed = true
		}
	}
	return changed
}

// ApplyRequestSender is ApplyRequest with an explicit HTTP sender.
func (r *Runtime) ApplyRequestSender(req *store.Request, sender HTTPSender) (bool, *TerminalAction) {
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
		res := r.runHookAsync(p, requestHook, req, nil, timeout, req.ID, sender)
		if res.Err != nil {
			r.recordError(p, res.Err, requestHook)
		} else {
			r.recordSuccess(p, res.Logs, res.Changed)
		}
		if res.Changed {
			changed = true
		}
		// a terminal action already taken stands even if the hook later
		// errored (e.g. a second respond/drop attempt)
		if res.Ctrl != nil && (res.Ctrl.respond != nil || res.Ctrl.drop) {
			return changed, res.Ctrl.Respawn()
		}
	}
	return changed, nil
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
	return r.runHookTx(p, hook, req, resp, timeout, "")
}

// runHookTx is runHook with an explicit transaction key (flow ID for live
// traffic; "" for sandbox/test runs — each test run gets its own state).
func (r *Runtime) runHookTx(p *Plugin, hook string, req *store.Request, resp *store.Response, timeout time.Duration, txKey string) (bool, []string, error) {
	if timeout <= 0 {
		timeout = hookTimeout
	}
	vm := goja.New()
	// the program re-initializes in every fresh VM — the budget must cover
	// that execution too, not just the hook call
	timer := time.AfterFunc(timeout, func() { vm.Interrupt("plugin timeout") })
	defer timer.Stop()
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
	// R1 SDK surface: message helpers, stores, config
	sdk(vm, pulseObj)
	buildStoresAPI(vm, pulseObj, r.memoryStore(p.File), r.localStore(p.File))
	vm.Set("pulse", pulseObj)

	// transaction state: request and response hooks of one flow share a map
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

	fn, ok := goja.AssertFunction(vm.Get(hook))
	if !ok || fn == nil {
		return false, logs, nil
	}

	if _, err := fn(goja.Undefined(), ctx); err != nil {
		return false, logs, fmt.Errorf("%s: %w", hook, err)
	}

	changed := applyBackRequest(ctx.Get("request"), req)
	if resp != nil {
		if applyBackResponse(ctx.Get("response"), resp) {
			changed = true
		}
		if txKey != "" {
			r.tx.drop(txKey) // response done — release the transaction
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

// ---------- R1 public API: config + stores ----------

// ConfigFields describes a plugin's config for the UI (secrets show set/not-set).
func (r *Runtime) ConfigFields(file string) []ConfigFieldView {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, p := range r.plugins {
		if p.File == file {
			return r.configs.describe(file, p.Config)
		}
	}
	return nil
}

// SetConfigValues validates and persists user values for a plugin.
func (r *Runtime) SetConfigValues(file string, values map[string]any) error {
	r.mu.RLock()
	var schema map[string]ConfigField
	found := false
	for _, p := range r.plugins {
		if p.File == file {
			schema = p.Config
			found = true
			break
		}
	}
	r.mu.RUnlock()
	if !found {
		return fmt.Errorf("no such plugin: %s", file)
	}
	return r.configs.setValues(file, schema, values)
}

// MemoryStateSnapshot returns the plugin's in-memory store contents (tests).
func (r *Runtime) MemoryStateSnapshot(file string) map[string]any {
	mem := r.memoryStore(file)
	out := map[string]any{}
	for _, k := range mem.keys() {
		if v, ok := mem.get(k); ok {
			out[k] = v
		}
	}
	return out
}
