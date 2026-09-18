package api

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/andybalholm/brotli"
	"pulse/internal/store"
)

func TestShareFilesSurviveRestartAndExpire(t *testing.T) {
	dir := t.TempDir()
	shares, err := openShares(dir)
	if err != nil {
		t.Fatal(err)
	}
	id := strings.Repeat("a", 48)
	meta := trafficShare{ID: id, ExpiresAt: time.Now().Add(90 * 24 * time.Hour), CreatedAt: time.Now()}
	path := filepath.Join(shares.dir, id)
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	flow := &store.Flow{ID: "complete", Req: store.Request{URL: "https://x.test/?token=original", Body: []byte{0, 255, 1}}}
	if err := writeShareJSON(filepath.Join(path, "metadata.json"), meta); err != nil {
		t.Fatal(err)
	}
	if err := writeShareJSON(filepath.Join(path, "snapshot.json"), sharePayload{Share: meta, Flow: flow}); err != nil {
		t.Fatal(err)
	}
	reopened, err := openShares(dir)
	if err != nil {
		t.Fatal(err)
	}
	srv := &Server{shares: reopened}
	w := httptest.NewRecorder()
	srv.handlePublicShare(w, httptest.NewRequest("GET", "/share/"+id+"/data", nil))
	if w.Code != 200 {
		t.Fatalf("restart lost share: %d", w.Code)
	}
	var result sharePayload
	json.Unmarshal(w.Body.Bytes(), &result)
	if result.Flow.Req.URL != flow.Req.URL || string(result.Flow.Req.Body) != string(flow.Req.Body) {
		t.Fatal("restart changed data")
	}
	meta.ExpiresAt = time.Now().Add(-time.Second)
	reopened.items[id] = meta
	w = httptest.NewRecorder()
	srv.handlePublicShare(w, httptest.NewRequest("GET", "/share/"+id+"/data", nil))
	if w.Code != 404 {
		t.Fatal("expired data served")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("expired files not reclaimed")
	}
}

func TestIntruderPlanPersistsModeAndTarget(t *testing.T) {
	dir := t.TempDir()
	s := newIntruderStore(dir)
	plan := IntruderAttack{Raw: "GET /?u=§u§ HTTP/1.1", Mode: "pitchfork", TargetURL: "https://example.test:8443", PayloadSets: []string{"a", "b"}}
	a, err := s.put("", plan)
	if err != nil {
		t.Fatal(err)
	}
	loaded := newIntruderStore(dir).list()
	if len(loaded) != 1 || loaded[0].TargetURL != plan.TargetURL || loaded[0].Mode != plan.Mode {
		t.Fatal("plan changed after restart")
	}
	if err := os.Mkdir(s.path+".tmp", 0700); err != nil {
		t.Fatal(err)
	}
	plan.Mode = "sniper"
	if _, err := s.put(a.ID, plan); err == nil {
		t.Fatal("save error hidden")
	}
	if s.list()[0].Mode != "pitchfork" {
		t.Fatal("failed save changed plan")
	}
	if err := s.delete(a.ID); err == nil {
		t.Fatal("delete error hidden")
	}
	if len(s.list()) != 1 {
		t.Fatal("failed delete lost plan")
	}
}

