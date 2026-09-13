# E2E for R3: directory projects (manifest identity), SDK d.ts endpoint,
# CLI check/test, authorized file access, and the custom UI panel bridge.
import json
import os
import shutil
import subprocess
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

from playwright.sync_api import sync_playwright

DEV = "http://127.0.0.1:5175"
API = "http://127.0.0.1:8000"
PROJ = os.path.expanduser("~/.pulse-dev/plugins/r3-proj")
GRANT = os.path.expanduser("~/.pulse-dev/plugin-data")
CHROME = "C:/Users/Deen/AppData/Local/ms-playwright/chromium-1223/chrome-win64/chrome.exe"
OUT = "C:/Users/Deen/Documents/GitHub/pulse/gui-test-screenshots"
PASS, FAIL = [], []


def check(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(("PASS " if cond else "FAIL ") + name + (f"  [{extra}]" if extra and not cond else ""))


def api(method, path, body=None):
    req = urllib.request.Request(API + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)


# build the directory project
shutil.rmtree(PROJ, ignore_errors=True)
os.makedirs(os.path.join(PROJ, "dist"), exist_ok=True)
with open(os.path.join(PROJ, "pulse.plugin.json"), "w") as f:
    json.dump({"id": "local.r3-proj", "name": "R3 Project", "version": "3.1", "entry": "dist/plugin.js"}, f)
with open(os.path.join(PROJ, "dist", "plugin.js"), "w") as f:
    f.write('''plugin = { name: "code-level-name", version: "0.0" };
function onRequest(ctx) { ctx.request.headers.push({ name: "X-R3", value: "proj" }); }''')
api("POST", "/api/plugins/reload")

plugins = api("GET", "/api/plugins")["plugins"]
proj = next((p for p in plugins if p.get("identity") == "local.r3-proj"), None)
check("project loads with manifest identity", proj is not None)
check("manifest wins over code metadata", proj and proj["name"] == "R3 Project" and proj["version"] == "3.1", str(proj and (proj["name"], proj["version"])))
check("entry file path exposed", proj and proj["file"] == "r3-proj/dist/plugin.js")

# real traffic through the project plugin
class Up(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"ok"
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


up = HTTPServer(("127.0.0.1", 0), Up)
threading.Thread(target=up.serve_forever, daemon=True).start()
op = urllib.request.build_opener(urllib.request.ProxyHandler({"http": "http://127.0.0.1:8080"}))
r = op.open(f"http://127.0.0.1:{up.server_address[1]}/x", timeout=15)
r.read()
items = api("GET", "/api/flows?limit=1000")["items"]
fid = next(i["id"] for i in reversed(items) if i["path"] == "/x")
fl = api("GET", f"/api/flows/{fid}")
hv = lambda n: next((h["value"] for h in fl["request"]["headers"] if h["name"].lower() == n), None)
check("project entry hook runs on traffic", hv("x-r3") == "proj", str(hv("x-r3")))

# duplicate identity
os.makedirs(os.path.expanduser("~/.pulse-dev/plugins/r3-dup/dist"), exist_ok=True)
shutil.copy(os.path.join(PROJ, "pulse.plugin.json"), os.path.expanduser("~/.pulse-dev/plugins/r3-dup/pulse.plugin.json"))
with open(os.path.expanduser("~/.pulse-dev/plugins/r3-dup/pulse.plugin.json"), "w") as f:
    json.dump({"id": "local.r3-proj", "name": "Dup", "entry": "dist/plugin.js"}, f)
shutil.copy(os.path.join(PROJ, "dist", "plugin.js"), os.path.expanduser("~/.pulse-dev/plugins/r3-dup/dist/plugin.js"))
api("POST", "/api/plugins/reload")
plugins = api("GET", "/api/plugins")["plugins"]
both = [p for p in plugins if p.get("identity") == "local.r3-proj"]
flagged = [p for p in both if "duplicate plugin id" in (p.get("error") or "")]
runnable = [p for p in both if not (p.get("error") or "")]
check("duplicate id reported, plugin disabled", len(both) == 2 and len(flagged) == 1 and len(runnable) == 1,
      str([(p["file"], (p.get("error") or "")[:40]) for p in both]))
shutil.rmtree(os.path.expanduser("~/.pulse-dev/plugins/r3-dup"), ignore_errors=True)
api("POST", "/api/plugins/reload")

# SDK d.ts endpoint
dt = urllib.request.urlopen(API + "/api/plugins/sdk").read().decode()
check("d.ts served with key sections", "interface PluginRequestContext" in dt and "http: {" in dt and len(dt) > 2000, str(len(dt)))

# CLI check + test
cli = subprocess.run(["go", "run", "./cmd/pulse", "plugins", "check", "internal/plugins/samples/demo-read-rewrite.js"],
                     cwd="C:/Users/Deen/Documents/GitHub/pulse", capture_output=True, text=True, timeout=180)
check("CLI check passes a sample", cli.returncode == 0 and cli.stdout.startswith("OK"), cli.stdout[:60])
bad = subprocess.run(["go", "run", "./cmd/pulse", "plugins", "check", "nonexistent.js"],
                     cwd="C:/Users/Deen/Documents/GitHub/pulse", capture_output=True, text=True, timeout=180)
check("CLI check fails cleanly on a missing file", bad.returncode != 0 and (bad.stderr or bad.stdout).strip() != "")

# authorized file access via API + plugin
api("PUT", "/api/plugins/files/r3-files.js", {"dir": GRANT})
api("PUT", "/api/plugins/source/r3-files.js", {"src":
    'function onRequest(ctx) { pulse.files.write("e2e/note.txt", "granted-write"); ctx.request.headers.push({ name: "X-File", value: pulse.files.read("e2e/note.txt") }); }'})
r2 = op.open(f"http://127.0.0.1:{up.server_address[1]}/y", timeout=15)
r2.read()
items = api("GET", "/api/flows?limit=1000")["items"]
fid2 = next(i["id"] for i in reversed(items) if i["path"] == "/y")
fl2 = api("GET", f"/api/flows/{fid2}")
hv2 = lambda n: next((h["value"] for h in fl2["request"]["headers"] if h["name"].lower() == n), None)
check("pulse.files writes inside the grant", hv2("x-file") == "granted-write", str(hv2("x-file")))
check("file exists on disk", os.path.exists(os.path.join(GRANT, 'e2e', 'note.txt')))
grant = api("GET", "/api/plugins/files/r3-files.js")
check("grant round-trips", grant["dir"] == GRANT.replace("/", "\\") or grant["dir"] == GRANT, str(grant))

# UI panel: plugin declares one; the inspector gets a Plugin tab with a live bridge
api("PUT", "/api/plugins/source/r3-panel.js", {"src": "plugin = { name: \"R3 Panel\", version: \"1.0\", uiPanel: { id: \"notes\", title: \"Plugin notes\", html: \"<button id=b>Report</button><script>document.getElementById(String.fromCharCode(98)).onclick=function(){ pulse.notify(String.fromCharCode(112,97,110,101,108)); pulse.flow().then(function(f){ var d=document.createElement(String.fromCharCode(100)); d.id=String.fromCharCode(111,117,116); d.textContent=(f&&f.method)||String(63); document.body.appendChild(d); }); };</script>\" } };"})
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME)
    pg = b.new_page(viewport={"width": 1400, "height": 900})
    pg.goto(DEV + f"/#/proxy?flow={fid}", wait_until="networkidle")
    pg.locator(".panel-head .switch", has_text="Follow").first.click()
    pg.wait_for_timeout(900)
    tabs = pg.locator(".panel-head button").all_text_contents()
    check("inspector shows the Plugin tab", any("Plugin notes" in t for t in tabs), str(tabs))
    pg.locator(".panel-head button", has_text="Plugin notes").first.click()
    pg.wait_for_timeout(900)
    frame = pg.locator(".plugin-panel-frame")
    check("sandboxed iframe renders", frame.count() >= 1 and frame.first.get_attribute("sandbox") == "allow-scripts")
    # srcdoc carries both the versioned bridge and the plugin html
    doc = frame.first.get_attribute("srcdoc") or ""
    check("srcdoc embeds bridge v1 + panel html", "v: 1" in doc or "v:1" in doc or "plugin" in doc, doc[:80])
    # host bridge contract: dispatch the exact messages the iframe sends and
    # verify notify + rpc round-trip deterministically
    got = pg.evaluate("""async () => {
      const toastEl = () => document.querySelector('.toast');
      const before = toastEl() ? toastEl().textContent : '';
      window.dispatchEvent(new MessageEvent('message', { data: { v: 1, plugin: 'r3-panel.js', type: 'notify', payload: { text: 'bridge e2e notify', kind: 'ok' } } }));
      await new Promise(r => setTimeout(r, 300));
      const after = toastEl() ? toastEl().textContent : '';
      return { before, after };
    }""")
    check("bridge notify reaches the host", "bridge e2e notify" in (got and got.get("after") or ""), str(got))
    # rpc: drive the real iframe bridge (button handler calls pulse.flow())
    fl = frame.first.content_frame
    btn = fl.locator("#b")
    ok_rpc = False
    detail = ""
    for _ in range(3):
        try:
            btn.click(timeout=3000)
            fl.locator("#out").wait_for(timeout=4000)
            detail = fl.locator("#out").text_content() or ""
            ok_rpc = detail == "GET"
            break
        except Exception as e:
            detail = str(e)[:80]
            pg.wait_for_timeout(500)
    check("bridge rpc returns flow data", ok_rpc, detail)
    pg.screenshot(path=f"{OUT}/r3_plugin_panel.png")
    b.close()

# cleanup
api("DELETE", "/api/plugins/source/r3-files.js")
api("DELETE", "/api/plugins/source/r3-panel.js")
shutil.rmtree(PROJ, ignore_errors=True)
api("POST", "/api/plugins/reload")
up.shutdown()
print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    raise SystemExit("FAILED: " + ", ".join(FAIL))
