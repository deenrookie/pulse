// HTTP/2 support: the MITM TLS session negotiates h2 via ALPN and streams
// are bridged into the same record→plugins→rewrite→intercept→upstream
// pipeline the HTTP/1 path uses (executeRequest in engine.go).
package proxy

import (
	"net"
	"net/http"
	"time"

	"golang.org/x/net/http2"

	"pulse/internal/store"
)

// serveHTTP2 speaks HTTP/2 on an intercepted (MITM) TLS connection for the
// CONNECT target connectHost. Each stream becomes one flow.
func (e *Engine) serveHTTP2(conn net.Conn, connectHost string) {
	srv := &http2.Server{}
	srv.ServeConn(conn, &http2.ServeConnOpts{Handler: e.h2Handler(connectHost)})
}

func (e *Engine) h2Handler(connectHost string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodConnect || r.Header.Get("Upgrade") != "" {
			http.Error(w, "Pulse: upgrades are not supported over HTTP/2", http.StatusBadGateway)
			return
		}
		body, truncated, err := readLimited(r.Body, e.client.maxBody())
		if err != nil {
			http.Error(w, "Pulse: reading request body: "+err.Error(), http.StatusBadRequest)
			return
		}
		if body == nil {
			body = []byte{}
		}
		headers := make([]store.Header, 0, len(r.Header)+1)
		if r.Host != "" {
			headers = append(headers, store.Header{Name: "Host", Value: r.Host})
		}
		headers = append(headers, headersFromHTTP(r.Header)...)

		req := &store.Request{
			Method:      r.Method,
			URL:         "https://" + connectHost + requestTarget(r.URL.RequestURI()),
			HTTPVersion: "HTTP/2.0",
			Headers:     headers,
			Body:        body,
			Truncated:   truncated,
			Timestamp:   time.Now(),
			Source:      "proxy",
		}

		e.executeRequest(req, func(resp *store.Response, gwErr error) error {
			if gwErr != nil {
				http.Error(w, "Pulse: "+gwErr.Error(), http.StatusBadGateway)
				return nil
			}
			for _, h := range resp.Headers {
				if hopByHop(h.Name) || h.Name == "Content-Length" {
					continue
				}
				w.Header().Add(h.Name, h.Value)
			}
			w.WriteHeader(resp.StatusCode)
			_, err := w.Write(resp.Body)
			return err
		})
	})
}
