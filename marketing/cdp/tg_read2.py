import json, asyncio, websockets, sys, urllib.request
CDP_HTTP="http://172.23.16.1:9333"
tabs=json.load(urllib.request.urlopen(f"{CDP_HTTP}/json/list",timeout=8))
tg=next(t for t in tabs if t["type"]=="page" and "web.telegram.org" in t["url"])

async def main():
    title=sys.argv[1]          # exact substring, case-sensitive
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
        # row whose TITLE element (not last message) matches
        res=await js(f"""(function(){{
            const q={json.dumps(title)};
            const titles=[...document.querySelectorAll('[class*=title]')].filter(e=>e.textContent.includes(q) && e.children.length<=2);
            if(!titles.length) return null;
            // climb to the clickable row
            let row=titles[0];
            for(let i=0;i<6 && row.parentElement;i++){{
                if(row.getBoundingClientRect().height>30 && row.getBoundingClientRect().height<100 && row.getBoundingClientRect().width>250) break;
                row=row.parentElement;
            }}
            const r=row.getBoundingClientRect();
            return JSON.stringify({{x:r.x+150, y:r.y+r.height/2, txt:titles[0].textContent.slice(0,40)}});
        }})()""")
        if not res:
            print("NOT-FOUND"); sys.exit(2)
        p=json.loads(res)
        print("open:",p["txt"],flush=True)
        for t in ["mousePressed","mouseReleased"]:
            await cmd("Input.dispatchMouseEvent",{"type":t,"x":p["x"],"y":p["y"],"button":"left","clickCount":1})
        await asyncio.sleep(5)
        if send:
            ok=await js("document.querySelector('#editable-message-text').focus(); 'ok'")
            await asyncio.sleep(0.5)
            await cmd("Input.insertText",{"text":send})
            await asyncio.sleep(1)
            await cmd("Input.dispatchKeyEvent",{"type":"keyDown","key":"Enter","code":"Enter","windowsVirtualKeyCode":13})
            await cmd("Input.dispatchKeyEvent",{"type":"keyUp","key":"Enter","code":"Enter","windowsVirtualKeyCode":13})
            await asyncio.sleep(2)
            print("SENT:",send[:60],"...",flush=True)
        out=await js("""(function(){
            const msgs=[...document.querySelectorAll('.Message')];
            return msgs.slice(-30).map(m=>{
                const s=m.querySelector('[class*=sender]')?.textContent||'';
                const b=m.querySelector('[class*=text-content]')?.innerText||'';
                const t=m.querySelector('time')?.textContent||'';
                return s+' ['+t+']: '+b.replace(/\\s+/g,' ').slice(0,250);
            }).filter(x=>x.length>6).join('\\n---\\n');
        })()""")
        print("MSGS>>>")
        print(out or "EMPTY")
asyncio.run(main())
