import time
from camoufox.sync_api import Camoufox

PROFILE = "/home/oleg/camoufox/murmur-promo-profile"

with Camoufox(headless=False, persistent_context=True, user_data_dir=PROFILE, os="windows", i_know_what_im_doing=True) as ctx:
    pg = ctx.pages[0] if ctx.pages else ctx.new_page()
    try:
        pg.goto("https://alternativeto.net/login/", timeout=60000, wait_until="domcontentloaded")
    except Exception as e:
        print("goto:", e, flush=True)
    print("WINDOW-OPEN: логиньтесь, окно закроется через 15 минут", flush=True)
    for i in range(90):
        time.sleep(10)
        try:
            has_logout = pg.evaluate("() => /log ?out/i.test(document.body.innerText.slice(0,3000))")
            has_signin = pg.evaluate("() => !!document.querySelector('a[href=\"/login/\"]')")
            if has_logout and not has_signin:
                print(f"[{i}] LOGGED-IN (logout present, signin gone)", flush=True)
                pg.wait_for_timeout(60000)
                break
        except Exception:
            pass
    print("WINDOW-CLOSING", flush=True)
