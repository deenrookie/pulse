// R1 state: per-transaction ctx.state, plugin memory store (cross-request,
// restart-lost) and plugin persistent store (JSON, restart-kept). Values are
// copied across the VM boundary — no shared JS objects.
package plugins

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/dop251/goja"
)

// txStates tracks per-flow transaction state: the same plugin's request and
// response hooks for one flow see the same map. Cleared when the flow
// completes (ApplyResponse) or on a timeout.
type txStates struct {
	mu    sync.Mutex
	state map[string]map[string]any // flowID -> pluginFile -> values
}

func newTxStates() *txStates { return &txStates{state: map[string]map[string]any{}} }

func (t *txStates) get(flowKey, plugin string) map[string]any {
	t.mu.Lock()
	defer t.mu.Unlock()
	byPlugin := t.state[flowKey]
	if byPlugin == nil {
		return nil
	}
	if m, ok := byPlugin[plugin].(map[string]any); ok {
		return m
	}
	return nil
}

func (t *txStates) put(flowKey, plugin string, m map[string]any) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.state[flowKey] == nil {
		t.state[flowKey] = map[string]any{}
	}
	t.state[flowKey][plugin] = m
}

func (t *txStates) drop(flowKey string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.state, flowKey)
}

// buildStateAPI exposes a state map to the VM. Writes via the returned object
// are captured back on every mutation through a Proxy-free approach: the map
// is exported once and re-imported by the host after the hook returns, which
// keeps semantics simple (last state wins) and copy-safe.
func buildStateAPI(vm *goja.Runtime, target map[string]any, snapshot func(map[string]any)) {
	o := vm.NewObject()
	_ = o.Set("get", func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) < 1 {
			return goja.Undefined()
		}
		v, ok := target[call.Argument(0).String()]
		if !ok {
			return goja.Undefined()
		}
		return vm.ToValue(v)
	})
	_ = o.Set("set", func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) < 2 {
			return goja.Undefined()
		}
		target[call.Argument(0).String()] = call.Argument(1).Export()
		snapshot(target)
		return goja.Undefined()
	})
	_ = o.Set("delete", func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) >= 1 {
			delete(target, call.Argument(0).String())
			snapshot(target)
		}
		return goja.Undefined()
	})
	_ = o.Set("keys", func(call goja.FunctionCall) goja.Value {
		out := make([]string, 0, len(target))
		for k := range target {
			out = append(out, k)
		}
		return vm.ToValue(out)
	})
	vm.RunString("var __stateObj = undefined") // placeholder to keep linters honest
	stateVar, _ := vm.Get("__stateObj").(*goja.Object)
	_ = stateVar
	vm.Set("state", o)
}

// ---- plugin stores ----

const (
	storeMaxKeys   = 256
	storeMaxBytes  = 256 << 10
	memStoreMaxTTL = 0 // memory store has no TTL by default in R1
)

type memEntry struct {
	value   any
	expires time.Time // zero = no TTL
}

// pluginStore is the in-memory cross-request store (lost on restart).
type pluginStore struct {
	mu    sync.Mutex
	items map[string]memEntry
}

func newPluginStore() *pluginStore { return &pluginStore{items: map[string]memEntry{}} }

func (s *pluginStore) get(key string) (any, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.items[key]
	if !ok {
		return nil, false
	}
	if !e.expires.IsZero() && time.Now().After(e.expires) {
		delete(s.items, key)
		return nil, false
	}
	return e.value, true
}

func (s *pluginStore) set(key string, value any, ttl time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.items) >= storeMaxKeys {
		// refuse silently beyond the cap — visible via keys()
		if _, exists := s.items[key]; !exists {
			return
		}
	}
	var exp time.Time
	if ttl > 0 {
		exp = time.Now().Add(ttl)
	}
	s.items[key] = memEntry{value: value, expires: exp}
}

func (s *pluginStore) del(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.items, key)
}

func (s *pluginStore) keys() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.items))
	now := time.Now()
	for k, e := range s.items {
		if !e.expires.IsZero() && now.After(e.expires) {
			continue
		}
		out = append(out, k)
	}
	return out
}

