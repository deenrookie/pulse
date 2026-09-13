# E2E: WebSocket traffic stands out — a WS badge in the method column and a
# WS-only toolbar filter. Drives a real upgrade + frames through the proxy.
import json
import socket
import struct
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

from playwright.sync_api import sync_playwright

DEV = "http://127.0.0.1:5175"
API = "http://127.0.0.1:8000"
PROXY = ("127.0.0.1", 8080)
CHROME = "C:/Users/Deen/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe"
OUT = "C:/Users/Deen/Documents/GitHub/pulse/gui-test-screenshots"
PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if extra and not cond else ""))


class Up(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.headers.get("Upgrade", "").lower() == "websocket":
            self.send_response(101, "Switching Protocols")
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
            self.end_headers()
            # server->client binary frame, then echo whatever comes until close
            self.wfile.write(bytes([0x82, 0x03]) + b"hi!")
            self.connection.settimeout(5)
            try:
                while True:
                    hdr = self.rfile.read(2)
                    if not hdr or len(hdr) < 2:
                        break
                    ln = hdr[1] & 0x7F
                    if ln == 126:
                        ln = struct.unpack(">H", self.rfile.read(2))[0]
                    self.rfile.read(4)  # mask
                    self.rfile.read(ln)
            except OSError:
                pass
        else:
            body = b"plain page"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def log_message(self, *a):
        pass


up = HTTPServer(("127.0.0.1", 0), Up)
threading.Thread(target=up.serve_forever, daemon=True).start()
UP_HOST = "127.0.0.1"
UP_PORT = up.server_address[1]


def ws_through_proxy():
    """raw WebSocket handshake + one binary frame + close, through Pulse.
    Plain forward-proxy form (no CONNECT): the engine parses the request,
    records the flow and relays WS frames."""
    s = socket.create_connection(PROXY, timeout=10)
    req = (
        f"GET http://{UP_HOST}:{UP_PORT}/ws/chat HTTP/1.1\r\nHost: {UP_HOST}:{UP_PORT}\r\nUpgrade: websocket\r\n"
        "Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n"
    ).encode()
    s.sendall(req)
    buf = b""
    while b"\r\n\r\n" not in buf:
        buf += s.recv(4096)
    ok = b"101" in buf.split(b"\r\n", 1)[0]
    # client->server binary frame (masked)
    payload = b"ping-from-client"
    mask = b"\x01\x02\x03\x04"
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    s.sendall(bytes([0x82, 0x80 | len(payload)]) + mask + masked)
    time.sleep(0.3)
    s.sendall(bytes([0x88, 0x80]) + mask)  # close
    time.sleep(0.3)
    s.close()
    return ok


def api(path):
    with urllib.request.urlopen(API + path) as r:
        return json.load(r)


ok = ws_through_proxy()
urllib.request.build_opener(urllib.request.ProxyHandler({"http": f"http://{PROXY[0]}:{PROXY[1]}"})).open(
    f"http://{UP_HOST}:{UP_PORT}/plain", timeout=10).read()
time.sleep(1.2)

# confirm the WS flow got recorded with wsCount
items = api("/api/flows")["items"]
ws_flows = [i for i in items if i["path"] == "/ws/chat"]
check("upgrade handshake succeeded", ok)
check("flow recorded with wsCount >= 3", len(ws_flows) >= 1 and (ws_flows[0].get("wsCount") or 0) >= 3,
      str(ws_flows[:1]))

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME)
    pg = b.new_page(viewport={"width": 1500, "height": 900})
    pg.goto(DEV + "/#/proxy", wait_until="networkidle")
    pg.locator(".panel-head .switch", has_text="Follow").first.click()
    pg.wait_for_timeout(400)

    row = pg.locator("table tbody tr").filter(has_text="/ws/chat").first
    badge = row.locator(".ws-badge")
    check("WS badge in method column", badge.count() == 1, str(badge.count()))
    check("badge shows message count", "WS" in (badge.text_content() or "") and any(c.isdigit() for c in (badge.text_content() or "")),
          badge.text_content())
    pg.screenshot(path=f"{OUT}/ws_badge.png")

    rows_before = pg.locator("table tbody tr").count()
    pg.locator(".toolbar .tchip", has_text="WS").first.click()
    pg.wait_for_timeout(400)
    rows_after = pg.locator("table tbody tr").count()
    all_ws = pg.locator("table tbody tr .ws-badge").count() == rows_after and rows_after >= 1
    check("WS filter keeps only websocket flows", all_ws and rows_after < rows_before,
          f"{rows_before} -> {rows_after}, badges={pg.locator('table tbody tr .ws-badge').count()}")
    check("our /ws/chat flow is among them", pg.locator("table tbody tr").filter(has_text="/ws/chat").count() >= 1)
    check("WS chip is on", "on" in (pg.locator(".toolbar .tchip", has_text="WS").first.get_attribute("class") or ""))
    pg.screenshot(path=f"{OUT}/ws_filter.png")

    pg.locator(".toolbar .tchip", has_text="WS").first.click()
    pg.wait_for_timeout(400)
    check("filter off restores the list", pg.locator("table tbody tr").count() >= rows_before)

    b.close()

up.shutdown()
print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    raise SystemExit("FAILED: " + ", ".join(FAIL))
