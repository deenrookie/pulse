# E2E for the R0 plugin-reliability work: draft autosave/restore, stale test
# results, last-good-revision fallback, separated counters, accurate save
# status, and undo/redo in the editor.
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


GOOD = 'plugin = { name: "R0 E2E", version: "1.0" };\nfunction onRequest(ctx) { ctx.request.headers.push({ name: "X-R0", value: "on" }); }'


def api(method, path, body=None):
    req = urllib.request.Request(API + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)


with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME)
    ctx = b.new_context(viewport={"width": 1400, "height": 900})
    pg = ctx.new_page()
    pg.goto(DEV + "/#/extensions?tab=plugins", wait_until="networkidle")
    pg.wait_for_selector(".ext-tab", timeout=8000)

    # ---- editor open + type (draft materializes) ----
    pg.evaluate("localStorage.clear()")
    pg.reload(wait_until="networkidle")
    pg.wait_for_selector(".subtab", timeout=8000)
    api("PUT", "/api/plugins/source/r0-e2e.js", {"src": GOOD})
    pg.reload(wait_until="networkidle")
    pg.wait_for_selector(".plugin-card", timeout=8000)

    pg.locator(".plugin-card", has_text="R0 E2E").locator("button", has_text="Edit").click()
    pg.wait_for_selector(".plugin-editor .cm-content", timeout=8000)
    editor = pg.locator(".plugin-editor .cm-content").first
    editor.click()
    pg.keyboard.press("Control+a")
    pg.keyboard.type('plugin = { name: "R0 Draft", version: "1.0" }; // DRAFT MARKER\n' + GOOD)
    pg.wait_for_timeout(900)  # draft debounce 500ms
    drafts = pg.evaluate("JSON.parse(localStorage.getItem('pulse.plugin.drafts') || '{}')")
    check("draft autosaved to localStorage", drafts.get("r0-e2e.js", "").find("DRAFT MARKER") >= 0, str(list(drafts)))

    # ---- navigate away and back: draft restored ----
    pg.locator(".rail-item", has_text="Live Traffic").click()
    pg.wait_for_timeout(600)
    pg.locator(".rail-item", has_text="Extensions").click()
    pg.wait_for_timeout(300)
    pg.locator(".subtab", has_text="Installed").click()
    pg.wait_for_selector(".plugin-card", timeout=15000)
    pg.locator(".plugin-card", has_text="R0 E2E").locator("button", has_text="Edit").click()
    pg.wait_for_selector(".plugin-editor .cm-content", timeout=8000)
    pg.wait_for_timeout(300)
    check("draft restored after navigation", "DRAFT MARKER" in (pg.locator(".plugin-editor .cm-content").first.text_content() or ""))

    # ---- undo/redo history ----
    editor = pg.locator(".plugin-editor .cm-content").first
    editor.click()
    pg.keyboard.type("// UNDO ME")
    pg.wait_for_timeout(200)
    pg.keyboard.press("Control+z")
    pg.wait_for_timeout(200)
    body_text = pg.locator(".plugin-editor .cm-content").first.text_content() or ""
    check("undo removes the typed text", "UNDO ME" not in body_text, body_text[-60:])
    pg.keyboard.press("Control+y")
    pg.wait_for_timeout(200)
    body_text = pg.locator(".plugin-editor .cm-content").first.text_content() or ""
    check("redo re-applies it", "UNDO ME" in body_text, body_text[-60:])

    # ---- stale test result marking ----
    pg.locator(".plugin-editor .cm-content").first.click()
    pg.keyboard.press("Control+a")
    pg.keyboard.type(GOOD)  # clean source, no marker
    pg.wait_for_timeout(200)
    pg.locator(".plugin-test .fixture-head button", has_text="Test run").click()
    pg.wait_for_selector(".plugin-test-result .plugin-status.ok", timeout=8000)
    check("test run reports clean", True)
    # edit the source -> result must go stale
    pg.locator(".plugin-editor .cm-content").first.click()
    pg.keyboard.press("Control+End")
    pg.keyboard.type("// edited after run")
    pg.wait_for_timeout(300)
    check("stale marker after editing source", pg.locator(".plugin-test-result .plugin-status.warn", has_text="stale").count() == 1)

    # ---- save accurate status: disabled plugin says disabled ----
    api("PUT", "/api/plugins/r0-e2e.js", {"enabled": False})
    pg.wait_for_timeout(500)
    pg.locator(".plugin-editor .cm-content").first.click()
    pg.keyboard.press("Control+a")
    pg.keyboard.type(GOOD)
    pg.locator(".plugin-editor .editor-toolbar button", has_text="Save to disk").click()
    pg.wait_for_timeout(900)
    status = pg.locator(".plugin-editor .plugin-status").all_text_contents()
    check("save reports actual disabled state", any("disabled" in s for s in status), str(status))
    api("PUT", "/api/plugins/r0-e2e.js", {"enabled": True})

    # ---- broken source -> last good revision keeps running ----
    api("PUT", "/api/plugins/source/r0-e2e.js", {"src": "function ( { broken javascript"})
    pg.wait_for_timeout(600)
    api("POST", "/api/plugins/reload")
    meta = next(p for p in api("GET", "/api/plugins")["plugins"] if p["file"] == "r0-e2e.js")
    check("runningLastGood flag set", meta.get("runningLastGood") is True, str(meta.get("error")))
    check("error explains the fallback", "running last good revision" in (meta.get("error") or ""))
    src = api("GET", "/api/plugins/source/r0-e2e.js")["src"]
    check("editor source stays the broken one", "broken javascript" in src)

    # ---- separated counters on a runtime error ----
    badrt = 'function onRequest(ctx) { throw new Error("kaboom"); }'
    api("PUT", "/api/plugins/source/r0-throw.js", {"src": badrt})
    # trigger through the proxy
    import threading, urllib.request as u
    op = u.build_opener(u.ProxyHandler({"http": "http://127.0.0.1:8080"}))
    try:
        op.open("http://127.0.0.1:1/nope", timeout=5)
    except Exception:
        pass
    pg.wait_for_timeout(600)
    meta2 = next(p for p in api("GET", "/api/plugins")["plugins"] if p["file"] == "r0-throw.js")
    check("attempts counted", meta2.get("attempts", 0) >= 1, str(meta2.get("attempts")))
    check("errors counted with sticky lastError", meta2.get("errors", 0) >= 1 and "kaboom" in (meta2.get("lastError") or ""), str(meta2.get("lastError")))

    # cleanup test plugins
    api("DELETE", "/api/plugins/source/r0-e2e.js")
    api("DELETE", "/api/plugins/source/r0-throw.js")
    pg.evaluate("localStorage.clear()")
    b.close()

print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    raise SystemExit("FAILED: " + ", ".join(FAIL))
