import json,asyncio,websockets,urllib.request
T=json.load(urllib.request.urlopen('http://172.23.16.1:9333/json/list')); t=next(x for x in T if x['type']=='page' and 'web.telegram.org' in x['url'])
async def main():
 async with websockets.connect(t['webSocketDebuggerUrl'],max_size=40*1024*1024) as c:
  i=0
  async def js(e):
   nonlocal i;i+=1;await c.send(json.dumps({'id':i,'method':'Runtime.evaluate','params':{'expression':e,'returnByValue':True}}))
   while 1:
    r=json.loads(await c.recv())
    if r.get('id')==i:return r['result']['result'].get('value')
  print(await js("JSON.stringify([...document.querySelectorAll('*')].filter(e=>e.textContent.trim()==='GrapheneOS').slice(0,3).map(e=>({tag:e.tagName,cls:(e.className||'').toString(),outer:e.outerHTML.slice(0,400)})))"))
asyncio.run(main())
