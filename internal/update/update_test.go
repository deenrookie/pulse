package update

import (
	"archive/zip"
	"bytes"
	"compress/gzip"
	"archive/tar"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestNewer(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"0.3.3", "0.3.2", true},
		{"v0.4.0", "0.3.9", true},
		{"0.3.2", "0.3.3", false},
		{"0.3.2", "0.3.2", false},
		{"0.10.0", "0.9.9", true},
		{"1.0.0-rc1", "0.9.0", true},
		{"0.3", "0.3.1", false},
		{"0.3.1", "0.3", true},
	}
	for _, c := range cases {
		if got := newer(c.a, c.b); got != c.want {
			t.Errorf("newer(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

func TestAssetFor(t *testing.T) {
	rel := &Release{TagName: "v0.3.3"}
	rel.Assets = []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
		Size int64  `json:"size"`
	}{
		{"pulse_0.3.3_darwin_arm64.tar.gz", "u1", 1},
		{"pulse_0.3.3_linux_amd64.tar.gz", "u2", 2},
		{"pulse_0.3.3_windows_amd64.zip", "u3", 3},
		{"README.md", "u4", 4},
	}
	if a := assetFor(rel, "windows", "amd64"); a == nil || a.URL != "u3" {
		t.Fatalf("windows asset: %+v", a)
	}
	if a := assetFor(rel, "darwin", "arm64"); a == nil || a.URL != "u1" {
		t.Fatalf("darwin asset: %+v", a)
	}
	if a := assetFor(rel, "linux", "386"); a != nil {
		t.Fatalf("unsupported platform should have no asset, got %+v", a)
	}
}

func TestExtractBinary(t *testing.T) {
	// zip (windows)
	var zb bytes.Buffer
	zw := zip.NewWriter(&zb)
	w, _ := zw.Create("pulse.exe")
	w.Write([]byte("winbin"))
	zw.Close()
	if b, err := ExtractBinary(zb.Bytes(), "windows"); err != nil || string(b) != "winbin" {
		t.Fatalf("zip extract: %q %v", b, err)
	}
	// tar.gz with a directory prefix (unix)
	var tb bytes.Buffer
	gz := gzip.NewWriter(&tb)
	tw := tar.NewWriter(gz)
	hdr := &tar.Header{Name: "pulse-0.3.3/", Typeflag: tar.TypeDir}
	tw.WriteHeader(hdr)
	hdr = &tar.Header{Name: "pulse-0.3.3/pulse", Size: 6, Mode: 0o755}
	tw.WriteHeader(hdr)
	tw.Write([]byte("unxbin"))
	tw.Close()
	gz.Close()
	if b, err := ExtractBinary(tb.Bytes(), "linux"); err != nil || string(b) != "unxbin" {
		t.Fatalf("tar extract: %q %v", b, err)
	}
}

func TestReplaceSwapsAndKeepsOld(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "pulse.exe")
	if err := os.WriteFile(exe, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := Replace(exe, []byte("new")); err != nil {
		t.Fatalf("replace: %v", err)
	}
	got, _ := os.ReadFile(exe)
	if string(got) != "new" {
		t.Fatalf("exe now %q, want new", got)
	}
	// old was cleaned up (or left as .old when locked — either is fine)
	if _, err := os.Stat(exe + ".old"); err == nil {
		os.Remove(exe + ".old")
	}
}

func TestCheckAgainstMockAPI(t *testing.T) {
	asset := map[string]any{"name": "pulse_9.9.9_windows_amd64.zip", "browser_download_url": "http://x/z.zip", "size": 11}
	body, _ := json.Marshal(map[string]any{"tag_name": "v9.9.9", "html_url": "http://x", "body": "notes", "assets": []any{asset}})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/deenrookie/pulse/releases/latest" {
			http.NotFound(w, r)
			return
		}
		w.Write(body)
	}))
	defer srv.Close()
	t.Setenv("PULSE_GH_API", srv.URL)

	res, err := Check(t.Context(), "0.3.2")
	if err != nil {
		t.Fatal(err)
	}
	if !res.Newer || res.Latest != "9.9.9" || res.AssetName != "pulse_9.9.9_windows_amd64.zip" {
		t.Fatalf("check result: %+v", res)
	}
	if runtime.GOOS != "windows" {
		t.Log("asset pick asserted for windows naming on non-windows runner — fine, matcher is name-based")
	}
}
