import json, asyncio, websockets, sys, urllib.request
CDP_HTTP="http://172.23.16.1:9333"
tabs=json.load(urllib.request.urlopen(f"{CDP_HTTP}/json/list",timeout=8))
tg=next(t for t in tabs if t["type"]=="page" and "web.telegram.org" in t["url"])
async def main():
    target=sys.argv[1]
    wait=int(sys.argv[2]) if len(sys.argv)>2 else 15
    async with websockets.connect(tg["webSocketDebuggerUrl"],max_size=40*1024*1024) as c:
        _id=[0]
        async def cmd(method,params=None):
            _id[0]+=1; i=_id[0]
            await c.send(json.dumps({"id":i,"method":method,"params":params or {}}))
            while True:
                r=json.loads(await asyncio.wait_for(c.recv(),60))
                if r.get("id")==i: return r
        async def js(expr):
            r=await cmd("Runtime.evaluate",{"expression":expr,"returnByValue":True})
            return r.get("result",{}).get("result",{}).get("value")
        await cmd("Page.enable")
        await cmd("Page.navigate",{"url":f"https://web.telegram.org/a/#{target}"})
        await asyncio.sleep(wait)
        r=await cmd("Runtime.evaluate",{"expression":"JSON.stringify({hash:location.hash.slice(0,40), header:(document.querySelector('.MiddleHeader')?.textContent||'none').slice(0,60), msgs:document.querySelectorAll('.Message').length})","returnByValue":True})
        print(r["result"]["result"]["value"])
asyncio.run(main())
