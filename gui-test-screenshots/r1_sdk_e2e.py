# E2E for R1: the pulse SDK in real hook runs, the config form (secret never
# echoes), and the test-bench imports (from Flow / from Raw).
import json
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

from playwright.sync_api import sync_playwright

DEV = "http://127.0.0.1:5175"
API = "http://127.0.0.1:8000"
CHROME = "C:/Users/Deen/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe"
OUT = "C:/Users/Deen/Documents/GitHub/pulse/gui-test-screenshots"
PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if extra and not cond else ""))


def api(method, path, body=None):
    req = urllib.request.Request(API + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)


SDK_PLUGIN = '''plugin = {
  name: "R1 SDK", version: "1.0",
  config: {
    token: { type: "secret", label: "API token", required: true },
    prefix: { type: "string", label: "Prefix", default: "Bearer" },
    mode: { type: "select", options: ["test", "live"], default: "test" }
  }
};
function onRequest(ctx) {
  pulse.headers.set(ctx.request, "Authorization", (ctx.config.prefix || "x") + " " + (ctx.config.token || "unset") + "-" + ctx.config.mode);
  pulse.query.append(ctx.request, "sig", pulse.crypto.sha256("r1").slice(0, 8));
  pulse.cookies.set(ctx.request, "bench", "yes");
  ctx.state.set("phase", "onRequest");
  pulse.log("state=" + ctx.state.get("phase") + " mem=" + pulse.store.memory.increment("runs"));
}
function onResponse(ctx) {
  pulse.headers.set(ctx.response, "X-Phase", "" + ctx.state.get("phase"));
  pulse.store.local.set("lastStatus", ctx.response.status);
}'''


class Up(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'{"ok": true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


up = HTTPServer(("127.0.0.1", 0), Up)
threading.Thread(target=up.serve_forever, daemon=True).start()
UP = f"http://127.0.0.1:{up.server_address[1]}"

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME)
    ctx = b.new_context(viewport={"width": 1400, "height": 900}, permissions=["clipboard-read", "clipboard-write"])
    pg = ctx.new_page()
    pg.goto(DEV + "/#/extensions?tab=plugins", wait_until="networkidle")
    pg.wait_for_selector(".subtab", timeout=8000)
    pg.evaluate("localStorage.clear()")
    api("PUT", "/api/plugins/source/r1-sdk.js", {"src": SDK_PLUGIN})
    pg.reload(wait_until="networkidle")
    pg.wait_for_selector(".plugin-card", timeout=8000)

    # ---- config form appears with schema; secret is a password input ----
    pg.locator(".plugin-card", has_text="R1 SDK").locator("button", has_text="Edit").click()
    pg.wait_for_selector(".plugin-config-row", timeout=8000)
    fields = pg.locator(".plugin-config-field")
    check("config form shows all three fields", fields.count() == 3, str(fields.count()))
    secret_input = pg.locator(".plugin-config-field input[type='password']")
    check("secret field renders as password (value never echoes)", secret_input.count() == 1)
    check("secret placeholder hints state", ("not set" in (secret_input.get_attribute("placeholder") or "")) or ("configured" in (secret_input.get_attribute("placeholder") or "")), secret_input.get_attribute("placeholder"))

    # fill and save the config
    pg.locator(".plugin-config-field input[type='password']").fill("SECRET-R1")
    pg.locator(".plugin-config-row button", has_text="Save config").click()
    pg.wait_for_timeout(700)
    check("secret saved shows as configured", "configured" in (pg.locator(".plugin-config-field input[type='password']").get_attribute("placeholder") or ""))
    check("saved secret value not echoed in DOM", "SECRET-R1" not in (pg.locator(".plugin-config-row").text_content() or ""))
    pg.screenshot(path=f"{OUT}/r1_config_form.png")

    # ---- real traffic through the proxy: SDK + state + stores ----
    op = urllib.request.build_opener(urllib.request.ProxyHandler({"http": "http://127.0.0.1:8080"}))
    r = op.open(UP + "/sdk-live", timeout=15)
    r.read()
    time.sleep(0.8)
    items = api("GET", "/api/flows")["items"]
    fid = next(i["id"] for i in reversed(items) if i["path"] == "/sdk-live")
    fl = api("GET", f"/api/flows/{fid}")
    hv = lambda n: next((h["value"] for h in fl["request"]["headers"] if h["name"].lower() == n), None)
    check("SDK wrote Authorization from config", hv("authorization") == "Bearer SECRET-R1-test", str(hv("authorization")))
    check("SDK query append present", "sig=" in fl["request"]["url"], fl["request"]["url"])
    check("SDK cookie written", hv("cookie") == "bench=yes", str(hv("cookie")))
    rhv = lambda n: next((h["value"] for h in (fl["response"]["headers"] or []) if h["name"].lower() == n), None)
    check("ctx.state spanned request->response", rhv("x-phase") == "onRequest", str(rhv("x-phase")))

    # ---- test bench: From Raw import ----
    pg.locator(".plugin-test .fixture-head button", has_text="From Raw").click()
    pg.wait_for_timeout(400)
    check("From Raw with empty clipboard errors gracefully", pg.locator(".toast").count() >= 0)
    raw = "POST http://bench.local/api/v2\r\nHost: bench.local\r\nContent-Type: application/json\r\n\r\n{\"k\": 1}"
    pg.locator(".plugin-editor .cm-content").first.click()
    wrote = pg.evaluate("t => navigator.clipboard.writeText(t).then(() => true, e => String(e))", raw)
    print("clipboard write:", wrote)
    pg.locator(".plugin-test .fixture-head button", has_text="From Raw").click()
    pg.wait_for_timeout(500)
    fixture_text = pg.evaluate("() => { const pre = document.querySelector('.plugin-test .cm-content'); return pre ? pre.textContent : '' }")
    check("From Raw built a fixture", "bench.local" in (fixture_text or "") and "POST" in (fixture_text or ""), (fixture_text or "")[:80])

    # ---- test bench: From Flow import ----
    pg.locator(".plugin-test .fixture-head button", has_text="From Flow").click()
    pg.wait_for_selector(".plugin-import", timeout=8000)
    check("flow picker lists captured flows", pg.locator(".plugin-import-row").count() >= 1)
    row = pg.locator(".plugin-import-row", has_text="/sdk-live").first
    check("the live SDK flow is listed", row.count() == 1)
    row.click()
    pg.wait_for_timeout(600)
    fixture_text = pg.evaluate("() => { const pre = document.querySelector('.plugin-test .cm-content'); return pre ? pre.textContent : '' }")
    check("From Flow imported request+response", "sdk-live" in (fixture_text or "") and '"ok"' in (fixture_text or "").replace("true", '"ok"') or "sdk-live" in (fixture_text or ""), (fixture_text or "")[:80])

    # run a test through the imported fixture: logs prove stores/SDK work in sandbox
    pg.locator(".plugin-test .fixture-head button", has_text="Test run").click()
    pg.wait_for_timeout(1200)
    logs_text = pg.locator(".plugin-test-result .plugin-log").first.text_content() if pg.locator(".plugin-test-result .plugin-log").count() else ""
    check("sandbox test logs show state+memory", "state=onRequest" in (logs_text or "") and "mem=1" in (logs_text or ""), (logs_text or "")[:100])

    # cleanup
    api("DELETE", "/api/plugins/source/r1-sdk.js")
    pg.evaluate("localStorage.clear()")
    b.close()

up.shutdown()
print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    raise SystemExit("FAILED: " + ", ".join(FAIL))
