// Package store keeps captured flows in memory and mirrors them to an
// append-only JSONL log that is replayed on startup.
package store

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

type Header struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type Request struct {
	ID          string    `json:"id"`
	Method      string    `json:"method"`
	URL         string    `json:"url"`
	HTTPVersion string    `json:"httpVersion"`
	Headers     []Header  `json:"headers"`
	Body        []byte    `json:"body"`
	Truncated   bool      `json:"truncated"`
	Timestamp   time.Time `json:"timestamp"`
	Source      string    `json:"source"` // "proxy" | "repeater"
}

type Response struct {
	StatusCode  int       `json:"statusCode"`
	Reason      string    `json:"reason"`
	HTTPVersion string    `json:"httpVersion"`
	Headers     []Header  `json:"headers"`
	Body        []byte    `json:"body"`
	Truncated   bool      `json:"truncated"`
	Timestamp   time.Time `json:"timestamp"`
	DurationMs  int64     `json:"durationMs"`
}

type FlowState string

const (
	StatePending     FlowState = "pending"
	StateComplete    FlowState = "complete"
	StateIntercepted FlowState = "intercepted"
	StateDropped     FlowState = "dropped"
	StateError       FlowState = "error"
)

type Flow struct {
	ID    string    `json:"id"`
	Req   Request   `json:"request"`
	Resp  *Response `json:"response,omitempty"`
	State FlowState `json:"state"`
	Error string    `json:"error,omitempty"`
	// WebSocket messages captured after a 101 upgrade (empty for plain HTTP).
	WSMessages []WSMessage `json:"ws,omitempty"`
}

// WSMessage is one completed WebSocket message (assembled from fragments)
// observed while relaying an upgraded connection. Payload is capped.
type WSMessage struct {
	Dir       string    `json:"dir"` // "c2s" | "s2c"
	Opcode    string    `json:"opcode"` // "text" | "binary" | "close" | "ping" | "pong"
	Size      int       `json:"size"`
	Data      []byte    `json:"data,omitempty"`
	Truncated bool      `json:"truncated,omitempty"`
	At        time.Time `json:"at"`
}

// FlowMeta is the list-view projection of a flow (no bodies).
type FlowMeta struct {
	ID          string    `json:"id"`
	Method      string    `json:"method"`
	URL         string    `json:"url"`
	Host        string    `json:"host"`
	Path        string    `json:"path"`
	StatusCode  int       `json:"statusCode"`
	ContentType string    `json:"contentType"`
	ReqSize     int       `json:"reqSize"`
	RespSize    int       `json:"respSize"`
	DurationMs  int64     `json:"durationMs"`
	State       FlowState `json:"state"`
	Timestamp   time.Time `json:"timestamp"`
	Source      string    `json:"source"`
	WSCount     int       `json:"wsCount"`
}

// Store is safe for concurrent use. Flows are immutable once published
// except for the documented in-place transitions below.
type Store struct {
	mu    sync.RWMutex
	order []string
	flows map[string]*Flow
	next  int64
	path  string
	file  *os.File
}

func Open(path string) (*Store, error) {
	s := &Store{flows: map[string]*Flow{}, path: path, next: 1}
	if err := s.load(); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open flow log: %w", err)
	}
	s.file = f
	return s, nil
}

func (s *Store) load() error {
	f, err := os.Open(s.path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("open flow log: %w", err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1024*1024), 64*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var fl Flow
		if err := json.Unmarshal([]byte(line), &fl); err != nil {
			continue // torn last write: skip malformed line
		}
		if _, exists := s.flows[fl.ID]; !exists {
			s.order = append(s.order, fl.ID)
		}
		s.flows[fl.ID] = &fl
		if n := idNumber(fl.ID); n >= s.next {
			s.next = n + 1
		}
	}
	return sc.Err()
}

func idNumber(id string) int64 {
	var n int64
	if _, err := fmt.Sscanf(id, "req-%d", &n); err != nil {
		return 0
	}
	return n
}

// NewID returns the next monotonic request id (req-<n>).
func (s *Store) NewID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := fmt.Sprintf("req-%d", s.next)
	s.next++
	return id
}

// Add records a new flow and appends it to the JSONL log.
func (s *Store) Add(fl *Flow) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, dup := s.flows[fl.ID]; dup {
		return fmt.Errorf("duplicate flow id %s", fl.ID)
	}
	s.flows[fl.ID] = fl
	s.order = append(s.order, fl.ID)
	return s.persist(fl)
}

