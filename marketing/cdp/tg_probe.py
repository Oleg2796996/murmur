import json,urllib.request,websockets,asyncio
tabs=json.load(urllib.request.urlopen("http://172.23.16.1:9333/json/list"))
t=next(x for x in tabs if x["type"]=="page" and "web.telegram.org" in x["url"])
async def main():
 async with websockets.connect(t["webSocketDebuggerUrl"],max_size=40*1024*1024) as c:
  await c.send(json.dumps({"id":1,"method":"Runtime.evaluate","params":{"expression":"JSON.stringify({url:location.href,hash:location.hash,body:document.body.innerText.slice(0,500),edit:!!document.querySelector(\"#editable-message-text\")})","returnByValue":True}}))
  while 1:
   r=json.loads(await c.recv())
   if r.get("id")==1: print(r["result"]["result"].get("value")); break
asyncio.run(main())
