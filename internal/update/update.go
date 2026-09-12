// Package update: self-update from GitHub releases. Check fetches the
// latest release metadata, Apply downloads the archive for this platform,
// extracts the binary and swaps it in place (the old file is kept as
// .old until the next start removes it), Restart re-execs the binary.
package update

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	Repo       = "deenrookie/pulse"
	defaultAPI = "https://api.github.com"
	// releases are ~12 MB; refuse anything absurd instead of filling the disk
	maxArchiveSize = 300 << 20
)

// Release is the subset of the GitHub release payload we use.
type Release struct {
	TagName string `json:"tag_name"`
	HTMLURL string `json:"html_url"`
	Body    string `json:"body"`
	Assets  []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
		Size int64  `json:"size"`
	} `json:"assets"`
}

// Result is what the API layer reports to the frontend.
type Result struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	Newer     bool   `json:"newer"`
	AssetName string `json:"assetName,omitempty"`
	AssetURL  string `json:"assetUrl,omitempty"`
	Size      int64  `json:"size,omitempty"`
	Notes     string `json:"notes,omitempty"`
	HTMLURL   string `json:"htmlUrl,omitempty"`
}

// APIBase honours PULSE_GH_API for mirrors/proxies of api.github.com.
func APIBase() string {
	if v := os.Getenv("PULSE_GH_API"); v != "" {
		return strings.TrimRight(v, "/")
	}
	return defaultAPI
}

func httpClient() *http.Client {
	return &http.Client{Timeout: 30 * time.Second}
}

// FetchLatest pulls the latest release metadata.
func FetchLatest(ctx context.Context) (*Release, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, APIBase()+"/repos/"+Repo+"/releases/latest", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := httpClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("github api: %s", resp.Status)
	}
	var rel Release
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&rel); err != nil {
		return nil, err
	}
	if rel.TagName == "" {
		return nil, errors.New("release has no tag")
	}
	return &rel, nil
}

// Check compares the running version against the latest release.
func Check(ctx context.Context, current string) (*Result, error) {
	rel, err := FetchLatest(ctx)
	if err != nil {
		return nil, err
	}
	latest := strings.TrimPrefix(rel.TagName, "v")
	res := &Result{
		Current: current,
		Latest:  latest,
		Newer:   newer(latest, current),
		Notes:   strings.TrimSpace(rel.Body),
		HTMLURL: rel.HTMLURL,
	}
	if a := assetFor(rel, runtime.GOOS, runtime.GOARCH); a != nil {
		res.AssetName, res.AssetURL, res.Size = a.Name, a.URL, a.Size
	}
	return res, nil
}

// assetFor picks the archive matching the platform (vX.Y.Z in the name is
// matched by suffix so pre-release tags still resolve).
func assetFor(rel *Release, goos, goarch string) *struct {
	Name string `json:"name"`
	URL  string `json:"browser_download_url"`
	Size int64  `json:"size"`
} {
	want := "_" + goos + "_" + goarch + "."
	for i := range rel.Assets {
		a := &rel.Assets[i]
		name := strings.ToLower(a.Name)
		if strings.Contains(name, want) && (strings.HasSuffix(name, ".zip") || strings.HasSuffix(name, ".tar.gz")) {
			return a
		}
	}
	return nil
}

// newer reports whether a > b numerically (v-prefix tolerated, missing
// parts count as 0, non-numeric tails are ignored).
func newer(a, b string) bool {
	pa, pb := parseSemver(a), parseSemver(b)
	for i := 0; i < 3; i++ {
		if pa[i] != pb[i] {
			return pa[i] > pb[i]
		}
	}
	return false
}

func parseSemver(v string) [3]int {
	v = strings.TrimPrefix(strings.TrimSpace(strings.ToLower(v)), "v")
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	var out [3]int
	for i, p := range strings.SplitN(v, ".", 3) {
		n, _ := strconv.Atoi(strings.TrimSpace(p))
		out[i] = n
	}
	return out
}

// Download fetches the release archive into memory.
func Download(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := httpClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download: %s", resp.Status)
	}
	return io.ReadAll(io.LimitReader(resp.Body, maxArchiveSize))
}

// ExtractBinary pulls the pulse binary out of the platform archive.
func ExtractBinary(archive []byte, goos string) ([]byte, error) {
	want := "pulse"
	if goos == "windows" {
		want += ".exe"
	}
	if goos == "windows" {
		zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
		if err != nil {
			return nil, fmt.Errorf("open zip: %w", err)
		}
		for _, f := range zr.File {
			if strings.HasSuffix(f.Name, want) {
				rc, err := f.Open()
				if err != nil {
					return nil, err
				}
				defer rc.Close()
				return io.ReadAll(io.LimitReader(rc, maxArchiveSize))
			}
		}
		return nil, fmt.Errorf("no %s inside the archive", want)
	}
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, fmt.Errorf("open gzip: %w", err)
	}
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read tar: %w", err)
		}
		if strings.HasSuffix(filepath.ToSlash(hdr.Name), want) {
			return io.ReadAll(io.LimitReader(tr, maxArchiveSize))
		}
	}
	return nil, fmt.Errorf("no %s inside the archive", want)
}

// Replace swaps the binary at exePath with bin. The running file is moved
// aside as .old (rename of a running executable is legal on Windows and
// unix); it is removed on the next start.
func Replace(exePath string, bin []byte) error {
	if exePath == "" {
		var err error
		exePath, err = os.Executable()
		if err != nil {
			return fmt.Errorf("locate executable: %w", err)
		}
	}
	exePath = filepath.Clean(exePath)
	tmp := exePath + ".new"
	if err := os.WriteFile(tmp, bin, 0o755); err != nil {
		return fmt.Errorf("write %s: %w", tmp, err)
	}
	if err := os.Rename(exePath, exePath+".old"); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("move current binary aside: %w", err)
	}
	if err := os.Rename(tmp, exePath); err != nil {
		// put the old one back — better a stale binary than none
		os.Rename(exePath+".old", exePath)
		os.Remove(tmp)
		return fmt.Errorf("activate new binary: %w", err)
	}
	os.Remove(exePath + ".old") // works when the old process is gone
	return nil
}

// CleanupOld removes a leftover .old next to exe (call at startup, before
// anything binds listeners).
func CleanupOld() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	os.Remove(filepath.Clean(exe) + ".old")
}

// Apply = check + download + extract + replace, reporting what landed.
func Apply(ctx context.Context, current string) (*Result, error) {
	res, err := Check(ctx, current)
	if err != nil {
		return nil, err
	}
	if res.AssetURL == "" {
		return nil, fmt.Errorf("release %s has no archive for %s/%s", res.Latest, runtime.GOOS, runtime.GOARCH)
	}
	archive, err := Download(ctx, res.AssetURL)
	if err != nil {
		return nil, err
	}
	bin, err := ExtractBinary(archive, runtime.GOOS)
	if err != nil {
		return nil, err
	}
	if err := Replace("", bin); err != nil {
		return nil, err
	}
	return res, nil
}
