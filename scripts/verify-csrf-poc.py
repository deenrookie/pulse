#!/usr/bin/env python3
"""UI regression checks for "Generate CSRF PoC" (Live Traffic + Repeater).

Run only against an isolated Pulse instance. Requires Python playwright and
Google Chrome. Creates synthetic flows and one Repeater tab.

  PULSE_TEST_API / PULSE_TEST_UI   defaults: http://127.0.0.1:8090 (the Go
                                   binary serves the embedded web/dist UI)
  PULSE_TEST_OUT                   screenshot + results dir (default /tmp)
"""
import json
import os
import urllib.request

from playwright.sync_api import expect, sync_playwright

API = os.environ.get("PULSE_TEST_API", "http://127.0.0.1:8090")
UI = os.environ.get("PULSE_TEST_UI", API)
OUT = os.environ.get("PULSE_TEST_OUT", "/tmp/pulse-csrf-verification")
os.makedirs(OUT, exist_ok=True)


def api(method, path, body=None):
    request = urllib.request.Request(
        API + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request) as response:
        return json.load(response)


def fire(path, method="GET", ct=None, body=""):
    """record a synthetic flow (the upstream is unreachable; that is fine)"""
    headers = [{"name": "Host", "value": "127.0.0.1:1"}]
    if ct:
        headers.append({"name": "Content-Type", "value": ct})
    return api(
        "POST",
        "/api/intruder/fire",
        {"request": {"method": method, "url": f"http://127.0.0.1:1{path}", "headers": headers, "body": body}},
    )["flow"]


import base64

b64 = lambda s: base64.b64encode(s.encode()).decode()  # noqa: E731

form_flow = fire("/csrf-form-login", "POST", "application/x-www-form-urlencoded", b64("username=carlos&token=abc"))
json_flow = fire("/csrf-json-api", "POST", "application/json", b64('{"email":"attacker@evil.com"}'))
get_flow = fire("/csrf-search?q=pulse&page=2", "GET")

json_tab = api(
    "POST",
    "/api/repeater",
    {
        "request": {
            "method": "POST",
            "url": "https://poc-target.example/api/change-email",
            "headers": [
                {"name": "Host", "value": "poc-target.example"},
                {"name": "Content-Type", "value": "application/json"},
            ],
            "body": b64('{"email":"attacker@evil.com"}'),
        }
    },
)

checks = []


def ok(name):
    checks.append(name)
    print(f"  ✓ {name}")


