<div align="center">

# ⚡ Pulse

**A local web-security testing platform driven from your browser**

MITM interception, tampering, replay, rewriting and plugin extensibility — the core Burp Suite / Caido workflows, in a single binary.

[English](README.md) · [简体中文](README.zh-CN.md)

<img src="https://img.shields.io/badge/Go-1.25+-00ADD8?logo=go&logoColor=white" alt="Go 1.25+"/>
<img src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white" alt="React 18"/>
<img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey" alt="platform"/>
<img src="https://img.shields.io/badge/single%20binary-zero%20runtime%20deps-8A2BE2" alt="single binary"/>

[Quick start](#-quick-start) · [Core features](#-core-features) · [Plugins](#-plugin-system) · [Docs](#-docs)

</div>

---

## 📸 Core views

**Live Traffic** — real-time MITM capture: a virtualized flow table (smooth at 5,000 rows), multi-dimensional filters & highlighting, right-click to Repeater / cURL, and an inspector with Headers / Params / Pretty / Hex / per-frame WebSocket:

<div align="center"><img src="docs/screenshots/proxy.png" alt="Pulse Live Traffic — MITM capture and inspection" width="880"/></div>

**Repeater** — a Burp-style raw editor: request line, headers and body in a single buffer, `Ctrl+Enter` to re-send, live response rendering, tabs that survive restarts:

<div align="center"><img src="docs/screenshots/repeater.png" alt="Pulse Repeater — raw editing and replay" width="880"/></div>

> Three themes (**Linear by default** / Warm / Midnight), fully offline — your traffic never leaves the machine.

## ✨ Core features

| Module | Capabilities |
| --- | --- |
| **Proxy** | HTTP/HTTPS MITM capture, real-time SSE **virtualized** table (5k rows, resizable columns, sortable), multi-facet filters + advanced filter builder + 8-color highlights, gzip/br auto-decompression, JSONL persistence across restarts, star & note annotations with a ★-only filter, right-click Send to Repeater / Copy as cURL / deep links; **Scope** targeting (right-click a host, one click to filter to your targets — rules include subdomains, shield badges in the site map); **deep search** (`Ctrl+Shift+F`) across traffic + repeater records; **HAR export** |
| **Intercept** | Hold requests in a queue, edit method/URL/headers/body, forward or drop, `F` / `D` shortcuts; **response interception** (hold replies before the client) |
| **Intruder** | Burp-style batch fuzzing: mark `§positions§` in a raw template, load a payload list, fire — status/length/time per shot with baseline-deviation highlighting, **grep-match columns**, single-set & **pitchfork (per-position sets)** modes, response inspector (`Ctrl+7`, right-click any flow → Send to Intruder) |
| **Site Map** | host→path→method endpoint tree (status coloring, counts, search), per-endpoint **status variants** (200·12 / 500·2 chips), click to inspect the latest exchange; **Comparer** tool in the footer diffs any two raws |
| **Repeater** | raw-editor replay, persistent tabs, instant response inspection, **diff vs previous response** (word-aware); **editable Params tab** writes back into the raw |
| **Extensions** | **Match & Replace** (5 zones, regex/literal, hit counters); **JS plugins** (onRequest/onResponse hooks, isolated VMs + 2s timeout, hot reload, log panel, a **CodeMirror online editor**: Check dry-run / sandbox Test run / one-click save, **configurable plugin directory**, built-in samples) |
| **WebSocket** | RFC 6455 frame-level capture: text/binary/close/ping/pong logged both ways, dedicated inspector tab |
| **Settings** | CA certificate download & per-platform install guides, **runtime proxy-address rebinding**, memory guard, runtime stats, shortcut cheatsheet |

Pipeline order: `plugins → rewrite rules → intercept → upstream`; stored flows always reflect what was actually sent/received. Repeater sends bypass plugins & rewrites (Burp default).

## 🚀 Quick start

**No build needed** — grab a prebuilt binary from the [releases](https://github.com/deenrookie/pulse/releases) (single file, zero runtime deps):

```bash
# macOS (Apple Silicon)
curl -L https://github.com/deenrookie/pulse/releases/download/v0.3.2/pulse_0.3.2_darwin_arm64.tar.gz | tar xz && chmod +x pulse && ./pulse

# Linux (x64)
curl -L https://github.com/deenrookie/pulse/releases/download/v0.3.2/pulse_0.3.2_linux_amd64.tar.gz | tar xz && chmod +x pulse && ./pulse
```

```powershell
# Windows (x64) — PowerShell
curl.exe -L -o pulse.zip https://github.com/deenrookie/pulse/releases/download/v0.3.2/pulse_0.3.2_windows_amd64.zip
Expand-Archive pulse.zip -Force; .\pulse.exe
```

Each archive carries `pulse` (binary with the web UI embedded) and `README.md`. Newer releases: swap the version in the URL.

Or build from source:

Prerequisites: Go 1.25+, Node 18+ (only to build the frontend).

```bash
# build the single binary (frontend embedded)
cd web && npm install && npm run build && cd ..
go build -o pulse.exe ./cmd/pulse        # Linux/macOS: -o pulse

# run — proxy on 127.0.0.1:8080, console on 127.0.0.1:8787
./pulse.exe
# customize: --proxy :9090 --ui :9000 --data-dir D:/pulse-data
```

Open the console at <http://127.0.0.1:8787>. The same build is hosted at <https://pulsesec.vercel.app/> — it talks to your local instance over CORS.

### Remote / hosted-panel access

The console listens on loopback only by default. To drive it from the hosted
panel (or another machine on your LAN):

1. Bind the UI to a reachable address: `pulse --ui 0.0.0.0:8787`
2. Pin or read the access key: `PULSE_KEY=... pulse ...` (otherwise a random
   key is generated and printed at startup — loopback access never needs it)
3. On the hosted panel open **Settings → Remote instance**, enter the
   instance address (e.g. `http://192.168.1.5:8787`) and the key — stored in
   that browser's localStorage — and the panel drives that instance

Non-loopback API calls must carry the key (`X-Pulse-Key` header, or `?key=`
for the SSE stream).

**Chrome's local-network permission** — HTTPS pages (like the hosted panel)
may only call `127.0.0.1` / LAN services after you grant the site the
*local network access* permission. If the hosted panel says
"Can't reach the Pulse instance": click the 🔒 / tune icon left of the
address bar → **Site settings** → **Local network access** → **Allow** →
reload. (Or skip the permission entirely by opening
<http://127.0.0.1:8787> directly — same panel, zero setup.)

### Capturing HTTPS (once)

1. Download the CA certificate from Settings (`pulse-ca.pem`).
2. Add it to your trust store:
   - **Windows**: `certmgr.msc` → Trusted Root Certification Authorities → import (or `certutil -addstore -user root pulse-ca.pem`).
   - **macOS**: Keychain Access → System → import → mark "Always Trust".
   - **Firefox**: Settings → Privacy & Security → Certificates → Import → check "Trust this CA".
3. Point your browser's proxy at `127.0.0.1:8080` (SwitchyOmega & friends work) — every site you visit shows up in Live Traffic.

> Only trust the Pulse CA in test environments; remove it when done. Pulse never modifies your system trust store by itself.

<details>
<summary><b>Architecture</b></summary>

```
┌────────────┐  proxied traffic (HTTP/HTTPS)  ┌─────────────┐   ┌──────────┐
│ browser /  ├───────────────────────────────▶│ Pulse :8080 ├──▶│ upstream │
│ client     │                                │ (MITM core) │   │ servers  │
└────────────┘                                └─────────────┘   └──────────┘
┌────────────┐  REST + SSE (control)          │             │
│ console    ├───────────────────────────────▶│ Pulse :8787 │
│ browser    │                                └─────────────┘
└────────────┘
```

- Backend: Go (stdlib + goja JS runtime; the web UI is embedded in the binary)
- Frontend: React + TypeScript + CodeMirror 6 (embedded build, zero runtime dependencies, zero network requests)

</details>

<details>
<summary><b>Development</b></summary>

```bash
# one command: backend + Vite HMR, Ctrl+C stops both (macOS / Linux / Git Bash)
./dev.sh                     # console http://127.0.0.1:5175, proxy :8080
PROXY_PORT=9090 ./dev.sh     # different proxy port

# or run them separately:
go run ./cmd/pulse           # terminal 1
cd web && npm run dev        # terminal 2 — http://127.0.0.1:5175
```

</details>

## 🧩 Plugin system

JavaScript files in the plugin directory (ES5.1+, goja runtime) observe and modify every proxied request and response — nothing to install:

```js
plugin = { name: "Add Header", version: "1.0" };

function onRequest(ctx) {
  ctx.request.headers.push({ name: "X-Powered-By", value: "pulse" });
  pulse.log("tagged " + ctx.request.url);
}
```

The console ships an online editor: **Check** dry-compiles (errors pinpoint line:column), **Test run** executes the hook against a fixture with zero traffic, one click saves to the plugin directory with hot reload; the plugin directory is configurable at runtime. See the [plugin guide](docs/Plugins.md) (Chinese).

## 📚 Docs

- [Product](docs/Product.md): positioning, competitors, scope, roadmap
- [Architecture](docs/Architecture.md): modules, data flow, pipeline order, security model, test strategy
- [API reference](docs/API.md): REST + SSE endpoints
- [Plugin guide](docs/Plugins.md): JS plugin API, samples, security model

## 🧪 Tests

```bash
go test ./...                            # engine / intercept / tunnel / store / API / plugins
cd web && npx tsc --noEmit && npm run build
```

## 📁 Layout

```
cmd/pulse          entrypoint
internal/          certs | proxy | store | repeater | rewrite | plugins | api
web/               React SPA (CodeMirror plugin editor)
examples/plugins/  sample plugins (same as the Samples tab)
docs/              docs & screenshots
```

## 📄 License

TBD.

---

<div align="center">

**Pulse** — a local capture-and-replay workbench for security engineers

⭐ Star it if it helps — it keeps the roadmap moving

</div>
