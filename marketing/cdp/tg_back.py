import json, asyncio, websockets, urllib.request
CDP_HTTP="http://172.23.16.1:9333"
tabs=json.load(urllib.request.urlopen(f"{CDP_HTTP}/json/list",timeout=8))
tg=next(t for t in tabs if t["type"]=="page" and "web.telegram.org" in t["url"])
async def main():
    async with websockets.connect(tg["webSocketDebuggerUrl"],max_size=40*1024*1024) as c:
        _id=[0]
        async def cmd(method,params=None):
            _id[0]+=1; i=_id[0]
            await c.send(json.dumps({"id":i,"method":method,"params":params or {}}))
            while True:
                r=json.loads(await asyncio.wait_for(c.recv(),30))
                if r.get("id")==i: return r
        # back to main screen
        await cmd("Input.dispatchKeyEvent",{"type":"keyDown","key":"Escape","code":"Escape","windowsVirtualKeyCode":27})
        await cmd("Input.dispatchKeyEvent",{"type":"keyUp","key":"Escape","code":"Escape","windowsVirtualKeyCode":27})
        await asyncio.sleep(2)
        r=await cmd("Runtime.evaluate",{"expression":"(document.querySelector('.MiddleHeader')?.textContent||'none').slice(0,60)","returnByValue":True})
        print(r["result"]["result"]["value"])
asyncio.run(main())
