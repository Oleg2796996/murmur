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
        res=await js("""(function(){
            const q=%s;
            const titles=[...document.querySelectorAll('[class*=title]')].filter(e=>e.textContent.trim()===q);
            if(!titles.length) return null;
            const r=titles[0].getBoundingClientRect();
            return JSON.stringify({x:r.x+Math.min(120,r.width/2), y:r.y+r.height/2, vis:r.width>0});
        })()""" % json.dumps(title))
        if not res:
            print("NOT-FOUND"); sys.exit(2)
        p=json.loads(res)
        print("click at",int(p["x"]),int(p["y"]),flush=True)
        await cmd("Input.dispatchMouseEvent",{"type":"mouseMoved","x":p["x"],"y":p["y"]})
        await asyncio.sleep(0.3)
        await cmd("Input.dispatchMouseEvent",{"type":"mousePressed","x":p["x"],"y":p["y"],"button":"left","clickCount":1})
        await asyncio.sleep(0.15)
        await cmd("Input.dispatchMouseEvent",{"type":"mouseReleased","x":p["x"],"y":p["y"],"button":"left","clickCount":1})
        await asyncio.sleep(5)
        hdr=await js("document.querySelector('.MiddleColumn')?.querySelector('[class*=header], [class*=topbar]')?.textContent?.slice(0,50) || document.querySelector('.MiddleColumn')?.innerText.slice(0,80)")
        print("header:",hdr,flush=True)
        if send:
            ok=await js("var e=document.querySelector('#editable-message-text'); e.focus(); 'ok'")
            await asyncio.sleep(0.5)
            await cmd("Input.insertText",{"text":send})
            await asyncio.sleep(1)
            await cmd("Input.dispatchKeyEvent",{"type":"keyDown","key":"Enter","code":"Enter","windowsVirtualKeyCode":13})
            await cmd("Input.dispatchKeyEvent",{"type":"keyUp","key":"Enter","code":"Enter","windowsVirtualKeyCode":13})
            await asyncio.sleep(2)
            print("SENT",flush=True)
        out=await js("""(function(){
            const msgs=[...document.querySelectorAll('.MiddleColumn .Message')];
            return msgs.slice(-25).map(m=>{
                const s=m.querySelector('[class*=sender]')?.textContent||'';
                const b=m.querySelector('[class*=text-content]')?.innerText||'';
                const t=m.querySelector('time')?.textContent||'';
                return s+' ['+t+']: '+b.replace(/\\s+/g,' ').slice(0,250);
            }).filter(x=>x.length>6).join('\\n');
        })()""")
        print("MSGS>>>")
        print(out or "EMPTY")
asyncio.run(main())
