import json, asyncio, websockets, sys, urllib.request
CDP_HTTP="http://172.23.16.1:9333"
tabs=json.load(urllib.request.urlopen(f"{CDP_HTTP}/json/list",timeout=8))
tg=next(t for t in tabs if t["type"]=="page" and "web.telegram.org" in t["url"])
async def main():
    q=sys.argv[1]
    async with websockets.connect(tg["webSocketDebuggerUrl"],max_size=40*1024*1024) as c:
        async def cmd(method,params=None):
            await c.send(json.dumps({"id":1,"method":method,"params":params or {}}))
            while True:
                r=json.loads(await asyncio.wait_for(c.recv(),40))
                if r.get("id")==1: return r
        r=await cmd("Runtime.evaluate",{"expression":json.dumps(f"""(function(){{
            const q={json.dumps(q)};
            // find the deepest element containing q
            const all=[...document.querySelectorAll('*')].filter(e=>e.textContent.includes(q));
            const deep=all.filter(e=>!all.some(o=>o!==e && e.contains(o)));
            return JSON.stringify(deep.slice(0,5).map(e=>({{
                tag:e.tagName, cls:(e.className||'').toString().slice(0,80),
                rect:(r=>({{x:r.x,y:r.y,w:r.width,h:r.height}}))(e.getBoundingClientRect()),
                hasTitleChild: !!e.querySelector('[class*=title]')
            }})));
        }})()"""), "returnByValue":True})
        # the expression was double-wrapped; simpler:
        r2=await cmd("Runtime.evaluate",{"expression":f"""(function(){{
            const q={json.dumps(q)};
            const all=[...document.querySelectorAll('*')].filter(e=>e.textContent.includes(q));
            const deep=all.filter(e=>!all.some(o=>o!==e && e.contains(o)));
            return JSON.stringify(deep.slice(0,5).map(e=>({{
                tag:e.tagName, cls:(e.className||'').toString().slice(0,80),
                x:Math.round(e.getBoundingClientRect().x), y:Math.round(e.getBoundingClientRect().y),
                w:Math.round(e.getBoundingClientRect().width), h:Math.round(e.getBoundingClientRect().height)
            }})));
        }})()""","returnByValue":True})
        print(r2["result"]["result"]["value"])
asyncio.run(main())