func TestPublicShareDecodeAndRequestOnly(t *testing.T) {
	dir := t.TempDir()
	shares, err := openShares(dir)
	if err != nil {
		t.Fatal(err)
	}
	id := strings.Repeat("b", 48)
	var compressed bytes.Buffer
	w := gzip.NewWriter(&compressed)
	if _, err := w.Write([]byte("decoded shared response")); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	meta := trafficShare{ID: id, CreatedAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour)}
	path := filepath.Join(shares.dir, id)
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	flow := &store.Flow{ID: "req-only", Req: store.Request{Method: "POST", URL: "https://x.test/only", Body: []byte("request-body")}, Resp: &store.Response{Headers: []store.Header{{Name: "Content-Encoding", Value: "gzip"}}, Body: compressed.Bytes()}}
	if err := writeShareJSON(filepath.Join(path, "metadata.json"), meta); err != nil {
		t.Fatal(err)
	}
	if err := writeShareJSON(filepath.Join(path, "snapshot.json"), sharePayload{Share: meta, Flow: flow}); err != nil {
		t.Fatal(err)
	}
	shares.items[id] = meta
	srv := &Server{shares: shares}
	wrec := httptest.NewRecorder()
	srv.handlePublicShare(wrec, httptest.NewRequest("GET", "/share/"+id+"/decode?side=response", nil))
	if wrec.Code != 200 || !strings.Contains(wrec.Body.String(), "ZGVjb2RlZCBzaGFyZWQgcmVzcG9uc2U=") {
		t.Fatalf("share gzip decode = %d %s", wrec.Code, wrec.Body.String())
	}
	flow.Resp = nil
	if err := writeShareJSON(filepath.Join(path, "request-only.tmp"), sharePayload{Share: meta, Flow: flow}); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(path, "request-only.tmp"), filepath.Join(path, "snapshot.json")); err != nil {
		t.Fatal(err)
	}
	wrec = httptest.NewRecorder()
	srv.handlePublicShare(wrec, httptest.NewRequest("GET", "/share/"+id+"/data", nil))
	if wrec.Code != 200 {
		t.Fatalf("request-only share = %d %s", wrec.Code, wrec.Body.String())
	}
	var requestOnly sharePayload
	if err := json.Unmarshal(wrec.Body.Bytes(), &requestOnly); err != nil || requestOnly.Flow.Resp != nil {
		t.Fatalf("request-only share invented response: %v %+v", err, requestOnly.Flow.Resp)
	}
}

func TestPublicShareBrotliDecode(t *testing.T) {
	dir := t.TempDir()
	shares, err := openShares(dir)
	if err != nil {
		t.Fatal(err)
	}
	id := strings.Repeat("c", 48)
	var compressed bytes.Buffer
	w := brotli.NewWriter(&compressed)
	if _, err := w.Write([]byte("decoded shared brotli")); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	meta := trafficShare{ID: id, CreatedAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour)}
	path := filepath.Join(shares.dir, id)
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	flow := &store.Flow{Req: store.Request{URL: "https://x.test/"}, Resp: &store.Response{Headers: []store.Header{{Name: "Content-Encoding", Value: "br"}}, Body: compressed.Bytes()}}
	if err := writeShareJSON(filepath.Join(path, "metadata.json"), meta); err != nil {
		t.Fatal(err)
	}
	if err := writeShareJSON(filepath.Join(path, "snapshot.json"), sharePayload{Share: meta, Flow: flow}); err != nil {
		t.Fatal(err)
	}
	shares.items[id] = meta
	recorder := httptest.NewRecorder()
	(&Server{shares: shares}).handlePublicShare(recorder, httptest.NewRequest("GET", "/share/"+id+"/decode?side=response", nil))
	if recorder.Code != 200 || !strings.Contains(recorder.Body.String(), "ZGVjb2RlZCBzaGFyZWQgYnJvdGxp") {
		t.Fatalf("share brotli decode = %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestIntruderResultsPersistAndDeleteTogether(t *testing.T) {
	dir := t.TempDir()
	s := newIntruderStore(dir)
	a, err := s.put("", IntruderAttack{Raw: "GET / HTTP/1.1"})
	if err != nil {
		t.Fatal(err)
	}
	results := []IntruderResult{{Payload: "admin", StatusCode: 200, Length: 42, FlowID: "req-7", GrepHits: []string{"welcome"}}}
	if err := s.saveResults(a.ID, results); err != nil {
		t.Fatal(err)
	}
	loaded := newIntruderStore(dir).list()
	if len(loaded) != 1 || len(loaded[0].Results) != 1 || loaded[0].Results[0].FlowID != "req-7" || loaded[0].LastRunAt == nil {
		t.Fatalf("results not restored: %+v", loaded)
	}
	if err := s.delete(a.ID); err != nil {
		t.Fatal(err)
	}
	if got := newIntruderStore(dir).list(); len(got) != 0 {
		t.Fatalf("deleted attack retained results: %+v", got)
	}
}
