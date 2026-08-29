// Package rewrite implements Match & Replace rules that modify requests and
// responses as they pass through the proxy (Burp/Caido-style).
package rewrite

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"sync"

	"pulse/internal/store"
)

// Zones describe where a rule applies.
const (
	ZoneRequestLine   = "request_line"   // the request URL (affects where it is sent)
	ZoneRequestHeader = "request_header" // each request header value
	ZoneRequestBody   = "request_body"
	ZoneRespHeader    = "response_header" // each response header value
	ZoneRespBody      = "response_body"
)

var validZones = map[string]bool{
	ZoneRequestLine: true, ZoneRequestHeader: true, ZoneRequestBody: true,
	ZoneRespHeader: true, ZoneRespBody: true,
}

type Rule struct {
	ID      string `json:"id"`
	Enabled bool   `json:"enabled"`
	Zone    string `json:"zone"`
	Match   string `json:"match"`
	Replace string `json:"replace"`
	Regex   bool   `json:"regex"`
	Comment string `json:"comment"`
	Hits    int64  `json:"hits"` // this session only
}

// Engine holds the rule set, persisted as JSON in the data directory.
type Engine struct {
	mu    sync.RWMutex
	rules []*Rule
	next  int
	path  string

	reMu    sync.RWMutex
	reCache map[string]*regexp.Regexp // rule ID -> compiled pattern
}

func Open(path string) (*Engine, error) {
	e := &Engine{path: path, next: 1, reCache: map[string]*regexp.Regexp{}}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return e, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read rewrite rules: %w", err)
	}
	if err := json.Unmarshal(data, &e.rules); err != nil {
		return nil, fmt.Errorf("parse rewrite rules: %w", err)
	}
	for _, r := range e.rules {
		var n int
		if _, err := fmt.Sscanf(r.ID, "rule-%d", &n); err == nil && n >= e.next {
			e.next = n + 1
		}
	}
	return e, nil
}

func (e *Engine) List() []Rule {
	e.mu.RLock()
	defer e.mu.RUnlock()
	out := make([]Rule, 0, len(e.rules))
	for _, r := range e.rules {
		out = append(out, *r)
	}
	return out
}

