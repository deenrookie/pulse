# E2E: query-key / set-cookie highlighting in raw views, and the
# copy-as-Go/Python/JS menu entries.
# Surfaces: proxy request pane (RawEditor), proxy response pane (RawView),
# GlobalSearch preview (read-only request RawView), FlowTable menu, Repeater.
import json
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

from playwright.sync_api import sync_playwright

DEV = "http://127.0.0.1:5175"
CHROME = "C:/Users/Deen/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe"
OUT = "C:/Users/Deen/Documents/GitHub/pulse/gui-test-screenshots"
PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if extra and not cond else ""))


class Up(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'{"token": "xyz", "count": 2}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Set-Cookie", "sid=abc123; Path=/; HttpOnly")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


up = HTTPServer(("127.0.0.1", 0), Up)
threading.Thread(target=up.serve_forever, daemon=True).start()
UP = f"http://127.0.0.1:{up.server_address[1]}"

op = urllib.request.build_opener(urllib.request.ProxyHandler({"http": "http://127.0.0.1:8080"}))
op.open(UP + "/ping?a=bc&foo=bar&baz", timeout=10).read()
time.sleep(1)

with urllib.request.urlopen("http://127.0.0.1:8000/api/flows") as r:
    items = json.load(r)["items"]
flow_id = next(i["id"] for i in reversed(items) if "ping" in (i.get("path") or ""))


def clipboard():
    return pg.evaluate("navigator.clipboard.readText()")


with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME)
    ctx = b.new_context(viewport={"width": 1500, "height": 900}, permissions=["clipboard-read", "clipboard-write"])
    pg = ctx.new_page()
    pg.goto(f"{DEV}/#/proxy?flow={flow_id}", wait_until="networkidle")
    pg.locator(".panel-head .switch", has_text="Follow").first.click()  # live traffic: stop auto-select
    pg.wait_for_timeout(800)

    # ---- proxy request pane: RawEditor mirror ----
    ed = pg.locator(".raw-edit-stack")
    ed.wait_for(timeout=8000)
    for _ in range(20):
        if "GET /ping" in (ed.locator("textarea").input_value() or ""):
            break
        pg.wait_for_timeout(300)
    qk = ed.locator(".query-key").all_text_contents()
    check("proxy request editor: query keys tinted", qk == ["a", "foo", "baz"], str(qk))

    def editor_copy(label, expect, name):
        ed.locator("textarea").click(button="right")
        pg.wait_for_selector(".ctx-menu")
        pg.locator(".ctx-item", has_text=label).first.click()
        pg.wait_for_timeout(300)
        clip = clipboard()
        check(name, expect in clip and "/ping?a=bc&foo=bar&baz" in clip, clip[:120])

    editor_copy("Copy as Go", "net/http", "RawEditor: Copy as Go + URL")
    editor_copy("Copy as Python", "requests.get", "RawEditor: Copy as Python + URL")
    editor_copy("Copy as JavaScript", "await fetch", "RawEditor: Copy as JS + URL")

    # ---- proxy response pane: read-only RawView ----
    resp = pg.locator(".code-view").first  # the only code-view on the proxy page
    ck = resp.locator(".cookie-key").all_text_contents()
    check("response Set-Cookie keys tinted", any("sid" in k for k in ck), str(ck))
    jk = resp.locator(".json-key").all_text_contents()
    check("response JSON keys tinted", any("token" in k for k in jk), str(jk))
    resp.click(button="right")
    pg.wait_for_selector(".ctx-menu")
    pg.locator(".ctx-item", has_text="Copy as Python").first.click()
    pg.wait_for_timeout(300)
    check("RawView (response side): request code via flow", "requests.get" in clipboard() and "/ping?a=bc" in clipboard())
    pg.screenshot(path=f"{OUT}/hl_query_cookie.png")

    # ---- GlobalSearch preview: read-only REQUEST RawView ----
    pg.evaluate("window.dispatchEvent(new CustomEvent('pulse:open-search', { detail: { q: 'ping?a=bc' } }))")
    pg.wait_for_selector(".gsearch-hit", timeout=8000)
    pg.locator(".gsearch-hit").first.click()
    pg.wait_for_selector(".gsearch-preview .code-view", timeout=8000)
    pq = pg.locator(".gsearch-preview .code-view .query-key").all_text_contents()
    check("search preview: read-only request line query keys", pq == ["a", "foo", "baz"], str(pq))
    pg.locator(".gsearch-preview .code-view").first.click(button="right")
    pg.wait_for_selector(".gsearch-preview .ctx-menu")
    pg.locator(".gsearch-preview .ctx-item", has_text="Copy as Go").first.click()
    pg.wait_for_timeout(300)
    check("search preview: Copy as Go", "net/http" in clipboard() and "/ping?a=bc" in clipboard())
    pg.locator(".gsearch-win .decoder-head .icon-btn").last.click()
    pg.wait_for_timeout(300)

    # ---- FlowTable row menu ----
    row = pg.locator("table tbody tr").filter(has_text="/ping").first
    row.click(button="right")
    pg.wait_for_selector(".ctx-menu")
    items_txt = pg.locator(".ctx-item").all_text_contents()
    check("flow row menu has all four code entries",
          all(any(x in i for i in items_txt) for x in ["cURL", "Go", "Python", "JavaScript"]), str(items_txt))
    pg.locator(".ctx-item", has_text="Copy as Python").first.click()
    pg.wait_for_timeout(400)
    check("FlowTable: Copy as Python", "requests.get" in clipboard() and "/ping?a=bc" in clipboard())

    # ---- Repeater: tab with the ping request ----
    row.click(button="right")
    pg.wait_for_selector(".ctx-menu")
    pg.locator(".ctx-item", has_text="Send to Repeater").first.click()
    pg.wait_for_timeout(1000)
    pg.evaluate("location.hash = '#/repeater'")
    pg.wait_for_timeout(1200)
    tab = pg.locator(".side-item").filter(has_text="ping").last
    tab.click()
    pg.wait_for_selector(".raw-edit-stack textarea", timeout=8000)
    for _ in range(20):
        if "GET /ping" in (pg.locator(".raw-edit-stack textarea").input_value() or ""):
            break
        pg.wait_for_timeout(300)
    rq = pg.locator(".raw-edit-stack .query-key").all_text_contents()
    check("Repeater editor: query keys tinted", rq == ["a", "foo", "baz"], str(rq))

    b.close()

up.shutdown()
print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    raise SystemExit("FAILED: " + ", ".join(FAIL))
