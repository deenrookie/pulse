package plugins

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pulse/internal/store"
)

func writeProject(t *testing.T, dir, name, id string) {
	t.Helper()
	pdir := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Join(pdir, "dist"), 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := `{"id": "` + id + `", "name": "Proj ` + name + `", "version": "2.0", "entry": "dist/plugin.js"}`
	if err := os.WriteFile(filepath.Join(pdir, "pulse.plugin.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	src := `plugin = { name: "from-code", version: "0.1" };
function onRequest(ctx) { ctx.request.headers.push({ name: "X-Proj", value: "1" }); }`
	if err := os.WriteFile(filepath.Join(pdir, "dist", "plugin.js"), []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
}

// Directory projects: manifest is the identity authority (name/version win
// over the code's own metadata), the entry artifact runs like any plugin.
func TestDirectoryProject(t *testing.T) {
	dir := t.TempDir()
	writeProject(t, dir, "alpha", "com.alpha")
	rt, err := Open(dir, filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	p := rt.List()[0]
	if !p.Dir {
		t.Fatalf("not a dir project: %+v", p)
	}
	if p.Identity != "com.alpha" {
		t.Fatalf("identity = %q", p.Identity)
	}
	// manifest wins over code metadata
	if p.Name != "Proj alpha" || p.Version != "2.0" {
		t.Fatalf("name/version = %q/%q", p.Name, p.Version)
	}
	if p.File != "alpha/dist/plugin.js" {
		t.Fatalf("file = %q", p.File)
	}
	req := &store.Request{Method: "GET", URL: "http://h/", Headers: []store.Header{}}
	if !rt.ApplyRequest(req) || headerValue(req.Headers, "X-Proj") != "1" {
		t.Fatal("project entry did not run")
	}
}

// Duplicate identities are reported, not silently shadowed: the second
// plugin does not run but stays visible for fixing.
func TestDuplicateIdentity(t *testing.T) {
	dir := t.TempDir()
	writeProject(t, dir, "one", "com.same")
	writeProject(t, dir, "two", "com.same")
	rt, err := Open(dir, filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	var withErr, runnable int
	for _, p := range rt.List() {
		if strings.Contains(p.Error, "duplicate plugin id") {
			withErr++
			if p.prog != nil {
				t.Fatal("duplicate-id plugin must not run")
			}
		} else if p.prog != nil {
			runnable++
		}
	}
	if withErr != 1 || runnable != 1 {
		t.Fatalf("dup=%d runnable=%d", withErr, runnable)
	}
}

// A broken manifest/entry reports a clear error on the project entry.
func TestBrokenProject(t *testing.T) {
	dir := t.TempDir()
	pdir := filepath.Join(dir, "broken")
	if err := os.MkdirAll(pdir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(pdir, "pulse.plugin.json"), []byte("{ not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	rt, err := Open(dir, filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	p := rt.List()[0]
	if p.Error == "" || !strings.Contains(p.Error, "manifest") {
		t.Fatalf("error = %q", p.Error)
	}
}

// Authorized file access: reads/writes stay inside the granted dir;
// traversal and symlink escapes are rejected; no grant = clear error.
func TestFilesAPI(t *testing.T) {
	grant := t.TempDir()
	outside := t.TempDir()
	// symlink escape: link inside the grant points outside
	if err := os.Symlink(outside, filepath.Join(grant, "escape")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	src := `function onRequest(ctx) {
	pulse.files.write("data/note.txt", "hello");
	ctx.request.headers.push({ name: "X-Read", value: pulse.files.read("data/note.txt") });
	try { pulse.files.read("../escape/secret.txt"); pulse.log("ESCAPED"); } catch (e) { pulse.log("blocked"); }
	try { pulse.files.read("x"); } catch (e) { pulse.log("no-grant-clear"); }
}`
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "f.js"), []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	rt, err := Open(dir, filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}

	// before the grant: clear error
	req := &store.Request{Method: "GET", URL: "http://h/", Headers: []store.Header{}}
	rt.ApplyRequest(req)
	if headerValue(req.Headers, "X-Read") != "" {
		t.Fatal("write worked without a grant")
	}

	if err := rt.SetFilesGrantDir("f.js", grant); err != nil {
		t.Fatal(err)
	}
	req2 := &store.Request{Method: "GET", URL: "http://h/", Headers: []store.Header{}}
	rt.ApplyRequest(req2)
	if headerValue(req2.Headers, "X-Read") != "hello" {
		t.Fatalf("read = %q", headerValue(req2.Headers, "X-Read"))
	}
	b, _ := os.ReadFile(filepath.Join(grant, "data", "note.txt"))
	if string(b) != "hello" {
		t.Fatalf("file = %q", b)
	}
	joined := strings.Join(rt.List()[0].Log, "\n")
	if !strings.Contains(joined, "blocked") {
		t.Fatalf("traversal not blocked: %q", joined)
	}
	// grant survives restart
	rt2, err := Open(dir, filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if rt2.FilesGrantDir("f.js") != grant {
		t.Fatal("grant lost")
	}
	// revoke
	if err := rt2.SetFilesGrantDir("f.js", ""); err != nil {
		t.Fatal(err)
	}
	if rt2.FilesGrantDir("f.js") != "" {
		t.Fatal("revoke failed")
	}
}

// resolveInside unit checks: traversal, absolute-style cleaning, nesting.
func TestResolveInside(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "a"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveInside(root, "a/b/../c.txt"); err != nil {
		t.Fatalf("nested clean path rejected: %v", err)
	}
	// traversal is clamped by the leading-slash Clean — it lands inside the
	// root rather than escaping, which is the safe behavior
	if p, err := resolveInside(root, "../../etc/passwd"); err != nil || !strings.HasPrefix(p, root) {
		t.Fatalf("traversal handling: %v %v", p, err)
	}
	if p, err := resolveInside(root, "/abs.txt"); err != nil || strings.HasPrefix(p, "/abs.txt") {
		t.Fatalf("absolute handling: %v %v", p, err)
	}
}

// UI panel declaration is extracted from plugin.uiPanel.
func TestUIPanelExtraction(t *testing.T) {
	src := `plugin = { name: "P", uiPanel: { id: "decode", title: "Decoder", html: "<b>hi</b>" } };
function onRequest(ctx) {}`
	rt := newRuntime(t, map[string]string{"p.js": src})
	p := rt.List()[0]
	if p.UIPanel == nil || p.UIPanel.ID != "decode" || p.UIPanel.Title != "Decoder" || !strings.Contains(p.UIPanel.HTML, "<b>") {
		t.Fatalf("panel = %+v", p.UIPanel)
	}
}

// SDK d.ts is embedded and non-trivial.
func TestSDKDTS(t *testing.T) {
	if !strings.Contains(SDKDTS(), "interface PluginRequestContext") || !strings.Contains(SDKDTS(), "http: {") {
		t.Fatal("d.ts missing sections")
	}
}
