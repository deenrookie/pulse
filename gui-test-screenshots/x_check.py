# Footer search-history tab x-visibility check across themes (dev 5175).
# Seeds two history entries, screenshots the footer strip per theme, and
# dumps the computed style of the x button for an audit trail.
import json
from playwright.sync_api import sync_playwright

OUT = "C:/Users/Deen/Documents/GitHub/pulse/gui-test-screenshots"
THEMES = ["linear", "warm", "midnight"]

with sync_playwright() as p:
    b = p.chromium.launch(
        executable_path="C:/Users/Deen/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe"
    )
    pg = b.new_page(viewport={"width": 1440, "height": 800}, device_scale_factor=2)
    pg.goto("http://127.0.0.1:5175", wait_until="networkidle")
    pg.evaluate("localStorage.setItem('pulse.search.history', JSON.stringify(['intercept','curl']))")
    for t in THEMES:
        pg.evaluate(f"localStorage.setItem('pulse.theme', '{t}')")
        pg.reload(wait_until="networkidle")
        pg.wait_for_selector(".foot-search-tab", timeout=8000)
        tab = pg.locator(".foot-search-tab").first
        x = pg.locator(".foot-search-tab .tab-x").first
        cs = x.evaluate("el => { const s = getComputedStyle(el); return { color: s.color, bg: s.backgroundColor } }")
        box = tab.bounding_box()
        pg.screenshot(
            path=f"{OUT}/x_visibility_{t}.png",
            clip={"x": max(0, box["x"] - 24), "y": box["y"] - 6, "width": min(560, 1440 - box["x"]), "height": box["height"] + 12},
        )
        print(t, json.dumps(cs))
    b.close()
