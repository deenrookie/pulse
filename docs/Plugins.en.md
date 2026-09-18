# Pulse Plugin Development Guide

**[中文](Plugins.md) | English**

Pulse plugins are **JavaScript files** (ES5.1+, executed by the embedded [goja](https://github.com/dop251/goja) runtime — nothing to install) dropped into the data directory's `plugins/` folder. They observe and modify every request and response passing through the proxy.

## Quick start

**AI development entry**: Extensions → Plugins → **Skills** lets you read/copy the plugin-development skill or download the full `pulse-plugin-dev` ZIP (SKILL.md, SDK types, scope templates, positive/negative fixtures, and a Python-3-stdlib sandbox assertion script). The skill source lives in `internal/plugins/skills/pulse-plugin-dev/`; the page and ZIP come from embedded assets, and the SDK types are generated from the running instance. Install into your AI tool's skills directory and reload, or just paste the instructions. See the Skill for the full flow.

Pick one of two ways to start:

- **Online editor (recommended)**: open **Extensions → Plugins → Editor**, write code, run `Check` validation and `Test run` sandbox execution, then `Save to disk` writes straight into the plugins directory and takes effect immediately.
- **Manual placement**: copy an example from `examples/plugins/` into the plugins directory (the Installed tab lets you **change the directory path**), then hit Reload.

Browse any site through the proxy and the plugin takes effect immediately. The **Samples** tab holds ready-to-copy example code (one-click copy or load into the editor).

## Plugin structure

```js
// metadata (optional, shown in the UI)
plugin = {
  name: "My Plugin",
  version: "1.0",
};

// request hook: called before the request goes upstream
function onRequest(ctx) {
  // ctx.request = { method, url, httpVersion, headers, body }
}

// response hook: called before the response returns to the client
function onResponse(ctx) {
  // ctx.request  read-only reference
  // ctx.response = { status, reason, httpVersion, headers, body }
}
```

Both hooks are optional; a response-only plugin can define just `onResponse`.

## Data model and how to modify it

`ctx` is a **mutable plain-data object** — mutate fields directly and Pulse writes the changes back to the live traffic after the hook returns:

```js
function onRequest(ctx) {
  // change method / URL
  ctx.request.method = "POST";
  ctx.request.url = ctx.request.url.replace("http://", "https://");

  // edit/add/remove headers (headers is an array of {name, value})
  for (var i = 0; i < ctx.request.headers.length; i++) {
    if (ctx.request.headers[i].name === "User-Agent") {
      ctx.request.headers[i].value = "pulse-bot/1.0";
    }
  }
  ctx.request.headers.push({ name: "X-Powered-By", value: "my-plugin" });

  // change the body (as a string; do not rewrite binary content this way)
  ctx.request.body = "rewritten";
}

function onResponse(ctx) {
  if (ctx.response.body.indexOf("secret") >= 0) {
    ctx.response.body = ctx.response.body.replace(/secret/g, "[REDACTED]");
  }
}
```

## Utility API: `pulse`

| Call | Description |
| --- | --- |
| `pulse.log(msg)` | Print one log line (shown in the Plugins panel, last 60 lines kept) |
| `pulse.version` | Pulse version |

## R1 SDK: `pulse.*` message and data helpers

The following host APIs work directly on the current `ctx.request` / `ctx.response` draft (equivalent to mutating the fields yourself):

| API | Description |
| --- | --- |
| `pulse.headers.get/getAll/set/append/remove(message, name, …)` | Case-insensitive; set dedupes, append keeps repeats, remove returns the deleted count |
| `pulse.url.parse(url)` | Returns `{scheme, host, port, path, query}` |
| `pulse.query.getAll/set/append/remove(request, name, value?)` | URL query params, preserving repeated params and order |
| `pulse.cookies.get/set/remove(message, name, value)` | Cookie semantics for the request Cookie header |
| `pulse.body.json / setJSON / setText(message, …)` | JSON / text body read & write |
| `pulse.encoding.base64 / hex(text)` | Encoding helpers |
| `pulse.crypto.sha256(text)` / `hmacSha256(key, text)` | Hex digest / signature |

### State and configuration

- `ctx.state.get/set/delete/keys()`: shared across the request→response phases of one Flow, released when the transaction ends.
- `pulse.store.memory.get/set/delete/keys/increment(key, val?, ttlMs?)`: cross-request in-memory state (lost on restart; TTL and atomic increment supported).
- `pulse.store.local.get/set/delete/keys(key, …)`: persistent JSON state per plugin (survives restarts, 256KB cap).
- `plugin.config`: declares a config form (`string/number/boolean/select/secret`); users fill it in the Configuration row above the editor. Secrets are write-only and never echoed. The runtime reads a snapshot through `ctx.config` (defaults merged in).

### Test-bench import

- **From Flow**: pick a captured flow and import its request+response as the fixture.
- **From Raw**: paste a raw HTTP message (request or response) to build the fixture automatically.

## R2: active capabilities

### `pulse.http.send(options)` — plugin-initiated HTTP requests (async)

```js
async function onRequest(ctx) {
  const r = await pulse.http.send({
    method: "POST", url: "https://auth.test/token",
    headers: [{ name: "Content-Type", value: "application/json" }],
    body: JSON.stringify({ grant: "refresh" }),
    timeoutMs: 5000, redirects: "manual",
  });
  if (r.status !== 200) return;
  pulse.store.memory.set("token", pulse.body.json(r).access_token);
}
```

- Returns a Promise bounded by both the overall hook budget and `timeoutMs`; timeouts/cancellation propagate as rejections.
- Requests **bypass the plugin chain, Match & Replace and interception** (no self-triggering recursion), are recorded with `source: plugin`, and show up in Live Traffic.
- `redirects: "manual"` returns 3xx hop-by-hop; credentials are never inherited implicitly.

### `ctx.respond()` / `ctx.drop()` — terminal actions (onRequest)

- `ctx.respond({ status, headers, body })`: serve a local response without contacting the upstream; Content-Length is recomputed; response-phase plugins still run afterwards.
- `ctx.drop({ reason })`: the plugin blocks the transaction (the client gets a 502; the Flow is marked blocked by plugin).
- Repeating a terminal action in the same transaction throws.

### `onComplete(ctx)` — post-completion analysis

Runs read-only after the transaction finishes (it may use plugin stores and make HTTP calls) without blocking the response.

### Mock network test mode

`POST /api/plugins/test-mock` (the editor's Mock test mode): any URL without a configured mock rejects with `unmocked network request` — tests can never silently reach the real network.

### Actions — manual actions

```js
plugin = { name: "Tools", actions: [ { id: "extract", label: "Extract endpoint" } ] };
var actions = { extract: (ctx) => ctx.request.method + " " + ctx.request.url };
```

Declared actions appear in the **flow context menu** (Run: …) and run against a copy of the selected Flow; results show as a toast.

### Repeater: Apply plugin

The **Apply plugin** button in the Repeater request header runs the chosen plugin's onRequest against a copy of the current buffer, previews the result, then applies it back to the editor manually — nothing is sent. Repeater still bypasses plugins automatically by default.

## R3: engineering scale

### Directory projects (pulse.plugin.json)

Single-file plugins need no scaffolding; upgrade to a directory when you want splitting, bundling or type hints:

	pulse dir/
	  pulse.plugin.json    # id, name, version, entry (default dist/plugin.js)
	  dist/plugin.js       # entry artifact (any bundler can produce it)
	  src/…, tests/…, pulse.d.ts, README.md

- **The manifest is the identity authority**: `id` identifies the plugin; `name`/`version` override the same fields declared in code metadata.
- **Identity conflicts**: when two plugins claim the same id, the later one reports "duplicate plugin id" and stops running (the source stays editable to fix) — never silently shadowed.
- Bundling: bundle pure-JS dependencies into the single entry artifact on your dev machine with esbuild or similar; the Pulse runtime never touches npm or runs install scripts. Artifacts are compile-checked by the pinned goja version at load time.

### SDK types and the command line

- **TypeScript declarations**: `GET /api/plugins/sdk` returns the full `pulse.d.ts` (the entire ctx/pulse/actions API). Reference it next to your source: `/// <reference path="pulse.d.ts" />`.
- **CLI check/test** (the same host contract as the browser):
	go run ./cmd/pulse plugins check internal/plugins/samples/demo-read-rewrite.js
	go run ./cmd/pulse plugins test my-plugin.js fixture.json
	# or with a released binary: pulse plugins check <path>

### Custom UI panels (sandboxed iframe + versioned message bridge)

	plugin = { ..., uiPanel: { id: "notes", title: "Plugin notes", html: "<button onclick=…>…</button>" } };

- Panels render inside an iframe with `sandbox="allow-scripts"` — **no DOM access to the Pulse page**.
- The panel attaches as an extra tab on the message inspector (request/response) for the first enabled plugin declaring `uiPanel`.
- **Bridge protocol v1** (postMessage): `{ v: 1, plugin: "<file>", type, payload }`:
  - `pulse.notify(text, kind)` — host toast
  - `pulse.copy(text)` — clipboard write
  - `pulse.flow()` → `Promise<{method,url,status}|null>` — read-only summary of the inspected message
  - RPC replies use `{type:'rpc', seq, result}`; unknown methods return `{error:'unknown method'}`.

### Authorized directory file access (pulse.files)

- One granted directory per plugin (`PUT /api/plugins/files/{file}` to grant, empty to revoke), persisted in the data directory.
- `pulse.files.read/write/list(rel)`: paths are normalized (`..` folds back inside the root) and symlink-resolved; any path escaping the granted directory (including symlink exits) throws.
- Without a grant you get a clear error, never a silent failure.

## Plugins directory

Defaults to `<data-dir>/plugins`. Change it to any path in the *Plugin directory* input at the top of **Extensions → Plugins → Installed** (Enter or Apply; the directory is created if missing; Reset restores the default). The setting persists in `settings.json` (`pluginsDir`) across restarts.

## Online editor (Editor tab)

| Action | Description |
| --- | --- |
| **Check** | Dry compile: nothing hits disk; syntax/load errors and detected hooks (incl. `plugin` metadata) report immediately |
| **Test run** | Sandbox run: executes the hook against the editable JSON fixture below, showing `pulse.log` output, thrown errors and the transformed message — **zero real traffic** |
| **Save to disk** | Writes into the plugins directory with hot reload (`Ctrl+S` works too). If the code fails to compile: the file is still written, the error shows inline, the plugin stays inactive until you fix and save again |
| **Delete** | Removes the file from the plugins directory |

## Writing correct plugins / debugging / catching failures early

1. **While writing**: `Check` dry-compiles; syntax errors pinpoint `line:column` (the status bar shows a clickable location); you immediately see whether hooks were recognized (`hooks: request, response`).
2. **Before deploying**: `Test run` executes against your fixture — check logs (`pulse.log`), the transformed message and thrown errors with zero traffic. **Editing the source or fixture marks old results as stale**, so stale results are never mistaken for current conclusions.
3. **Draft protection**: editor content autosaves to a local draft (per file name) every 0.5s. Leave the page, switch files or load a sample and come back — unsaved edits are restored automatically; a successful save clears the draft.
4. **While running**:
   - Load errors (syntax / top-level throws) show in the plugin card's red error bar;
   - Runtime throws inside a hook only affect that call; errors and `pulse.log` output stream into the plugin card (panel refreshes every 4s);
   - Every hook execution (including top-level init) has a 2-second budget — an infinite loop can't take down the proxy;
   - Plugin cards show separated counters: `hits/attempts ok · errors err` with modified/timeouts details on hover; **the most recent error is kept forever** (never erased by later successes) with a timestamp.
5. **Running-revision protection (last good revision)**: saved a broken source? The proxy **keeps running the last revision that loaded** (the card shows "last good revision running"; the editor still shows the broken source for you to fix). Restarting recovers the same good revision. Fix the source, save, and it returns to normal.
6. **Disabling is the kill switch**: the toggle on a plugin card stops it immediately without affecting others. If persisting the enable state to disk fails, you get an explicit error instead of silent fake success.

## Runtime rules (and security)

- **Execution order**: `onRequest` hooks run in file-name order → Match & Replace rules → Intercept (what you see in the intercept panel is the final form) → upstream. On the response side: `onResponse` → response rules → client.
- **Isolation**: every hook call runs in a **brand-new VM**; plugins share no state with each other or across requests (closure variables are fresh each time).
- **Timeout**: one hook execution (including per-call top-level init) is capped at **2 seconds** and interrupted on overrun; infinite loops can't hang the proxy.
- **Error isolation**: syntax errors are recorded into plugin state at load time; runtime throws affect only that invocation — other plugins and the proxy pipeline are untouched. Errors surface in the Plugins panel.
- **Performance**: each request instantiates a VM and re-executes plugin top-level code. Keep the top level to function definitions; no heavy computation there.
- **Capability boundaries**: no Node/browser globals, no native fetch or timers; network goes through `pulse.http.send`, files through explicitly authorized `pulse.files`, config and state through the host SDK.

### v1 field contract (explicit and tested)

| Field | writable in onRequest | writable in onResponse | Notes |
| --- | --- | --- | --- |
| `ctx.request.method / url / headers / body` | ✓ | ✓ (v1 compat, kept) | mutating the request in the response phase is v1 legacy; v2 will tighten this |
| `ctx.response.status / headers / body` | — (no response) | ✓ | |
| `ctx.request.httpVersion` / `ctx.response.httpVersion` | read-only | read-only | the transport owns the protocol |
| `ctx.response.reason` | — | read-only | HTTP/1 concept; HTTP/2 has no reason phrase |

## Known limitations

- Bodies round-trip as UTF-8 strings; rewriting binary bodies may corrupt them (avoid changing binary content in plugins).
- Repeater sends bypass plugins and rewrite rules (matching Burp's default).

## Examples

In the repo at `examples/plugins/` (the same content ships built into **Extensions → Plugins → Samples** with syntax highlighting, one-click copy or load into the editor):

| File | Purpose |
| --- | --- |
| `demo-read-rewrite.js` | **Full-featured demo**: reads and rewrites the request path, query params, headers, POST body and response headers/body |
| `add-header.js` | Injects a custom header into every request; demonstrates `pulse.log` |
| `redact-tokens.js` | Redacts Bearer tokens / API keys in responses (regex) |
| `template.js` | Minimal plugin skeleton |

## Roadmap

R0–R3 all shipped (v0.3.7–v0.3.8): active HTTP, sandboxed UI panels, directory projects and the AI skill are live. The current Scope only filters the traffic view; plugins must restrict host/path themselves. Remaining directions (WebSocket frame hooks, streaming/SSE/gRPC rewriting, scheduled tasks, cross-plugin calls, a marketplace, a Node-compatible runtime) are evaluation items — see the [product roadmap](Product.md).
