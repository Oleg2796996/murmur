import json,asyncio,websockets,urllib.request,sys
T=json.load(urllib.request.urlopen('http://172.23.16.1:9333/json/list')); t=next(x for x in T if x['type']=='page' and 'web.telegram.org' in x['url'])
async def main():
 title=sys.argv[1]
 async with websockets.connect(t['webSocketDebuggerUrl'],max_size=40*1024*1024) as c:
  i=0
  async def cmd(m,p={}):
   nonlocal i;i+=1;await c.send(json.dumps({'id':i,'method':m,'params':p}))
   while 1:
    r=json.loads(await c.recv())
    if r.get('id')==i:return r
  async def js(e):return (await cmd('Runtime.evaluate',{'expression':e,'returnByValue':True}))['result']['result'].get('value')
  print(await js(f'''(()=>{{let h=[...document.querySelectorAll("h3.fullName")].find(e=>e.textContent.includes({json.dumps(title)}));if(!h)return "none";h.click();return h.outerHTML}})()'''),flush=True)
  await asyncio.sleep(5)
  print(await js("JSON.stringify({hash:location.hash,edit:!!document.querySelector('#editable-message-text'),body:document.body.innerText.slice(-300)})"))
asyncio.run(main())
