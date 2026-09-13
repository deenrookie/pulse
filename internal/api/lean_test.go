package api_test

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

var (
	timeNow        = time.Now
	timeSleep      = time.Sleep
	timeSecond     = time.Second
	timeMillisecond = time.Millisecond
)

// Lean capture: with stubStatic on, JS/image response bodies are replaced by
// a stub while HTML/JSON bodies and the request record stay intact.
func TestLeanCaptureStubsStaticBodies(t *testing.T) {
	e := newEnv(t)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/app.js":
			w.Header().Set("Content-Type", "application/javascript")
			w.Write([]byte("console.log('" + strings.Repeat("x", 5000) + "')"))
		case "/logo.png":
			w.Header().Set("Content-Type", "image/png")
			w.Write([]byte{0x89, 'P', 'N', 'G', 1, 2, 3, 4, 5, 6, 7, 8})
		case "/style.css":
			w.Header().Set("Content-Type", "text/css; charset=utf-8")
			w.Write([]byte("body{color:red}"))
		case "/api/data":
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"ok":true,"big":"` + strings.Repeat("y", 2000) + `"}`))
		default:
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write([]byte("<html>page</html>"))
		}
	}))
	defer up.Close()

	// lean capture on via the settings API (exactly what the toggle does)
	resp, data := e.do(t, "PUT", "/api/settings", map[string]any{"stubStatic": true})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("put settings: %d %s", resp.StatusCode, data)
	}

	cl := proxiedClient(e.proxyAddr)
	for _, p := range []string{"/app.js", "/logo.png", "/style.css", "/api/data", "/page"} {
		r, err := cl.Get(up.URL + p)
		if err != nil {
			t.Fatalf("GET %s: %v", p, err)
		}
		// the client must still receive the REAL payload
		if p == "/app.js" && r.ContentLength < 5000 {
			t.Fatalf("client got a stubbed body for %s (len=%d)", p, r.ContentLength)
		}
		r.Body.Close()
	}
	if !waitFlows(t, e, 5) {
		t.Fatal("flows never arrived")
	}

	// wait until every flow's response has landed (items can appear while
	// the response is still in flight)
	deadline := timeNow().Add(3 * timeSecond)
	for {
		var probe struct {
			Items []struct {
				ID    string `json:"id"`
				State string `json:"state"`
			} `json:"items"`
		}
		_, d := e.do(t, "GET", "/api/flows", nil)
		json.Unmarshal(d, &probe)
		done := true
		for _, it := range probe.Items {
			if it.State != "complete" && it.State != "error" {
				done = false
			}
		}
		if done || timeNow().After(deadline) {
			break
		}
		timeSleep(20 * timeMillisecond)
	}

	var list struct {
		Items []struct {
			ID   string `json:"id"`
			Path string `json:"path"`
		} `json:"items"`
	}
	_, data = e.do(t, "GET", "/api/flows", nil)
	json.Unmarshal(data, &list)

	bodies := map[string]string{} // path -> decoded response body
	for _, it := range list.Items {
		resp, d := e.do(t, "GET", "/api/flows/"+it.ID, nil)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("flow detail %s: %d", it.ID, resp.StatusCode)
		}
		var fl struct {
			Request struct {
				Method string `json:"method"`
				URL    string `json:"url"`
				Body   string `json:"body"`
			} `json:"request"`
			Response struct {
				StatusCode int    `json:"statusCode"`
				Body       string `json:"body"`
			} `json:"response"`
		}
		json.Unmarshal(d, &fl)
		path := strings.TrimPrefix(fl.Request.URL, up.URL)
		decoded, _ := base64.StdEncoding.DecodeString(fl.Response.Body)
		bodies[path] = string(decoded)
		if fl.Request.Method != "GET" {
			t.Fatalf("request record damaged for %s", path)
		}
		if fl.Response.StatusCode != 200 {
			t.Fatalf("status lost for %s: %d", path, fl.Response.StatusCode)
		}
	}

	for path, want := range map[string]struct{ stubbed bool; contains string }{
		"/app.js":   {true, "stubbed by lean capture"},
		"/logo.png": {true, "stubbed by lean capture"},
		"/style.css": {true, "stubbed by lean capture"},
		"/api/data": {false, `"ok":true`},
		"/page":     {false, "<html>page</html>"},
	} {
		got := bodies[path]
		if strings.Contains(got, "stubbed by lean capture") != want.stubbed {
			t.Fatalf("%s stubbed=%v, body: %.80s", path, want.stubbed, got)
		}
		if !strings.Contains(got, want.contains) {
			t.Fatalf("%s missing %q, body: %.80s", path, want.contains, got)
		}
	}

	// memory sanity: stubbed bodies are tiny
	if len(bodies["/app.js"]) > 200 || len(bodies["/logo.png"]) > 200 {
		t.Fatal("stubbed bodies should be tiny")
	}

	// toggle off via API round-trips
	_, data = e.do(t, "GET", "/api/settings", nil)
	var gs struct {
		StubStatic bool `json:"stubStatic"`
	}
	json.Unmarshal(data, &gs)
	if !gs.StubStatic {
		t.Fatal("GET settings should report stubStatic=true")
	}
}
