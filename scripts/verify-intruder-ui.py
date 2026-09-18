#!/usr/bin/env python3
"""Boundary UI checks. Use only an isolated Pulse test instance; see Verification.md."""
import json,urllib.request,threading,time,gzip,os
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import sync_playwright,expect
API=os.environ.get('PULSE_TEST_API','http://127.0.0.1:8000');UI=os.environ.get('PULSE_TEST_UI','http://127.0.0.1:5176');OUT=Path(os.environ.get('PULSE_TEST_OUT','/tmp/pulse-r2-verification'));OUT.mkdir(parents=True,exist_ok=True)
seen=[]
class Up(BaseHTTPRequestHandler):
 def do_GET(self):
  seen.append(self.path)
  if self.path.startswith('/slow'):time.sleep(.35)
  body=('A'*220000+'needle-at-end') if self.path.startswith('/long') else 'admin gzip-needle'
  payload=gzip.compress(body.encode()) if self.path.startswith('/gzip') else body.encode()
  self.send_response(200);self.send_header('Content-Type','text/plain');self.send_header('Content-Length',str(len(payload)))
  if self.path.startswith('/gzip'):self.send_header('Content-Encoding','gzip')
  self.end_headers();self.wfile.write(payload)
 def log_message(self,*args):pass
up=ThreadingHTTPServer(('127.0.0.1',0),Up);threading.Thread(target=up.serve_forever,daemon=True).start();origin=f'http://127.0.0.1:{up.server_port}'
def api(method,path,data=None):
 r=urllib.request.Request(API+path,method=method,data=json.dumps(data).encode() if data is not None else None,headers={'Content-Type':'application/json'})
 with urllib.request.urlopen(r) as response:return json.load(response)
raw='GET /?u=one&p=two HTTP/1.1'+chr(10)+f'Host: 127.0.0.1:{up.server_port}'+chr(10)+chr(10)
a=api('POST','/api/intruder',{'raw':raw,'targetURL':origin,'mode':'sniper','title':'edge-check'})
checks=[]
with sync_playwright() as p:
 b=p.chromium.launch(channel='chrome',headless=False);ctx=b.new_context(viewport={'width':1400,'height':900});page=ctx.new_page()
 page.goto(UI+'/#/intruder?attack='+a['id']);ta=page.get_by_label('Request template');expect(ta).to_have_value(raw)
 ta.evaluate('(el)=>{el.focus();let start=el.value.indexOf("one");el.setSelectionRange(start,start+3)}')
 page.get_by_role('button',name='Add § §',exact=True).click();expect(ta).to_have_value(raw.replace('one','§one§'))
 ta.evaluate('(el)=>{el.focus();let start=el.value.indexOf("one");el.setSelectionRange(start,start)}')
 page.get_by_role('button',name='Remove position',exact=True).click();expect(ta).to_have_value(raw)
 ta.fill(raw.replace('one','§one§').replace('two','§two§'));page.get_by_role('button',name='Clear positions',exact=True).click();expect(ta).to_have_value(raw)
 ta.fill(raw.replace('one','§one§'));page.get_by_role('tab',name='Payloads',exact=True).click()
 f=OUT/'payloads.txt';f.write_text(' leading'+chr(10)+'two'+chr(10)+'two')
 page.locator('input[type=file]').set_input_files(str(f));expect(page.get_by_label('Payload values')).to_have_value(f.read_text())
 page.get_by_role('button',name='Deduplicate').click();expect(page.get_by_label('Payload values')).to_have_value(' leading'+chr(10)+'two')
 page.get_by_role('button',name='Save',exact=True).click();expect(page.locator('.intruder-status')).to_contain_text('saved')
 page.reload();page.get_by_role('tab',name='Payloads',exact=True).click();expect(page.get_by_label('Payload values')).to_have_value(' leading'+chr(10)+'two')
 checks.append('position add/remove/clear, file import, dedup preserves whitespace, save and reload')
 page.get_by_role('tab',name='Positions',exact=True).click();ta.fill(raw.replace('/?u=one&p=two','/gzip?u=§x§'));page.get_by_role('tab',name='Payloads',exact=True).click();page.get_by_label('Payload values').fill('a');page.get_by_label('Grep match').fill('gzip-needle');page.get_by_role('button',name='Start attack',exact=True).click();expect(page.locator('.intruder-status')).to_contain_text('Finished · 1 requests');expect(page.locator('.intruder-table tbody')).to_contain_text('✓')
 row=page.locator('.intruder-table tbody tr').first;row.click(button='right');expect(page.get_by_role('menuitem',name='Copy as Python',exact=True)).to_be_visible();page.keyboard.press('Escape')
 checks.append('gzip body grep match and result right-click menu')
 page.get_by_role('tab',name='Positions',exact=True).click();ta.fill(raw.replace('/?u=one&p=two','/slow?u=§x§'));page.get_by_role('tab',name='Payloads',exact=True).click();page.get_by_label('Payload values').fill(chr(10).join(str(i) for i in range(10)))
 before=len(seen);page.get_by_role('button',name='Start attack',exact=True).click();expect(page.get_by_role('button',name='Save',exact=True)).to_be_disabled();page.get_by_role('button',name='Settings',exact=True).click();time.sleep(.8);assert len(seen)-before<=1,seen[before:]
 checks.append('leaving Intruder stops queued sends; editing/save locked while running')
 t=api('POST','/api/repeater',{'request':{'method':'GET','url':origin+'/long','headers':[{'name':'Host','value':f'127.0.0.1:{up.server_port}'}]}})
 flow=api('POST','/api/repeater/'+t['id']+'/send',{})['flow'];share=api('POST','/api/shares',{'flowId':flow['id']})
 page.goto(share['url']);resp=page.get_by_role('region',name='Response');search=resp.get_by_label('Find in raw');search.fill('needle-at-end');search.press('Enter');expect(resp.locator('mark.cur')).to_contain_text('needle-at-end')
 ctx2=b.new_context(viewport={'width':900,'height':700},reduced_motion='reduce');pg=ctx2.new_page();pg.goto(share['url']);expect(pg.get_by_role('region',name='Request')).to_be_visible();expect(pg.get_by_role('region',name='Response')).to_be_visible();assert pg.evaluate('document.documentElement.scrollWidth<=innerWidth')
 checks.append('search finds content beyond old 200k display cap; 900px and reduced motion usable')
 api('DELETE','/api/shares/'+share['id']);page.reload();expect(page.locator('body')).to_contain_text('expired')
 (OUT/'edge-results.json').write_text(json.dumps(checks,indent=2));print(json.dumps(checks,indent=2));b.close()
up.shutdown()
