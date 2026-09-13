# E2E for R2: mock-network test mode, ctx.respond/drop in live traffic,
# plugin-source flows visible in Live Traffic, flow context-menu actions,
# and Repeater "Apply plugin".
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


RESPONDER = '''plugin = { name: "R2 Responder", version: "1.0" };
function onRequest(ctx) {
	if (ctx.request.url.indexOf("/mockme") >= 0) {
		ctx.respond({ status: 200, headers: [{ name: "Content-Type", value: "text/plain" }], body: "hello from plugin" });
	}
}'''

DROPPER = '''plugin = { name: "R2 Dropper", version: "1.0" };
function onRequest(ctx) {
	if (ctx.request.url.indexOf("/dropme") >= 0) {
		ctx.drop({ reason: "deny-listed" });
	}
}'''

ACTION_PLUGIN = '''plugin = {
	name: "R2 Acts", version: "1.0",
	actions: [ { id: "extract", label: "Extract endpoint", hint: "method + host" } ]
};
var actions = {
	extract: function (ctx) { return ctx.request.method + " " + ctx.request.url; }
};'''


class Up(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"real upstream"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


up = HTTPServer(("127.0.0.1", 0), Up)
threading.Thread(target=up.serve_forever, daemon=True).start()
UP = f"http://127.0.0.1:{up.server_address[1]}"

api("PUT", "/api/plugins/source/r2-responder.js", {"src": RESPONDER})
api("PUT", "/api/plugins/source/r2-action.js", {"src": ACTION_PLUGIN})

op = urllib.request.build_opener(urllib.request.ProxyHandler({"http": "http://127.0.0.1:8080"}))

# ctx.respond: client gets the plugin's local response, upstream untouched
r = op.open(UP + "/mockme", timeout=15)
body = r.read().decode()
check("ctx.respond serves local body", r.status == 200 and body == "hello from plugin", f"{r.status} {body[:40]}")

# unaffected path still hits upstream
r2 = op.open(UP + "/normal", timeout=15)
check("unmatched path passes through", r2.read().decode() == "real upstream")

api("PUT", "/api/plugins/source/r2-dropper.js", {"src": DROPPER})
time.sleep(0.3)
try:
    op.open(UP + "/dropme", timeout=15)
    check("ctx.drop blocks the transaction", False, "request went through")
except urllib.error.HTTPError as e:
    check("ctx.drop blocks the transaction", e.code == 502, str(e.code))

api("DELETE", "/api/plugins/source/r2-dropper.js")

# action via the flow context menu in the browser
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME)
    pg = b.new_page(viewport={"width": 1400, "height": 900})
    pg.goto(DEV + "/#/proxy", wait_until="networkidle")
    pg.locator(".panel-head .switch", has_text="Follow").first.click()
    pg.wait_for_timeout(800)
    row = pg.locator("table tbody tr").filter(has_text="/mockme").first
    row.click(button="right")
    pg.wait_for_selector(".ctx-menu")
    items = pg.locator(".ctx-item").all_text_contents()
    check("context menu lists the plugin action", any("Extract endpoint" in i for i in items), str(items))
    pg.locator(".ctx-item", has_text="Extract endpoint").click()
    pg.wait_for_timeout(800)
    toast = pg.locator(".toast").last.text_content() if pg.locator(".toast").count() else ""
    check("action result shown in a toast", "GET http" in toast and "/mockme" in toast, toast)
    pg.screenshot(path=f"{OUT}/r2_action_menu.png")

    # Repeater Apply plugin
    pg.evaluate("location.hash = '#/repeater'")
    pg.wait_for_timeout(1200)
    pg.locator("button", has_text="Apply plugin").first.click()
    pg.wait_for_selector(".modal[role='dialog']")
    check("apply picker lists request-hook plugins", pg.locator(".modal .btn", has_text="R2 Responder").count() >= 1)
    pg.locator(".modal .btn", has_text="R2 Responder").click()
    pg.wait_for_timeout(900)
    pg.wait_for_timeout(400)
    preview = pg.locator(".modal").last.text_content() if pg.locator(".modal").count() else ""
    check("apply preview shows result or no-change", ("No changes" in preview) or ("GET" in preview) or ("modified" in preview), preview[:80])
    pg.screenshot(path=f"{OUT}/r2_apply_plugin.png")
    pg.keyboard.press("Escape")
    b.close()

# mock-network test mode via the API (frontend test-mock endpoint)
out = api("POST", "/api/plugins/test-mock", {
    "src": RESPONDER, "hook": "request",
    "request": {"method": "GET", "url": "http://x/mockme"},
    "mocks": {},
})
check("test-mock returns mocked respond", out.get("mocked") is True and ((out.get("response") or {}).get("body") == "hello from plugin"), str(out.get("error") or (out.get("response") or {}).get("body")))

out2 = api("POST", "/api/plugins/test-mock", {
    "src": "async function onRequest(ctx) { try { await pulse.http.send({ url: 'https://nope.test/x' }); pulse.log('SENT'); } catch (e) { pulse.log('rej'); } }",
    "hook": "request",
    "request": {"method": "GET", "url": "http://x/"},
    "mocks": {},
})
check("unmocked request rejects in test mode", any("rej" in l for l in out2.get("logs") or []) and not any("SENT" in l for l in out2.get("logs") or []), str(out2.get("logs")))

api("DELETE", "/api/plugins/source/r2-responder.js")
api("DELETE", "/api/plugins/source/r2-action.js")

up.shutdown()
print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    raise SystemExit("FAILED: " + ", ".join(FAIL))
