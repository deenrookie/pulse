#!/usr/bin/env python3
"""Regression check for Live Traffic -> Send to Repeater navigation.

Run only against an isolated Pulse instance. Requires Python playwright and
Google Chrome. Creates two synthetic failed flows and two Repeater tabs.
"""
import json
import os
import urllib.request

from playwright.sync_api import expect, sync_playwright

API = os.environ.get("PULSE_TEST_API", "http://127.0.0.1:8000")
UI = os.environ.get("PULSE_TEST_UI", "http://127.0.0.1:5176")


def api(method, path, body=None):
    request = urllib.request.Request(
        API + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request) as response:
        return json.load(response)


def synthetic_flow(path, method="GET"):
    return api(
        "POST",
        "/api/intruder/fire",
        {
            "request": {
                "method": method,
                "url": "http://127.0.0.1:1/" + path,
                "headers": [],
                "body": "",
            }
        },
    )["flow"]


older = synthetic_flow("older-source")
newest = synthetic_flow("newest-source", "POST")

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel="chrome", headless=False)
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))

    def rail(name):
        return page.locator("button.rail-item").filter(has_text=name)

    page.goto(UI + "/#/proxy?flow=" + older["id"])
    page.get_by_role("button", name="Send to Repeater", exact=False).first.click()
    expect(page.locator(".toast")).to_contain_text("Sent to Repeater")
    rail("Repeater").click()
    expect(page.locator(".side-item.selected")).to_contain_text("older-source")
    old_id = page.locator(".side-item.selected").get_attribute("data-tab-id")

    # Navigate immediately after the click. This is the old failure window:
    # Repeater can mount before the create + list refresh has settled.
    rail("Live Traffic").click()
    page.goto(UI + "/#/proxy?flow=" + newest["id"])
    page.get_by_role("button", name="Send to Repeater", exact=False).first.click(no_wait_after=True)
    rail("Repeater").click()

    selected = page.locator(".side-item.selected")
    expect(selected).to_contain_text("newest-source", timeout=10000)
    new_id = selected.get_attribute("data-tab-id")
    assert new_id != old_id
    assert page.url.endswith("tab=" + new_id)
    assert page.evaluate("localStorage.getItem('pulse.repeater.pendingTab')") is None

    # With no pending send, ordinary navigation restores the operated tab.
    rail("Settings").click()
    rail("Repeater").click()
    expect(selected).to_have_attribute("data-tab-id", new_id)
    assert not errors, errors
    print(json.dumps({"oldTab": old_id, "newTab": new_id, "url": page.url}, indent=2))
    browser.close()
