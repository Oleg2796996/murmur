import json, asyncio, websockets, sys, urllib.request
CDP_HTTP="http://172.23.16.1:9333"
tabs=json.load(urllib.request.urlopen(f"{CDP_HTTP}/json/list",timeout=8))
tg=next(t for t in tabs if t["type"]=="page" and "web.telegram.org" in t["url"])
async def main():
    title=sys.argv[1]
    chars=int(sys.argv[2]) if len(sys.argv)>2 else 4000
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
        # find exact title element and print all candidates first
        cands=await js("""(function(){
            const q=%s;
            return [...document.querySelectorAll('[class*=title]')]
              .filter(e=>e.textContent.trim()===q || e.textContent.trim().startsWith(q))
              .map(e=>e.textContent.trim());
        })()""" % json.dumps(title))
        print("candidates:",cands,flush=True)
        res=await js("""(function(){
            const q=%s;
            const titles=[...document.querySelectorAll('[class*=title]')].filter(e=>e.textContent.trim()===q);
            if(!titles.length) return null;
            let row=titles[0];
            for(let i=0;i<8 && row.parentElement;i++){
                const r=row.getBoundingClientRect();
                if(r.height>30 && r.height<100 && r.width>250) break;
                row=row.parentElement;
            }
            const r=row.getBoundingClientRect();
            return JSON.stringify({x:r.x+150,y:r.y+r.height/2,ok:true});
        })()""" % json.dumps(title))
        if not res:
            print("NOT-FOUND"); sys.exit(2)
        p=json.loads(res)
        for t in ["mousePressed","mouseReleased"]:
            await cmd("Input.dispatchMouseEvent",{"type":t,"x":p["x"],"y":p["y"],"button":"left","clickCount":1})
        await asyncio.sleep(5)
        # verify opened chat title in header
        hdr=await js("document.querySelector('.MiddleColumn [class*=header], [class*=ChatInfo]')?.textContent?.slice(0,60)")
        print("header:",hdr,flush=True)
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
