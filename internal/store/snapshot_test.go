package store

import (
	"path/filepath"
	"testing"
)

func TestPublishedMetadataIsIndependent(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "flows.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	flow := mkFlow("req-1")
	if err := s.Add(flow); err != nil {
		t.Fatal(err)
	}
	flow.State = StateComplete
	flow.Req.Headers[0].Value = "modified-after-add"
	flow.Resp = &Response{StatusCode: 200, Headers: []Header{{Name: "X-Result", Value: "initial"}}, Body: []byte("response")}
	before, _ := s.Get(flow.ID)
	if before.State != StatePending || before.Resp != nil || before.Req.Headers[0].Value != "example.com" {
		t.Fatal("producer mutated published metadata before Update")
	}
	if err := s.Update(flow); err != nil {
		t.Fatal(err)
	}
	flow.Resp.StatusCode = 500
	flow.Resp.Headers[0].Value = "modified-after-update"
	first, _ := s.Get(flow.ID)
	if first.Resp.StatusCode != 200 || first.Resp.Headers[0].Value != "initial" {
		t.Fatal("Update retained caller metadata")
	}
	first.Req.Headers[0].Value = "reader-edit"
	first.Resp.Headers[0].Value = "reader-edit"
	second, _ := s.Get(flow.ID)
	if second.Req.Headers[0].Value != "modified-after-add" || second.Resp.Headers[0].Value != "initial" {
		t.Fatal("Get leaked mutable metadata")
	}
	if s.BodyBytes() != int64(len(flow.Req.Body)+len(flow.Resp.Body)) {
		t.Fatal("body accounting drifted after producer mutation")
	}
	flow.Req.Headers = []Header{}
	if err := s.Update(flow); err != nil {
		t.Fatal(err)
	}
	empty, _ := s.Get(flow.ID)
	if empty.Req.Headers == nil {
		t.Fatal("empty headers must remain an array in API JSON")
	}
}
