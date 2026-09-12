# Verify the thickened x: computed styles, element screenshots per theme,
# zoomed crops, and a WCAG contrast ratio computed from the actual computed
# colors (glyph vs tint-over-footer background).
import json
from PIL import Image
from playwright.sync_api import sync_playwright

CHROME = "C:/Users/Deen/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe"
OUT = "C:/Users/Deen/Documents/GitHub/pulse/gui-test-screenshots"
THEMES = ["linear", "warm", "midnight"]


def lum(rgb):
    def ch(c):
        c /= 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = rgb
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


def contrast(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def parse(c):
    return tuple(int(x) for x in c.replace("rgba", "rgb").strip("rgb() ").split(",")[:3])


with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME)
    pg = b.new_page(viewport={"width": 1440, "height": 800}, device_scale_factor=2)
    pg.goto("http://127.0.0.1:5175", wait_until="networkidle")
    pg.evaluate("localStorage.setItem('pulse.search.history', JSON.stringify(['intercept','curl']))")
    for t in THEMES:
        pg.evaluate(f"localStorage.setItem('pulse.theme', '{t}')")
        pg.reload(wait_until="networkidle")
        pg.wait_for_selector(".foot-search-tab", timeout=8000)
        d = pg.evaluate(
            """() => {
          const x = document.querySelector('.foot-search-tab .tab-x')
          const svg = x.querySelector('svg')
          const pill = x.closest('.foot-search-tab')
          const footerBg = getComputedStyle(pill.parentElement).backgroundColor
          const s = getComputedStyle(x)
          return { color: s.color, bg: s.backgroundColor, sw: getComputedStyle(svg).strokeWidth,
                   svgSize: svg.getBoundingClientRect().width, footerBg }
        }"""
        )
        fg, tintbg, footer = parse(d["color"]), parse(d["bg"]), parse(d["footerBg"])
        a = float(d["bg"].split(",")[-1].strip(") ")) if "rgba" in d["bg"] else 1.0
        block = tuple(round(a * tintbg[i] + (1 - a) * footer[i]) for i in range(3))
        print(t, json.dumps(d), "block=", block, "contrast= %.2f:1" % contrast(fg, block))
        pg.locator(".foot-search-tab").first.screenshot(path=f"{OUT}/x2_{t}.png")
    b.close()

for t in THEMES:
    img = Image.open(f"{OUT}/x2_{t}.png")
    crop = img.crop((img.width - 90, 0, img.width, img.height))
    crop = crop.resize((90 * 6, crop.height * 6), Image.NEAREST)
    crop.save(f"{OUT}/x2_zoom_{t}.png")
print("zooms saved")
