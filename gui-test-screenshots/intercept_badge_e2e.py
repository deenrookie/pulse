# Bug fix E2E: "Send to Repeater" on the Intercept page must refresh the
# Repeater badge in the nav rail.
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


def repeater_count():
    with urllib.request.urlopen(API + "/api/repeater") as r:
        return len(json.load(r)["tabs"])


# hold one request through the intercept queue
api("PUT", "/api/intercept", {"enabled": True})
tunnel = threading.Thread(
    target=lambda: urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": "http://127.0.0.1:8080"})
    ).open(UP + "/held?a=1", timeout=15).read(), daemon=True)
tunnel.start()
time.sleep(1.5)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME)
    pg = b.new_page(viewport={"width": 1500, "height": 900})
    pg.goto(DEV + "/#/intercept", wait_until="networkidle")
    pg.wait_for_selector(".rail-badge", timeout=8000)

    rail_rep = pg.locator(".rail-item").filter(has_text="Repeater")
    badge_before = int(rail_rep.locator(".rail-badge").text_content() or "0")
    tabs_before = repeater_count()

    # select the held request and send it
    pg.locator(".side-item, tr, .held-row").filter(has_text="/held").first.click()
    pg.wait_for_timeout(300)
    pg.get_by_role("button", name="Send to Repeater").first.click()
    pg.wait_for_timeout(900)

    badge_after = int(rail_rep.locator(".rail-badge").text_content() or "0")
    tabs_after = repeater_count()
    check("repeater tab created", tabs_after == tabs_before + 1, f"{tabs_before} -> {tabs_after}")
    check("rail badge updated immediately", badge_after == badge_before + 1,
          f"{badge_before} -> {badge_after}")

    api("PUT", "/api/intercept", {"enabled": False})
    b.close()

up.shutdown()
tunnel.join(timeout=1)
print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    raise SystemExit("FAILED: " + ", ".join(FAIL))
