import asyncio
from camoufox.async_api import AsyncCamoufox

PROFILE = "/home/oleg/camoufox/murmur-promo-profile"

async def main():
    async with AsyncCamoufox(headless=True, persistent_context=True, user_data_dir=PROFILE, os="windows", i_know_what_im_doing=True) as ctx:
        pg = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await pg.goto("https://alternativeto.net/", timeout=60000, wait_until="domcontentloaded")
        await pg.wait_for_timeout(4000)
        # признак логина: аватар/меню пользователя
        logged = await pg.evaluate("""() => {
            const t = document.body.innerText;
            return {
                hasLoginLink: /log ?in|sign ?in/i.test(t.slice(0,3000)),
                hasAccount: /my ?account|log ?out/i.test(t.slice(0,3000)),
                title: document.title
            };
        }""")
        print("state:", logged)
        await pg.screenshot(path="/tmp/at-state.png")
        # cloudflare?
        cf = await pg.evaluate("() => document.body.innerText.slice(0,300)")
        print("top text:", cf[:200].replace("\n"," | "))
        await pg.close()

asyncio.run(main())
