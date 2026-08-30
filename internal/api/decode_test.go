package api_test

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"testing"

)

func TestDecodeEndpoint(t *testing.T) {
	e := newEnv(t)

	// gzip round-trip
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	zw.Write([]byte("hello gzip decode"))
	zw.Close()
	resp, body := e.do(t, "POST", "/api/decode", map[string]any{
		"body":     base64.StdEncoding.EncodeToString(buf.Bytes()),
		"encoding": "gzip",
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("gzip decode status = %d: %s", resp.StatusCode, body)
	}
	var out struct {
		Body  string `json:"body"`
		Bytes int    `json:"bytes"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	dec, _ := base64.StdEncoding.DecodeString(out.Body)
	if string(dec) != "hello gzip decode" {
		t.Fatalf("gzip decode = %q", dec)
	}

	// identity passthrough
	_, body = e.do(t, "POST", "/api/decode", map[string]any{
		"body":     base64.StdEncoding.EncodeToString([]byte("plain")),
		"encoding": "identity",
	})
	json.Unmarshal(body, &out)
	dec, _ = base64.StdEncoding.DecodeString(out.Body)
	if string(dec) != "plain" {
		t.Fatalf("identity decode = %q", dec)
	}

	// unsupported encoding → 400
	resp, _ = e.do(t, "POST", "/api/decode", map[string]any{
		"body":     base64.StdEncoding.EncodeToString([]byte("x")),
		"encoding": "rot13",
	})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("unsupported encoding status = %d, want 400", resp.StatusCode)
	}
}