def open_dialog(page, target, label):
    target.click(button="right")
    page.get_by_role("menuitem", name="Generate CSRF PoC").click()
    dialog = page.locator("dialog.csrf-dialog")
    expect(dialog).to_be_visible()
    html_area = page.locator("textarea.csrf-html")
    expect(html_area).to_be_visible()
    return html_area


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="chrome", headless=False)
    context = browser.new_context(viewport={"width": 1400, "height": 900}, permissions=["clipboard-read", "clipboard-write"])
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))

    # ---- Live Traffic row → urlencoded POST → auto-submitting form ----
    page.goto(UI + "/#/proxy?flow=" + form_flow["id"])
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)
    row = page.locator("table.flows tbody tr").filter(has_text="csrf-form-login").first
    expect(row).to_be_visible()
    html = open_dialog(page, row, "traffic row")
    value = html.input_value()
    assert 'action="http://127.0.0.1:1/csrf-form-login" method="POST"' in value, value
    assert 'name="username" value="carlos"' in value, value
    assert 'name="token" value="abc"' in value, value
    assert "document.forms[0].submit();" in value, value
    assert "cookie" not in value.lower(), "cookies must not appear in the PoC"
    assert page.locator(".csrf-tech").inner_text().lower() == "form"
    ok("traffic row: urlencoded POST → Burp-style auto-submit form")

    # ---- technique select → XHR reproduces method/CT/body exactly ----
    page.get_by_role("combobox", name="Technique").select_option("xhr")
    page.wait_for_timeout(200)
    value = html.input_value()
    assert 'xhr.open("POST", "http://127.0.0.1:1/csrf-form-login", true);' in value, value
    assert "xhr.setRequestHeader('Content-Type', \"application/x-www-form-urlencoded\");" in value, value
    assert "xhr.withCredentials = true;" in value, value
    assert 'xhr.send("username=carlos&token=abc");' in value, value
    ok("traffic row: technique switch to XHR regenerates the script PoC")

    # ---- form options: submit button in, auto-submit out ----
    page.get_by_role("combobox", name="Technique").select_option("form")
    page.wait_for_timeout(200)
    page.get_by_role("checkbox", name="Auto-submit script").uncheck()
    page.get_by_role("checkbox", name="Submit button").check()
    page.wait_for_timeout(200)
    value = html.input_value()
    assert '<input type="submit" value="Submit request" />' in value, value
    assert "document.forms[0].submit();" not in value, value
    page.get_by_role("checkbox", name="Auto-submit script").check()
    page.get_by_role("checkbox", name="Submit button").uncheck()
    page.wait_for_timeout(200)
    ok("traffic row: submit-button / auto-submit options round-trip")

    # ---- edit the request, then Regenerate ----
    editor = page.locator("dialog .raw-edit-stack textarea.over-mirror")
    editor.fill("POST /csrf-form-login HTTP/1.1\nHost: 127.0.0.1:1\nContent-Type: application/json\n\n{}")
    page.get_by_role("button", name="Regenerate").click()
    page.wait_for_timeout(200)
    value = html.input_value()
    assert 'enctype="text/plain"' in value, value  # JSON forced through the form technique
    assert page.locator(".csrf-warn").count() >= 1, "content-type warning expected"
    editor.fill("GET /x?go=1 HTTP/1.1\nHost: 127.0.0.1:1\n\n")
    page.get_by_role("button", name="Regenerate").click()
    page.wait_for_timeout(200)
    value = html.input_value()
    assert '<form action="http://127.0.0.1:1/x">' in value and 'name="go" value="1"' in value, value
    ok("dialog: edit request + Regenerate (JSON→text/plain trick, GET→form)")

    # ---- Copy HTML → clipboard carries exactly what is on screen ----
    html.fill("<html>hand-edited</html>")
    page.get_by_role("button", name="Copy HTML").click()
    expect(page.locator(".toast")).to_contain_text("Copied CSRF PoC HTML")
    clip = page.evaluate("navigator.clipboard.readText()")
    assert clip == "<html>hand-edited</html>", clip
    ok("dialog: Copy HTML copies the edited buffer verbatim")

    page.screenshot(path=os.path.join(OUT, "csrf-dialog.png"))
    page.get_by_role("button", name="Close", exact=True).click()
    expect(page.locator("dialog.csrf-dialog")).to_have_count(0)

    # ---- JSON flow → auto picks XHR with the preflight warning ----
    page.goto(UI + "/#/proxy?flow=" + json_flow["id"])
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)
    row = page.locator("table.flows tbody tr").filter(has_text="csrf-json-api").first
    html = open_dialog(page, row, "json row")
    value = html.input_value()
    assert "XMLHttpRequest" in value and '\'Content-Type\', "application/json"' in value, value
    assert "xhr.send(" in value and "attacker@evil.com" in value, value
    warn = page.locator(".csrf-warn").inner_text()
    assert "preflight" in warn, warn
    ok("traffic row: JSON POST → auto XHR + CORS preflight warning")
    page.get_by_role("button", name="Close", exact=True).click()

    # ---- GET flow → form without method attr, query as inputs ----
    page.goto(UI + "/#/proxy?flow=" + get_flow["id"])
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)
    row = page.locator("table.flows tbody tr").filter(has_text="csrf-search").first
    html = open_dialog(page, row, "get row")
    value = html.input_value()
    assert '<form action="http://127.0.0.1:1/csrf-search">' in value, value
    assert 'name="q" value="pulse"' in value and 'name="page" value="2"' in value, value
    assert 'method="' not in value, value
    ok("traffic row: GET → form (no method attr), query params as inputs")
    page.get_by_role("button", name="Close", exact=True).click()

    # ---- Live Traffic request pane (raw editor) entry ----
    page.goto(UI + "/#/proxy?flow=" + form_flow["id"])
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(800)
    req_editor = page.locator(".view .raw-edit-stack textarea.over-mirror").first
    html = open_dialog(page, req_editor, "request pane")
    assert 'action="http://127.0.0.1:1/csrf-form-login"' in html.input_value()
    ok("traffic request pane: raw editor right-click generates the PoC")
    page.get_by_role("button", name="Close", exact=True).click()

    # ---- Repeater tab right-click ----
    page.goto(UI + "/#/repeater?tab=" + json_tab["id"])
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(900)
    side = page.locator(f'.side-item[data-tab-id="{json_tab["id"]}"]')
    expect(side).to_be_visible()
    html = open_dialog(page, side, "repeater tab")
    value = html.input_value()
    assert 'xhr.open("POST", "https://poc-target.example/api/change-email", true);' in value, value
    assert "attacker@evil.com" in value, value
    assert page.locator(".csrf-tech").inner_text().lower() == "xhr"
    ok("repeater tab: right-click → PoC (https + JSON→XHR)")
    page.get_by_role("button", name="Close", exact=True).click()

    # ---- Repeater request editor right-click uses the CURRENT buffer ----
    req_editor = page.locator(".view .raw-edit-stack textarea.over-mirror").first
    req_editor.fill("POST /edited HTTP/1.1\nHost: poc-target.example\nContent-Type: application/x-www-form-urlencoded\n\na=1")
    html = open_dialog(page, req_editor, "repeater editor")
    value = html.input_value()
    assert 'action="https://poc-target.example/edited"' in value and 'name="a" value="1"' in value, value
    ok("repeater editor: right-click uses the unsaved buffer")

    page.screenshot(path=os.path.join(OUT, "csrf-repeater.png"))
    page.get_by_role("button", name="Close", exact=True).click()

    assert errors == [], errors
    ok("no page errors during the whole run")
    browser.close()

print(f"\n{len(checks)} checks passed — screenshots in {OUT}")
