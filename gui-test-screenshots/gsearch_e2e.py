# E2E for the two search goals:
#   1) Burp-style options (side / case / regex) actually filter results
#   2) reopening a search from a footer history tab restores the last-
#      selected hit (selected row + preview)
# Seeds marker flows through the real dev proxy (8080) first.
import json
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

from playwright.sync_api import sync_playwright

DEV = "http://127.0.0.1:5175"
PROXY = "http://127.0.0.1:8080"
CHROME = "C:/Users/Deen/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe"
OUT = "C:/Users/Deen/Documents/GitHub/pulse/gui-test-screenshots"
PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if extra and not cond else ""))


class Up(BaseHTTPRequestHandler):
    def do_GET(self):
        body = {
            "/both": b"echo BOTHMARK in the response body",
            "/responly": b"the secret is RESPONLYMARK here",
            "/case": b"mixed CaseSenTest token",
        }.get(self.path.split("?")[0], b"ok")
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


up = HTTPServer(("127.0.0.1", 0), Up)
threading.Thread(target=up.serve_forever, daemon=True).start()
UP = f"http://127.0.0.1:{up.server_address[1]}"

opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": PROXY}))
for path in ["/both?q=BOTHMARK", "/responly", "/reqonly?find=REQONLYMARK", "/case"]:
    opener.open(UP + path, timeout=10).read()

# wait until the API sees all four flows
import time

for _ in range(50):
    with urllib.request.urlopen("http://127.0.0.1:8000/api/flows") as r:
        if len(json.load(r).get("items", [])) >= 4:
            break
    time.sleep(0.1)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME)
    pg = b.new_page(viewport={"width": 1500, "height": 900})
    pg.goto(DEV, wait_until="networkidle")
    pg.evaluate("localStorage.clear()")
    pg.evaluate("localStorage.setItem('pulse.theme', 'linear')")
    pg.reload(wait_until="networkidle")

    # --- open the top-entry search window ---
    pg.evaluate("window.dispatchEvent(new CustomEvent('pulse:open-search'))")
    pg.wait_for_selector(".gsearch-win", timeout=5000)
    inp = pg.locator(".gsearch-bar input.input")

    def run_search(text):
        inp.fill(text)
        with pg.expect_response(lambda r: "/api/search" in r.url, timeout=8000):
            inp.press("Enter")
        pg.wait_for_timeout(150)  # let the results DOM settle

    def side_tags():
        return pg.locator(".gsearch-hit .side-tag").all_text_contents()

    def opt(label):
        pg.locator(".gsearch-opts .mini.opt", has_text=label).first.click()

    # A. default: both sides
    run_search("BOTHMARK")
    check("default search hits side=both", "both" in side_tags(), str(side_tags()))

    # B. side=request
    opt("Req")
    run_search("BOTHMARK")
    tags = side_tags()
    check("side=request filters to request", tags and all(t == "request" for t in tags), str(tags))

    # C. side=response
    opt("Resp")
    run_search("BOTHMARK")
    tags = side_tags()
    check("side=response filters to response", tags and all(t == "response" for t in tags), str(tags))

    # D. request-only marker invisible under side=response
    run_search("REQONLYMARK")
    check("REQONLYMARK hidden under side=response", "No match" in (pg.locator(".gsearch-results .gsearch-empty").text_content() or ""))

    # E. case sensitivity
    opt("All")
    opt("Aa")
    run_search("casesentest")
    check("cs=1 lowercase finds nothing", "No match" in (pg.locator(".gsearch-results .gsearch-empty").text_content() or ""))
    run_search("CaseSenTest")
    check("cs=1 exact case finds the flow", pg.locator(".gsearch-hit").count() >= 1)
    opt("Aa")

    # F. regex mode
    opt(".*")
    run_search("(RESP|REQ)ONLYMARK")
    check("regex alternation finds the marker flows", pg.locator(".gsearch-hit").count() >= 2)
    run_search("[")
    check("invalid regex shows error", "failed" in (pg.locator(".gsearch-results .gsearch-empty").text_content() or ""))
    opt(".*")

    pg.screenshot(path=f"{OUT}/gsearch_opts_bar.png", clip=pg.locator(".gsearch-bar").bounding_box())

    # G. last-selected restore: several hits, select the last, close, reopen from footer
    run_search("ONLYMARK")
    hits = pg.locator(".gsearch-hit")
    check("ONLYMARK finds the marker flows", hits.count() >= 2, str(hits.count()))
    last = hits.count() - 1
    hits.nth(last).click()
    pg.wait_for_selector(".gs-preview-head", timeout=5000)
    second_key = hits.nth(last).get_attribute("data-key")
    check("clicking a hit opens preview", pg.locator(".gs-preview-head").is_visible())
    pg.locator(".decoder-head .icon-btn", has_text="").last.click()  # window close (x)
    pg.wait_for_selector(".gsearch-win", state="detached", timeout=5000)

    # footer tab for ONLYMARK was created by this top-entry window (tracksHistory)
    tab = pg.get_by_role("button", name="ONLYMARK", exact=True)
    check("footer history tab exists", tab.count() == 1)
    tab.click()
    pg.wait_for_selector(".gsearch-win", timeout=5000)
    pg.wait_for_selector(".gsearch-hit", timeout=8000)
    sel = pg.locator(".gsearch-hit.selected")
    check("reopen restores selection", sel.count() == 1 and sel.first.get_attribute("data-key") == second_key,
          f"sel={sel.first.get_attribute('data-key') if sel.count() else None} want={second_key}")
    check("reopen restores preview", pg.locator(".gs-preview-head").is_visible())

    pg.screenshot(path=f"{OUT}/gsearch_restored.png")
    b.close()

up.shutdown()
print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    raise SystemExit("FAILED: " + ", ".join(FAIL))
