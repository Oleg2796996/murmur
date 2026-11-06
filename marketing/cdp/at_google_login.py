import time, sys
from camoufox.sync_api import Camoufox

PROFILE = "/home/oleg/camoufox/murmur-promo-profile"
EMAIL = "ok2796996@gmail.com"
PASSWORD = "Pa$ha78593042"

def log(*a):
    print(*a, flush=True)

with Camoufox(headless=True, persistent_context=True, user_data_dir=PROFILE, os="windows", i_know_what_im_doing=True, timeout=90000) as ctx:
    pg = ctx.pages[0] if ctx.pages else ctx.new_page()

    # перехват popup (OAuth открывается в новом окне)
    popups = []
    def on_page(p):
        popups.append(p)
        log("POPUP-OPENED:", p.url[:80])
    ctx.on("page", on_page)

    log("step1: открытие alternativeto.net/login/")
    pg.goto("https://alternativeto.net/login/", timeout=90000, wait_until="domcontentloaded")
    pg.wait_for_timeout(4000)

    # ищем кнопку Google
    btn = pg.query_selector('a[href*="google"]') or pg.query_selector('button:has-text("Google")') or pg.query_selector('[class*="google"]')
    if not btn:
        log("step1 FAIL: кнопка Google не найдена")
        log(pg.evaluate("() => Array.from(document.querySelectorAll('a,button')).map(e=>e.textContent.trim()+'|'+(e.href||'')).filter(t=>t.length>2).join('\\n')")[:800])
        sys.exit(1)
    log("step2: клик по Google-кнопке")
    btn.click()
    pg.wait_for_timeout(5000)

    # работаем с popup
    gpage = None
    for _ in range(10):
        for p in popups:
            if "accounts.google.com" in p.url:
                gpage = p
                break
        if gpage:
            break
        pg.wait_for_timeout(2000)
    if not gpage:
        # может, OAuth открылся в той же вкладке
        if "accounts.google.com" in pg.url:
            gpage = pg
        else:
            log("step2 FAIL: нет accounts.google.com; popup urls:", [p.url[:60] for p in popups], "main:", pg.url[:80])
            sys.exit(1)

    log("step3: Google-страница:", gpage.url[:90])
    gpage.wait_for_timeout(3000)

    # email
    email_field = gpage.query_selector('input[type="email"]')
    if email_field:
        log("step4: ввожу email")
        email_field.fill(EMAIL)
        gpage.wait_for_timeout(800)
        gpage.keyboard.press("Enter")
        gpage.wait_for_timeout(5000)
    else:
        log("step4: поля email нет, url:", gpage.url[:90])

    log("step5 состояние после email:", gpage.url[:90])

    # password
    pw_field = None
    for _ in range(6):
        pw_field = gpage.query_selector('input[type="password"]:visible')
        if pw_field:
            break
        gpage.wait_for_timeout(2000)
    if pw_field:
        log("step6: ввожу пароль")
        pw_field.fill(PASSWORD)
        gpage.wait_for_timeout(800)
        gpage.keyboard.press("Enter")
        gpage.wait_for_timeout(6000)
    else:
        log("step6 FAIL: поля пароля нет")
        log("page text:", gpage.evaluate("() => document.body.innerText.slice(0,500)"))
        gpage.screenshot(path="/tmp/gauth-state.png")
        sys.exit(1)

    log("step7 состояние после пароля:", gpage.url[:90])
    txt = gpage.evaluate("() => document.body.innerText.slice(0,400)")
    log("step7 text:", txt.replace("\n", " | ")[:300])

    # возможные промежуточные экраны (2FA/подтверждение) — просто логируем
    for i in range(12):
        gpage.wait_for_timeout(5000)
        u = gpage.url
        if "accounts.google.com" not in u:
            log("step8: OAuth завершён →", u[:90])
            break
        if i in (0, 5, 11):
            log(f"step8-wait[{i}]:", u[:90])
            log("text:", gpage.evaluate("() => document.body.innerText.slice(0,300)").replace("\n", " | ")[:250])

    pg.wait_for_timeout(4000)
    state = pg.evaluate("""() => {
        const t = document.body.innerText.slice(0, 4000);
        return { url: location.href, logout: /log ?out/i.test(t), signin: !!document.querySelector('a[href="/login/"]') };
    }""")
    log("RESULT:", state)
    pg.screenshot(path="/tmp/at-after-login.png")
