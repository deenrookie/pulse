#!/usr/bin/env python3
"""Run ONLY against an isolated Pulse instance. Exercises full sharing and
Intruder using synthetic traffic, a headed local Chrome, and Python playwright.
Changes test settings, creates test tabs/attacks, and deletes test instance shares.
"""
import json,time,threading,subprocess,urllib.request,base64,os
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from urllib.parse import urlsplit,parse_qs
from playwright.sync_api import sync_playwright,expect
API=os.environ.get('PULSE_TEST_API','http://127.0.0.1:8000');UI=os.environ.get('PULSE_TEST_UI','http://127.0.0.1:5176');OUT=Path(os.environ.get('PULSE_TEST_OUT','/tmp/pulse-r2-verification'));OUT.mkdir(parents=True,exist_ok=True)
seen=[]
class Up(BaseHTTPRequestHandler):
 def do_GET(self):self.reply()
 def do_POST(self):self.reply()
 def reply(self):
  body=self.rfile.read(int(self.headers.get('Content-Length','0')))
  seen.append({'path':self.path,'headers':list(self.headers.items()),'body':base64.b64encode(body).decode()})
  if self.path.startswith('/slow'):time.sleep(.25)
  payload=json.dumps({'path':self.path,'body':base64.b64encode(body).decode(),'message':'needle-response admin','unsafe':'<script>window.BAD=1</script>'}).encode()
  self.send_response(201 if 'b' in parse_qs(urlsplit(self.path).query).get('u',[]) else 200)
  self.send_header('Content-Type','application/json');self.send_header('Set-Cookie','secret=unfiltered');self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
 def log_message(self,*args):pass
up=ThreadingHTTPServer(('127.0.0.1',0),Up);threading.Thread(target=up.serve_forever,daemon=True).start();origin=f'http://127.0.0.1:{up.server_port}'
def api(method,path,data=None):
 r=urllib.request.Request(API+path,method=method,data=json.dumps(data).encode() if data is not None else None,headers={'Content-Type':'application/json'})
 with urllib.request.urlopen(r) as response:return json.load(response)
