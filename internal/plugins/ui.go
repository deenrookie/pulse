// R3 UI panels + authorized file access.
package plugins

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/dop251/goja"
)

// UIPanelDef is a declared custom inspector panel: sandboxed HTML rendered
// in an iframe, talking to the host over a versioned message bridge.
type UIPanelDef struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	HTML  string `json:"html"` // inline document (single-file scale); projects may point at files later
}

// extractUIPanel pulls plugin.uiPanel from the compiled VM.
func extractUIPanel(vm *goja.Runtime) *UIPanelDef {
	v := vm.Get(metadataVar)
	if v == nil || v == goja.Undefined() || v == goja.Null() {
		return nil
	}
	obj, ok := v.(*goja.Object)
	if !ok {
		return nil
	}
	pv := obj.Get("uiPanel")
	if pv == nil || pv == goja.Undefined() || pv == goja.Null() {
		return nil
	}
	o, ok := pv.(*goja.Object)
	if !ok {
		return nil
	}
	id, _ := objString(o, "id")
	if id == "" {
		return nil
	}
	title, _ := objString(o, "title")
	html, _ := objString(o, "html")
	return &UIPanelDef{ID: id, Title: title, HTML: html}
}

// ---------- authorized file access ----------

// FilesGrant maps plugin file name -> an absolute directory the user
// authorized for that plugin's reads/writes. Persisted beside the plugin
// state; a plugin with no grant gets a clear error, never the CWD.
type FilesGrant struct {
	path string
	mu   sync.Mutex
	data map[string]string
}

func openFilesGrant(path string) *FilesGrant {
	g := &FilesGrant{path: path, data: map[string]string{}}
	if b, err := os.ReadFile(path); err == nil {
		var m map[string]string
		if json.Unmarshal(b, &m) == nil && m != nil {
			g.data = m
		}
	}
	return g
}

func (g *FilesGrant) persist() error {
	b, err := json.MarshalIndent(g.data, "", "  ")
	if err != nil {
		return err
	}
	tmp := g.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, g.path)
}

func (g *FilesGrant) get(file string) (string, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	v, ok := g.data[file]
	return v, ok
}

func (g *FilesGrant) set(file, dir string) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.data[file] = dir
	return g.persist()
}

func (g *FilesGrant) delete(file string) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.data, file)
	return g.persist()
}

// resolveInside normalizes rel and guarantees the result stays inside root
// after symlink resolution — the check that makes "just use ../" and
// symlinked escapes impossible.
func resolveInside(root, rel string) (string, error) {
	clean := filepath.Clean("/" + strings.ReplaceAll(rel, "\\", "/"))
	full := filepath.Join(root, clean)
	rootReal, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("grant dir unavailable: %w", err)
	}
	// deepest existing ancestor is resolved physically (symlink-escape
	// check); missing child segments are for new files and append lexically
	dir := filepath.Dir(full)
	relToEnd := []string{filepath.Base(full)}
	for {
		if real, err := filepath.EvalSymlinks(dir); err == nil {
			if real != rootReal && !strings.HasPrefix(real, rootReal+string(filepath.Separator)) {
				return "", fmt.Errorf("path escapes the granted directory")
			}
			return filepath.Join(append([]string{real}, relToEnd...)...), nil
		}
		if dir == root || len(dir) <= len(root) {
			return "", fmt.Errorf("path escapes the granted directory")
		}
		relToEnd = append([]string{filepath.Base(dir)}, relToEnd...)
		dir = filepath.Dir(dir)
	}
}

// buildFilesAPI wires pulse.files (read/write/list inside the plugin's
// granted directory).
func buildFilesAPI(vm *goja.Runtime, pulseObj *goja.Object, file string, grants *FilesGrant) {
	f := vm.NewObject()
	_ = f.Set("read", func(call goja.FunctionCall) goja.Value {
		root, ok := grants.get(file)
		if !ok {
			panic(vm.NewGoError(fmt.Errorf("pulse.files: no granted directory for this plugin — grant one in Extensions")))
		}
		full, err := resolveInside(root, argString(call, 0))
		if err != nil {
			panic(vm.NewGoError(fmt.Errorf("pulse.files.read: %w", err)))
		}
		b, err := os.ReadFile(full)
		if err != nil {
			panic(vm.NewGoError(fmt.Errorf("pulse.files.read: %w", err)))
		}
		return vm.ToValue(string(b))
	})
	_ = f.Set("write", func(call goja.FunctionCall) goja.Value {
		root, ok := grants.get(file)
		if !ok {
			panic(vm.NewGoError(fmt.Errorf("pulse.files: no granted directory for this plugin")))
		}
		full, err := resolveInside(root, argString(call, 0))
		if err != nil {
			panic(vm.NewGoError(fmt.Errorf("pulse.files.write: %w", err)))
		}
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			panic(vm.NewGoError(fmt.Errorf("pulse.files.write: %w", err)))
		}
		if err := os.WriteFile(full, []byte(call.Argument(1).String()), 0o644); err != nil {
			panic(vm.NewGoError(fmt.Errorf("pulse.files.write: %w", err)))
		}
		return goja.Undefined()
	})
	_ = f.Set("list", func(call goja.FunctionCall) goja.Value {
		root, ok := grants.get(file)
		if !ok {
			return vm.ToValue([]string{})
		}
		entries, err := os.ReadDir(root)
		if err != nil {
			return vm.ToValue([]string{})
		}
		out := []string{}
		for _, e := range entries {
			out = append(out, e.Name())
		}
		return vm.ToValue(out)
	})
	pulseObj.Set("files", f)
}

// FilesGrantDir returns the granted directory for a plugin (” = none).
func (r *Runtime) FilesGrantDir(file string) string {
	v, _ := r.files.get(file)
	return v
}

// SetFilesGrantDir grants (empty = revoke) a directory for a plugin.
func (r *Runtime) SetFilesGrantDir(file, dir string) error {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return r.files.delete(file)
	}
	if !filepath.IsAbs(dir) {
		return fmt.Errorf("dir must be an absolute path on the machine running Pulse")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create dir: %w", err)
	}
	return r.files.set(file, dir)
}
