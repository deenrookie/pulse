# Verify the three fixes and audit layout at MacBook 14" (1512x982) and
# 16" (1728x1117) effective resolutions:
#   1) "All methods" select wide enough (no clipped text)
#   2) highlight-rule rows: equal selects, nothing squeezed; blank rules are
#      not counted and are pruned on close
#   3) every view fits horizontally at both sizes
from playwright.sync_api import sync_playwright

DEV = "http://127.0.0.1:5175"
CHROME = "C:/Users/Deen/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe"
OUT = "C:/Users/Deen/Documents/GitHub/pulse/gui-test-screenshots"
VIEWS = ["proxy", "intercept", "repeater", "intruder", "sitemap", "extensions", "settings"]
SIZES = {"mb14": (1512, 982), "mb16": (1728, 1117)}
PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if extra and not cond else ""))


with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME)

    # ---- functional checks at 14" size ----
    pg = b.new_page(viewport={"width": 1512, "height": 982})
    pg.goto(DEV + "/#/proxy", wait_until="networkidle")
    pg.evaluate("localStorage.setItem('pulse.theme', 'linear')")
    pg.reload(wait_until="networkidle")

    sel = pg.locator(".select.method-select")
    w = sel.evaluate("el => el.getBoundingClientRect().width")
    fits = sel.evaluate("el => el.scrollWidth <= el.clientWidth + 1")
    check("method select >= 136px wide", w >= 136, f"w={w}")
    check("method select text fits (All methods)", fits)
    pg.locator(".select.method-select").screenshot(path=f"{OUT}/fix_method_select.png")

    # highlights modal
    pg.get_by_role("button", name="Highlights").click()
    pg.wait_for_selector(".highlights-modal")
    modal_w = pg.locator(".highlights-modal").evaluate("el => el.getBoundingClientRect().width")
    check("highlights modal is ~560px (post-animation)", 545 <= modal_w <= 570, f"w={modal_w}")
    pg.get_by_role("button", name="Add rule").click()
    pg.wait_for_selector(".highlights-modal .rule-row")
    cols = pg.locator(".highlights-modal .rule-row").first.evaluate(
        """el => {
      const kids = [...el.children].filter(c => c.tagName === 'SELECT')
      return kids.map(c => ({ text: c.value, w: Math.round(c.getBoundingClientRect().width) }))
    }"""
    )
    check("rule selects each >= 80px", all(c["w"] >= 80 for c in cols), str(cols))
    # blank row: Add again focuses it instead of adding a second
    pg.get_by_role("button", name="Add rule").click()
    pg.wait_for_timeout(150)
    check("Add rule with a blank row focuses it (no second row)",
          pg.locator(".highlights-modal .rule-row").count() == 1)
    # type a match, badge shows 1
    pg.locator(".highlights-modal .rule-row input.mini").fill("api.")
    pg.get_by_role("button", name="Close", exact=True).click()
    pg.wait_for_selector(".highlights-modal", state="detached")
    badge = pg.locator(".toolbar .badge").all_text_contents()
    check("badge counts the filled rule", badge == ["1"], str(badge))
    # reopen, clear the match, close -> rule pruned, badge gone
    pg.get_by_role("button", name="Highlights").click()
    pg.wait_for_selector(".highlights-modal")
    pg.locator(".highlights-modal .rule-row input.mini").fill("")
    pg.get_by_role("button", name="Close", exact=True).click()
    pg.wait_for_selector(".highlights-modal", state="detached")
    check("blank rule pruned on close (no badge, no primary)",
          pg.locator(".toolbar .badge").count() == 0)
    stored = pg.evaluate("JSON.parse(localStorage.getItem('pulse.highlights') || '[]')")
    check("localStorage holds no blank rules", all(r["match"].strip() for r in stored), str(stored))
    pg.screenshot(path=f"{OUT}/fix_proxy_mb14.png")

    # ---- responsive audit: horizontal overflow per view per size ----
    for label, (w, h) in SIZES.items():
        vp = b.new_page(viewport={"width": w, "height": h})
        vp.goto(DEV + "/#/proxy", wait_until="networkidle")
        vp.evaluate("localStorage.setItem('pulse.theme', 'linear')")
        for v in VIEWS:
            vp.goto(f"{DEV}/#/{v}", wait_until="networkidle")
            vp.wait_for_timeout(250)
            overflow = vp.evaluate(
                "() => document.documentElement.scrollWidth - document.documentElement.clientWidth"
            )
            check(f"[{label}] {v} no horizontal overflow", overflow <= 1, f"overflow={overflow}px")
        vp.screenshot(path=f"{OUT}/audit_{label}_proxy.png")
        vp.close()

    pg.close()
    b.close()

print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    raise SystemExit("FAILED: " + ", ".join(FAIL))
