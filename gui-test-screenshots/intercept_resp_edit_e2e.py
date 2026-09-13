# E2E: edit a held response in the Intercept UI and forward it — the client
# must receive the edited status line, headers and body.
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
        body = b"original body"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("X-Orig", "1")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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


api("PUT", "/api/intercept", {"respEnabled": True})

client_result = {}


def browse():
    try:
        r = urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": "http://127.0.0.1:8080"})
        ).open(UP + "/e2e", timeout=25)
        client_result["status"] = r.status
        client_result["body"] = r.read().decode()
        client_result["xedited"] = r.headers.get("X-Edited")
        client_result["xorig"] = r.headers.get("X-Orig")
    except urllib.error.HTTPError as h:
        client_result["status"] = h.code
        client_result["body"] = h.read().decode()
        client_result["xedited"] = h.headers.get("X-Edited")
        client_result["xorig"] = h.headers.get("X-Orig")
    except Exception as e:
        client_result["err"] = str(e)


t = threading.Thread(target=browse)
t.start()

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME)
    pg = b.new_page(viewport={"width": 1500, "height": 900})
    pg.goto(DEV + "/#/intercept", wait_until="networkidle")

    # the held response row appears in the Responses column
    for _ in range(50):
        if len(api("GET", "/api/intercept").get("pendingResp", [])) > 0:
            break
        time.sleep(0.1)
    row = pg.locator(".resp-hold-row").first
    row.wait_for(timeout=8000)
    row.click()
    pg.wait_for_selector(".raw-edit-stack textarea", timeout=8000)

    ta = pg.locator(".raw-edit-stack textarea").first
    raw = ta.input_value()
    check("editor shows the original response", "original body" in raw and "200" in raw, raw[:80])

    edited = raw.replace("200 OK", "418 I'm a teapot").replace("original body", "EDITED BODY")
    edited = edited.replace("X-Orig: 1", "X-Orig: 1\nX-Edited: yes")
    ta.fill(edited)
    pg.wait_for_timeout(300)
    pg.screenshot(path=f"{OUT}/intercept_resp_edit.png", clip={"x": 480, "y": 60, "width": 1000, "height": 780})

    # the status chip in the inspector head follows the edit
    head = pg.locator(".panel").filter(has=pg.locator(".panel-head .title", has_text="Response")).last
    check("inspector reflects edited status", "418" in (head.locator(".panel-head").text_content() or ""))

    pg.locator('button[title="Forward this response to the client"]').click()
    t.join(timeout=20)

    check("client received the edited status", client_result.get("status") == 418, str(client_result.get("status")))
    check("client received the edited body", client_result.get("body") == "EDITED BODY", str(client_result.get("body")))
    check("client received the added header", client_result.get("xedited") == "yes", str(client_result.get("xedited")))
    check("original headers kept as edited", client_result.get("xorig") == "1", str(client_result.get("xorig")))

    api("PUT", "/api/intercept", {"respEnabled": False})
    b.close()

up.shutdown()
print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    raise SystemExit("FAILED: " + ", ".join(FAIL))
