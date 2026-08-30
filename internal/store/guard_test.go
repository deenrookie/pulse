package store

import (
	"path/filepath"
	"testing"
	"time"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "flows.jsonl"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func flowWith(id string, reqBody, respBody []byte) *Flow {
	return &Flow{
		ID:    id,
		Req:   Request{ID: id, Body: reqBody, Timestamp: time.Now()},
		Resp:  &Response{Body: respBody},
		State: StateComplete,
	}
}

func TestBodyBytesAccounting(t *testing.T) {
	s := newTestStore(t)
	if got := s.BodyBytes(); got != 0 {
		t.Fatalf("fresh store bodyBytes = %d", got)
	}
	fl := flowWith("req-1", []byte("aaaa"), []byte("bbbbbb"))
	if err := s.Add(fl); err != nil {
		t.Fatalf("add: %v", err)
	}
	if got := s.BodyBytes(); got != 10 {
		t.Fatalf("after add = %d, want 10", got)
	}
	// response grows on update
	fl2 := flowWith("req-1", []byte("aaaa"), []byte("bbbbbbbbbb"))
	if err := s.Update(fl2); err != nil {
		t.Fatalf("update: %v", err)
	}
	if got := s.BodyBytes(); got != 14 {
		t.Fatalf("after update = %d, want 14", got)
	}
	if !s.Delete("req-1") {
		t.Fatal("delete failed")
	}
	if got := s.BodyBytes(); got != 0 {
		t.Fatalf("after delete = %d, want 0", got)
	}
	// reload replays accounting from the log. Delete only removes from
	// memory — the JSONL keeps history — so the replayed total includes the
	// final state of req-1 (14) plus req-2 (5).
	s.Add(flowWith("req-2", []byte("xx"), []byte("yyy")))
	s2, err := Open(filepath.Dir(s.path) + "/flows.jsonl")
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s2.Close()
	if got := s2.BodyBytes(); got != 19 {
		t.Fatalf("after reload = %d, want 19", got)
	}
}

func TestShouldDropBody(t *testing.T) {
	s := newTestStore(t)
	s.SetMemoryGuard(1, 1) // 1 MB budget, drop binaries over 1 MB for the test

	big := 2 << 20
	if s.ShouldDropBody("video/mp4", big) {
		t.Fatal("dropped below budget — guard must stay idle until the budget is exceeded")
	}
	// push the store past its 1 MB budget with stored bodies
	s.Add(flowWith("req-big", nil, make([]byte, big)))
	if !s.ShouldDropBody("video/mp4", big) {
		t.Fatal("large binary above budget must be dropped")
	}
	if s.ShouldDropBody("application/json", big) {
		t.Fatal("JSON must always be kept")
	}
	if s.ShouldDropBody("text/html; charset=utf-8", big) {
		t.Fatal("text must always be kept")
	}
	if s.ShouldDropBody("application/vnd.api+json", big) {
		t.Fatal("+json suffix must be kept")
	}
	if s.ShouldDropBody("video/mp4", 1<<10) {
		t.Fatal("small binary below the drop size must be kept")
	}
	if !s.ShouldDropBody("", big) {
		t.Fatal("missing content-type counts as binary")
	}
	if !s.ShouldDropBody("application/octet-stream", big) {
		t.Fatal("octet-stream counts as binary")
	}
	// defaults when never configured
	s2 := newTestStore(t)
	s2.Add(flowWith("req-huge", nil, make([]byte, 600<<20))) // > default 500 MB
	if !s2.ShouldDropBody("video/mp4", 4<<20) {
		t.Fatal("default guard (500 MB / 3 MB) must engage")
	}
	if s2.ShouldDropBody("video/mp4", 2<<20) {
		t.Fatal("default drop size is 3 MB — 2 MB stays")
	}
}
