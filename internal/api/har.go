// HAR 1.2 export: streams every completed flow as an HTTP Archive file —
// the interchange format Burp, browsers and most tools import.
package api

import (
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"pulse/internal/store"
)

type harHeader struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type harNameValuePair struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type harPostData struct {
	MimeType string `json:"mimeType"`
	Text     string `json:"text"`
}

type harRequest struct {
	Method      string            `json:"method"`
	URL         string            `json:"url"`
	HTTPVersion string            `json:"httpVersion"`
	Cookies     []harNameValuePair `json:"cookies"`
	Headers     []harHeader       `json:"headers"`
	QueryString []harNameValuePair `json:"queryString"`
	HeadersSize int               `json:"headersSize"`
	BodySize    int               `json:"bodySize"`
	PostData    *harPostData      `json:"postData,omitempty"`
}

type harContent struct {
	Size     int    `json:"size"`
	MimeType string `json:"mimeType"`
	Text     string `json:"text,omitempty"`
	Encoding string `json:"encoding,omitempty"`
}

type harResponse struct {
	Status      int               `json:"status"`
	StatusText  string            `json:"statusText"`
	HTTPVersion string            `json:"httpVersion"`
	Cookies     []harNameValuePair `json:"cookies"`
	Headers     []harHeader       `json:"headers"`
	Content     harContent        `json:"content"`
	RedirectURL string            `json:"redirectURL"`
	HeadersSize int               `json:"headersSize"`
	BodySize    int               `json:"bodySize"`
}

type harTimings struct {
	Send    float64 `json:"send"`
	Wait    float64 `json:"wait"`
	Receive float64 `json:"receive"`
}

type harEntry struct {
	StartedDateTime string       `json:"startedDateTime"`
	Time            float64      `json:"time"`
	Request         harRequest   `json:"request"`
	Response        harResponse  `json:"response"`
	Cache           struct{}     `json:"cache"`
	Timings         harTimings   `json:"timings"`
}

type harLog struct {
	Version string     `json:"version"`
	Creator harCreator `json:"creator"`
	Entries []harEntry `json:"entries"`
}

type harCreator struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Comment string `json:"comment,omitempty"`
}

func harHeaders(headers []store.Header) []harHeader {
	out := make([]harHeader, 0, len(headers))
	for _, h := range headers {
		out = append(out, harHeader{Name: h.Name, Value: h.Value})
	}
	return out
}

func headerValue(headers []store.Header, name string) string {
	for _, h := range headers {
		if strings.EqualFold(h.Name, name) {
			return h.Value
		}
	}
	return ""
}

func harQuery(url string) []harNameValuePair {
	var out []harNameValuePair
	i := strings.IndexByte(url, '?')
	if i < 0 {
		return out
	}
	for _, kv := range strings.Split(url[i+1:], "&") {
		if kv == "" {
			continue
		}
		name, value, _ := strings.Cut(kv, "=")
		out = append(out, harNameValuePair{Name: name, Value: value})
	}
	return out
}

// harBodyText: UTF-8-safe bodies go in as plain text, anything else as
// base64 with an encoding marker (per the HAR spec).
func harBodyText(body []byte) (text, encoding string) {
	if len(body) == 0 {
		return "", ""
	}
	if utf8.Valid(body) && !strings.ContainsRune(string(body), 0xFFFD) {
		return string(body), ""
	}
	return base64.StdEncoding.EncodeToString(body), "base64"
}

func buildHAREntry(fl *store.Flow) harEntry {
	req := fl.Req
	e := harEntry{
		StartedDateTime: req.Timestamp.UTC().Format(time.RFC3339Nano),
		Request: harRequest{
			Method:      req.Method,
			URL:         req.URL,
			HTTPVersion: req.HTTPVersion,
			Cookies:     []harNameValuePair{},
			Headers:     harHeaders(req.Headers),
			QueryString: harQuery(req.URL),
			HeadersSize: -1,
			BodySize:    len(req.Body),
		},
		Cache:   struct{}{},
		Timings: harTimings{Send: -1, Wait: -1, Receive: -1},
	}
	if len(req.Body) > 0 {
		text, _ := harBodyText(req.Body)
		e.Request.PostData = &harPostData{MimeType: headerValue(req.Headers, "Content-Type"), Text: text}
	}
	if fl.Resp != nil {
		resp := fl.Resp
		text, encoding := harBodyText(resp.Body)
		e.Time = float64(resp.DurationMs)
		e.Timings = harTimings{Send: 0, Wait: float64(resp.DurationMs), Receive: 0}
		e.Response = harResponse{
			Status:      resp.StatusCode,
			StatusText:  resp.Reason,
			HTTPVersion: resp.HTTPVersion,
			Cookies:     []harNameValuePair{},
			Headers:     harHeaders(resp.Headers),
			Content: harContent{
				Size:     len(resp.Body),
				MimeType: headerValue(resp.Headers, "Content-Type"),
				Text:     text,
				Encoding: encoding,
			},
			HeadersSize: -1,
			BodySize:    len(resp.Body),
		}
	}
	return e
}

// handleFlowsHAR: GET /api/flows/har — download every completed flow as HAR.
func (s *Server) handleFlowsHAR(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	metas, _ := s.st.List("")
	entries := make([]harEntry, 0, len(metas))
	for _, m := range metas {
		fl, ok := s.st.Get(m.ID)
		if !ok || fl.Resp == nil {
			continue // HAR entries require a response
		}
		entries = append(entries, buildHAREntry(fl))
	}
	log := harLog{
		Version: "1.2",
		Creator: harCreator{Name: "Pulse", Version: s.Version},
		Entries: entries,
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Disposition", `attachment; filename="pulse-`+time.Now().Format("20060102-150405")+`.har"`)
	w.Header().Set("X-HAR-Entries", strconv.Itoa(len(entries)))
	writeJSON(w, http.StatusOK, map[string]harLog{"log": log})
}
