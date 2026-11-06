import json, asyncio, websockets, sys, urllib.request
CDP_HTTP="http://172.23.16.1:9333"
tabs=json.load(urllib.request.urlopen(f"{CDP_HTTP}/json/list",timeout=8))
tg=next(t for t in tabs if t["type"]=="page" and "web.telegram.org" in t["url"])
async def main():
    chars=int(sys.argv[1]) if len(sys.argv)>1 else 5000
    async with websockets.connect(tg["webSocketDebuggerUrl"],max_size=40*1024*1024) as c:
        _id=[0]
        async def cmd(method,params=None):
            _id[0]+=1; i=_id[0]
            await c.send(json.dumps({"id":i,"method":method,"params":params or {}}))
            while True:
                r=json.loads(await asyncio.wait_for(c.recv(),30))
                if r.get("id")==i: return r
        async def js(expr):
            r=await cmd("Runtime.evaluate",{"expression":expr,"returnByValue":True})
            return r.get("result",{}).get("result",{}).get("value")
        await asyncio.sleep(3)
        out=await js("""(function(){
            const m=document.querySelector('.MiddleColumn, [class*=middle], [id*=Middle], [class*=chat] > div');
            const all=[...document.querySelectorAll('div')].filter(d=>d.getBoundingClientRect().width>500 && d.getBoundingClientRect().height>400 && d.innerText.length>500);
            all.sort((a,b)=>a.innerText.length-b.innerText.length);
            return JSON.stringify({sel1: m? m.innerText.slice(0,200):'none',
              bigBlocks: all.slice(0,4).map(e=>({cls:(e.className||'').toString().slice(0,60), len:e.innerText.length}))});
        })()""")
        print(out)
asyncio.run(main())
