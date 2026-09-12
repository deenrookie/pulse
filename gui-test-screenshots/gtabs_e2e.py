# E2E for the tab<->window linkage goal:
#   1) footer tab x closes its search window too
#   2) one top-entry window owns ONE footer tab — re-searching renames it
#   3) the focused window's footer tab shows the active highlight (glow)
import time

from playwright.sync_api import sync_playwright

DEV = "http://127.0.0.1:5175"
CHROME = "C:/Users/Deen/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe"
OUT = "C:/Users/Deen/Documents/GitHub/pulse/gui-test-screenshots"
PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if extra and not cond else ""))


with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME)
    pg = b.new_page(viewport={"width": 1500, "height": 900})
    pg.goto(DEV, wait_until="networkidle")
    pg.evaluate("localStorage.clear()")
    pg.evaluate("localStorage.setItem('pulse.theme', 'linear')")
    pg.reload(wait_until="networkidle")

    def tabs():
        return pg.locator(".foot-search-tab .kw").all_text_contents()

    def win(kw=None):
        loc = pg.locator(".gsearch-win")
        if kw:
            loc = loc.filter(has=pg.locator(".decoder-head .faint", has_text=kw))
        return loc

    def open_top():
        pg.evaluate("window.dispatchEvent(new CustomEvent('pulse:open-search'))")
        pg.wait_for_selector(".gsearch-win", timeout=5000)
        return pg.locator(".gsearch-bar input.input").last

    # ---- req 2: one window, one tab; re-search renames ----
    inp = open_top()
    inp.fill("ZKWA")
    with pg.expect_response(lambda r: "/api/search" in r.url, timeout=8000):
        inp.press("Enter")
    pg.wait_for_timeout(200)
    check("first search creates one tab", tabs() == ["ZKWA"], str(tabs()))
    inp.fill("ZKWB")
    with pg.expect_response(lambda r: "/api/search" in r.url, timeout=8000):
        inp.press("Enter")
    pg.wait_for_timeout(200)
    check("re-search renames the tab (no new one)", tabs() == ["ZKWB"], str(tabs()))
    # window keyword identity followed the rename
    check("window identity followed rename", win("ZKWB").count() == 1)

    # a second top window creates its own single tab
    inp2 = open_top()
    inp2.fill("ZKWD")
    with pg.expect_response(lambda r: "/api/search" in r.url, timeout=8000):
        inp2.press("Enter")
    pg.wait_for_timeout(200)
    check("second window gets its own tab", sorted(tabs()) == ["ZKWB", "ZKWD"], str(tabs()))

    # ---- req 3: focused window highlights its tab ----
    win("ZKWB").locator(".decoder-head").first.click()  # focus the ZKWB window
    pg.wait_for_timeout(250)
    active = pg.locator(".foot-search-tab.active .kw")
    check("focused window's tab is active", active.count() == 1 and active.first.text_content() == "ZKWB",
          f"active={active.all_text_contents() if active.count() else None}")
    shadow = pg.locator(".foot-search-tab.active").first.evaluate("el => getComputedStyle(el).boxShadow")
    check("active tab has visible glow", shadow != "none" and shadow != "", shadow)
    pg.screenshot(path=f"{OUT}/gtabs_active.png")

    # focus the other window: it sits underneath, only its cascade-offset
    # bottom/right edge is exposed — click that corner to raise it
    box = win("ZKWD").first.bounding_box()
    pg.mouse.click(box["x"] + box["width"] - 8, box["y"] + box["height"] - 8)
    pg.wait_for_timeout(250)
    active = pg.locator(".foot-search-tab.active .kw")
    check("focus moves, highlight follows", active.count() == 1 and active.first.text_content() == "ZKWD",
          f"active={active.all_text_contents() if active.count() else None}")

    # ---- req 1: closing a footer tab closes its window ----
    before = pg.locator(".gsearch-win").count()
    pg.locator(".foot-search-tab").filter(has=pg.locator(".kw", has_text="ZKWB")).locator(".tab-x").click()
    pg.wait_for_timeout(300)
    check("tab x closes its window", pg.locator(".gsearch-win").count() == before - 1,
          f"{before} -> {pg.locator('.gsearch-win').count()}")
    check("closed window's keyword remains gone", win("ZKWB").count() == 0)
    check("other window survives", win("ZKWD").count() == 1)

    # window close (x in header) keeps the tab for later reopening
    win("ZKWD").locator(".decoder-head .icon-btn").last.click()
    pg.wait_for_timeout(200)
    check("window close keeps the tab", "ZKWD" in tabs(), str(tabs()))
    check("all windows closed", pg.locator(".gsearch-win").count() == 0)
    check("no tab stays active without windows", pg.locator(".foot-search-tab.active").count() == 0)

    # reopening from the renamed tab works and restores identity
    pg.get_by_role("button", name="ZKWD", exact=True).click()
    pg.wait_for_selector(".gsearch-win", timeout=5000)
    check("reopen from renamed tab", win("ZKWD").count() == 1)

    b.close()

print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    raise SystemExit("FAILED: " + ", ".join(FAIL))
