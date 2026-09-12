// Deep keyword search across everything Pulse has captured: traffic flows
// (request AND response bodies/headers) and Repeater tabs (current requests
// plus every stored response in their history). Sequential scan — fast
// enough for tens of thousands of flows, no index to maintain.
//
// Burp-style options: restrict the match to one side of the message
// (?side=request|response), case sensitivity (?cs=1) and regex mode
// (?re=1).
package api

import (
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"pulse/internal/repeater"
	"pulse/internal/store"
)

// SearchHit is one match: where it came from, which side of the message
// matched, and a context snippet around the keyword.
type SearchHit struct {
	Source string `json:"source"` // "traffic" | "repeater"
	ID     string `json:"id"`     // flow id or repeater tab id
	Title  string `json:"title"`  // "GET host/path" or tab title
	Side   string `json:"side"`   // "request" | "response" | "both"
	Status int    `json:"statusCode,omitempty"`
	Snippet string `json:"snippet"`
}

const (
	searchSnippetRadius = 60
	searchMaxHits       = 200
)

// matcher wraps the query under the case/regex options so every call site
// (traffic scan, repeater scan, snippet) agrees on what "a match" is.
type matcher struct {
	re     *regexp.Regexp // regex mode
	needle string         // plain mode, verbatim
	lower  string         // plain mode, pre-lowered for the default case-insensitive search
	cs     bool
}

func newMatcher(q string, caseSensitive, isRegex bool) (*matcher, error) {
	m := &matcher{needle: q, lower: strings.ToLower(q), cs: caseSensitive}
	if isRegex {
		expr := q
		if !caseSensitive {
			expr = "(?i)" + expr
		}
		re, err := regexp.Compile(expr)
		if err != nil {
			return nil, err
		}
		m.re = re
	}
	return m, nil
}

// find locates the first match: its start index and length (-1 when absent).
func (m *matcher) find(s string) (int, int) {
	if m.re != nil {
		loc := m.re.FindStringIndex(s)
		if loc == nil {
			return -1, 0
		}
		return loc[0], loc[1] - loc[0]
	}
	if m.cs {
		i := strings.Index(s, m.needle)
		return i, len(m.needle)
	}
	i := strings.Index(strings.ToLower(s), m.lower)
	return i, len(m.lower)
}

func (m *matcher) contains(s string) bool {
	i, _ := m.find(s)
	return i >= 0
}

func snippetAround(hay string, idx, length int) string {
	if idx < 0 {
		return ""
	}
	start := idx - searchSnippetRadius
	if start < 0 {
		start = 0
	}
	end := idx + length + searchSnippetRadius
	if end > len(hay) {
		end = len(hay)
	}
	s := hay[start:end]
	if !utf8.ValidString(s) {
		return "" // binary body — skip the snippet, keep the hit
	}
	s = strings.TrimSpace(strings.ReplaceAll(s, "\n", " "))
	if start > 0 {
		s = "…" + s
	}
	if end < len(hay) {
		s += "…"
	}
	return s
}

func headerText(headers []store.Header) string {
	var b strings.Builder
	for _, h := range headers {
		b.WriteString(h.Name)
		b.WriteString(": ")
		b.WriteString(h.Value)
		b.WriteString("\n")
	}
	return b.String()
}

func requestText(req *store.Request) string {
	return req.Method + " " + req.URL + "\n" + headerText(req.Headers) + string(req.Body)
}

func responseText(resp *store.Response) string {
	if resp == nil {
		return ""
	}
	return resp.HTTPVersion + " " + resp.Reason + "\n" + headerText(resp.Headers) + string(resp.Body)
}

// handleSearch: GET /api/search?q=keyword[&side=request|response][&cs=1][&re=1]
// — deep search across traffic and Repeater records. side restricts matching
// to one half of the message; cs makes it case-sensitive; re treats q as a
// regular expression (all Burp search options).
func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeErr(w, http.StatusBadRequest, "missing ?q=")
		return
	}
	side := r.URL.Query().Get("side")
	if side != "request" && side != "response" {
		side = "" // anything else means "both sides"
	}
	m, err := newMatcher(q, r.URL.Query().Get("cs") == "1", r.URL.Query().Get("re") == "1")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid regex: "+err.Error())
		return
	}
	hits := make([]SearchHit, 0)

	// ---- traffic flows ----
	metas, _ := s.st.List("")
	for i := len(metas) - 1; i >= 0 && len(hits) < searchMaxHits; i-- { // newest first
		fl, ok := s.st.Get(metas[i].ID)
		if !ok {
			continue
		}
		reqIdx, reqLen := -1, 0
		if side != "response" {
			reqIdx, reqLen = m.find(requestText(&fl.Req))
		}
		respIdx := -1
		if side != "request" && fl.Resp != nil {
			respIdx, _ = m.find(responseText(fl.Resp))
		}
		if reqIdx < 0 && respIdx < 0 {
			continue
		}
		msgSide, hay, idx, length := "request", requestText(&fl.Req), reqIdx, reqLen
		switch {
		case reqIdx >= 0 && respIdx >= 0:
			msgSide = "both"
		case respIdx >= 0:
			msgSide = "response"
			hay = responseText(fl.Resp)
			idx, length = m.find(hay)
		}
		status := 0
		if fl.Resp != nil {
			status = fl.Resp.StatusCode
		}
		hits = append(hits, SearchHit{
			Source: "traffic", ID: fl.ID, Side: msgSide, Status: status,
			Title:   metas[i].Method + " " + metas[i].Host + metas[i].Path,
			Snippet: snippetAround(hay, idx, length),
		})
	}

	// ---- repeater tabs (current request + response history) ----
	for _, t := range s.rep.List() {
		if len(hits) >= searchMaxHits {
			break
		}
		tab := t
		if hit := searchRepeaterTab(&tab, m, side); hit != nil {
			hits = append(hits, *hit)
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{"q": q, "hits": hits, "total": len(hits)})
}

func searchRepeaterTab(t *repeater.Tab, m *matcher, side string) *SearchHit {
	reqIdx, reqLen := -1, 0
	if side != "response" {
		reqIdx, reqLen = m.find(requestText(&t.Request))
	}
	respIdx := -1
	var respHay string
	if side != "request" {
		if t.LastResponse != nil {
			respHay = responseText(t.LastResponse)
			respIdx, _ = m.find(respHay)
		}
		if respIdx < 0 && len(t.History) > 0 {
			for _, h := range t.History {
				if h.Err != "" && m.contains(h.Err) {
					respIdx, respHay = 0, h.Err
					break
				}
				if txt := responseText(h.Resp); txt != "" && m.contains(txt) {
					respIdx, respHay = 0, txt
					break
				}
			}
		}
	}
	if reqIdx < 0 && respIdx < 0 {
		return nil
	}
	msgSide, hay, idx, length := "request", requestText(&t.Request), reqIdx, reqLen
	if respIdx >= 0 {
		if reqIdx >= 0 {
			msgSide = "both"
		} else {
			msgSide = "response"
			hay = respHay
			idx, length = m.find(hay)
		}
	}
	status := 0
	if t.LastResponse != nil {
		status = t.LastResponse.StatusCode
	}
	return &SearchHit{
		Source: "repeater", ID: t.ID, Side: msgSide, Status: status,
		Title:  t.Title,
		Snippet: snippetAround(hay, idx, length),
	}
}
