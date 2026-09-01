#!/usr/bin/env python3
"""v160i iPhone-симуляция: полный invite→PWA флоу на WebKit (движок Safari).

Фазы:
1. Safari-режим: открываем /invite/<npub> как обычную страницу (не standalone):
   - inline-скрипт должен свапнуть манифест на /manifest/<npub>.json
   - inline-скрипт должен поставить cookie murmur_invite=<npub>
   - app.js должен показать лендинг (не identity-карточку)
2. «A2HS»: открываем НОВЫЙ контекст (изолированное хранилище, как PWA-контейнер iOS),
   но cookie переписываем вручную из Safari-контекста (симуляция общих cookie iOS).
   PWA-старт: открываем / как standalone (start_url сценарий):
   - если манифест-механизм сработал, iOS бы открыл /invite/<npub>; мы симулируем
     ОБА варианта: (a) start_url дошёл → /invite/<npub>; (b) iOS обрезал → / + cookie-мост.
3. Проверяем: лендинг/чат, создание аккаунта, авто-открытие чата с inviter'ом.
"""
import asyncio, json, sys
from playwright.async_api import async_playwright

MURMUR = "https://murmur.senswifi.ru"
INVITE = "npub1simtest" + "a1b2c3d4e5f6g7h8"  # тестовый peer (не валидный bech32 — парсер пропускает по [a-z0-9]+)

