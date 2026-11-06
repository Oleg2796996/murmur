import json, asyncio, websockets, sys, urllib.request
CDP_HTTP="http://172.23.16.1:9333"
tabs=json.load(urllib.request.urlopen(f"{CDP_HTTP}/json/list",timeout=8))
tg=next(t for t in tabs if t["type"]=="page" and "web.telegram.org" in t["url"])
async def main():
    # chat ids from state file: -100 prefixed
    ids=json.loads(sys.argv[1])
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
        for cid in ids:
            await js(f"location.hash={json.dumps('#'+cid)}; window.dispatchEvent(new Event('hashchange'))")
            await asyncio.sleep(5)
            hdr=await js("location.hash.split('?')[0].slice(0,40)")
            out=await js("""(function(){
                const msgs=[...document.querySelectorAll('.MiddleColumn .Message')];
                return msgs.slice(-20).map(m=>{
                    const s=m.querySelector('[class*=sender]')?.textContent||'';
                    const b=m.querySelector('[class*=text-content]')?.innerText||'';
                    const t=m.querySelector('time')?.textContent||'';
                    return s+' ['+t+']: '+b.replace(/\\s+/g,' ').slice(0,250);
                }).filter(x=>x.length>6).join('\\n');
            })()""")
            print(f"=== {cid} (hash={hdr})")
            print(out or "EMPTY")
            print(flush=True)
asyncio.run(main())
