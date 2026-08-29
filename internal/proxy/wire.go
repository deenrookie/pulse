package proxy

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"strconv"
	"strings"

	"pulse/internal/store"
)

// Minimal hand-rolled HTTP/1.1 wire helpers. They keep header order and
// duplicates (unlike net/http's map-based Header) and leave 101-upgraded
// connections usable for raw tunneling.

type reqHead struct {
	method  string
	target  string
	version string
	headers []store.Header
}

func readRequestHead(br *bufio.Reader) (reqHead, error) {
	line, err := readLine(br)
	if err != nil {
		return reqHead{}, err
	}
	method, rest, ok := strings.Cut(line, " ")
	if !ok {
		return reqHead{}, fmt.Errorf("malformed request line %q", line)
	}
	target, version, ok := strings.Cut(rest, " ")
	if !ok {
		version = "HTTP/1.0"
	}
	headers, err := readHeaders(br)
	if err != nil {
		return reqHead{}, err
	}
	return reqHead{method: method, target: target, version: version, headers: headers}, nil
}

type respHead struct {
	version string
	code    int
	reason  string
	headers []store.Header
}

func readResponseHead(br *bufio.Reader) (respHead, error) {
	line, err := readLine(br)
	if err != nil {
		return respHead{}, err
	}
	version, rest, ok := strings.Cut(line, " ")
	if !ok || !strings.HasPrefix(version, "HTTP/") {
		return respHead{}, fmt.Errorf("malformed status line %q", line)
	}
	codeStr, reason, _ := strings.Cut(rest, " ")
	code, err := strconv.Atoi(codeStr)
	if err != nil || code < 100 || code > 599 {
		return respHead{}, fmt.Errorf("malformed status code in %q", line)
	}
	headers, err := readHeaders(br)
	if err != nil {
		return respHead{}, err
	}
	return respHead{version: version, code: code, reason: reason, headers: headers}, nil
}

func readLine(br *bufio.Reader) (string, error) {
	s, err := br.ReadString('\n')
	if err != nil {
		if err == io.EOF && s != "" {
			return strings.TrimRight(s, "\r\n"), nil
		}
		return "", err
	}
	return strings.TrimRight(s, "\r\n"), nil
}

func readHeaders(br *bufio.Reader) ([]store.Header, error) {
	var headers []store.Header
	for {
		line, err := readLine(br)
		if err != nil {
			return nil, err
		}
		if line == "" {
			return headers, nil
		}
		name, value, ok := strings.Cut(line, ":")
		if !ok {
			continue // tolerate malformed line
		}
		headers = append(headers, store.Header{Name: strings.TrimSpace(name), Value: strings.Trim(value, " \t")})
	}
}

// hasHeader reports a case-insensitive exact-name match.
func hasHeader(headers []store.Header, name string) bool {
	for _, h := range headers {
		if strings.EqualFold(h.Name, name) {
			return true
		}
	}
	return false
}

func headerValue(headers []store.Header, name string) (string, bool) {
	for _, h := range headers {
		if strings.EqualFold(h.Name, name) {
			return h.Value, true
		}
	}
	return "", false
}

func contentLength(headers []store.Header) (int64, bool) {
	v, ok := headerValue(headers, "Content-Length")
	if !ok {
		return 0, false
	}
	n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
	if err != nil || n < 0 {
		return 0, false
	}
	return n, true
}

func isChunked(headers []store.Header) bool {
	v, ok := headerValue(headers, "Transfer-Encoding")
	return ok && strings.Contains(strings.ToLower(v), "chunked")
}

// hopByHop lists the headers that must not be forwarded end to end.
func hopByHop(name string) bool {
	switch strings.ToLower(name) {
	case "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
		"proxy-connection", "te", "trailer", "trailers", "transfer-encoding", "upgrade":
		return true
	}
	return false
}

// readBody consumes the message body per HTTP/1.1 framing rules. Bodies larger
// than max are truncated (remainder drained) and flagged. A nil body is never
// returned: empty bodies become []byte{} so JSON encodes "" instead of null.
func readBody(br *bufio.Reader, headers []store.Header, max int64, isResponse bool, code int) (body []byte, truncated bool, err error) {
	if isResponse && (code == 101 || code == 204 || code == 304 || (code >= 100 && code < 200)) {
		return []byte{}, false, nil
	}
	if isChunked(headers) {
		cr := httputil.NewChunkedReader(br)
		body, truncated, err = readLimited(cr, max)
		if err != nil {
			return nil, false, err
		}
		if err := drainTrailers(br); err != nil {
			return nil, false, err
		}
		if body == nil {
			body = []byte{}
		}
		return body, truncated, nil
	}
	if n, ok := contentLength(headers); ok {
		if n > max {
			body = make([]byte, max)
			if _, err := io.ReadFull(br, body); err != nil {
				return nil, false, err
			}
			if _, err := io.CopyN(io.Discard, br, n-max); err != nil {
				return nil, false, err
			}
			return body, true, nil
		}
		body = make([]byte, n)
		if _, err := io.ReadFull(br, body); err != nil {
			return nil, false, err
		}
		return body, false, nil
	}
	if isResponse {
		// close-delimited response: read until EOF
		return readLimited(br, max)
	}
	// request without framing information: no body
	return []byte{}, false, nil
}

