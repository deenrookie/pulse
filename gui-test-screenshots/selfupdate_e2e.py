# REAL self-update E2E against the production 8787 instance:
# 0.3.2 → check → upgrade (downloads the actual v0.3.3 release from GitHub)
# → restart → the page reconnects and shows 0.3.3.
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8787"
CHROME = "C:/Users/Deen/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe"
OUT = "C:/Users/Deen/Documents/GitHub/pulse/gui-test-screenshots"
PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if extra and not cond else ""))


with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME)
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    pg.goto(BASE + "/#/settings", wait_until="networkidle")
    pg.wait_for_selector(".update-row .mono")

    ver = pg.locator(".update-row .mono").text_content()
    check("settings shows current version", ver and "0.3.2" in ver, ver)

    pg.get_by_role("button", name="Check for updates").click()
    pg.wait_for_selector(".update-banner", timeout=30000)
    banner = pg.locator(".update-banner").first.text_content()
    check("release v0.3.3 detected as newer", banner and "0.3.3" in banner and "available" in banner, banner)
    pg.screenshot(path=f"{OUT}/update_available.png")

    pg.get_by_role("button", name="Upgrade to v0.3.3").click()
    pg.wait_for_selector("text=downloaded and swapped", timeout=180000)
    check("upgrade downloaded and swapped", True)
    pg.screenshot(path=f"{OUT}/update_applied.png")

    pg.get_by_role("button", name="Restart now").click()
    # the page polls /api/status and reloads on its own
    pg.wait_for_url("**/#/settings", timeout=45000)
    pg.wait_for_selector(".update-row .mono", timeout=45000)
    pg.wait_for_function(
        "() => { const v = document.querySelector('.update-row .mono'); return v && v.textContent.includes('0.3.3') }",
        timeout=30000,
    )
    check("after restart the backend runs 0.3.3", True)
    pg.screenshot(path=f"{OUT}/update_done.png")

    # a fresh check now reports up-to-date
    pg.get_by_role("button", name="Check for updates").click()
    pg.wait_for_selector(".update-banner", timeout=30000)
    up = pg.locator(".update-banner").first.text_content()
    check("post-update check says up to date", up and "Up to date" in up, up)

    b.close()

print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    raise SystemExit("FAILED: " + ", ".join(FAIL))
