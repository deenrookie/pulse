# E2E: a gzip-encoded held response is shown DECODED in the intercept
# editor, and after editing + Forward the client receives valid gzip whose
# decompressed content is the edited text (auto re-encode, like the
# request side's auto Content-Length).
import gzip
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


PLAIN = b"the original gzip payload lives here"

class Up(BaseHTTPRequestHandler):
    def do_GET(self):
        gz = gzip.compress(PLAIN)
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(gz)))
        self.end_headers()
        self.wfile.write(gz)

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

client = {}


def browse():
    try:
        # explicit Accept-Encoding so urllib does NOT transparently decompress
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": "http://127.0.0.1:8080"}))
        req = urllib.request.Request(UP + "/gz", headers={"Accept-Encoding": "gzip"})
        r = opener.open(req, timeout=25)
        client["status"] = r.status
        client["ce"] = r.headers.get("Content-Encoding")
        client["raw"] = r.read()
    except Exception as e:
        client["err"] = str(e)


t = threading.Thread(target=browse)
t.start()

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME)
    pg = b.new_page(viewport={"width": 1500, "height": 900})
    pg.goto(DEV + "/#/intercept", wait_until="networkidle")

    for _ in range(50):
        if len(api("GET", "/api/intercept").get("pendingResp", [])) > 0:
            break
        time.sleep(0.1)
    pg.locator(".resp-hold-row").first.wait_for(timeout=8000)
    pg.locator(".resp-hold-row").first.click()
    pg.wait_for_selector(".raw-edit-stack textarea", timeout=8000)
    pg.wait_for_timeout(600)  # decode settles

    ta = pg.locator(".raw-edit-stack textarea").first
    raw = ta.input_value()
    check("editor shows the DECODED plain body", PLAIN.decode() in raw, raw[-80:])
    check("Content-Encoding header still visible in raw", "Content-Encoding: gzip" in raw)

    ta.fill(raw.replace(PLAIN.decode(), "EDITED gzip payload"))
    pg.wait_for_timeout(300)
    pg.screenshot(path=f"{OUT}/intercept_resp_gzip_edit.png")
    pg.locator('button[title="Forward this response to the client"]').click()
    t.join(timeout=20)

    check("client got 200", client.get("status") == 200, str(client.get("status")))
    check("client Content-Encoding stays gzip", client.get("ce") == "gzip", str(client.get("ce")))
    try:
        plain = gzip.decompress(client.get("raw", b"")).decode()
    except Exception as e:
        plain = f"<not gzip: {e}>"
    check("client body decompresses to the edited text", plain == "EDITED gzip payload", plain[:80])

    api("PUT", "/api/intercept", {"respEnabled": False})
    b.close()

up.shutdown()
print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    raise SystemExit("FAILED: " + ", ".join(FAIL))