def request(path):return {'method':'POST','url':origin+path,'httpVersion':'HTTP/1.1','headers':[{'name':'Host','value':f'127.0.0.1:{up.server_port}'},{'name':'Authorization','value':'Bearer original-token'},{'name':'Cookie','value':'key=original-cookie'},{'name':'X-Repeat','value':'one'},{'name':'X-Repeat','value':'two'},{'name':'Content-Length','value':'4'}],'body':base64.b64encode(bytes([0,255,65,10])).decode()}
api('PUT','/api/settings',{'shareIP':'127.0.0.1'})
tab=api('POST','/api/repeater',{'request':request('/first?token=private-query')})
first=api('POST','/api/repeater/'+tab['id']+'/send',{})['flow']
api('POST','/api/repeater/'+tab['id']+'/send',{'request':request('/second')})
checks=[]
with sync_playwright() as p:
 b=p.chromium.launch(channel='chrome',headless=False)
 ctx=b.new_context(viewport={'width':1500,'height':1000},permissions=['clipboard-read','clipboard-write'],accept_downloads=True)
 page=ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(UI+'/#/proxy?flow='+first['id'])
 page.get_by_role('button',name='Share',exact=True).click();dlg=page.get_by_role('dialog',name='Share complete traffic')
 expect(dlg.get_by_role('region',name='Request')).to_contain_text('Bearer original-token')
 expect(dlg.get_by_role('region',name='Response')).to_contain_text('secret=unfiltered')
 assert dlg.locator('input[type=checkbox]').count()==0
 dlg.get_by_role('combobox').select_option('525600')
 dlg.get_by_role('button',name='Create share link').click()
 link=dlg.get_by_label('Share link').input_value()
 with ctx.expect_page() as new:dlg.get_by_role('link',name='Open snapshot').click()
 recipient=new.value;recipient.wait_for_load_state()
 expect(recipient.get_by_role('region',name='Request')).to_contain_text('Bearer original-token')
 expect(recipient.get_by_role('region',name='Response')).to_contain_text('needle-response')
 assert recipient.evaluate('window.BAD') is None
 reqbox=recipient.get_by_role('region',name='Request');respbox=recipient.get_by_role('region',name='Response')
 assert reqbox.bounding_box()['x']<respbox.bounding_box()['x']
 assert reqbox.locator('.raw-hname').count()>0
 search=respbox.get_by_label('Find in raw');search.fill('needle-response');search.press('Enter');expect(respbox.locator('mark.cur')).to_contain_text('needle-response')
 reqbox.locator('pre.raw-lines').click(button='right');recipient.get_by_role('menuitem',name='Copy as Python',exact=True).click()
 python=recipient.evaluate('navigator.clipboard.readText()');(OUT/'copied.py').write_text(python)
 result=subprocess.run(['python3',str(OUT/'copied.py')],capture_output=True,text=True);assert result.returncode==0,result.stderr
 assert seen[-1]['body']==request('')['body'];assert [v for k,v in seen[-1]['headers'] if k=='X-Repeat']==['one','two']
 reqbox.locator('pre.raw-lines').click(button='right');recipient.get_by_role('menuitem',name='Copy as cURL',exact=True).click()
 curl=recipient.evaluate('navigator.clipboard.readText()');result=subprocess.run(curl,shell=True,capture_output=True);assert result.returncode==0,result.stderr
 assert seen[-1]['body']==request('')['body']
 with recipient.expect_download() as download:recipient.get_by_role('link',name='Download complete snapshot').click()
 download.value.save_as(str(OUT/'snapshot.json'));snapshot=json.loads((OUT/'snapshot.json').read_text());assert snapshot['flow']==first
 recipient.screenshot(path=str(OUT/'shared.png'))
 checks.append('full share: exact JSON, binary bodies, duplicate and secret headers, one-year expiry, side-by-side highlight, search, runnable Python/cURL')
 dlg.get_by_role('button',name='Close',exact=True).click();page.goto(UI+'/#/repeater?tab='+tab['id'])
 page.get_by_role('button',name='Previous response',exact=True).click()
 page.get_by_role('button',name='Share exchange',exact=True).click();dlg=page.get_by_role('dialog')
 expect(dlg.get_by_role('region',name='Request')).to_contain_text('/first?token=private-query')
 expect(dlg.get_by_role('region',name='Response')).to_contain_text('/first?token=private-query')
 dlg.get_by_role('button',name='Close',exact=True).click()
 checks.append('Repeater shares selected historic request with its matching response')
 # Repeater context menu sends HTTPS target intact to Intruder.
 https=api('POST','/api/repeater',{'request':{'method':'GET','url':'https://secure.example.test/v1?u=one','headers':[{'name':'Host','value':'secure.example.test'}]}})
 page.goto(UI+'/#/repeater?tab='+https['id']);page.reload();page.locator('[data-tab-id="'+https['id']+'"]').click(button='right');page.get_by_role('menuitem',name='Send to Intruder').click()
 expect(page.get_by_label('Target URL')).to_have_value('https://secure.example.test/v1?u=one')
 checks.append('Send to Intruder preserves HTTPS')
 raw='GET /attack?u=§x§&p=§y§ HTTP/1.1'+chr(10)+f'Host: 127.0.0.1:{up.server_port}'+chr(10)+chr(10)
 page.get_by_label('Target URL').fill(origin);page.get_by_label('Request template').fill(raw)
 page.get_by_label('Attack type').select_option('sniper');page.get_by_role('tab',name='Payloads',exact=True).click();page.get_by_label('Payload values').fill('a'+chr(10)+'b');page.get_by_label('Grep match').fill('needle-response')
 before=len(seen);page.get_by_role('button',name='Start attack',exact=True).click();expect(page.locator('.intruder-status')).to_contain_text('Finished · 4 requests')
 paths=[x['path'] for x in seen[before:]];assert paths==['/attack?u=a&p=y','/attack?u=b&p=y','/attack?u=x&p=a','/attack?u=x&p=b'],paths
 assert page.locator('.intruder-table tbody tr').count()==4;expect(page.locator('.intruder-table tbody')).to_contain_text('✓')
 page.get_by_label('Search results').fill('201');assert page.locator('.intruder-table tbody tr').count()==1;page.get_by_label('Search results').fill('')
 page.get_by_role('button',name='Length').click();page.locator('.intruder-table tbody tr').first.click()
 expect(page.get_by_role('region',name='Request')).to_be_visible();expect(page.get_by_role('region',name='Response')).to_be_visible()
 page.screenshot(path=str(OUT/'intruder-results.png'))
 checks.append('Sniper sends each position separately, grep decodes body, results filter/sort and left/right inspector work')
 page.get_by_role('tab',name='Positions',exact=True).click();page.get_by_label('Attack type').select_option('battering-ram');before=len(seen)
 page.get_by_role('button',name='Start attack',exact=True).click();expect(page.locator('.intruder-status')).to_contain_text('Finished · 2 requests')
 assert [x['path'] for x in seen[before:]]==['/attack?u=a&p=a','/attack?u=b&p=b']
 checks.append('Battering ram replaces every position with the same payload')
 page.get_by_role('tab',name='Positions',exact=True).click();page.get_by_label('Attack type').select_option('pitchfork');page.get_by_role('tab',name='Payloads',exact=True).click()
 page.get_by_label('Payload values').fill('a'+chr(10)+'b');page.get_by_label('Payload set',exact=True).select_option(index=1);page.get_by_label('Payload values').fill('one'+chr(10)+'two');before=len(seen)
 page.get_by_role('button',name='Start attack',exact=True).click();expect(page.locator('.intruder-status')).to_contain_text('Finished · 2 requests')
 assert [x['path'] for x in seen[before:]]==['/attack?u=a&p=one','/attack?u=b&p=two'], [x['path'] for x in seen[before:]]
 checks.append('Pitchfork uses the corresponding payload set for each position')
 page.get_by_role('tab',name='Positions',exact=True).click();page.get_by_label('Request template').fill(raw.replace('/attack','/slow'));page.get_by_label('Attack type').select_option('battering-ram');page.get_by_role('tab',name='Payloads',exact=True).click();page.get_by_label('Payload values').fill(chr(10).join(str(i) for i in range(20)))
 before=len(seen);page.get_by_role('button',name='Start attack',exact=True).click();page.get_by_role('button',name='Stop attack',exact=True).click();expect(page.locator('.intruder-status')).to_contain_text('Stopped')
 assert len(seen)-before<20
 page.get_by_role('tab',name='Positions',exact=True).click();page.get_by_label('Request template').fill(raw+'§');page.get_by_role('button',name='Start attack',exact=True).click();expect(page.get_by_role('alert')).to_contain_text('balanced')
 checks.append('Stop halts remaining requests; unbalanced markers are rejected')
 assert not errors,errors
 (OUT/'ui-results.json').write_text(json.dumps(checks,indent=2));print(json.dumps(checks,indent=2))
 b.close()
up.shutdown()
for item in api('GET','/api/shares')['shares']: api('DELETE','/api/shares/'+item['id'])
