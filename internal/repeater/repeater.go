// Package repeater manages persisted Repeater tabs (editable request copies).
package repeater

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"pulse/internal/store"
)

// HistoryEntry is the outcome of one send: a response or an error.
type HistoryEntry struct {
	Resp *store.Response `json:"response,omitempty"`
	Err  string          `json:"error,omitempty"`
	At   time.Time       `json:"at"`
}

type Tab struct {
	ID           string           `json:"id"`
	Title        string           `json:"title"`
	Request      store.Request    `json:"request"`
	LastResponse *store.Response  `json:"lastResponse,omitempty"`
	// History holds the outcomes of recent sends, oldest first (max 20).
	History   []HistoryEntry `json:"history,omitempty"`
	UpdatedAt time.Time      `json:"updatedAt"`
}

// Manager keeps tabs in memory and mirrors them to a JSON file.
type Manager struct {
	mu   sync.Mutex
	tabs []*Tab
	next int
	path string
}

func Open(path string) (*Manager, error) {
	m := &Manager{path: path, next: 1}
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return m, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read repeater file: %w", err)
	}
	if err := json.Unmarshal(data, &m.tabs); err != nil {
		return nil, fmt.Errorf("parse repeater file: %w", err)
	}
	for _, t := range m.tabs {
		var n int
		if _, err := fmt.Sscanf(t.ID, "tab-%d", &n); err == nil && n >= m.next {
			m.next = n + 1
		}
	}
	return m, nil
}

func (m *Manager) List() []Tab {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Tab, 0, len(m.tabs))
	for _, t := range m.tabs {
		out = append(out, *t)
	}
	return out
}

func (m *Manager) Get(id string) (Tab, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, t := range m.tabs {
		if t.ID == id {
			return *t, true
		}
	}
	return Tab{}, false
}

// CreateFromRequest stores a copy of req as a new tab.
func (m *Manager) CreateFromRequest(req *store.Request) (Tab, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := *req
	cp.ID = ""
	t := &Tab{
		ID:        fmt.Sprintf("tab-%d", m.next),
		Request:   cp,
		UpdatedAt: time.Now(),
	}
	m.next++
	t.Title = titleOf(&t.Request)
	m.tabs = append(m.tabs, t)
	return *t, m.save()
}

func (m *Manager) Update(id string, req *store.Request) (Tab, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, t := range m.tabs {
		if t.ID == id {
			cp := *req
			cp.ID = t.Request.ID
			t.Request = cp
			t.Title = titleOf(&t.Request)
			t.UpdatedAt = time.Now()
			return *t, true, m.save()
		}
	}
	return Tab{}, false, nil
}

func (m *Manager) Delete(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i, t := range m.tabs {
		if t.ID == id {
			m.tabs = append(m.tabs[:i], m.tabs[i+1:]...)
			return m.save() == nil
		}
	}
	return false
}

// SetLastResponse records the outcome of a send into the history (capped)
// and mirrors it into LastResponse for compatibility.
func (m *Manager) SetLastResponse(id string, resp *store.Response, sendErr string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, t := range m.tabs {
		if t.ID == id {
			t.History = append(t.History, HistoryEntry{Resp: resp, Err: sendErr, At: time.Now()})
			if n := len(t.History); n > 20 {
				t.History = t.History[n-20:]
			}
			t.LastResponse = resp
			t.UpdatedAt = time.Now()
			_ = m.save()
			return
		}
	}
}

func (m *Manager) save() error {
	data, err := json.MarshalIndent(m.tabs, "", "  ")
	if err != nil {
		return err
	}
	tmp := m.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, m.path)
}

func titleOf(req *store.Request) string {
	host := req.URL
	if i := strings.Index(host, "://"); i >= 0 {
		host = host[i+3:]
	}
	if i := strings.IndexByte(host, '/'); i >= 0 {
		host = host[:i]
	}
	path := "/"
	if i := strings.Index(req.URL, "://"); i >= 0 {
		rest := req.URL[i+3:]
		if j := strings.IndexByte(rest, '/'); j >= 0 {
			path = rest[j:]
		}
	}
	return req.Method + " " + host + path
}
