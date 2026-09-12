# E2E for the inspector-preview + repeater-actions goal:
#   1) the search preview renders the shared Request/Response inspector
#      (panel head, sub-tabs, raw search bar) instead of a plain <pre>
#   2) hits expose Send-to-Repeater via right-click menu AND the R shortcut;
#      arrows walk the selection
import json
import urllib.request

from playwright.sync_api import sync_playwright

DEV = "http://127.0.0.1:5175"
API = "http://127.0.0.1:8000"
CHROME = "C:/Users/Deen/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe"
OUT = "C:/Users/Deen/Documents/GitHub/pulse/gui-test-screenshots"
PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if extra and not cond else ""))


def repeater_count():
    with urllib.request.urlopen(API + "/api/repeater") as r:
        return len(json.load(r)["tabs"])


with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME)
    pg = b.new_page(viewport={"width": 1500, "height": 900})
    pg.goto(DEV, wait_until="networkidle")
    pg.evaluate("localStorage.clear()")
    pg.evaluate("localStorage.setItem('pulse.theme', 'linear')")
    pg.reload(wait_until="networkidle")

    pg.evaluate("window.dispatchEvent(new CustomEvent('pulse:open-search'))")
    pg.wait_for_selector(".gsearch-win")
    inp = pg.locator(".gsearch-bar input.input")
    inp.fill("BOTHMARK")
    with pg.expect_response(lambda r: "/api/search" in r.url, timeout=8000):
        inp.press("Enter")
    hits = pg.locator(".gsearch-hit")
    hits.first.click()
    pg.wait_for_selector(".gsearch-preview .panel-head", timeout=8000)

    # ---- req 1: shared inspector renders ----
    check("request inspector rendered", pg.locator(".gsearch-preview .panel-head .title").first.text_content() == "Request")
    check("inspector sub-tabs present", pg.locator(".gsearch-preview .panel-head").first.locator("button").count() >= 3)
    check("raw view has its own search bar", pg.locator(".gsearch-preview .raw-search").count() >= 1)
    pg.locator(".gs-preview-head .mini", has_text="response").click()
    pg.wait_for_timeout(300)
    check("side toggle switches to Response inspector",
          pg.locator(".gsearch-preview .panel-head .title").first.text_content() == "Response")
    pg.screenshot(path=f"{OUT}/gsearch_inspector_preview.png")

    # ---- req 2: arrows walk the selection ----
    inp.click()
    before = pg.locator(".gsearch-hit.selected").get_attribute("data-key")
    pg.keyboard.press("ArrowDown")
    pg.wait_for_timeout(400)
    after = pg.locator(".gsearch-hit.selected").get_attribute("data-key")
    check("ArrowDown moves the selection", before != after, f"{before} -> {after}")

    # ---- req 2: right-click menu sends to repeater ----
    n0 = repeater_count()
    hits.first.click(button="right")
    pg.wait_for_selector(".ctx-menu")
    items = pg.locator(".ctx-item").all_text_contents()
    check("context menu has Send to Repeater", any("Send to Repeater" in i for i in items), str(items))
    pg.locator(".ctx-item", has_text="Send to Repeater").click()
    pg.wait_for_timeout(600)
    check("menu send creates a repeater tab", repeater_count() == n0 + 1, f"{n0} -> {repeater_count()}")

    # ---- req 2: R shortcut on the selected hit ----
    hits.first.click()  # focus inside the window, row selected
    pg.keyboard.press("r")
    pg.wait_for_timeout(600)
    check("R shortcut creates another tab", repeater_count() == n0 + 2, f"{n0} -> {repeater_count()}")

    b.close()

print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    raise SystemExit("FAILED: " + ", ".join(FAIL))
