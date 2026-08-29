package rewrite

import (
	"path/filepath"
	"strings"
	"testing"

	"pulse/internal/store"
)

func mustAdd(t *testing.T, e *Engine, zone, match, replace string, regex bool) Rule {
	t.Helper()
	r, err := e.Add(Rule{Enabled: true, Zone: zone, Match: match, Replace: replace, Regex: regex})
	if err != nil {
		t.Fatalf("add rule: %v", err)
	}
	return r
}

func TestRequestLineRewrite(t *testing.T) {
	e, err := Open(filepath.Join(t.TempDir(), "mr.json"))
	if err != nil {
		t.Fatal(err)
	}
	mustAdd(t, e, ZoneRequestLine, "/v1/", "/v2/", false)
	req := &store.Request{
		Method: "GET", URL: "http://api.example.com:8080/v1/users?id=7",
		Headers: []store.Header{{Name: "Host", Value: "api.example.com:8080"}},
	}
	if !e.ApplyRequest(req) {
		t.Fatal("expected change")
	}
	if req.URL != "http://api.example.com:8080/v2/users?id=7" {
		t.Fatalf("url = %s", req.URL)
	}
	if req.Headers[0].Value != "api.example.com:8080" {
		t.Fatalf("host header = %s", req.Headers[0].Value)
	}
}

func TestRequestLineHostChangeSyncsHostHeader(t *testing.T) {
	e, _ := Open(filepath.Join(t.TempDir(), "mr.json"))
	mustAdd(t, e, ZoneRequestLine, "api.example.com", "api.internal.example", false)
	req := &store.Request{
		URL:     "http://api.example.com/v1/x",
		Headers: []store.Header{{Name: "Host", Value: "api.example.com"}},
	}
	e.ApplyRequest(req)
	if !strings.HasPrefix(req.URL, "http://api.internal.example/") {
		t.Fatalf("url = %s", req.URL)
	}
	found := false
	for _, h := range req.Headers {
		if strings.EqualFold(h.Name, "Host") {
			found = true
			if h.Value != "api.internal.example" {
				t.Fatalf("host header not synced: %s", h.Value)
			}
		}
	}
	if !found {
		t.Fatal("host header disappeared")
	}
}

func TestHeaderAndBodyRewrites(t *testing.T) {
	e, _ := Open(filepath.Join(t.TempDir(), "mr.json"))
	mustAdd(t, e, ZoneRequestHeader, "curl/[0-9.]+", "pulse-agent", true)
	mustAdd(t, e, ZoneRequestBody, "secret-token", "REDACTED", false)
	req := &store.Request{
		URL:     "http://h.example/api",
		Headers: []store.Header{{Name: "User-Agent", Value: "curl/7.87.0"}, {Name: "Accept", Value: "*/*"}},
		Body:    []byte("token=secret-token&x=1"),
	}
	if !e.ApplyRequest(req) {
		t.Fatal("expected change")
	}
	if req.Headers[0].Value != "pulse-agent" {
		t.Fatalf("UA = %s", req.Headers[0].Value)
	}
	if req.Headers[1].Value != "*/*" {
		t.Fatalf("untouched header changed: %+v", req.Headers[1])
	}
	if string(req.Body) != "token=REDACTED&x=1" {
		t.Fatalf("body = %s", req.Body)
	}
}

func TestResponseRewritesAndHits(t *testing.T) {
	e, _ := Open(filepath.Join(t.TempDir(), "mr.json"))
	r := mustAdd(t, e, ZoneRespBody, `<h1>Original</h1>`, "<h1>Replaced</h1>", false)
	resp := &store.Response{
		StatusCode: 200,
		Headers:    []store.Header{{Name: "Content-Type", Value: "text/html"}},
		Body:       []byte("<html><h1>Original</h1></html>"),
	}
	if !e.ApplyResponse(resp) {
		t.Fatal("expected change")
	}
	if string(resp.Body) != "<html><h1>Replaced</h1></html>" {
		t.Fatalf("body = %s", resp.Body)
	}
	rules := e.List()
	if rules[0].Hits != 1 {
		t.Fatalf("hits = %d", rules[0].Hits)
	}
	_ = r
}

func TestDisabledRuleSkipped(t *testing.T) {
	e, _ := Open(filepath.Join(t.TempDir(), "mr.json"))
	r := mustAdd(t, e, ZoneRequestBody, "a", "b", false)
	_, ok, err := e.Update(r.ID, Rule{Enabled: false, Zone: ZoneRequestBody, Match: "a", Replace: "b"})
	if !ok || err != nil {
		t.Fatalf("update: %v %v", ok, err)
	}
	req := &store.Request{URL: "http://h/", Body: []byte("aaa")}
	if e.ApplyRequest(req) {
		t.Fatal("disabled rule applied")
	}
}

func TestValidationAndPersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mr.json")
	e, _ := Open(path)
	if _, err := e.Add(Rule{Zone: "bogus", Match: "x"}); err == nil {
		t.Fatal("invalid zone accepted")
	}
	if _, err := e.Add(Rule{Zone: ZoneRequestBody, Match: "[", Regex: true}); err == nil {
		t.Fatal("invalid regex accepted")
	}
	if _, err := e.Add(Rule{Zone: ZoneRequestBody, Match: ""}); err == nil {
		t.Fatal("empty match accepted")
	}
	mustAdd(t, e, ZoneRequestBody, "a", "b", false)

	e2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := len(e2.List()); got != 1 {
		t.Fatalf("persisted rules = %d", got)
	}
}
