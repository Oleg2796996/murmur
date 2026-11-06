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
        # focus search via Ctrl+K (Telegram Web A shortcut) or input focus
        await cmd("Input.dispatchKeyEvent",{"type":"keyDown","key":"k","code":"KeyK","modifiers":["ctrl"],"windowsVirtualKeyCode":75})
        await cmd("Input.dispatchKeyEvent",{"type":"keyUp","key":"k","code":"KeyK","modifiers":["ctrl"]})
        await asyncio.sleep(1)
        focused=await js("document.activeElement?.tagName + '.' + (document.activeElement?.className||'').slice(0,40)")
        print("focused:",focused,flush=True)
        await cmd("Input.insertText",{"text":query})
        await asyncio.sleep(4)
        # keyboard: ArrowDown selects first result, Enter opens
        for key,code,vk in [("ArrowDown","ArrowDown",40),("Enter","Enter",13)]:
            await cmd("Input.dispatchKeyEvent",{"type":"keyDown","key":key,"code":code,"windowsVirtualKeyCode":vk})
            await cmd("Input.dispatchKeyEvent",{"type":"keyUp","key":key,"code":code,"windowsVirtualKeyCode":vk})
            await asyncio.sleep(0.4)
        await asyncio.sleep(1)
        await cmd("Input.dispatchKeyEvent",{"type":"keyDown","key":"Escape","code":"Escape","windowsVirtualKeyCode":27})
        await cmd("Input.dispatchKeyEvent",{"type":"keyUp","key":"Escape","code":"Escape","windowsVirtualKeyCode":27})
        await asyncio.sleep(4)
        hdr=await js("(document.querySelector('.MiddleColumn [class*=header]')||{}).textContent?.slice(0,60)")
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
