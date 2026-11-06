import json, asyncio, websockets, urllib.request
CDP_HTTP="http://172.23.16.1:9333"
tabs=json.load(urllib.request.urlopen(f"{CDP_HTTP}/json/list",timeout=8))
tg=next(t for t in tabs if t["type"]=="page" and "web.telegram.org" in t["url"])
async def main():
    async with websockets.connect(tg["webSocketDebuggerUrl"],max_size=40*1024*1024) as c:
        async def cmd(method,params=None):
            await c.send(json.dumps({"id":1,"method":method,"params":params or {}}))
            while True:
                r=json.loads(await asyncio.wait_for(c.recv(),40))
                if r.get("id")==1: return r
        r=await cmd("Runtime.evaluate",{"expression":"""(function(){
            const t=document.querySelector('.Transition.full-height');
            return JSON.stringify({
              cls: t? t.className.slice(0,120):null,
              firstChildCls: t&&t.firstElementChild? t.firstElementChild.className.slice(0,100):null,
              txt: t? t.innerText.slice(0,300):null
            });
        })()""","returnByValue":True})
        print(r["result"]["result"]["value"])
asyncio.run(main())
