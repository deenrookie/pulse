# Full footer strip at linear + hover state of the x button.
from playwright.sync_api import sync_playwright

CHROME = "C:/Users/Deen/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe"
OUT = "C:/Users/Deen/Documents/GitHub/pulse/gui-test-screenshots"

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME)
    pg = b.new_page(viewport={"width": 1440, "height": 800}, device_scale_factor=2)
    pg.goto("http://127.0.0.1:5175", wait_until="networkidle")
    pg.evaluate("localStorage.setItem('pulse.search.history', JSON.stringify(['intercept','curl']))")
    pg.evaluate("localStorage.setItem('pulse.theme', 'linear')")
    pg.reload(wait_until="networkidle")
    pg.wait_for_selector(".foot-search-tab", timeout=8000)
    foot = pg.locator(".foot-search-tab").first.bounding_box()
    pg.screenshot(path=f"{OUT}/x_footer_full_linear.png", clip={"x": 340, "y": foot["y"] - 8, "width": 640, "height": foot["height"] + 16})
    pg.locator(".foot-search-tab .tab-x").first.hover()
    pg.wait_for_timeout(200)
    pg.locator(".foot-search-tab").first.screenshot(path=f"{OUT}/x_hover_linear.png")
    print("done")
    b.close()
