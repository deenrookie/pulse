// POST /api/decode — server-side body decompression (gzip/deflate/brotli).
// The frontend decompresses gzip/deflate locally via DecompressionStream;
// this endpoint covers encodings the browser runtime cannot handle (br)
// and acts as a universal fallback for any stored body.
package api

import (
	"bytes"
	"compress/bzip2"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"encoding/base64"
	"io"
	"net/http"
	"strings"

	"github.com/andybalholm/brotli"
)

func (s *Server) handleDecode(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Body     string `json:"body"`     // base64
		Encoding string `json:"encoding"` // gzip | deflate | br | bzip2 | identity
	}
	if !readJSON(w, r, &body, 16<<20) {
		return
	}
	raw, err := base64.StdEncoding.DecodeString(body.Body)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid base64 body")
		return
	}
	enc := strings.ToLower(strings.TrimSpace(body.Encoding))
	var out []byte
	var decErr error
	switch {
	case enc == "" || enc == "identity" || enc == "none":
		out = raw
	case enc == "gzip" || enc == "x-gzip":
		zr, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			decErr = err
			break
		}
		out, decErr = io.ReadAll(zr)
	case enc == "deflate":
		// HTTP "deflate" is zoo-flavored: zlib-wrapped in theory, raw in practice
		if zr, err := zlib.NewReader(bytes.NewReader(raw)); err == nil {
			out, decErr = io.ReadAll(zr)
		} else {
			out, decErr = io.ReadAll(flate.NewReader(bytes.NewReader(raw)))
		}
	case enc == "br":
		out, decErr = io.ReadAll(brotli.NewReader(bytes.NewReader(raw)))
	case enc == "bzip2":
		out, decErr = io.ReadAll(bzip2.NewReader(bytes.NewReader(raw)))
	default:
		writeErr(w, http.StatusBadRequest, "unsupported encoding: "+body.Encoding)
		return
	}
	if decErr != nil {
		writeErr(w, http.StatusUnprocessableEntity, "decode failed: "+decErr.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"body":    base64.StdEncoding.EncodeToString(out),
		"bytes":   len(out),
		"encoded": len(raw),
	})
}
