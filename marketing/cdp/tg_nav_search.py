import json, asyncio, websockets, sys, urllib.request
CDP_HTTP="http://172.23.16.1:9333"
tabs=json.load(urllib.request.urlopen(f"{CDP_HTTP}/json/list",timeout=8))
tg=next(t for t in tabs if t["type"]=="page" and "web.telegram.org" in t["url"])
async def main():
    query=sys.argv[1]
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
        # focus search input
        ok=await js("var i=document.querySelector('input.form-control[placeholder=Search]'); i.focus(); 'ok'")
        await asyncio.sleep(0.5)
        # clear
        await cmd("Input.dispatchKeyEvent",{"type":"keyDown","key":"a","code":"KeyA","modifiers":["ctrl"],"windowsVirtualKeyCode":65})
        await cmd("Input.dispatchKeyEvent",{"type":"keyUp","key":"a","code":"KeyA","modifiers":["ctrl"]})
        await cmd("Input.dispatchKeyEvent",{"type":"keyDown","key":"Backspace","code":"Backspace","windowsVirtualKeyCode":8})
        await cmd("Input.dispatchKeyEvent",{"type":"keyUp","key":"Backspace","code":"Backspace"})
        await asyncio.sleep(0.3)
        await cmd("Input.insertText",{"text":query})
        await asyncio.sleep(4)
        # click first search result (global chats section)
        res=await js("""(function(){
            const items=[...document.querySelectorAll('.chat-item-clickable')];
            if(!items.length) return null;
            const r=items[0].getBoundingClientRect();
            return JSON.stringify({x:r.x+r.width/2, y:r.y+r.height/2, txt:items[0].textContent.slice(0,40)});
        })()""")
        if not res:
            print("NO-RESULTS"); sys.exit(2)
        p=json.loads(res)
        print("result:",p["txt"],flush=True)
        await cmd("Input.dispatchMouseEvent",{"type":"mousePressed","x":p["x"],"y":p["y"],"button":"left","clickCount":1})
        await cmd("Input.dispatchMouseEvent",{"type":"mouseReleased","x":p["x"],"y":p["y"],"button":"left","clickCount":1})
        # close search overlay
        await asyncio.sleep(1.5)
        await cmd("Input.dispatchKeyEvent",{"type":"keyDown","key":"Escape","code":"Escape","windowsVirtualKeyCode":27})
        await cmd("Input.dispatchKeyEvent",{"type":"keyUp","key":"Escape","code":"Escape"})
        await asyncio.sleep(4)
        hdr=await js("document.querySelector('.MiddleColumn [class*=header]')?.textContent?.slice(0,60)")
        print("header:",hdr,flush=True)
        if send:
            await js("document.querySelector('#editable-message-text').focus()")
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
