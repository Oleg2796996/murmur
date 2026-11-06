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
                r=json.loads(await asyncio.wait_for(c.recv(),40))
                if r.get("id")==i: return r
        async def js(expr):
            r=await cmd("Runtime.evaluate",{"expression":expr,"returnByValue":True})
            return r.get("result",{}).get("result",{}).get("value")
        # any message content visible anywhere (chat OR chat list preview)
        mode=await js("""(function(){
            const hasMsgs=document.querySelectorAll('.Message .text-content').length;
            if(hasMsgs>0) return 'CHAT';
            // otherwise check if left list present
            const list=document.querySelector('.left-column, [class*=LeftColumn], [class*=chat-list]');
            return list? 'LIST':'UNKNOWN';
        })()""")
        print("mode:",mode,flush=True)
        if mode=='LIST':
            # list item texts = chat previews; print all
            out=await js("""[...document.querySelectorAll('[class*=chat-item], li')].map(e=>{
                 const t=e.querySelector('[class*=title]')?.textContent||'';
                 const p=e.querySelector('[class*=last-message], [class*=subtitle]')?.textContent||'';
                 return t+' :: '+p.slice(0,120);
            }).filter(x=>x.length>5).join('\\n')""")
            print(out)
            sys.exit(0)
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