async def main():
    results = {}
    async with async_playwright() as pw:
        # WebKit = движок Safari
        iphone = pw.devices["iPhone 13"]
        browser = await pw.webkit.launch(headless=True)

        # ── Фаза 1: Safari (не-standalone), юзер открывает invite-ссылку ──
        ctx_safari = await browser.new_context(**iphone, locale="ru-RU")
        page = await ctx_safari.new_page()
        logs = []
        page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
        await page.goto(f"{MURMUR}/invite/{INVITE}", wait_until="networkidle", timeout=60000)

        manifest_href = await page.evaluate("document.querySelector('link[rel=manifest]')?.href || null")
        cookie = await ctx_safari.cookies(MURMUR)
        cookie_map = {c["name"]: c["value"] for c in cookie}
        landing_visible = await page.evaluate("!!document.getElementById('invite-landing')")
        identity_hidden = await page.evaluate(
            "(()=>{const c=document.querySelector('#identity-screen .identity-card');return c? c.style.display==='none' : null})()"
        )
        results["safari"] = {
            "url": page.url,
            "manifest_href": manifest_href,
            "cookie_murmur_invite": cookie_map.get("murmur_invite") if (cookie_map := cookie_map) else None,
            "landing_visible": landing_visible,
            "identity_card_hidden": identity_hidden,
        }

        # ── Фаза 2: PWA-старт. Симулируем 2 сценария в изолированном контексте ──
        # (a) iOS передал start_url=/invite/<npub> (манифест-механизм сработал)
        ctx_pwa = await browser.new_context(**{**iphone, "is_mobile": True}, locale="ru-RU")
        # Переносим cookie из Safari (симуляция общего cookie-jar iOS)
        await ctx_pwa.add_cookies([
            {"name": "murmur_invite", "value": INVITE, "url": MURMUR, "sameSite": "Lax"}
        ])
        pwa = await ctx_pwa.new_page()
        pwa_logs = []
        pwa.on("console", lambda m: pwa_logs.append(f"[{m.type}] {m.text}"))
        # Вариант (a): start_url дошёл
        await pwa.goto(f"{MURMUR}/invite/{INVITE}", wait_until="networkidle", timeout=60000)
        await pwa.wait_for_timeout(2000)
        screen_state = await pwa.evaluate("""
            (()=>({
                landing: !!document.getElementById('invite-landing'),
                identityScreenVisible: (()=>{const s=document.getElementById('identity-screen'); return s? (s.offsetParent!==null || s.style.display!=='none') : false})(),
                messengerVisible: (()=>{const m=document.querySelector('.messenger'); return m? m.classList.contains('active') : false})(),
                createBtn: !!document.getElementById('btn-create'),
                visibleScreens: Array.from(document.querySelectorAll('[id$="-screen"], .identity-card')).map(e=>({id:e.id||null, disp:e.style.display, vis:e.offsetParent!==null}))
            }))()
        """)
        results["pwa_a_starturl"] = {
            "url_after": pwa.url,
            "screen_state": screen_state,
        }
        # Headless WebKit не standalone → лендинг показан. Симулием юзера:
        # прочитал инструкцию → жмёт primary-кнопку лендинга → видит «Создать».
        landing_btn = pwa.locator("#invite-landing button.primary")
        if await landing_btn.count() > 0:
            await landing_btn.first.click()
            await pwa.wait_for_timeout(500)
        create_visible = await pwa.evaluate(
            "(()=>{const b=document.getElementById('btn-create');return b? b.offsetParent!==null : false})()"
        )
        if create_visible:
            await pwa.click("#btn-create")
            await pwa.wait_for_timeout(4000)
        contacts = await pwa.evaluate("(typeof contacts !== 'undefined') ? Object.keys(contacts) : []")
        chat_open = await pwa.evaluate(
            "(()=>{const h=document.querySelector('.chat-title, .chat-header-name, #chat-name');return h? h.textContent.trim() : null})()"
        )
        results["pwa_a_after_create"] = {
            "contacts": contacts,
            "invite_in_contacts": INVITE in contacts,
            "chat_header": chat_open,
            "url_final": pwa.url,
        }

        # ── Вариант (b): iOS ВЫКИНУЛ path (старт на /) → cookie-мост ──
        ctx_pwa2 = await browser.new_context(**{**iphone, "is_mobile": True}, locale="ru-RU")
        await ctx_pwa2.add_cookies([
            {"name": "murmur_invite", "value": INVITE, "url": MURMUR, "sameSite": "Lax"}
        ])
        pwa2 = await ctx_pwa2.new_page()
        await pwa2.goto(MURMUR + "/", wait_until="networkidle", timeout=60000)
        # Создаём аккаунт
        lb2 = pwa2.locator("#invite-landing button.primary")
        if await lb2.count() > 0:
            await lb2.first.click()
            await pwa2.wait_for_timeout(500)
        cv2 = await pwa2.evaluate(
            "(()=>{const b=document.getElementById('btn-create');return b? b.offsetParent!==null : false})()"
        )
        if cv2:
            await pwa2.click("#btn-create")
            await pwa2.wait_for_timeout(4000)
        contacts2 = await pwa2.evaluate("(typeof contacts !== 'undefined') ? Object.keys(contacts) : []")
        results["pwa_b_cookiebridge"] = {
            "url_final": pwa2.url,
            "invite_in_contacts": INVITE in contacts2,
            "contacts_count": len(contacts2),
            "cookie_consumed": (await ctx_pwa2.cookies(MURMUR.replace("https://", "https://"))),
        }
        cookies2 = {c["name"]: c["value"] for c in await ctx_pwa2.cookies(MURMUR)}
        results["pwa_b_cookiebridge"]["cookie_after"] = cookies2.get("murmur_invite", None)

        await browser.close()

    print(json.dumps(results, ensure_ascii=False, indent=2))
    # Верdict
    a_ok = results.get("pwa_a_after_create", {}).get("invite_in_contacts", False)
    b_ok = results.get("pwa_b_cookiebridge", {}).get("invite_in_contacts", False)
    print(f"\n=== VERDICT ===")
    print(f"Variant A (start_url /invite/ passed): {'PASS' if a_ok else 'FAIL'}")
    print(f"Variant B (cookie bridge, iOS cut URL): {'PASS' if b_ok else 'FAIL'}")
    if a_ok or b_ok:
        print("OVERALL: PASS — хотя бы один механизм доставляет invite в PWA")
    else:
        print("OVERALL: FAIL — invite не доходит, нужен третий механизм")
        sys.exit(1)

asyncio.run(main())