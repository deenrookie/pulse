// Deep keyword search across everything Pulse has captured: traffic flows
// (request AND response bodies/headers) and Repeater tabs (current requests
// plus every stored response in their history). Sequential scan — fast
// enough for tens of thousands of flows, no index to maintain.
package api

import (
	"net/http"
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

func snippetAround(hay, needle string) string {
	i := strings.Index(hay, needle)
	if i < 0 {
		return ""
	}
	start := i - searchSnippetRadius
	if start < 0 {
		start = 0
	}
	end := i + len(needle) + searchSnippetRadius
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

// handleSearch: GET /api/search?q=keyword — deep search across traffic and
// Repeater records (requests + responses).
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
	lower := strings.ToLower(q)
	hits := make([]SearchHit, 0)

	// ---- traffic flows ----
	metas, _ := s.st.List("")
	for i := len(metas) - 1; i >= 0 && len(hits) < searchMaxHits; i-- { // newest first
		fl, ok := s.st.Get(metas[i].ID)
		if !ok {
			continue
		}
		inReq := strings.Contains(strings.ToLower(requestText(&fl.Req)), lower)
		inResp := strings.Contains(strings.ToLower(responseText(fl.Resp)), lower)
		if !inReq && !inResp {
			continue
		}
		side := "request"
		hay := requestText(&fl.Req)
		switch {
		case inReq && inResp:
			side = "both"
		case inResp:
			side = "response"
			hay = responseText(fl.Resp)
		}
		status := 0
		if fl.Resp != nil {
			status = fl.Resp.StatusCode
		}
		hits = append(hits, SearchHit{
			Source: "traffic", ID: fl.ID, Side: side, Status: status,
			Title:   metas[i].Method + " " + metas[i].Host + metas[i].Path,
			Snippet: snippetAround(strings.ToLower(hay), lower),
		})
	}

	// ---- repeater tabs (current request + response history) ----
	for _, t := range s.rep.List() {
		if len(hits) >= searchMaxHits {
			break
		}
		tab := t
		if hit := searchRepeaterTab(&tab, lower); hit != nil {
			hits = append(hits, *hit)
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{"q": q, "hits": hits, "total": len(hits)})
}

func searchRepeaterTab(t *repeater.Tab, lower string) *SearchHit {
	reqHit := strings.Contains(strings.ToLower(requestText(&t.Request)), lower)
	respHit := false
	var respHay string
	if t.LastResponse != nil {
		respHay = responseText(t.LastResponse)
		respHit = strings.Contains(strings.ToLower(respHay), lower)
	}
	if !respHit && len(t.History) > 0 {
		for _, h := range t.History {
			if h.Err != "" && strings.Contains(strings.ToLower(h.Err), lower) {
				respHit = true
				respHay = h.Err
				break
			}
			if txt := responseText(h.Resp); txt != "" && strings.Contains(strings.ToLower(txt), lower) {
				respHit = true
				respHay = txt
				break
			}
		}
	}
	if !reqHit && !respHit {
		return nil
	}
	side, hay := "request", requestText(&t.Request)
	switch {
	case reqHit && respHit:
		side = "both"
	case respHit:
		side = "response"
		hay = respHay
	}
	status := 0
	if t.LastResponse != nil {
		status = t.LastResponse.StatusCode
	}
	return &SearchHit{
		Source: "repeater", ID: t.ID, Side: side, Status: status,
		Title:   t.Title,
		Snippet: snippetAround(strings.ToLower(hay), lower),
	}
}
