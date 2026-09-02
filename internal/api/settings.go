// Persisted user settings (settings.json in the data dir) with a small
// REST surface: GET /api/settings, PUT /api/settings. Timeouts and other
// knobs live here so they survive restarts.
package api

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

const defaultResponseTimeoutSec = 30
const defaultMemoryGuardMB = 500
const defaultLargeBodyMB = 3

type Settings struct {
	mu sync.Mutex
	path string
	// ResponseTimeoutSec bounds reading upstream response heads (>=1).
	ResponseTimeoutSec int `json:"responseTimeoutSec"`
	// MemoryGuardMB: once stored bodies exceed this budget, newly captured
	// binary bodies larger than LargeBodyMB are dropped instead of stored.
	MemoryGuardMB int `json:"memoryGuardMB"`
	LargeBodyMB   int `json:"largeBodyMB"`
	// PluginsDir is where *.js plugins are loaded from; empty means the
	// default <data-dir>/plugins.
	PluginsDir string `json:"pluginsDir"`
	// ProxyAddr is the address the proxy listener is bound to; empty means
	// "keep whatever --proxy passed at startup".
	ProxyAddr string `json:"proxyAddr"`
}

func LoadSettings(dataDir string) (*Settings, error) {
	s := &Settings{
		path:               filepath.Join(dataDir, "settings.json"),
		ResponseTimeoutSec: defaultResponseTimeoutSec,
		MemoryGuardMB:      defaultMemoryGuardMB,
		LargeBodyMB:        defaultLargeBodyMB,
	}
	data, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		if err := s.save(); err != nil {
			return nil, err
		}
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, s); err != nil {
		return nil, err
	}
	if s.ResponseTimeoutSec < 1 {
		s.ResponseTimeoutSec = defaultResponseTimeoutSec
	}
	if s.MemoryGuardMB < 1 {
		s.MemoryGuardMB = defaultMemoryGuardMB
	}
	if s.LargeBodyMB < 1 {
		s.LargeBodyMB = defaultLargeBodyMB
	}
	return s, nil
}

func (s *Settings) save() error {
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.set.mu.Lock()
		defer s.set.mu.Unlock()
		proxy := s.eng.Addr()
		if proxy == "" {
			proxy = s.ProxyAddr
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"responseTimeoutSec": s.set.ResponseTimeoutSec,
			"memoryGuardMB":      s.set.MemoryGuardMB,
			"largeBodyMB":        s.set.LargeBodyMB,
			"pluginsDir":         s.plug.Dir(),
			"proxyAddr":          proxy,
		})
	case http.MethodPut:
		s.handlePutSettings(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handlePutSettings applies setting changes. The plugins directory is
// switched (and validated by actually rescanning it) before anything is
// persisted, so a bad path never reaches settings.json.
func (s *Server) handlePutSettings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ResponseTimeoutSec *int    `json:"responseTimeoutSec"`
		MemoryGuardMB      *int    `json:"memoryGuardMB"`
		LargeBodyMB        *int    `json:"largeBodyMB"`
		PluginsDir         *string `json:"pluginsDir"`
		ProxyAddr          *string `json:"proxyAddr"`
	}
	if !readJSON(w, r, &body, 1<<16) {
		return
	}

	set := s.set
	set.mu.Lock()
	defer set.mu.Unlock()

	if body.ProxyAddr != nil {
		addr := strings.TrimSpace(*body.ProxyAddr)
		if addr == "" {
			writeErr(w, http.StatusBadRequest, "proxyAddr must be host:port (empty is not allowed — point it at another address instead)")
			return
		}
		host, port, err := net.SplitHostPort(addr)
		if err != nil || host == "" || port == "" {
			writeErr(w, http.StatusBadRequest, "proxyAddr must be host:port, e.g. 127.0.0.1:8080")
			return
		}
		if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
			writeErr(w, http.StatusBadRequest, "proxyAddr port must be 1..65535")
			return
		}
		// rebind first — a failed bind must not be persisted, and the old
		// listener stays untouched when Relisten errors out
		if addr != s.eng.Addr() {
			if err := s.eng.Relisten(addr); err != nil {
				writeErr(w, http.StatusBadRequest, "proxyAddr: "+err.Error())
				return
			}
		}
		set.ProxyAddr = addr
	}

	if body.PluginsDir != nil {
		dir := *body.PluginsDir
		if dir == "" { // empty resets to the default location
			dir = filepath.Join(s.DataDir, "plugins")
		}
		if dir != s.plug.Dir() {
			if err := s.plug.SetDir(dir); err != nil {
				writeErr(w, http.StatusBadRequest, "pluginsDir: "+err.Error())
				return
			}
		}
		set.PluginsDir = s.plug.Dir()
	}

	if body.ResponseTimeoutSec != nil {
		if *body.ResponseTimeoutSec < 1 || *body.ResponseTimeoutSec > 600 {
			writeErr(w, http.StatusBadRequest, "responseTimeoutSec must be 1..600")
			return
		}
		set.ResponseTimeoutSec = *body.ResponseTimeoutSec
	}
	if body.MemoryGuardMB != nil {
		if *body.MemoryGuardMB < 16 || *body.MemoryGuardMB > 65536 {
			writeErr(w, http.StatusBadRequest, "memoryGuardMB must be 16..65536")
			return
		}
		set.MemoryGuardMB = *body.MemoryGuardMB
	}
	if body.LargeBodyMB != nil {
		if *body.LargeBodyMB < 1 || *body.LargeBodyMB > 64 {
			writeErr(w, http.StatusBadRequest, "largeBodyMB must be 1..64")
			return
		}
		set.LargeBodyMB = *body.LargeBodyMB
	}
	if err := set.save(); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if set.ResponseTimeoutSec > 0 {
		s.eng.SetRepeaterTimeout(set.ResponseTimeoutSec)
	}
	s.st.SetMemoryGuard(set.MemoryGuardMB, set.LargeBodyMB)
	proxy := s.eng.Addr()
	if proxy == "" {
		proxy = s.ProxyAddr
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"responseTimeoutSec": set.ResponseTimeoutSec,
		"memoryGuardMB":      set.MemoryGuardMB,
		"largeBodyMB":        set.LargeBodyMB,
		"pluginsDir":         s.plug.Dir(),
		"proxyAddr":          proxy,
	})
}