// Add appends a validated rule and persists.
func (e *Engine) Add(r Rule) (Rule, error) {
	if !validZones[r.Zone] {
		return Rule{}, fmt.Errorf("invalid zone %q", r.Zone)
	}
	if r.Match == "" {
		return Rule{}, fmt.Errorf("match must not be empty")
	}
	if r.Regex {
		if _, err := regexp.Compile(r.Match); err != nil {
			return Rule{}, fmt.Errorf("invalid regex: %v", err)
		}
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	r.ID = fmt.Sprintf("rule-%d", e.next)
	e.next++
	cp := r
	e.rules = append(e.rules, &cp)
	e.cacheRegex(&cp)
	return cp, e.save()
}

// Update replaces a rule by id.
func (e *Engine) Update(id string, r Rule) (Rule, bool, error) {
	if !validZones[r.Zone] {
		return Rule{}, false, fmt.Errorf("invalid zone %q", r.Zone)
	}
	if r.Match == "" {
		return Rule{}, false, fmt.Errorf("match must not be empty")
	}
	if r.Regex {
		if _, err := regexp.Compile(r.Match); err != nil {
			return Rule{}, false, fmt.Errorf("invalid regex: %v", err)
		}
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, old := range e.rules {
		if old.ID == id {
			r.ID = id
			r.Hits = old.Hits
			*old = r
			e.cacheRegex(old)
			return r, true, e.save()
		}
	}
	return Rule{}, false, nil
}

func (e *Engine) Delete(id string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	for i, r := range e.rules {
		if r.ID == id {
			e.rules = append(e.rules[:i], e.rules[i+1:]...)
			return e.save() == nil
		}
	}
	return false
}

func (e *Engine) save() error {
	data, err := json.MarshalIndent(e.rules, "", "  ")
	if err != nil {
		return err
	}
	tmp := e.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, e.path)
}

func (e *Engine) bump(id string) {
	for _, r := range e.rules {
		if r.ID == id {
			r.Hits++
			return
		}
	}
}

// ApplyRequest runs the request rules (in order) and reports whether anything
// changed. A request_line rewrite that changes the host also updates the Host
// header so the request stays consistent.
func (e *Engine) ApplyRequest(req *store.Request) bool {
	e.mu.RLock()
	rules := make([]*Rule, len(e.rules))
	copy(rules, e.rules)
	e.mu.RUnlock()

	changed := false
	for _, r := range rules {
		if !r.Enabled {
			continue
		}
		re := e.regexFor(r)
		switch r.Zone {
		case ZoneRequestLine:
			if next, ok := applyText(req.URL, r, re); ok {
				if hostOf(next) != hostOf(req.URL) {
					setHostHeader(req, hostOf(next))
				}
				req.URL = next
				changed = true
				e.mu.Lock()
				e.bump(r.ID)
				e.mu.Unlock()
			}
		case ZoneRequestHeader:
			for i := range req.Headers {
				if v, ok := applyText(req.Headers[i].Value, r, re); ok {
					req.Headers[i].Value = v
					changed = true
					e.mu.Lock()
					e.bump(r.ID)
					e.mu.Unlock()
				}
			}
		case ZoneRequestBody:
			if out, ok := applyBytes(req.Body, r, re); ok {
				req.Body = out
				changed = true
				e.mu.Lock()
				e.bump(r.ID)
				e.mu.Unlock()
			}
		}
	}
	return changed
}

// ApplyResponse runs the response rules and reports whether anything changed.
func (e *Engine) ApplyResponse(resp *store.Response) bool {
	e.mu.RLock()
	rules := make([]*Rule, len(e.rules))
	copy(rules, e.rules)
	e.mu.RUnlock()

	changed := false
	for _, r := range rules {
		if !r.Enabled {
			continue
		}
		re := e.regexFor(r)
		switch r.Zone {
		case ZoneRespHeader:
			for i := range resp.Headers {
				if v, ok := applyText(resp.Headers[i].Value, r, re); ok {
					resp.Headers[i].Value = v
					changed = true
					e.mu.Lock()
					e.bump(r.ID)
					e.mu.Unlock()
				}
			}
		case ZoneRespBody:
			if out, ok := applyBytes(resp.Body, r, re); ok {
				resp.Body = out
				changed = true
				e.mu.Lock()
				e.bump(r.ID)
				e.mu.Unlock()
			}
		}
	}
	return changed
}

// cacheRegex pre-compiles (or invalidates) a rule's pattern. Caller must hold
// e.mu (write) — the cache itself is guarded by reMu.
func (e *Engine) cacheRegex(r *Rule) {
	e.reMu.Lock()
	defer e.reMu.Unlock()
	if !r.Regex || r.Match == "" {
		delete(e.reCache, r.ID)
		return
	}
	if re, err := regexp.Compile(r.Match); err == nil {
		e.reCache[r.ID] = re
	} else {
		delete(e.reCache, r.ID)
	}
}

func (e *Engine) regexFor(r *Rule) *regexp.Regexp {
	e.reMu.RLock()
	re := e.reCache[r.ID]
	e.reMu.RUnlock()
	return re
}

func applyText(in string, r *Rule, re *regexp.Regexp) (string, bool) {
	if r.Regex {
		if re == nil {
			return in, false
		}
		out := re.ReplaceAllString(in, r.Replace)
		return out, out != in
	}
	out := strings.ReplaceAll(in, r.Match, r.Replace)
	return out, out != in
}

func applyBytes(in []byte, r *Rule, re *regexp.Regexp) ([]byte, bool) {
	if r.Regex {
		if re == nil {
			return in, false
		}
		out := re.ReplaceAll(in, []byte(r.Replace))
		return out, !equalBytes(out, in)
	}
	out := bytesReplaceAll(in, []byte(r.Match), []byte(r.Replace))
	return out, !equalBytes(out, in)
}

func equalBytes(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func bytesReplaceAll(s, old, new []byte) []byte {
	return []byte(strings.ReplaceAll(string(s), string(old), string(new)))
}

func hostOf(rawURL string) string {
	rest := rawURL
	if i := strings.Index(rest, "://"); i >= 0 {
		rest = rest[i+3:]
	}
	if i := strings.IndexAny(rest, "/?#"); i >= 0 {
		rest = rest[:i]
	}
	return rest
}

func setHostHeader(req *store.Request, host string) {
	for i, h := range req.Headers {
		if strings.EqualFold(h.Name, "Host") {
			req.Headers[i].Value = host
			return
		}
	}
	req.Headers = append(req.Headers, store.Header{Name: "Host", Value: host})
}
