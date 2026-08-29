package store

import (
	"path/filepath"
	"testing"
	"time"
)

func mkFlow(id string) *Flow {
	return &Flow{
		ID: id,
		Req: Request{
			ID: id, Method: "GET", URL: "https://example.com/a?x=1",
			HTTPVersion: "HTTP/1.1",
			Headers:     []Header{{Name: "Host", Value: "example.com"}, {Name: "X-A", Value: "1"}},
			Body:        []byte("body"),
			Timestamp:   time.Now(),
			Source:      "proxy",
		},
		State: StatePending,
	}
}

func TestStoreCRUDAndFilter(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "flows.jsonl"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer st.Close()
	if err := st.Add(mkFlow("req-1")); err != nil {
		t.Fatalf("add: %v", err)
	}
	if err := st.Add(mkFlow("req-2")); err != nil {
		t.Fatalf("add: %v", err)
	}
	items, total := st.List("")
	if total != 2 || len(items) != 2 {
		t.Fatalf("List = %d items, total %d", len(items), total)
	}
	if items[0].Host != "example.com" || items[0].Path != "/a" {
		t.Fatalf("meta host/path = %q %q", items[0].Host, items[0].Path)
	}
	filtered, _ := st.List("GET")
	if len(filtered) != 2 {
		t.Fatalf("filter GET got %d", len(filtered))
	}
	got, _ := st.List("example.com")
	if len(got) != 2 {
		t.Fatalf("filter example.com got %d", len(got))
	}
	got, _ = st.List("nothing")
	if len(got) != 0 {
		t.Fatalf("filter nothing got %d", len(got))
	}

	fl, ok := st.Get("req-1")
	if !ok || fl.State != StatePending {
		t.Fatalf("Get: ok=%v state=%v", ok, fl.State)
	}
	fl.Resp = &Response{StatusCode: 200, Reason: "OK", Body: []byte("resp"), Timestamp: time.Now(), DurationMs: 5}
	fl.State = StateComplete
	if err := st.Update(fl); err != nil {
		t.Fatalf("update: %v", err)
	}
	if st.CountPending() != 1 {
		t.Fatalf("CountPending = %d, want 1", st.CountPending())
	}

	if !st.Delete("req-2") {
		t.Fatal("Delete returned false")
	}
	if _, total := st.List(""); total != 1 {
		t.Fatalf("after delete total = %d", total)
	}
}

func TestStorePersistsAcrossReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "flows.jsonl")
	st, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if id := st.NewID(); id != "req-1" {
		t.Fatalf("first id = %s", id)
	}
	fl := mkFlow("req-1")
	if err := st.Add(fl); err != nil {
		t.Fatalf("add: %v", err)
	}
	fl.Resp = &Response{StatusCode: 201, Body: []byte("ok")}
	fl.State = StateComplete
	if err := st.Update(fl); err != nil {
		t.Fatalf("update: %v", err)
	}
	st.Close()

	st2, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer st2.Close()
	got, ok := st2.Get("req-1")
	if !ok || got.State != StateComplete || got.Resp == nil || got.Resp.StatusCode != 201 {
		t.Fatalf("restored flow: ok=%v state=%v", ok, got.State)
	}
	if string(got.Req.Body) != "body" {
		t.Fatalf("restored body = %q", got.Req.Body)
	}
	if id := st2.NewID(); id != "req-2" {
		t.Fatalf("id after reopen = %s, want req-2", id)
	}
	if err := st2.Clear(); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if st2.Count() != 0 {
		t.Fatal("clear left flows behind")
	}
}