func (s *pluginStore) increment(key string, delta int64) int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	var cur int64
	switch v := s.items[key].value.(type) {
	case float64:
		cur = int64(v)
	case int64:
		cur = v
	case int:
		cur = int64(v)
	}
	next := cur + delta
	s.items[key] = memEntry{value: next}
	return next
}

// persistentStore is a JSON-file-backed map per plugin file (survives
// restarts). Writes are atomic tmp+rename; errors surface to the VM.
type persistentStore struct {
	mu   sync.Mutex
	path string
	data map[string]any
}

func openPersistentStore(dir, file string) *persistentStore {
	s := &persistentStore{path: filepath.Join(dir, storeFileSafe(file)+".json"), data: map[string]any{}}
	if b, err := os.ReadFile(s.path); err == nil {
		var m map[string]any
		if json.Unmarshal(b, &m) == nil && m != nil {
			s.data = m
		}
	}
	return s
}

func (s *persistentStore) persist() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := json.Marshal(s.data)
	if err != nil {
		return err
	}
	if len(b) > storeMaxBytes {
		return errStoreTooLarge
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func storeFileSafe(file string) string {
	out := make([]rune, 0, len(file))
	for _, r := range file {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '-', r == '_':
			out = append(out, r)
		default:
			out = append(out, '_')
		}
	}
	return string(out)
}

// buildStoresAPI wires pulse.store.memory / pulse.store.local into the VM.
func buildStoresAPI(vm *goja.Runtime, pulseObj *goja.Object, mem *pluginStore, local *persistentStore) {
	store := vm.NewObject()

	memory := vm.NewObject()
	_ = memory.Set("get", func(call goja.FunctionCall) goja.Value {
		if v, ok := mem.get(argString(call, 0)); ok {
			return vm.ToValue(v)
		}
		return goja.Undefined()
	})
	_ = memory.Set("set", func(call goja.FunctionCall) goja.Value {
		ttlMs := 0.0
		if len(call.Arguments) > 2 && call.Argument(2) != goja.Undefined() {
			ttlMs = call.Argument(2).ToFloat()
		}
		mem.set(argString(call, 0), call.Argument(1).Export(), time.Duration(ttlMs*float64(time.Millisecond)))
		return goja.Undefined()
	})
	_ = memory.Set("delete", func(call goja.FunctionCall) goja.Value {
		mem.del(argString(call, 0))
		return goja.Undefined()
	})
	_ = memory.Set("keys", func(call goja.FunctionCall) goja.Value {
		return vm.ToValue(mem.keys())
	})
	_ = memory.Set("increment", func(call goja.FunctionCall) goja.Value {
		delta := 1.0
		if len(call.Arguments) > 1 {
			delta = call.Argument(1).ToFloat()
		}
		return vm.ToValue(mem.increment(argString(call, 0), int64(delta)))
	})

	lcl := vm.NewObject()
	_ = lcl.Set("get", func(call goja.FunctionCall) goja.Value {
		local.mu.Lock()
		v, ok := local.data[argString(call, 0)]
		local.mu.Unlock()
		if !ok {
			return goja.Undefined()
		}
		return vm.ToValue(v)
	})
	_ = lcl.Set("set", func(call goja.FunctionCall) goja.Value {
		local.mu.Lock()
		local.data[argString(call, 0)] = call.Argument(1).Export()
		local.mu.Unlock()
		if err := local.persist(); err != nil {
			return makeErr(vm, "pulse.store.local.set: "+err.Error())
		}
		return goja.Undefined()
	})
	_ = lcl.Set("delete", func(call goja.FunctionCall) goja.Value {
		local.mu.Lock()
		delete(local.data, argString(call, 0))
		local.mu.Unlock()
		if err := local.persist(); err != nil {
			return makeErr(vm, "pulse.store.local.delete: "+err.Error())
		}
		return goja.Undefined()
	})
	_ = lcl.Set("keys", func(call goja.FunctionCall) goja.Value {
		local.mu.Lock()
		out := make([]string, 0, len(local.data))
		for k := range local.data {
			out = append(out, k)
		}
		local.mu.Unlock()
		return vm.ToValue(out)
	})

	_ = store.Set("memory", memory)
	_ = store.Set("local", lcl)
	pulseObj.Set("store", store)
}

func (s *persistentStore) get(key string) (any, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.data[key]
	return v, ok
}
