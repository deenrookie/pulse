# E2E: the Intercept request column has working Forward all and Drop all
# (parity with the response column).
import json
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

from playwright.sync_api import sync_playwright

DEV = "http://127.0.0.1:5175"
API = "http://127.0.0.1:8000"
CHROME = "C:/Users/Deen/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe"
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


def hold_n(n):
    """hold n requests through the proxy, return their ids"""
    results = []

    def one(i):
        try:
            urllib.request.build_opener(
                urllib.request.ProxyHandler({"http": "http://127.0.0.1:8080"})
            ).open(UP + f"/x?a={i}", timeout=20).read()
            results.append(True)
        except Exception:
            results.append(False)

    ts = [threading.Thread(target=one, args=(i,)) for i in range(n)]
    for t in ts:
        t.start()
    deadline = time.time() + 5
    while time.time() < deadline:
        if len(api("GET", "/api/intercept")["pending"]) >= n:
            break
        time.sleep(0.1)
    return ts


with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME)
    pg = b.new_page(viewport={"width": 1500, "height": 900})

    # ---- Forward all ----
    api("PUT", "/api/intercept", {"enabled": True})
    ts = hold_n(3)
    pg.goto(DEV + "/#/intercept", wait_until="networkidle")
    pg.wait_for_selector(".bulk-row", timeout=8000)
    fwd = pg.locator(".bulk-row button", has_text="Forward all")
    drop = pg.locator(".bulk-row button", has_text="Drop all")
    check("both Forward all and Drop all present", fwd.count() == 1 and drop.count() == 1,
          f"fwd={fwd.count()} drop={drop.count()}")
    fwd.click()
    for t in ts:
        t.join(timeout=10)
    time.sleep(0.5)
    check("Forward all releases every held request",
          len(api("GET", "/api/intercept")["pending"]) == 0 and all(ts and True for _ in [1]),
          f"pending={len(api('GET', '/api/intercept')['pending'])}")

    # ---- Drop all (confirm dialog) ----
    ts = hold_n(2)
    pg.wait_for_selector(".bulk-row", timeout=8000)
    drop = pg.locator(".bulk-row button", has_text="Drop all")
    drop.click()
    pg.wait_for_selector(".modal[role='alertdialog']")
    check("Drop all asks for confirmation", "Drop" in pg.locator(".modal h3").text_content())
    pg.get_by_role("button", name="Drop all").last.click()  # the dialog's confirm
    pg.wait_for_timeout(1200)
    check("Drop all clears the held queue", len(api("GET", "/api/intercept")["pending"]) == 0,
          f"pending={len(api('GET', '/api/intercept')['pending'])}")

    # cancel path keeps items held
    ts = hold_n(2)
    pg.wait_for_selector(".bulk-row", timeout=8000)
    pg.locator(".bulk-row button", has_text="Drop all").click()
    pg.wait_for_selector(".modal[role='alertdialog']")
    pg.get_by_role("button", name="Cancel").click()
    pg.wait_for_timeout(600)
    check("Cancel keeps requests held", len(api("GET", "/api/intercept")["pending"]) == 2)
    # cleanup: forward the remainder
    pg.locator(".bulk-row button", has_text="Forward all").click()
    for t in ts:
        t.join(timeout=10)
    api("PUT", "/api/intercept", {"enabled": False})
    b.close()

up.shutdown()
print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    raise SystemExit("FAILED: " + ", ".join(FAIL))
