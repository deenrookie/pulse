package main

// `pulse plugins check <path>` and `pulse plugins test <path> [fixture]`:
// the same host contract the browser editor uses, runnable from a terminal
// or CI without a server.

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"pulse/internal/plugins"
	"pulse/internal/store"
)

func runPluginsCLI(args []string) int {
	if len(args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: pulse plugins <check|test> <file.js> [fixture.json]")
		return 2
	}
	cmd, path := args[0], args[1]
	src, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read %s: %v\n", path, err)
		return 2
	}
	switch cmd {
	case "check":
		in := plugins.Inspect(string(src))
		if in.Error != "" {
			fmt.Printf("FAIL %s: %s\n", path, in.Error)
			return 1
		}
		fmt.Printf("OK %s — name=%q version=%q hooks=%v\n", path, in.Name, in.Version, in.Hooks)
		return 0
	case "test":
		req := &store.Request{Method: "GET", URL: "http://example.com/", HTTPVersion: "HTTP/1.1", Headers: []store.Header{}}
		resp := &store.Response{StatusCode: 200, Reason: "OK", HTTPVersion: "HTTP/1.1", Headers: []store.Header{}}
		hook := "onRequest"
		if len(args) > 2 {
			b, err := os.ReadFile(args[2])
			if err != nil {
				fmt.Fprintf(os.Stderr, "read fixture: %v\n", err)
				return 2
			}
			var fx struct {
				Hook     string `json:"hook"`
				Request  struct {
					Method string `json:"method"`
					URL    string `json:"url"`
				} `json:"request"`
			}
			if json.Unmarshal(b, &fx) == nil {
				if h := strings.TrimSpace(fx.Hook); h != "" {
					hook = h
				}
				if fx.Request.Method != "" {
					req.Method = fx.Request.Method
				}
				if fx.Request.URL != "" {
					req.URL = fx.Request.URL
				}
			}
		}
		hookName := hook
		if !strings.HasPrefix(hookName, "on") {
			hookName = "on" + strings.ToUpper(hookName[:1]) + hookName[1:]
		}
		out := plugins.TestRun(string(src), hookName, req, resp, 0)
		for _, l := range out.Logs {
			fmt.Println("log:", l)
		}
		if out.Error != "" {
			fmt.Printf("FAIL: %s\n", out.Error)
			return 1
		}
		fmt.Printf("OK — %s\n", map[bool]string{true: "message modified", false: "no changes"}[out.Changed])
		return 0
	default:
		fmt.Fprintf(os.Stderr, "unknown plugins subcommand %q (want check or test)\n", cmd)
		return 2
	}
}
