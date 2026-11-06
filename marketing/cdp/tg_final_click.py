import json, asyncio, websockets, sys, urllib.request
CDP_HTTP="http://172.23.16.1:9333"
tabs=json.load(urllib.request.urlopen(f"{CDP_HTTP}/json/list",timeout=8))
tg=next(t for t in tabs if t["type"]=="page" and "web.telegram.org" in t["url"])
async def main():
    title=sys.argv[1]
    chars=int(sys.argv[2]) if len(sys.argv)>2 else 4500
    send=sys.argv[3] if len(sys.argv)>3 else None
    async with websockets.connect(tg["webSocketDebuggerUrl"],max_size=40*1024*1024) as c:
        _id=[0]
        async def cmd(method,params=None):
            _id[0]+=1; i=_id[0]
            await c.send(json.dumps({"id":i,"method":method,"params":params or {}}))
            while True:
                r=json.loads(await asyncio.wait_for(c.recv(),40))
                if r.get("id")==i: return r
        async def js(expr):
            r=await cmd("Runtime.evaluate",{"expression":expr,"returnByValue":True})
            return r.get("result",{}).get("result",{}).get("value")
        pos=await js(f"""(function(){{
            const q={json.dumps(title)};
            const h3=[...document.querySelectorAll('h3.fullName, .fullName')].find(e=>e.textContent.includes(q));
            if(!h3) return null;
            const r=h3.getBoundingClientRect();
            return JSON.stringify({{x:r.x+60, y:r.y+r.height/2}});
        }})()""")
        if not pos:
            print("NOT-FOND"); sys.exit(2)
        p=json.loads(pos)
        print("click:",int(p["x"]),int(p["y"]),flush=True)
        await cmd("Input.dispatchMouseEvent",{"type":"mouseMoved","x":p["x"],"y":p["y"]})
        await asyncio.sleep(0.2)
        await cmd("Input.dispatchMouseEvent",{"type":"mousePressed","x":p["x"],"y":p["y"],"button":"left","clickCount":1})
        await asyncio.sleep(0.12)
        await cmd("Input.dispatchMouseEvent",{"type":"mouseReleased","x":p["x"],"y":p["y"],"button":"left","clickCount":1})
        await asyncio.sleep(6)
        if send:
            ok=await js("(function(){const e=document.querySelector('#editable-message-text'); if(!e) return 'no-editor'; e.focus(); return 'ok';})()")
            print("editor:",ok,flush=True)
            await asyncio.sleep(0.5)
            await cmd("Input.insertText",{"text":send})
            await asyncio.sleep(1.2)
            await cmd("Input.dispatchKeyEvent",{"type":"keyDown","key":"Enter","code":"Enter","windowsVirtualKeyCode":13})
            await cmd("Input.dispatchKeyEvent",{"type":"keyUp","key":"Enter","code":"Enter","windowsVirtualKeyCode":13})
            await asyncio.sleep(2.5)
            print("SENT",flush=True)
        out=await js("""(function(){
            const msgs=[...document.querySelectorAll('.Message')];
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
