#!/usr/bin/env python3
"""UI regression check for Request-only sharing and Intruder persistence.

Run only against an isolated Pulse instance. Requires local Chrome and Python
playwright. Creates synthetic failed flows, one share, attacks and Repeater tabs.
"""
import base64
import gzip
import json
import os
import re
import urllib.request
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

API = os.environ.get("PULSE_TEST_API", "http://127.0.0.1:8000")
UI = os.environ.get("PULSE_TEST_UI", "http://127.0.0.1:8000")
OUT = Path(os.environ.get("PULSE_TEST_OUT", "/tmp/pulse-share-intruder-polish"))
OUT.mkdir(parents=True, exist_ok=True)


def api(method, path, body=None):
    request = urllib.request.Request(
        API + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request) as response:
        return json.load(response)


api("PUT", "/api/settings", {"shareIP": "127.0.0.1"})
compressed = gzip.compress(b"decoded gzip request")
flow = api(
    "POST",
    "/api/intruder/fire",
    {
        "request": {
            "method": "POST",
            "url": "http://127.0.0.1:1/request-only/" + "long-segment/" * 80 + "?token=end",
            "headers": [{"name": "Content-Encoding", "value": "gzip"}],
            "body": base64.b64encode(compressed).decode(),
        }
    },
)["flow"]
share = api("POST", "/api/shares", {"flowId": flow["id"]})
attack = api(
    "POST",
    "/api/intruder",
    {
        "raw": "GET /?u=§x§ HTTP/1.1\nHost: 127.0.0.1:1\n\n",
        "targetURL": "http://127.0.0.1:1",
        "mode": "sniper",
        "payloads": "alpha\nbeta",
        "grep": "",
    },
)

checks = []
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="chrome", headless=False)
    page = browser.new_page(viewport={"width": 1280, "height": 820})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))

    page.goto(share["url"].replace(API, UI))
    expect(page.get_by_role("region", name="Request")).to_contain_text("decoded gzip request")
    expect(page.get_by_role("note")).to_contain_text("No response was captured")
    assert page.get_by_role("region", name="Response").count() == 0
    expect(page.locator(".encoding-badge")).to_contain_text("decoded gzip")
    url = page.locator(".shared-url")
    assert url.evaluate("el => el.scrollWidth > el.clientWidth")
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    page.screenshot(path="/tmp/pulse-share-request-only.png", full_page=True)
    checks.append("Request-only share renders, decodes gzip and truncates long URL without page overflow")
    page.screenshot(path=str(OUT / "request-only-share.png"), full_page=True)

    page.goto(UI + "/#/intruder?attack=" + attack["id"])
    assert page.get_by_label("Attack name").count() == 0
    expect(page.locator(".side-item.selected")).to_contain_text("/?u=§x§")
    page.get_by_role("button", name="Start attack", exact=True).click()
    expect(page.locator(".intruder-status")).to_contain_text("Finished · 2 requests")
    expect(page.locator(".intruder-table tbody tr")).to_have_count(2)
    page.reload()
    expect(page.locator(".intruder-table tbody tr")).to_have_count(2)
    expect(page.locator(".side-item.selected .l2")).to_contain_text("2 results")
    page.screenshot(path="/tmp/pulse-intruder-restored.png", full_page=True)
    checks.append("Latest attack auto-selects, attack name is absent, and results survive reload")
    page.screenshot(path=str(OUT / "intruder-restored.png"), full_page=True)

    selected = page.locator(".side-item.selected")
    deleted_id = selected.locator(".id").inner_text()
    selected.click(button="right")
    expect(page.get_by_role("menuitem", name="Send template to Repeater")).to_be_visible()
    page.get_by_role("menuitem", name="Send template to Repeater").click()
    expect(page).to_have_url(re.compile(r"#/repeater[?]tab=tab-[0-9]+$"), timeout=10000)
    expect(page.locator(".side-item.selected")).to_contain_text("/?u=§x§")
    page.goto(UI + "/#/intruder?attack=" + attack["id"])
    selected = page.locator(".side-item.selected")
    delete = selected.get_by_role("button", name="Delete attack " + attack["id"])
    selected.hover()
    expect(delete).to_be_visible()
    delete.click()
    expect(page.locator(".side-item .id", has_text=deleted_id)).not_to_be_visible()
    assert page.locator(".side-item.selected").count() == 1 or page.get_by_role("button", name="New attack", exact=False).count() > 0
    checks.append("Intruder item right-click sends to the selected Repeater tab; quick delete selects next or empty")
    assert not errors, errors
    (OUT / "results.json").write_text(json.dumps(checks, indent=2), encoding="utf-8")
    print(json.dumps(checks, indent=2))
    browser.close()

api("DELETE", "/api/shares/" + share["id"])