func drainTrailers(br *bufio.Reader) error {
	for {
		line, err := readLine(br)
		if err != nil {
			return err
		}
		if line == "" {
			return nil
		}
	}
}

func readLimited(r io.Reader, max int64) (body []byte, truncated bool, err error) {
	limited := io.LimitReader(r, max+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, false, err
	}
	if int64(len(data)) > max {
		io.Copy(io.Discard, r)
		return data[:max], true, nil
	}
	return data, false, nil
}

// requestTarget extracts the origin-form target (path + query) from an
// absolute URL.
func requestTarget(rawURL string) string {
	rest := rawURL
	if i := strings.Index(rest, "://"); i >= 0 {
		rest = rest[i+3:]
	}
	if i := strings.IndexByte(rest, '/'); i >= 0 {
		return rest[i:]
	}
	return "/"
}

func hostOf(rawURL string) string {
	rest := rawURL
	if i := strings.Index(rest, "://"); i >= 0 {
		rest = rest[i+3:]
	}
	if i := strings.IndexAny(rest, "/?#"); i >= 0 {
		rest = rest[:i]
	}
	if i := strings.LastIndexByte(rest, '@'); i >= 0 { // strip userinfo
		rest = rest[i+1:]
	}
	return rest
}

// writeRequestHead writes the request exactly as it will be sent upstream:
// hop-by-hop headers stripped, Host ensured, Content-Length re-framed.
// Upgrade requests (WebSocket etc.) keep their Upgrade/Connection headers
// verbatim so the handshake survives.
func writeRequestHead(w io.Writer, req *store.Request) error {
	isUpgrade := hasHeader(req.Headers, "Upgrade")
	var b bytes.Buffer
	fmt.Fprintf(&b, "%s %s %s\r\n", req.Method, requestTarget(req.URL), orDefault(req.HTTPVersion, "HTTP/1.1"))
	hasHost := hasHeader(req.Headers, "Host")
	if !hasHost {
		fmt.Fprintf(&b, "Host: %s\r\n", hostOf(req.URL))
	}
	keepUpgrade := func(name string) bool {
		return isUpgrade && (strings.EqualFold(name, "Upgrade") || strings.EqualFold(name, "Connection"))
	}
	hostWritten := false
	for _, h := range req.Headers {
		if strings.EqualFold(h.Name, "Host") {
			if !hostWritten { // first Host stays at its original position
				hostWritten = true
				fmt.Fprintf(&b, "%s: %s\r\n", h.Name, h.Value)
			}
			continue
		}
		if keepUpgrade(h.Name) {
			fmt.Fprintf(&b, "%s: %s\r\n", h.Name, h.Value)
			continue
		}
		if hopByHop(h.Name) || strings.EqualFold(h.Name, "Content-Length") {
			continue
		}
		fmt.Fprintf(&b, "%s: %s\r\n", h.Name, h.Value)
	}
	if len(req.Body) > 0 && !isUpgrade {
		fmt.Fprintf(&b, "Content-Length: %d\r\n", len(req.Body))
	} else if len(req.Body) == 0 && !isUpgrade {
		switch req.Method {
		case "POST", "PUT", "PATCH":
			fmt.Fprintf(&b, "Content-Length: 0\r\n")
		}
	}
	b.WriteString("\r\n")
	_, err := w.Write(b.Bytes())
	return err
}

// writeResponseToClient re-frames a captured response for the client: hop-by-
// hop headers dropped, Content-Length set to the stored body size.
func writeResponseToClient(w io.Writer, resp *store.Response, keepAlive bool) error {
	var b bytes.Buffer
	fmt.Fprintf(&b, "HTTP/1.1 %d %s\r\n", resp.StatusCode, orDefault(resp.Reason, reasonPhrase(resp.StatusCode)))
	for _, h := range resp.Headers {
		if hopByHop(h.Name) || strings.EqualFold(h.Name, "Content-Length") {
			continue
		}
		fmt.Fprintf(&b, "%s: %s\r\n", h.Name, h.Value)
	}
	if len(resp.Body) > 0 {
		fmt.Fprintf(&b, "Content-Length: %d\r\n", len(resp.Body))
	}
	if keepAlive {
		b.WriteString("Connection: keep-alive\r\n")
	} else {
		b.WriteString("Connection: close\r\n")
	}
	b.WriteString("\r\n")
	if _, err := w.Write(b.Bytes()); err != nil {
		return err
	}
	_, err := w.Write(resp.Body)
	return err
}

// writeRawResponseHead passes a 101 response head through verbatim (Upgrade
// semantics must survive), then the connection becomes a raw tunnel.
func writeRawResponseHead(w io.Writer, h respHead) error {
	var b bytes.Buffer
	fmt.Fprintf(&b, "%s %d %s\r\n", h.version, h.code, h.reason)
	for _, hd := range h.headers {
		fmt.Fprintf(&b, "%s: %s\r\n", hd.Name, hd.Value)
	}
	b.WriteString("\r\n")
	_, err := w.Write(b.Bytes())
	return err
}

func writeGatewayError(w io.Writer, msg string) error {
	body := fmt.Sprintf("<html><body><h1>502 Bad Gateway (Pulse)</h1><p>%s</p></body></html>", msg)
	_, err := fmt.Fprintf(w, "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s", len(body), body)
	return err
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

func reasonPhrase(code int) string {
	if code == 0 {
		return "OK"
	}
	return http.StatusText(code)
}
