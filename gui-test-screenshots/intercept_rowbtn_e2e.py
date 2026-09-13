# E2E: Intercept request column matches the response column —
#   1) Forward all / Drop all live in the panel head, always rendered
#      (disabled with nothing held)
#   2) every held row has forward/drop icon buttons that work
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


class Up(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *a):
        pass


up = HTTPServer(("127.0.0.1", 0), Up)
threading.Thread(target=up.serve_forever, daemon=True).start()
UP = f"http://127.0.0.1:{up.server_address[1]}"


def api(method, path, body=None):
    req = urllib.request.Request(API + path, method=method,
                                 data=json.dumps(body).encode() if body else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def pending_count():
    return len(api("GET", "/api/intercept")["pending"])


def hold_n(n):
    ts = []
    for i in range(n):
        t = threading.Thread(target=lambda i=i: urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": "http://127.0.0.1:8080"})
        ).open(UP + f"/x?a={i}", timeout=20).read())
        t.start()
        ts.append(t)
    deadline = time.time() + 6
    while time.time() < deadline and pending_count() < n:
        time.sleep(0.1)
    return ts


with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME)
    pg = b.new_page(viewport={"width": 1500, "height": 900})
    api("PUT", "/api/intercept", {"enabled": True})
    pg.goto(DEV + "/#/intercept", wait_until="networkidle")
    pg.wait_for_timeout(600)

    # buttons always present in the request panel head, disabled when empty
    head = pg.locator(".panel").filter(has=pg.locator(".panel-head .title", has_text="Held requests")).first
    fwd = head.locator(".panel-head button", has_text="Forward all")
    drop = head.locator(".panel-head button", has_text="Drop all")
    check("head buttons always rendered", fwd.count() == 1 and drop.count() == 1)
    check("disabled with nothing held", fwd.is_disabled() and drop.is_disabled())
    check("drop styled danger like the response column", "danger" in (drop.get_attribute("class") or ""))
    pg.screenshot(path=f"{OUT}/intercept_head_buttons.png")

    # rows have the two icon actions
    ts = hold_n(3)
    pg.wait_for_selector(".side-item .icon-btn", timeout=8000)
    row0 = pg.locator(".side-item").first
    check("row has forward + drop icons", row0.locator(".icon-btn").count() == 2)

    # drop one row via its x icon (confirm not needed per-row)
    row0.locator(".icon-btn.danger, .btn.danger").first.click()
    pg.wait_for_timeout(900)
    check("row drop icon drops that request", pending_count() == 2, f"pending={pending_count()}")

    # forward one row via its check icon
    pg.locator(".side-item").first.locator(".icon-btn").first.click()
    pg.wait_for_timeout(900)
    check("row forward icon releases that request", pending_count() == 1, f"pending={pending_count()}")

    # head Forward all releases the rest
    fwd.click()
    for t in ts:
        t.join(timeout=10)
    time.sleep(0.5)
    check("head Forward all clears the queue", pending_count() == 0, f"pending={pending_count()}")

    # head Drop all still confirms and clears
    ts = hold_n(2)
    pg.wait_for_selector(".side-item", timeout=8000)
    head_drop = pg.locator(".panel-head button", has_text="Drop all").first
    head_drop.click()
    pg.wait_for_selector(".modal[role='alertdialog']")
    pg.get_by_role("button", name="Drop all").last.click()
    pg.wait_for_timeout(1000)
    check("head Drop all clears the queue", pending_count() == 0, f"pending={pending_count()}")

    api("PUT", "/api/intercept", {"enabled": False})
    b.close()

up.shutdown()
print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    raise SystemExit("FAILED: " + ", ".join(FAIL))
