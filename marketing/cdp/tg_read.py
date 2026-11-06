import json, asyncio, websockets, sys, urllib.request
CDP_HTTP="http://172.23.16.1:9333"
tabs=json.load(urllib.request.urlopen(f"{CDP_HTTP}/json/list",timeout=8))
tg=next(t for t in tabs if t["type"]=="page" and "web.telegram.org" in t["url"])

async def main():
    title=sys.argv[1]
    chars=int(sys.argv[2]) if len(sys.argv)>2 else 4000
    send=sys.argv[3] if len(sys.argv)>3 else None
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

        # click chat row by title (mousedown+mouseup+click for React)
        res=await js(f"""(function(){{
            const q={json.dumps(title)}.toLowerCase();
            const rows=[...document.querySelectorAll('[class*=chat-item-clickable], [class*=ListItem], li')];
            const row=rows.reverse().find(e=>e.textContent.toLowerCase().includes(q) && e.getBoundingClientRect().width>200 && e.getBoundingClientRect().height>30 && e.getBoundingClientRect().height<120);
            if(!row) return 'ROW-NOT-FOUND';
            const r=row.getBoundingClientRect();
            return JSON.stringify({{x:r.x+Math.min(r.width/2,250), y:r.y+r.height/2, txt:row.textContent.slice(0,50)}});
        }})()""")
        if not res or res=="ROW-NOT-FOUND":
            print("ROW-NOT-FOUND — try search"); sys.exit(2)
        p=json.loads(res)
        print("target:",p["txt"],flush=True)
        for t in ["mousePressed","mouseReleased"]:
            await cmd("Input.dispatchMouseEvent",{"type":t,"x":p["x"],"y":p["y"],"button":"left","clickCount":1})
        await asyncio.sleep(5)

        if send:
            ok=await js("document.querySelector('#editable-message-text')?.focus(); !!document.querySelector('#editable-message-text')")
            await asyncio.sleep(0.6)
            await cmd("Input.insertText",{"text":send})
            await asyncio.sleep(1)
            await cmd("Input.dispatchKeyEvent",{"type":"keyDown","key":"Enter","code":"Enter","windowsVirtualKeyCode":13})
            await cmd("Input.dispatchKeyEvent",{"type":"keyUp","key":"Enter","code":"Enter","windowsVirtualKeyCode":13})
            await asyncio.sleep(2)
            print("SENT.",flush=True)

        mid=await js("(document.querySelector('.MiddleColumn')||{innerText:''}).innerText") or ""
        print("MID>>>")
        print(mid[-chars:])
asyncio.run(main())
