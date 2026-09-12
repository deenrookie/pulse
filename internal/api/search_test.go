package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// searchResult mirrors the /api/search response the tests assert on.
type searchResult struct {
	Q    string `json:"q"`
	Hits []struct {
		Source  string `json:"source"`
		ID      string `json:"id"`
		Side    string `json:"side"`
		Snippet string `json:"snippet"`
	} `json:"hits"`
	Total int `json:"total"`
}

func searchQuery(t *testing.T, e *testEnv, path string) searchResult {
	t.Helper()
	resp, data := e.do(t, "GET", path, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s: status %d: %s", path, resp.StatusCode, data)
	}
	var out searchResult
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return out
}

func sides(res searchResult) map[string]bool {
	m := map[string]bool{}
	for _, h := range res.Hits {
		m[h.Side] = true
	}
	return m
}

func TestSearchBurpOptions(t *testing.T) {
	e := newEnv(t)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/both":
			w.Write([]byte("echo BOTHMARK in the response body"))
		case "/responly":
			w.Write([]byte("the secret is RESPONLYMARK here"))
		case "/case":
			w.Write([]byte("mixed CaseSenTest token"))
		default:
			w.Write([]byte("ok"))
		}
	}))
	defer up.Close()

	cl := proxiedClient(e.proxyAddr)
	for _, p := range []string{"/both?q=BOTHMARK", "/responly", "/reqonly?find=REQONLYMARK", "/case"} {
		resp, err := cl.Get(up.URL + p)
		if err != nil {
			t.Fatalf("proxied GET %s: %v", p, err)
		}
		resp.Body.Close()
	}
	if !waitFlows(t, e, 4) {
		t.Fatal("flows never reached the store")
	}

	// default: both sides, case-insensitive
	if res := searchQuery(t, e, "/api/search?q=BOTHMARK"); res.Total != 1 || !sides(res)["both"] {
		t.Fatalf("q=BOTHMARK: want 1 hit side=both, got %+v", res)
	}

	// side filter narrows the same flow to one half
	if res := searchQuery(t, e, "/api/search?q=BOTHMARK&side=request"); res.Total != 1 || !sides(res)["request"] || sides(res)["both"] {
		t.Fatalf("side=request: want 1 hit side=request, got %+v", res)
	}
	if res := searchQuery(t, e, "/api/search?q=BOTHMARK&side=response"); res.Total != 1 || !sides(res)["response"] || sides(res)["both"] {
		t.Fatalf("side=response: want 1 hit side=response, got %+v", res)
	}

	// request-only marker disappears under side=response and vice versa
	if res := searchQuery(t, e, "/api/search?q=REQONLYMARK&side=request"); res.Total != 1 {
		t.Fatalf("REQONLYMARK side=request: want 1, got %d", res.Total)
	}
	if res := searchQuery(t, e, "/api/search?q=REQONLYMARK&side=response"); res.Total != 0 {
		t.Fatalf("REQONLYMARK side=response: want 0, got %d", res.Total)
	}
	if res := searchQuery(t, e, "/api/search?q=RESPONLYMARK&side=response"); res.Total != 1 {
		t.Fatalf("RESPONLYMARK side=response: want 1, got %d", res.Total)
	}
	if res := searchQuery(t, e, "/api/search?q=RESPONLYMARK&side=request"); res.Total != 0 {
		t.Fatalf("RESPONLYMARK side=request: want 0, got %d", res.Total)
	}

	// case sensitivity (default insensitive)
	if res := searchQuery(t, e, "/api/search?q=casesentest"); res.Total != 1 {
		t.Fatalf("q=casesentest insensitive: want 1, got %d", res.Total)
	}
	if res := searchQuery(t, e, "/api/search?q=casesentest&cs=1"); res.Total != 0 {
		t.Fatalf("q=casesentest cs=1: want 0, got %d", res.Total)
	}
	if res := searchQuery(t, e, "/api/search?q=CaseSenTest&cs=1"); res.Total != 1 {
		t.Fatalf("q=CaseSenTest cs=1: want 1, got %d", res.Total)
	}

	// regex mode, including anchors and alternation
	if res := searchQuery(t, e, "/api/search?q=(RESP|REQ)ONLYMARK&re=1"); res.Total != 2 {
		t.Fatalf("regex alternation: want 2, got %d", res.Total)
	}
	if res := searchQuery(t, e, "/api/search?q=BOTHMARK$&re=1"); res.Total != 0 {
		t.Fatalf("anchored regex should not match mid-body, got %d", res.Total)
	}
	if res := searchQuery(t, e, "/api/search?q=(resp|req)onlymark&re=1&cs=1"); res.Total != 0 {
		t.Fatalf("regex cs=1 lowercase should not match, got %d", res.Total)
	}
	res := searchQuery(t, e, "/api/search?q=RESPONLY(MARK)&re=1")
	if res.Total != 1 || res.Hits[0].Snippet == "" {
		t.Fatalf("regex snippet: want 1 hit with snippet, got %+v", res)
	}

	// invalid regex → 400, not a panic
	resp, data := e.do(t, "GET", "/api/search?q=[&re=1", nil)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid regex: want 400, got %d (%s)", resp.StatusCode, data)
	}
}
