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
        # find the ListItem button and call native click() on the <a>
        res=await js(f"""(function(){{
            const q={json.dumps(title)};
            const h3=[...document.querySelectorAll('.fullName')].find(e=>e.textContent.includes(q));
            if(!h3) return 'no-h3';
            const row=h3.closest('[class*=chat-item-clickable]')||h3.closest('li');
            const btn=row?.querySelector('a.ListItem-button, a')||row;
            if(!btn) return 'no-btn';
            btn.click();
            return 'clicked:'+btn.tagName;
        }})()""")
        print(res,flush=True)
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
