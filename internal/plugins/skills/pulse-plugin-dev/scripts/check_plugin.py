#!/usr/bin/env python3
"""Check and assert a Pulse plugin in the sandbox. Does not install plugins."""
import argparse
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("fixture", type=Path)
    parser.add_argument("--server", default="http://127.0.0.1:8787")
    args = parser.parse_args()
    server = args.server.rstrip("/")
    url = urllib.parse.urlsplit(server)
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment or url.path:
        raise ValueError("--server must be an HTTP(S) origin without credentials, path, query or fragment")
    fixture = json.loads(args.fixture.read_text(encoding="utf-8"))
    if not isinstance(fixture, dict):
        raise ValueError("fixture must be a JSON object")
    expect = fixture.pop("expect", None)
    if not isinstance(expect, dict) or not expect:
        raise ValueError("fixture must contain a nonempty expect map")
    if fixture.get("hook", "request") not in ("request", "response"):
        raise ValueError("hook must be request or response")
    source = args.source.read_text(encoding="utf-8")

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None  # never forward access keys to another endpoint

    opener = urllib.request.build_opener(NoRedirect)

    def post(path, body):
        headers = {"Content-Type": "application/json"}
        if os.environ.get("PULSE_KEY"):
            headers["X-Pulse-Key"] = os.environ["PULSE_KEY"]
        request = urllib.request.Request(server + path, data=json.dumps(body).encode(), headers=headers)
        with opener.open(request, timeout=10) as response:
            result = json.load(response)
        if result.get("error"):
            raise ValueError(result["error"])
        return result

    post("/api/plugins/validate", {"src": source})
    fixture["src"] = source
    result = post("/api/plugins/test-mock" if "mocks" in fixture else "/api/plugins/test", fixture)
    for path, expected in expect.items():
        actual = result
        for part in path.split("."):
            actual = actual[int(part)] if isinstance(actual, list) else actual[part]
        if type(actual) is not type(expected) or actual != expected:
            raise ValueError("assertion failed: " + path)
    print("PASS: compile, sandbox run and " + str(len(expect)) + " assertions")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, IndexError, TypeError) as error:
        print("FAIL: " + str(error), file=sys.stderr)
        sys.exit(1)
