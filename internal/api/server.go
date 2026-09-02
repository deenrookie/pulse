// Package api serves the REST API, the SSE event stream and the embedded
// web UI.
package api

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"time"

	"pulse/internal/certs"
	"pulse/internal/events"
	"pulse/internal/plugins"
	"pulse/internal/proxy"
	"pulse/internal/repeater"
	"pulse/internal/rewrite"
	"pulse/internal/store"
	"pulse/web"
)

type Server struct {
	Version  string
	ProxyAddr string
	UIAddr    string
	DataDir   string

	st   *store.Store
	eng  *proxy.Engine
	rep  *repeater.Manager
	auth *certs.Authority
	bus  *events.Bus
	rw   *rewrite.Engine
	plug *plugins.Runtime
	set  *Settings
}

func New(st *store.Store, eng *proxy.Engine, rep *repeater.Manager, auth *certs.Authority, bus *events.Bus,
	rw *rewrite.Engine, plug *plugins.Runtime, version, proxyAddr, uiAddr, dataDir string) (*Server, error) {
	set, err := LoadSettings(dataDir)
	if err != nil {
		return nil, fmt.Errorf("load settings: %w", err)
	}
	// apply a persisted non-default plugins directory; a broken path falls
	// back to the default dir with a warning instead of refusing to start
	if set.PluginsDir != "" && set.PluginsDir != plug.Dir() {
		if err := plug.SetDir(set.PluginsDir); err != nil {
			log.Printf("WARN: pluginsDir %s unusable (%v) — keeping %s", set.PluginsDir, err, plug.Dir())
			set.PluginsDir = plug.Dir()
		}
	}
	// same for the proxy address: --proxy binds first, a persisted change
	// from the Settings page rebinds on startup
	if set.ProxyAddr != "" && set.ProxyAddr != eng.Addr() {
		if err := eng.Relisten(set.ProxyAddr); err != nil {
			log.Printf("WARN: proxyAddr %s unusable (%v) — keeping %s", set.ProxyAddr, err, eng.Addr())
			set.ProxyAddr = eng.Addr()
		}
	}
	eng.SetRepeaterTimeout(set.ResponseTimeoutSec)
	st.SetMemoryGuard(set.MemoryGuardMB, set.LargeBodyMB)
	return &Server{
		Version: version, ProxyAddr: proxyAddr, UIAddr: uiAddr, DataDir: dataDir,
		st: st, eng: eng, rep: rep, auth: auth, bus: bus, rw: rw, plug: plug, set: set,
	}, nil
}

// Handler builds the routed handler with host-header validation.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", s.handleHealth)
	mux.HandleFunc("/api/status", s.handleStatus)
	mux.HandleFunc("/api/cert", s.handleCert)
	mux.HandleFunc("/api/decode", s.handleDecode)
	mux.HandleFunc("/api/settings", s.handleSettings)
	mux.HandleFunc("/api/flows", s.handleFlows)
	mux.HandleFunc("/api/flows/", s.handleFlow)
	mux.HandleFunc("/api/events", s.handleEvents)
	mux.HandleFunc("/api/intercept", s.handleIntercept)
	mux.HandleFunc("/api/intercept/", s.handleInterceptID)
	mux.HandleFunc("/api/repeater", s.handleRepeater)
	mux.HandleFunc("/api/repeater/", s.handleRepeaterID)
	mux.HandleFunc("/api/rewrite", s.handleRewrite)
	mux.HandleFunc("/api/rewrite/", s.handleRewriteID)
	mux.HandleFunc("/api/plugins", s.handlePlugins)
	mux.HandleFunc("/api/plugins/reload", s.handlePluginsReload)
	mux.HandleFunc("/api/plugins/samples", s.handlePluginsSamples)
	mux.HandleFunc("/api/plugins/validate", s.handlePluginsValidate)
	mux.HandleFunc("/api/plugins/test", s.handlePluginsTest)
	mux.HandleFunc("/api/plugins/source/", s.handlePluginsSource)
	mux.HandleFunc("/api/plugins/", s.handlePluginFile)
	mux.HandleFunc("/", s.handleStatic)
	return s.checkHost(mux)
}

// checkHost mitigates DNS-rebinding/CSRF: requests must target our own
// listener address (the Vite dev proxy rewrites the Host accordingly).
func (s *Server) checkHost(next http.Handler) http.Handler {
	expectedHost, expectedPort, err := net.SplitHostPort(s.UIAddr)
	if err != nil {
		expectedHost, expectedPort = "127.0.0.1", "8000"
	}
	allowed := map[string]bool{}
	if expectedHost != "" {
		allowed[expectedHost] = true
	}
	if isLoopback(expectedHost) {
		allowed["localhost"] = true
		allowed["127.0.0.1"] = true
		allowed["::1"] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, port, err := net.SplitHostPort(r.Host)
		if err != nil || !allowed[host] || port != expectedPort {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func isLoopback(host string) bool {
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		http.NotFound(w, r)
		return
	}
	sub := web.Dist()
	serveFrom := func(name string) bool {
		f, err := sub.Open(name)
		if err != nil {
			return false
		}
		defer f.Close()
		rs, ok := f.(io.ReadSeeker)
		if !ok {
			http.Error(w, "embedded file not seekable", http.StatusInternalServerError)
			return true
		}
		http.ServeContent(w, r, name, time.Time{}, rs)
		return true
	}
	name := strings.TrimPrefix(r.URL.Path, "/")
	if name == "" || !serveFrom(name) {
		// SPA fallback: unknown paths serve the app shell
		if !serveFrom("index.html") {
			http.Error(w, "web UI not built (run: cd web && npm run build)", http.StatusNotFound)
		}
	}
}

// --- small helpers used across handlers ---

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func readJSON(w http.ResponseWriter, r *http.Request, v any, max int64) bool {
	body, err := io.ReadAll(io.LimitReader(r.Body, max))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "read body: "+err.Error())
		return false
	}
	if len(body) == 0 {
		return true // empty body allowed
	}
	if err := json.Unmarshal(body, v); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return false
	}
	return true
}

// parseEditableRequest validates a client-submitted request object.
func parseEditableRequest(w http.ResponseWriter, r *store.Request) bool {
	if r.Method == "" {
		r.Method = "GET"
	}
	if r.HTTPVersion == "" {
		r.HTTPVersion = "HTTP/1.1"
	}
	if r.Body == nil {
		r.Body = []byte{}
	}
	u := r.URL
	if !strings.Contains(u, "://") {
		writeErr(w, http.StatusBadRequest, "request URL must be absolute (http:// or https://)")
		return false
	}
	rest := u[strings.Index(u, "://")+3:]
	if i := strings.IndexAny(rest, "/?#"); i >= 0 {
		rest = rest[:i]
	}
	if strings.Trim(rest, "[]") == "" {
		writeErr(w, http.StatusBadRequest, "request URL has no host")
		return false
	}
	return true
}
