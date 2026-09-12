# E2E for the two refinements:
#   1) right-click INSIDE the preview's request/response view offers
#      "Send to Repeater" and it works
#   2) the results|preview split is draggable and persists across windows
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
    pg.locator(".gsearch-hit").first.click()
    pg.wait_for_selector(".gsearch-preview .panel-head", timeout=8000)

    # ---- req 1: right-click inside the REQUEST preview ----
    n0 = repeater_count()
    pg.locator(".gsearch-preview .code-view").first.click(button="right")
    pg.wait_for_selector(".gsearch-preview .ctx-menu")
    items = pg.locator(".gsearch-preview .ctx-item").all_text_contents()
    check("preview request menu has Send to Repeater", any("Send to Repeater" in i for i in items), str(items))
    pg.locator(".gsearch-preview .ctx-item", has_text="Send to Repeater").click()
    pg.wait_for_timeout(600)
    check("preview menu send creates a tab", repeater_count() == n0 + 1, f"{n0} -> {repeater_count()}")

    # same on the response side
    pg.locator(".gs-preview-head .mini", has_text="response").click()
    pg.wait_for_timeout(300)
    pg.locator(".gsearch-preview .code-view").first.click(button="right")
    pg.wait_for_selector(".gsearch-preview .ctx-menu")
    items = pg.locator(".gsearch-preview .ctx-item").all_text_contents()
    check("preview response menu has Send to Repeater", any("Send to Repeater" in i for i in items), str(items))
    pg.keyboard.press("Escape")

    # ---- req 2: drag the splitter ----
    split = pg.locator(".gsearch-main")
    box = split.bounding_box()
    results_before = pg.locator(".gsearch-results").bounding_box()["width"]
    mid_x = box["x"] + results_before
    sp = pg.locator(".gsearch-main .splitter")
    sp.hover()
    pg.mouse.down()
    pg.mouse.move(mid_x - 180, box["y"] + 100, steps=8)
    pg.mouse.up()
    pg.wait_for_timeout(300)
    results_after = pg.locator(".gsearch-results").bounding_box()["width"]
    check("splitter drag resizes the results pane", results_after < results_before - 100,
          f"{results_before:.0f} -> {results_after:.0f}")
    saved = pg.evaluate("localStorage.getItem('pulse.gsearch.split')")
    check("split fraction persisted", saved is not None and float(saved) < 0.42, str(saved))
    pg.screenshot(path=f"{OUT}/gsearch_split_resized.png")

    # persists into a fresh window after reload
    pg.reload(wait_until="networkidle")
    pg.evaluate("window.dispatchEvent(new CustomEvent('pulse:open-search', { detail: { q: 'BOTHMARK' } }))")
    pg.wait_for_selector(".gsearch-results .gsearch-hit", timeout=8000)
    again = pg.locator(".gsearch-results").bounding_box()["width"]
    check("split persists across windows", abs(again - results_after) < 4, f"{results_after:.0f} vs {again:.0f}")

    b.close()

print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    raise SystemExit("FAILED: " + ", ".join(FAIL))
