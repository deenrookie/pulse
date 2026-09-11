// Package api serves the REST API, the SSE event stream and the embedded
// web UI.
package api

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
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
	// AccessKey guards non-loopback API access (loopback stays keyless).
	// Set from PULSE_KEY or generated randomly at startup.
	AccessKey string

	st   *store.Store
	eng  *proxy.Engine
	rep  *repeater.Manager
	auth *certs.Authority
	bus  *events.Bus
	rw   *rewrite.Engine
	plug *plugins.Runtime
	set  *Settings
	intr *intruderStore
	anno *annoStore
}

// accessKeyFromEnv returns PULSE_KEY when set, otherwise a fresh random key.
func accessKeyFromEnv() (string, error) {
	if k := os.Getenv("PULSE_KEY"); k != "" {
		return k, nil
	}
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
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
	key, err := accessKeyFromEnv()
	if err != nil {
		return nil, fmt.Errorf("generate access key: %w", err)
	}
	return &Server{
		Version: version, ProxyAddr: proxyAddr, UIAddr: uiAddr, DataDir: dataDir, AccessKey: key,
		st: st, eng: eng, rep: rep, auth: auth, bus: bus, rw: rw, plug: plug, set: set,
		intr: newIntruderStore(dataDir),
		anno: newAnnoStore(dataDir),
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
	mux.HandleFunc("/api/search", s.handleSearch)
	mux.HandleFunc("/api/flows", s.handleFlows)
	mux.HandleFunc("/api/flows/har", s.handleFlowsHAR)
	mux.HandleFunc("/api/flows/", s.handleFlow)
	mux.HandleFunc("/api/events", s.handleEvents)
	mux.HandleFunc("/api/intercept", s.handleIntercept)
	mux.HandleFunc("/api/intercept/", s.handleInterceptID)
	mux.HandleFunc("/api/repeater", s.handleRepeater)
	mux.HandleFunc("/api/repeater/", s.handleRepeaterID)
	mux.HandleFunc("/api/intruder", s.handleIntruder)
	mux.HandleFunc("/api/intruder/", s.handleIntruder)
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
	return withCORS(s.gate(mux))
}

// hostedPanelOrigin is the deployed web panel allowed to call this local API
// cross-origin. The loopback-served UI needs no CORS; the hosted panel's
// browser context does. Everything else is left without CORS headers.
const hostedPanelOrigin = "https://pulsesec.vercel.app"

// withCORS answers preflights and tags responses for the one allowed origin.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") == hostedPanelOrigin {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", hostedPanelOrigin)
			h.Add("Vary", "Origin")
			if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
				h.Set("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS")
				h.Set("Access-Control-Allow-Headers", "Content-Type, X-Pulse-Key")
				h.Set("Access-Control-Max-Age", "86400")
				// https page → http LAN target: answer the Private Network
				// Access / Local Network Access preflights Chrome sends for
				// private-network requests (the user still has to grant the
				// browser's local-network permission)
				if r.Header.Get("Access-Control-Request-Private-Network") == "true" {
					h.Set("Access-Control-Allow-Private-Network", "true")
				}
				if r.Header.Get("Access-Control-Request-Local-Network") == "true" {
					h.Set("Access-Control-Allow-Local-Network", "true")
				}
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// gate is the access gate for the whole surface. Loopback connections pass
// freely but must still name this listener in the Host header (DNS-rebinding
// guard). Non-loopback connections must present the access key — X-Pulse-Key
// header, or ?key= query for SSE/EventSource which cannot set headers.
// Keyed requests skip the Host check (the key is the auth). Preflights are
// always let through: they carry no credentials and never reach a handler.
// Static assets stay open (the same code ships to the hosted panel).
func (s *Server) gate(next http.Handler) http.Handler {
	expectedHost, expectedPort, err := net.SplitHostPort(s.UIAddr)
	if err != nil {
		expectedHost, expectedPort = "127.0.0.1", "8787"
	}
	allowed := map[string]bool{}
	if expectedHost != "" {
		allowed[expectedHost] = true
	}
	if isLoopback(expectedHost) || isWildcard(expectedHost) {
		allowed["localhost"] = true
		allowed["127.0.0.1"] = true
		allowed["::1"] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		keyed := false
		if !remoteIsLoopback(r.RemoteAddr) && strings.HasPrefix(r.URL.Path, "/api/") {
			preflight := r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != ""
			if !preflight {
				k := r.Header.Get("X-Pulse-Key")
				if k == "" {
					k = r.URL.Query().Get("key")
				}
				if subtle.ConstantTimeCompare([]byte(k), []byte(s.AccessKey)) != 1 {
					writeErr(w, http.StatusUnauthorized, "missing or invalid access key")
					return
				}
				keyed = true
			}
		}
		if !keyed {
			host, port, err := net.SplitHostPort(r.Host)
			// IP-literal hosts are fine (you cannot DNS-rebind to an IP you
			// typed); hostnames must still name this listener — that lets the
			// static shell load when browsing a LAN-bound instance directly
			if err != nil || port != expectedPort || (!allowed[host] && !isIPLiteral(host)) {
				http.Error(w, "forbidden host", http.StatusForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func isIPLiteral(host string) bool {
	return net.ParseIP(strings.Trim(host, "[]")) != nil
}

func remoteIsLoopback(remote string) bool {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		return false
	}
	return isLoopback(host)
}

func isWildcard(host string) bool {
	return host == "" || host == "0.0.0.0" || host == "::"
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
	if r.Headers == nil {
		r.Headers = []store.Header{} // nil would serialize as JSON null and trip the UI
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