// Update replaces the stored flow with fl (response arrived, state
// transition, intercepted request rewritten) and re-persists it.
func (s *Store) Update(fl *Flow) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.flows[fl.ID]; !ok {
		return fmt.Errorf("unknown flow id %s", fl.ID)
	}
	s.flows[fl.ID] = fl
	return s.persist(fl)
}

func (s *Store) persist(fl *Flow) error {
	if s.file == nil {
		return nil
	}
	b, err := json.Marshal(fl)
	if err != nil {
		return err
	}
	if _, err := s.file.Write(append(b, '\n')); err != nil {
		return err
	}
	return nil
}

// Get returns a snapshot copy of the flow.
func (s *Store) Get(id string) (*Flow, bool) {
	s.mu.RLock()
	fl := s.flows[id]
	s.mu.RUnlock()
	if fl == nil {
		return nil, false
	}
	cp := *fl
	return &cp, true
}

// List returns flow metadata in chronological order filtered by a
// case-insensitive keyword (empty matches all).
func (s *Store) List(q string) ([]FlowMeta, int) {
	q = strings.ToLower(q)
	s.mu.RLock()
	defer s.mu.RUnlock()
	total := len(s.order)
	out := make([]FlowMeta, 0, len(s.order))
	for _, id := range s.order {
		m := metaOf(s.flows[id])
		if q != "" && !strings.Contains(strings.ToLower(fmt.Sprintf("%s %s %s %d %s", m.Method, m.URL, m.Path, m.StatusCode, m.State)), q) {
			continue
		}
		out = append(out, m)
	}
	return out, total
}

func metaOf(fl *Flow) FlowMeta {
	m := FlowMeta{
		ID: fl.ID, Method: fl.Req.Method, URL: fl.Req.URL,
		StatusCode: 0, ReqSize: len(fl.Req.Body), State: fl.State,
		WSCount:    len(fl.WSMessages),
		Timestamp: fl.Req.Timestamp, Source: fl.Req.Source,
		DurationMs: 0, RespSize: 0,
	}
	if u := splitURL(fl.Req.URL); u != nil {
		m.Host, m.Path = u.host, u.path
	}
	if fl.Resp != nil {
		m.StatusCode = fl.Resp.StatusCode
		m.DurationMs = fl.Resp.DurationMs
		m.RespSize = len(fl.Resp.Body)
		for _, h := range fl.Resp.Headers {
			if strings.EqualFold(h.Name, "Content-Type") {
				m.ContentType = h.Value
				break
			}
		}
	}
	return m
}

type urlParts struct{ host, path string }

func splitURL(raw string) *urlParts {
	rest := raw
	if i := strings.Index(rest, "://"); i >= 0 {
		rest = rest[i+3:]
	}
	host := rest
	path := "/"
	if i := strings.IndexAny(rest, "/?#"); i >= 0 {
		host = rest[:i]
		if rest[i] == '/' {
			path = rest[i:]
			if j := strings.IndexAny(path, "?#"); j >= 0 {
				path = path[:j]
			}
		}
	}
	if host == "" {
		return nil
	}
	return &urlParts{host: host, path: path}
}

// Delete removes one flow from memory (the log keeps its history; entries
// are compacted by Clear).
func (s *Store) Delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.flows[id]; !ok {
		return false
	}
	delete(s.flows, id)
	for i, x := range s.order {
		if x == id {
			s.order = append(s.order[:i], s.order[i+1:]...)
			break
		}
	}
	return true
}

// Clear drops all flows from memory and resets the log file. On Windows the
// append-mode handle cannot truncate, so the file is reopened with O_TRUNC.
func (s *Store) Clear() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.flows = map[string]*Flow{}
	s.order = nil
	if s.file != nil {
		old := s.file
		old.Close()
		f, err := os.OpenFile(s.path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			s.file = nil
			return err
		}
		s.file = f
	}
	return nil
}

// Count returns the number of stored flows.
func (s *Store) Count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.order)
}

// CountPending returns flows still awaiting a response.
func (s *Store) CountPending() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n := 0
	for _, id := range s.order {
		if s.flows[id].State == StatePending {
			n++
		}
	}
	return n
}

// Close flushes and closes the log file.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.file == nil {
		return nil
	}
	err := s.file.Close()
	s.file = nil
	return err
}
