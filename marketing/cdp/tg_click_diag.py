import json, asyncio, websockets, sys, urllib.request
CDP_HTTP="http://172.23.16.1:9333"
tabs=json.load(urllib.request.urlopen(f"{CDP_HTTP}/json/list",timeout=8))
tg=next(t for t in tabs if t["type"]=="page" and "web.telegram.org" in t["url"])
async def main():
    title=sys.argv[1]
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
        # what is at click point? elementFromPoint
        diag=await js(f"""(function(){{
            const q={json.dumps(title)};
            const h3=[...document.querySelectorAll('.fullName')].find(e=>e.textContent.includes(q));
            if(!h3) return 'no-h3';
            const r=h3.getBoundingClientRect();
            const x=r.x+60, y=r.y+r.height/2;
            const el=document.elementFromPoint(x,y);
            // climb parents
            let chain=[]; let e=el;
            for(let i=0;i<6&&e;i++){{chain.push(e.tagName+'.'+((e.className||'').toString().slice(0,40)));e=e.parentElement;}}
            return JSON.stringify({{x,y,chain}});
        }})()""")
        print("diag:",diag,flush=True)
        d=json.loads(diag)
        for t in ["mousePressed","mouseReleased"]:
            await cmd("Input.dispatchMouseEvent",{"type":t,"x":d["x"],"y":d["y"],"button":"left","clickCount":1})
        await asyncio.sleep(6)
        st=await js("""JSON.stringify({
            hash: location.hash.slice(0,40),
            header: (document.querySelector('.MiddleHeader')?.textContent||'none').slice(0,40),
            msgCount: document.querySelectorAll('.Message').length,
            activeCls: (document.querySelector('.Transition_slide-active')?.className||'').slice(0,100)
        })""")
        print("state:",st)
asyncio.run(main())
