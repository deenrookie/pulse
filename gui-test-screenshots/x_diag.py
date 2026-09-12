# Deep diagnostic: does the live page hold the new tab-x rule, and does
# the button actually paint? Dumps rule text from document.styleSheets,
# the button's box, and an element-level screenshot.
import json
from playwright.sync_api import sync_playwright

CHROME = "C:/Users/Deen/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe"
OUT = "C:/Users/Deen/Documents/GitHub/pulse/gui-test-screenshots"

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME)
    pg = b.new_page(viewport={"width": 1440, "height": 800}, device_scale_factor=2)
    pg.goto("http://127.0.0.1:5175", wait_until="networkidle")
    pg.evaluate("localStorage.setItem('pulse.search.history', JSON.stringify(['intercept','curl']))")
    pg.evaluate("document.documentElement.dataset.theme = 'linear'")
    pg.reload(wait_until="networkidle")
    pg.wait_for_selector(".foot-search-tab", timeout=8000)

    info = pg.evaluate(
        """() => {
      const x = document.querySelector('.foot-search-tab .tab-x')
      const r = x.getBoundingClientRect()
      const svg = x.querySelector('svg')
      const rules = []
      for (const sh of document.styleSheets) {
        let rs; try { rs = sh.cssRules } catch { continue }
        for (const rule of rs) {
          if (rule.cssText && rule.cssText.includes('.foot-search-tab .tab-x')) rules.push(rule.cssText)
        }
      }
      return {
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        offsetW: x.offsetWidth, offsetH: x.offsetHeight,
        svgSize: svg ? { w: svg.getBoundingClientRect().width, h: svg.getBoundingClientRect().height } : null,
        rules,
      }
    }"""
    )
    print(json.dumps(info, indent=1))

    net = pg.evaluate("fetch('/src/theme.css', {cache:'reload'}).then(r=>r.text()).then(t=>({new:t.includes('0.12)'), old:t.includes('0.08)')}))")
    print("network css:", net)

    pg.locator(".foot-search-tab").first.screenshot(path=f"{OUT}/x_elem_linear.png")
    b.close()
