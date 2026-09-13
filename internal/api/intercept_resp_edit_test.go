package api_test

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

// Held responses can be edited before forwarding: the modified status,
// headers and body are what the client receives.
func TestHeldResponseForwardWithModification(t *testing.T) {
	e := newEnv(t)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Header().Set("X-Orig", "1")
		io.WriteString(w, "original body")
	}))
	defer up.Close()

	if resp, data := e.do(t, "PUT", "/api/intercept", map[string]any{"respEnabled": true}); resp.StatusCode != http.StatusOK {
		t.Fatalf("enable resp hold: %d %s", resp.StatusCode, data)
	}

	type result struct {
		status int
		body   string
		header http.Header
		err    error
	}
	done := make(chan result, 1)
	go func() {
		r, err := proxiedClient(e.proxyAddr).Get(up.URL + "/held")
		if err != nil {
			done <- result{err: err}
			return
		}
		defer r.Body.Close()
		b, _ := io.ReadAll(r.Body)
		done <- result{status: r.StatusCode, body: string(b), header: r.Header.Clone()}
	}()

	// wait for the held response to appear
	var heldID string
	deadline := time.Now().Add(3 * time.Second)
	for heldID == "" {
		var sum struct {
			PendingResp []struct {
				ID string `json:"id"`
			} `json:"pendingResp"`
		}
		_, data := e.do(t, "GET", "/api/intercept", nil)
		if err := json.Unmarshal(data, &sum); err == nil && len(sum.PendingResp) > 0 {
			heldID = sum.PendingResp[0].ID
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("held response never appeared")
		}
		time.Sleep(20 * time.Millisecond)
	}

	resp, data := e.do(t, "POST", "/api/intercept/"+heldID+"/forward", map[string]any{
		"response": map[string]any{
			"statusCode":  404,
			"reason":      "Not Found",
			"httpVersion": "HTTP/1.1",
			"headers": []map[string]string{
				{"name": "Content-Type", "value": "text/plain"},
				{"name": "X-Edited", "value": "yes"},
			},
			"body": "ZWRpdGVkIGJvZHk=", // base64("edited body")
		},
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("forward modified: %d %s", resp.StatusCode, data)
	}

	got := <-done
	if got.err != nil {
		t.Fatalf("client: %v", got.err)
	}
	if got.status != http.StatusNotFound {
		t.Fatalf("client status = %d, want 404", got.status)
	}
	if got.body != "edited body" {
		t.Fatalf("client body = %q, want edited", got.body)
	}
	if got.header.Get("X-Edited") != "yes" {
		t.Fatalf("client X-Edited = %q", got.header.Get("X-Edited"))
	}
	if got.header.Get("X-Orig") != "" {
		t.Fatal("original header leaked through — the modified response must replace, not merge")
	}

	// invalid status rejected with 400
	e.do(t, "PUT", "/api/intercept", map[string]any{"respEnabled": true})
	go func() { proxiedClient(e.proxyAddr).Get(up.URL + "/held2") }()
	var id2 string
	for id2 == "" {
		var sum struct {
			PendingResp []struct {
				ID string `json:"id"`
			} `json:"pendingResp"`
		}
		_, data := e.do(t, "GET", "/api/intercept", nil)
		if json.Unmarshal(data, &sum) == nil && len(sum.PendingResp) > 0 {
			id2 = sum.PendingResp[0].ID
		}
		if id2 == "" {
			time.Sleep(20 * time.Millisecond)
		}
	}
	resp, data = e.do(t, "POST", "/api/intercept/"+id2+"/forward", map[string]any{
		"response": map[string]any{"statusCode": 42, "headers": []map[string]string{}, "body": ""},
	})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid status: want 400, got %d (%s)", resp.StatusCode, data)
	}
	// clean up the still-held response
	e.do(t, "POST", "/api/intercept/"+id2+"/drop", nil)
}

// Edited bodies are re-encoded to the declared Content-Encoding (gzip),
// and unsupported codings (br) degrade to identity instead of lying.
func TestHeldResponseReencode(t *testing.T) {

	for _, tc := range []struct {
		name      string
		ce        string
		wantCE    string // expected Content-Encoding the client sees
		wantPlain string // the body after the client decodes (or raw)
	}{
		{"gzip re-encoded", "gzip", "gzip", "edited gzip body"},
		{"br degrades to identity", "br", "", "edited br body"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t)
			upLocal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				io.WriteString(w, "compressed upstream body")
			}))
			defer upLocal.Close()
			if resp, data := e.do(t, "PUT", "/api/intercept", map[string]any{"respEnabled": true}); resp.StatusCode != http.StatusOK {
				t.Fatalf("enable: %d %s", resp.StatusCode, data)
			}
			type result struct {
				status int
				body   []byte
				ce     string
				err    error
			}
			noDecomp := &http.Client{
				Transport: &http.Transport{Proxy: func(r *http.Request) (*url.URL, error) { return url.Parse("http://" + e.proxyAddr) }, DisableCompression: true},
				Timeout:   10 * time.Second,
			}
			done := make(chan result, 1)
			go func() {
				r, err := noDecomp.Get(upLocal.URL)
				if err != nil {
					done <- result{err: err}
					return
				}
				defer r.Body.Close()
				b, _ := io.ReadAll(r.Body)
				done <- result{status: r.StatusCode, body: b, ce: r.Header.Get("Content-Encoding")}
			}()
			var id string
			for id == "" {
				var sum struct {
					PendingResp []struct {
						ID string `json:"id"`
					} `json:"pendingResp"`
				}
				_, data := e.do(t, "GET", "/api/intercept", nil)
				if json.Unmarshal(data, &sum) == nil && len(sum.PendingResp) > 0 {
					id = sum.PendingResp[0].ID
				} else {
					time.Sleep(20 * time.Millisecond)
				}
			}
			resp, data := e.do(t, "POST", "/api/intercept/"+id+"/forward", map[string]any{
				"response": map[string]any{
					"statusCode":  200,
					"reason":      "OK",
					"httpVersion": "HTTP/1.1",
					"headers": []map[string]string{
						{"name": "Content-Encoding", "value": tc.ce},
					},
					"body": base64.StdEncoding.EncodeToString([]byte(tc.wantPlain)),
				},
			})
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("forward: %d %s", resp.StatusCode, data)
			}
			got := <-done
			if got.err != nil {
				t.Fatalf("client: %v", got.err)
			}
			if got.ce != tc.wantCE {
				t.Fatalf("Content-Encoding = %q, want %q", got.ce, tc.wantCE)
			}
			if got.ce == "gzip" {
				zr, err := gzip.NewReader(bytes.NewReader(got.body))
				if err != nil {
					t.Fatalf("client body is not valid gzip: %v", err)
				}
				plain, _ := io.ReadAll(zr)
				if string(plain) != tc.wantPlain {
					t.Fatalf("decompressed = %q, want %q", plain, tc.wantPlain)
				}
			} else if string(got.body) != tc.wantPlain {
				t.Fatalf("body = %q, want %q", got.body, tc.wantPlain)
			}
		})
	}
}
