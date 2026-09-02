// Pulse: a browser-driven web security testing proxy (Burp/Caido-style).
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"time"

	"pulse/internal/api"
	"pulse/internal/certs"
	"pulse/internal/events"
	"pulse/internal/plugins"
	"pulse/internal/proxy"
	"pulse/internal/repeater"
	"pulse/internal/rewrite"
	"pulse/internal/store"
)

var version = "0.3.0"

func main() {
	var (
		proxyAddr = flag.String("proxy", "127.0.0.1:8080", "proxy listen address")
		uiAddr    = flag.String("ui", "127.0.0.1:8000", "web UI/API listen address")
		dataDir   = flag.String("data-dir", defaultDataDir(), "data directory (CA, flows, repeater tabs)")
		showVer   = flag.Bool("version", false, "print version and exit")
	)
	flag.Parse()
	if *showVer {
		fmt.Println("pulse", version)
		return
	}

	log.SetFlags(log.Ltime)
	if err := run(*proxyAddr, *uiAddr, *dataDir); err != nil {
		log.Fatalf("pulse: %v", err)
	}
}

func defaultDataDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".pulse"
	}
	return filepath.Join(home, ".pulse")
}

func run(proxyAddr, uiAddr, dataDir string) error {
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return fmt.Errorf("create data dir: %w", err)
	}
	auth, err := certs.LoadOrCreate(dataDir)
	if err != nil {
		return fmt.Errorf("load CA: %w", err)
	}
	st, err := store.Open(filepath.Join(dataDir, "flows.jsonl"))
	if err != nil {
		return fmt.Errorf("open flow store: %w", err)
	}
	defer st.Close()
	rep, err := repeater.Open(filepath.Join(dataDir, "repeater.json"))
	if err != nil {
		return fmt.Errorf("open repeater store: %w", err)
	}
	bus := events.NewBus()
	rw, err := rewrite.Open(filepath.Join(dataDir, "match-replace.json"))
	if err != nil {
		return fmt.Errorf("open rewrite rules: %w", err)
	}
	plug, err := plugins.Open(filepath.Join(dataDir, "plugins"), filepath.Join(dataDir, "plugins.json"))
	if err != nil {
		return fmt.Errorf("open plugins: %w", err)
	}
	engine := proxy.New(auth, st, bus, plug, rw, version)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	go func() {
		if err := engine.ListenAndServe(proxyAddr); err != nil {
			log.Fatalf("proxy listener: %v", err)
		}
	}()

	apiSrv, err := api.New(st, engine, rep, auth, bus, rw, plug, version, proxyAddr, uiAddr, dataDir)
	if err != nil {
		engine.Close()
		return fmt.Errorf("create api server: %w", err)
	}
	srv := &http.Server{Addr: uiAddr, Handler: apiSrv.Handler()}
	ln, err := net.Listen("tcp", uiAddr)
	if err != nil {
		engine.Close()
		return fmt.Errorf("UI listen %s: %w", uiAddr, err)
	}

	log.Printf("Pulse %s starting", version)
	log.Printf("  proxy : %s", proxyAddr)
	log.Printf("  ui    : http://%s", uiAddr)
	log.Printf("  data  : %s", dataDir)
	log.Printf("  ca    : %s", auth.Fingerprint())
	warnNonLoopback(proxyAddr, "proxy")
	warnNonLoopback(uiAddr, "ui")

	errCh := make(chan error, 1)
	go func() { errCh <- srv.Serve(ln) }()

	select {
	case <-ctx.Done():
		log.Printf("shutting down…")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		srv.Shutdown(shutdownCtx)
		engine.Close()
		return nil
	case err := <-errCh:
		engine.Close()
		return err
	}
}

func warnNonLoopback(addr, what string) {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	ip := net.ParseIP(host)
	if host != "" && host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		log.Printf("  WARN: %s listener bound to non-loopback %s — anyone on the network can use this proxy and reach the API", what, addr)
	}
}
