# WebKit keyboard simulation — локальный автотест «уезжания ленты» (Murmur PWA)

**Дата:** 2026-09-30 07:06–07:25 GMT+3 · **Исполнитель:** сабагент (автоматизация)
**Цель:** воспроизвести без телефона цепочку бага «уезжание ленты/композера при
открытии/закрытии клавиатуры» на WebKit, автотестом.

**Вердикт: ДА, баг воспроизводится локально — но в «застревающей» форме
(stuck-состояния между циклами), а не мгновенным overflow во время клавиатуры.**
3 из 5 прогонов показали патологию после blur (залипший --vvh 932–933px,
композер за экраном на старте следующего цикла, залипший scrollY=80).
Во время открытой клавиатуры (during-фаза) — 0/5: поведение эталонное.

---

## 1. Окружение

- HP DESKTOP-L3GKJ27 (WSL2), venv `/home/oleg/.camoufox-venv` (python 3.14, playwright).
- Браузер: Playwright WebKit `~/.cache/ms-playwright/webkit-2287` (headless).
- iPhone-контекст: viewport 393×852, DPR 3, `is_mobile=True`, `has_touch=True`,
  iPhone UA (iOS 17.5). Standalone-имитация: `navigator.standalone=true` +
  wrap `matchMedia('(display-mode: standalone)')` через `addInitScript`.
- Тест-контур: `https://murmur.senswifi.ru` — отдаёт клиент **v160w5v**
  (`app.js?v=160w5v&i18n=2`, 339 622 байта; проверено curl'ом). Локальный app.js
  в репо — более новый v160w6a (композер fixed + transform), на тесте его НЕТ.
- Сценарий входа: `window.__murmurCreate()` (WASM identity) → openChat с
  тестовым peer `npub1...w5vtest` (контакт «KB-Test», без истории).

**Важно про v160w5v:** композер `#input-area` — обычный flex-child в потоке
(v160x17, fixed убран), при открытой клавиатуре шапка чата скрыта классом
`body.keyboard-visible`. Лечение при blur: forceReflow[120/400/900] +
nudgeComposerLayer[150/450/1000] + settle[80/250/350/600/1200] +
gapWatchdog[600/1200/2000] (безусловный cure-набор + scrollCure×2 + само-повтор
300мс×5), `--vvh` ставится мгновенно (w5m, без анимации), vv-resize троттлинг 250мс.

## 2. Метод (синтетическая клавиатура)

1. `focus("#message-input")` → `Object.defineProperty(vv,'height')` 852→450 +
   redefine `window.innerHeight` → `dispatchEvent(new Event('resize'))` на
   visualViewport **и** window + `dispatchEvent(new Event('scroll'))` на vv.
2. During-фаза: 400ms ожидание (CSS-анимации нет, но treatment-цепочка живёт) +
   rAF-замеры rect композера/ленты 500мс (25–31 кадр).
3. `blur()` → `vv.height` 450→852 → 2600ms ожидание (полная цепочка лечения:
   поллинги до 3000ms, gapWatchdog само-повтор до ~2000ms) + rAF-замеры 500мс.
4. Итерации: 5 циклов подряд на одной странице (2-й и последующие циклы —
   ключевой сценарий Олега: «на ~5-й раз строка уезжает под экран»).

Критерии бага:
- **overflow**: `getBoundingClientRect(#input-area).bottom > visualViewport.height + 2`
- **jitter**: колебания `iaBottom` внутри rAF-окна 500мс > 2px
- **gapProbe**: `elementFromPoint(центр, innerH-5)` — композер там или дыра
- **stuck**: `--vvh` или `scrollY` залипли не на 852 после blur

## 2.1. Итоговая таблица (5 прогонов, клиент v160w5v)

| iter | фаза | innerH | vvH | --vvh | iaBottom | gapProbe | scrollY | jitt.Δ | overflow |
|------|------|--------|-----|-------|----------|----------|---------|--------|----------|
| 1 | before | 852 | 852 | 853px | 853 | ok | 0 | — | 0 |
| 1 | during | 450 | 450 | 450px | 450 | ok | 0 | **0** | 0 |
| 1 | after  | 852 | 852 | 852px | 852 | ok | 0 | **0** | 0 |
| 2 | before | 852 | 852 | 852px | 852 | ok | 0 | — | 0 |
| 2 | during | 450 | 450 | 450px | 450 | ok | 0 | **0** | 0 |
| 2 | after  | 852 | 852 | 852px | 852 | ok | 0 | **0** | 0 |
| 3 | before | 852 | 852 | 852px | 852 | ok | 0 | — | 0 |
| 3 | during | 450 | 450 | 450px | 450 | ok | 0 | **0** | 0 |
| 3 | after  | 852 | 852 | 852px | 853 | ok | 0 | 0 (но 853→**933** прыжок между сэмплами!) | 1 |
| 4 | **before** | 852 | 852 | **933px** | **933** | **hole:messages-area** | 0 | — | — |
| 4 | during | 450 | 450 | 450px | 450 | ok | 0 | **0** | 0 |
| 4 | after  | 852 | 852 | 853px | 853 | ok | 0 | 1 | 1 |
| 5 | before | 852 | 852 | 852px | 852 | ok | 0 | — | 0 |
| 5 | during | 450 | 450 | 450px | 450 | ok | 0 | **0** | 0 |
| 5 | after  | 852 | 852 | **932px** | 852 | ok | **80** | **0** | 0 |

Полные JSON: `research/kb-sim-results.json`.

## 3. Ключевые находки

1. **Залипший --vvh (iter3/iter4/iter5): 932–933px при innerH=852.** После blur
   цепочка gapWatchdog стреляет безусловно (forceReflow+nudge+scrollCure,
   само-повтор 300мс×5); каждый scrollCure расширяет body на +80px, и setVvh
   в ветке not-typing берёт `MAX(innerHeight, vvFull, bodyH)` → bodyH=932
   (расширенный forceReflow'ом body) → `--vvh=932px` → `.messenger` РАСТЁТ
   за экран → композер (flex-child) уезжает вниз (iaBottom=933 > 852 на 81px).
   Клэмп `h > phys → h = phys` НЕ спасает, потому что физически scrollY=0
   проверяется в момент вызова, а body уже расширен → 933 «легально» проходит.
2. **Композер за экраном на старте следующего цикла (iter4-before).**
   Скриншот `kb-sim-iter4-before.png`: шапка «KB-Test» видна, тела чата НЕТ,
   композера НЕТ (он на y=933, за нижним краем), gapProbe = `hole:messages-area`.
   Это точь-в-точь симптом Олега «строка уезжает под экран» — застревание
   переживает следующий фокус (лечится только им самим: during-фаза вернула
   композер, т.к. --vvh пересчитался при typing → vv.height=450).
3. **Залипший scrollY=80 (iter5-after): scrollCure не вернул скролл.**
   `scrollY=80, vvPageTop=80, --vvh=932px, msH=932`. Скриншот
   `kb-sim-iter5-after.png`: шапка скролл-ed за верхний край (тело чата
   начинается сразу с пустой зоны), композер виден, но messenger на 80px
   выше/длиннее экрана. scrollCure должен был `scrollTo(0,0)` + restore body —
   не восстановил (рачинг с gapWatchdog само-повтором).
4. **During-фаза эталонная (0/5).** vv.height 852→450: `--vvh=450px`,
   композер iaBottom=450 (ровно по низу vv), лента maBottom=392 (резерв под
   композером 58px корректен), `body.keyboard-visible=true`, шапка скрыта
   (скриншот `kb-sim-iter1-during.png`), gapProbe=ok. Jitter **0px**
   (maxDelta=0 во всех 5 прогонах, 25–31 кадр на окно). Синтетическая
   клавиатура НЕ роняет композер во время открытия.
5. **Осцилляция 853→933 (iter3, 80px прыжок).** Пойман между двумя сэмплами
   (финальный metrics-замер 853 → rAF-окно все кадры 933): внутри окна дельта
   0, но КРОСС-ОКНО прыжок 80px. Это то самое «рывки» (поле прыжком
   опускается вниз) — лечится/детектируется только мониторингом между окнами,
   не внутри одного rAF-замера. В критерий jitter >2px внутри окна — НЕ ловится.

## 4. Скриншоты (research/)

| файл | что показывает |
|------|----------------|
| `kb-sim-iter1-before.png` | норма: шапка + композер внизу, лента пуста (тестовый чат без истории) |
| `kb-sim-iter1-during.png` | клавиатура: композер на y≈450, шапка скрыта, фокус (синяя рамка) — эталон |
| `kb-sim-iter1-after.png` | норма после blur: всё вернулось |
| `kb-sim-iter3-after.png` | норма-визуально, но --vvh осциллировал 853→933 между сэмплами |
| `kb-sim-iter4-before.png` | **БАГ**: шапка есть, композера НЕТ (уехал за экран, --vvh=933, gapProbe=hole) |
| `kb-sim-iter4-during.png` | клавиатура вернула композер (self-heal через typing→vv.height) |
| `kb-sim-iter5-after.png` | **БАГ**: шапка скролл-ed за верх (scrollY=80 залип, --vvh=932) |

## 5. Воспроизводимость

- **Во время открытой клавиатуры (during): 0/5** — баг НЕ воспроизводится
  (overflow 0, jitter 0 во всех прогонах).
- **После blur / между циклами (stuck): 3/5** — воспроизводится:
  - iter3: осцилляция --vvh 853→933 (80px прыжок) после blur;
  - iter4: композер за экраном на старте СЛЕДУЮЩЕГО цикла (--vvh=933 залип);
  - iter5: залипший scrollY=80 + --vvh=932 после blur.
- Паттерн совпадает с задачей Олега: застревание накапливается от цикла к
  циклу (iter1/iter2 чистые, iter3+ — патологии), «на ~5-й раз уезжает».

## 6. Оговорки (headless vs реальный iPhone)

1. **PAINT-сталость НЕ воспроизводится headless.** Урок v160w5t/v160y61:
   на реальном iPhone layout НЕ врёт, PAINT устаревает (композитор красит
   783px-поверхность при честных метриках 844). Headless WebKit рендерит
   честно по layout → paint-вариант бага здесь невидим. Пойманное здесь —
   LAYOUT-уровень (композер реально за экраном, gapProbe=hole).
2. **Реальная клавиатура iOS делает больше:** vv.pageTop сдвиги (пан
   layout viewport), клавиатурные кривые анимации (~350ms, серия resize),
   safe-inset. Симулятор шлёт только resize+scroll без изменения pageTop —
   пан-layout-вариант (v160x8: scrollY≈347) не эмулировался.
3. **Тестовый чат без истории** — лента пустая; «подтягивание к низу»
   (scrollBottomUnfocus) на пустой ленте no-op. На реальном чате с сообщениями
   числа maBottom могут отличаться.
4. **WASM-identity:** `__murmurCreate()` вернул ok=false в логе (WASM-race,
   Lesson #308), но identity создался (npub сохранился, messenger активен) —
   автотест устойчив к гонке благодаря poll localStorage.

## 7. Выводы для следующей итерации (ПРАВКИ app.js — отдельно)

1. **Корень застревания: безусловный gapWatchdog cure-набор** (v160w5u/w5v):
   forceReflow расширяет body → setVvh берёт MAX(..., bodyH=932) → --vvh=932
   → композер уезжает. Починка-кандидат: в ветке not-typing КРОМЕ клэмпа
   `h > phys` добавить `Math.min(h, window.innerHeight)` БЕЗ условия scrollY
   (scrollY=0-гейт пропускает 933, когда body уже расширен самим лечением).
2. **scrollCure + само-повтор 300мс×5 race:** повторный watchdog расширяет
   body ПОСЛЕ того, как первый scrollCure вернул его → restore затирается.
   Кандидат: serialized cure-очередь (одна активная цепочка, gapFixTimer
   не сбрасывать до конца restore).
3. **Детекция «рывков» между окнами:** jitter внутри rAF-окна не ловит
   80px-прыжок 853→933. Диаг-HUD (vp-diag) уже тикает 500мс — добавить
   сравнение с предыдущим тиком (delta >2px = флаг) для детекции на телефоне.
4. **During-фаза не требует правки** (0/5, эталон): троттлинг 250мс + мгновенный
   setVvh + keyboard-visible работают как задумано.

## 8. Скрипт (целиком)

```python
```python
# murmur WebKit keyboard simulation — автотест цепочки лечения «уезжания ленты»
# Тест-контур: https://murmur.senswifi.ru (v160w5v). Playwright WebKit,
# iPhone 393x852 DPR3 touch, standalone-имитация (matchMedia standalone).
#
# Синтетическая клавиатура:
#   1. window.visualViewport.height 852→450 через Object.defineProperty
#   2. dispatchEvent new Event("resize") на visualViewport + window
#   3. focus/blur на #message-input (composer)
#   4. scroll события на window
#
# Проверки:
#   - композер не уезжает: getBoundingClientRect(#input-area).bottom <= visualViewport.height
#   - нет дёрганья: rAF-замеры rect 500мс, колебания >2px = дёрганье
#
# Запуск: /home/oleg/.camoufox-venv/bin/python /tmp/murmur_kb_sim.py [N_ITER]

import asyncio, json, os, sys, time, random
from playwright.async_api import async_playwright

URL = "https://murmur.senswifi.ru/"
SHOT_DIR = "/home/oleg/projects/murmur/pwa/research"
N_ITER = int(sys.argv[1]) if len(sys.argv) > 1 else 5

# WebKit iPhone флаги (Playwright device descriptor iPhone 14-ish)
DEVICE = {
    "user_agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    "viewport": {"width": 393, "height": 852},
    "device_scale_factor": 3,
    "is_mobile": True,
    "has_touch": True,
}

INSTALL_SIM = r"""
// standalone-имитация: iOS PWA standalone (Lesson #283: query отбрасывается)
Object.defineProperty(navigator, 'standalone', { get: () => true, configurable: true });
// override before matchMedia listeners читают
const _mm = window.matchMedia.bind(window);
window.matchMedia = (q) => {
    const m = _mm(q);
    if (q === '(display-mode: standalone)') {
        return new Proxy(m, { get: (t, k) => k === 'matches' ? true : Reflect.get(t, k) });
    }
    return m;
};
"""

KB_SIM = r"""
// СИНТЕТИЧЕСКАЯ КЛАВИАТУРА: vv.height + resize события (без реального фокуса-клавиатуры)
// Оригинальные дескрипторы сохраняются — restore после blur.
window.__kbSim = (() => {
    const vv = window.visualViewport;
    if (!vv) return null;
    const origDesc = Object.getOwnPropertyDescriptor(vv, 'height') ||
        Object.getOwnPropertyDescriptor(VisualViewport.prototype, 'height');
    const origWH = Object.getOwnPropertyDescriptor(window, 'innerHeight');

    let curH = 852;
    let simulated = false;

    const setVvHeight = (h) => {
        // redefine height на инстансе (перебивает prototype getter)
        Object.defineProperty(vv, 'height', {
            get: () => curH, configurable: true,
        });
        Object.defineProperty(window, 'innerHeight', {
            get: () => curH, configurable: true,
        });
        curH = h;
        // resize события: visualViewport + window
        vv.dispatchEvent(new Event('resize'));
        window.dispatchEvent(new Event('resize'));
        // iOS шлёт также scroll при изменении vv (offsetTop может меняться)
        vv.dispatchEvent(new Event('scroll'));
    };

    return {
        open: (h) => { simulated = true; setVvHeight(h || 450); },
        close: () => { simulated = true; setVvHeight(852); },
        restore: () => {
            if (origDesc) { try { delete vv.height; Object.defineProperty(vv, 'height', origDesc); } catch (e) {} }
            if (origWH) { try { delete window.innerHeight; Object.defineProperty(window, 'innerHeight', origWH); } catch (e) {} }
            simulated = false;
        },
        height: () => curH,
        isSimulated: () => simulated,
        realVvH: () => origDesc ? origDesc.get.call(vv) : null,
    };
})();
"""

MEASURE = r"""
// Замер композера + ленты + viewport-метрик
window.__murmurKbMetrics = () => {
    const ia = document.getElementById("input-area");
    const ma = document.querySelector(".messages-area");
    const ms = document.querySelector(".messenger");
    const vv = window.visualViewport;
    const cs = getComputedStyle(document.documentElement);
    const r = (el) => el ? Math.round(el.getBoundingClientRect().bottom * 100) / 100 : null;
    return {
        innerH: window.innerHeight || null,
        vvH: vv ? Math.round(vv.height) : null,
        vvPageTop: vv ? Math.round(vv.pageTop || 0) : null,
        vvOffsetTop: vv ? Math.round(vv.offsetTop || 0) : null,
        vvh: (cs.getPropertyValue("--vvh") || "").trim(),
        kbInset: (cs.getPropertyValue("--kb-inset") || "").trim(),
        scrollY: Math.round(window.scrollY || 0),
        iaBottom: r(ia),
        iaTop: ia ? Math.round(ia.getBoundingClientRect().top * 100) / 100 : null,
        msBottom: r(ms),
        msH: ms ? Math.round(ms.getBoundingClientRect().height) : null,
        maBottom: r(ma),
        // gapDetector: проба в физическом низу — композер там или bg?
        gapProbe: (() => {
            if (!ia || ia.hidden) return null;
            const y = Math.round((window.innerHeight || 852) - 5);
            const el = document.elementFromPoint(Math.round((window.innerWidth || 390) / 2), y);
            if (!el) return "none";
            if (el === ia || ia.contains(el)) return "ok";
            return "hole:" + (el.className || el.tagName);
        })(),
        kbVisibleClass: document.body.classList.contains("keyboard-visible"),
        // transform композера
        iaTransform: ia ? getComputedStyle(ia).transform : null,
    };
};

// rAF-замеры 500мс: колебания bottom композера и ленты
window.__murmurKbJitter = (durationMs) => {
    return new Promise((resolve) => {
        const ia = document.getElementById("input-area");
        const ma = document.querySelector(".messages-area");
        const frames = [];
        const t0 = performance.now();
        const tick = () => {
            const t = performance.now() - t0;
            if (ia) {
                const b = ia.getBoundingClientRect().bottom;
                frames.push({t: Math.round(t), iaBottom: Math.round(b * 100) / 100,
                             maBottom: ma ? Math.round(ma.getBoundingClientRect().bottom * 100) / 100 : null,
                             scrollY: Math.round(window.scrollY || 0)});
            }
            if (t < durationMs) requestAnimationFrame(tick);
            else resolve(frames);
        };
        requestAnimationFrame(tick);
    });
};

// анализ rAF-замеров: max колебание
window.__murmurKbJitterStats = (frames) => {
    if (!frames || frames.length < 2) return {maxDelta: 0, min: 0, max: 0, n: frames ? frames.length : 0};
    let min = Infinity, max = -Infinity;
    for (const f of frames) {
        if (f.iaBottom == null) continue;
        if (f.iaBottom < min) min = f.iaBottom;
        if (f.iaBottom > max) max = f.iaBottom;
    }
    const deltas = [];
    for (let i = 1; i < frames.length; i++) {
        deltas.push(Math.abs((frames[i].iaBottom || 0) - (frames[i-1].iaBottom || 0)));
    }
    return {
        maxDelta: Math.round(Math.max(...deltas) * 100) / 100,
        min: min === Infinity ? 0 : min,
        max: max === -Infinity ? 0 : max,
        range: Math.round((max - min) * 100) / 100,
        n: frames.length,
    };
};
"""


async def setup_page(pw):
    browser = await pw.webkit.launch(headless=True)
    ctx = await browser.new_context(**DEVICE)
    await ctx.add_init_script(INSTALL_SIM)
    page = await ctx.new_page()
    await page.goto(URL, wait_until="networkidle", timeout=60000)
    await page.wait_for_timeout(2000)
    # identity: WASM-путь (page.evaluate ломает DOM — Lesson из memory 2026-08-27)
    state = await page.evaluate("""async () => {
        const r = await window.__murmurCreate();
        return {ok: !!r, npub: (typeof myNpub !== 'undefined' ? myNpub : window.myNpub) || null,
                messengerActive: !!document.querySelector('.messenger.active')};
    }""")
    await page.wait_for_timeout(3000)
    state2 = await page.evaluate("""() => ({
        npub: window.myNpub || null,
        messengerActive: !!document.querySelector('.messenger.active'),
        banner: (document.getElementById('version-banner') || {}).textContent || null,
    })""")
    return browser, ctx, page, state, state2


async def open_test_chat(page):
    # Создать контакт (тестовый peer) и открыть чат программно
    peer = await page.evaluate("""() => {
        // тестовый npub (валидной формы, открываем как чат без истории)
        const peer = "npub1q9fzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzqqw5vtest";
        if (!contacts[peer]) {
            contacts[peer] = { peer: peer, lastMessagePreview: "", lastTs: 0, unreadCount: 0 };
            renderChatList();
        }
        saveContactName(peer, "KB-Test");
        openChat(peer, {fromUser: true});
        return peer;
    }""")
    await page.wait_for_timeout(3000)  # splash 800ms + фейд 250 + запас
    return peer


async def run_scenario(page, iter_n):
    """Один прогон: фокус → клавиатура-ревайс → проверки → blur → проверки."""
    result = {"iter": iter_n, "shots": {}}
    # BEFORE
    await page.evaluate("() => { window.__kbSim && window.__kbSim.restore(); }")
    await page.wait_for_timeout(500)
    m_before = await page.evaluate("() => window.__murmurKbMetrics()")
    result["before"] = m_before
    shot = os.path.join(SHOT_DIR, f"kb-sim-iter{iter_n}-before.png")
    await page.screenshot(path=shot)
    result["shots"]["before"] = shot

    # FOCUS в композер
    await page.focus("#message-input")
    await page.wait_for_timeout(200)

    # Клавиатура-ревайс: vv.height 852→450 (синтетически)
    await page.evaluate("() => window.__kbSim.open(450)")
    await page.wait_for_timeout(400)  # анимация CSS 300ms

    # DURING: замеры + jitter 500мс
    m_during = await page.evaluate("() => window.__murmurKbMetrics()")
    frames_during = await page.evaluate("() => window.__murmurKbJitter(500)")
    stats_during = await page.evaluate("(f) => window.__murmurKbJitterStats(f)", frames_during)
    result["during"] = m_during
    result["jitter_during"] = stats_during
    shot = os.path.join(SHOT_DIR, f"kb-sim-iter{iter_n}-during.png")
    await page.screenshot(path=shot)
    result["shots"]["during"] = shot

    # Проверка уезжания: композер bottom <= vv.height
    overflow_during = None
    if m_during["iaBottom"] is not None and m_during["vvH"]:
        overflow_during = round(m_during["iaBottom"] - m_during["vvH"], 2)
    result["overflow_during"] = overflow_during  # >0 = композер под экраном

    # BLUR → клавиатура закрылась
    await page.evaluate("() => document.getElementById('message-input').blur()")
    await page.wait_for_timeout(100)
    await page.evaluate("() => window.__kbSim.close()")
    # ждём цепочку лечения (gapWatchdog 450/900/1500/2400 + collapseLock 500ms)
    await page.wait_for_timeout(2600)

    m_after = await page.evaluate("() => window.__murmurKbMetrics()")
    frames_after = await page.evaluate("() => window.__murmurKbJitter(500)")
    stats_after = await page.evaluate("(f) => window.__murmurKbJitterStats(f)", frames_after)
    result["after"] = m_after
    result["jitter_after"] = stats_after
    shot = os.path.join(SHOT_DIR, f"kb-sim-iter{iter_n}-after.png")
    await page.screenshot(path=shot)
    result["shots"]["after"] = shot

    overflow_after = None
    if m_after["iaBottom"] is not None and m_after["vvH"]:
        overflow_after = round(m_after["iaBottom"] - m_after["vvH"], 2)
    result["overflow_after"] = overflow_after
    result["gapProbe_after"] = m_after.get("gapProbe")

    # Верdict
    bug = False
    if overflow_during and overflow_during > 2: bug = True
    if overflow_after and overflow_after > 2: bug = True
    if stats_during.get("maxDelta", 0) > 2 or stats_after.get("maxDelta", 0) > 2: bug = True
    if m_after.get("gapProbe") and str(m_after.get("gapProbe")).startswith("hole"): bug = True
    result["bug"] = bug
    return result


async def main():
    os.makedirs(SHOT_DIR, exist_ok=True)
    results = []
    async with async_playwright() as pw:
        browser, ctx, page, state, state2 = await setup_page(pw)
        print("identity:", json.dumps(state), flush=True)
        print("state2:", json.dumps(state2), flush=True)
        if not state2.get("messengerActive"):
            print("FATAL: messenger не активен после identity creation", flush=True)
            await browser.close()
            return
        peer = await open_test_chat(page)
        print("chat opened:", peer, flush=True)
        await page.wait_for_timeout(1000)
        # инжект KB sim + measure (после загрузки страницы — до сценария)
        await page.evaluate(MEASURE)
        await page.evaluate(KB_SIM)
        has_sim = await page.evaluate("() => !!window.__kbSim && typeof window.__murmurKbMetrics === 'function'")
        print("kbSim+metrics injected:", has_sim, flush=True)
        for i in range(1, N_ITER + 1):
            r = await run_scenario(page, i)
            results.append(r)
            print(json.dumps(r, ensure_ascii=False, default=str), flush=True)
            await page.wait_for_timeout(1000)
        await browser.close()
    with open(os.path.join(SHOT_DIR, "kb-sim-results.json"), "w") as f:
        json.dump(results, f, ensure_ascii=False, indent=2, default=str)
    bug_count = sum(1 for r in results if r["bug"])
    print(f"\n=== ИТОГ: {bug_count}/{len(results)} прогонов показали баг ===", flush=True)


asyncio.run(main())
```


---

# Дополнение 2: упрощённый замер «focus → resize → rAF» (07:37–07:38 GMT+3, 3 прогона)

**Дата:** 2026-09-30 07:37–07:38 GMT+3 · **Исполнитель:** сабагент (webkit-kb-sim2)
**Цель:** изолированный замер по упрощённому сценарию задачи: focus на композере →
синтетический resize (vv.height 852→450) → rAF-сэмплы каждые 50мс в течение 500мс.
Критерии из задачи: **уезд** = rect.bottom > 450; **дёрганье** = разброс top > 2px.

## Метод (отличие от прогона 1)

1. Playwright WebKit (playwright 1.63.0, webkit-2359 / WebKit 26.6, headless).
   iPhone 393×852, DPR 3, is_mobile=True, has_touch=True, iPhone 17.5 UA.
   Standalone-имитация: navigator.standalone=true + wrap matchMedia.
2. Вход в мессенджер: БЕЗ identity (WASM пропущен) — прямой DOM-сет как в
   openGroupChat (identity-screen скрыт, messenger.chat-open, chat-view flex,
   input-area visible). Композер #message-input до входа скрыт (h=0) —
   обязательно раскомпоновать ДО замера.
3. **Важный урок:** resize БЕЗ фокуса не двигает композер — в v160w5v setVvh
   при typing=false берёт MAX(innerHeight, vvFull, bodyH) = 852 → --vvh не
   сжимается → treatment молчит (--kb-inset остаётся 0px). Корректная
   последовательность: **сначала focus() (focusin → typing=true,
   keyboard-visible), потом defineProperty(vv,'height',450) + resize на
   window и vv.** Только тогда срабатывает ветка typing → --vvh=450px.
4. Сэмплы: setInterval 50мс × 11 точек (500мс) на #message-input rect.
5. Скриншоты до/после resize.

## Итоговая таблица (3 прогона)

| pass | фаза | top | bottom | vvH | --vvh | kb-inset | kbVisible | maBottom | уезд (bottom>450) | дёрганье (Δtop>2) |
|------|------|-----|--------|-----|-------|----------|-----------|----------|--------------------|--------------------|
| 1 | before | 803 | 844 | 852 | 852px | 0px | false | 794 | — | — |
| 1 | during (11 сэмплов) | **401** (конст.) | **442** | 450 | 450px | 402px | true | 392 | **нет** | **нет** (Δ=0) |
| 1 | after | 401 | 442 | 450 | 450px | 402px | true | 392 | нет | нет |
| 2 | before | 803 | 844 | 852 | 852px | 0px | false | 794 | — | — |
| 2 | during | **401** | **442** | 450 | 450px | 402px | true | 392 | **нет** | **нет** (Δ=0) |
| 2 | after | 401 | 442 | 450 | 450px | 402px | true | 392 | нет | нет |
| 3 | before | 803 | 844 | 852 | 852px | 0px | false | 794 | — | — |
| 3 | during | **401** | **442** | 450 | 450px | 402px | true | 392 | **нет** | **нет** (Δ=0) |
| 3 | after | 401 | 442 | 450 | 450px | 402px | true | 392 | нет | нет |

Полные JSON: research/kb_sim_results.json (этот замер, 3 итерации).

## Результат

- **Уезд: НЕТ (0/3).** Композер bottom=442 < 450 во всех 33 сэмпллах —
  ровно на линии симулированной клавиатуры (kb-inset=402 = innerHeight−vv.height).
- **Дёрганье: НЕТ (0/3).** top=401 константа во всех сэмпллах, разброс 0px (< 2px).
  Между before и during один переход 803→401 (ожидаемый подъём композера на
  высоту клавиатуры, не рывок).
- **Treatment-цепочка отработала штатно:** --vvh 852px→450px, --kb-inset
  0px→402px, body.keyboard-visible true, лента сжалась (maBottom 794→392,
  резерв под композером 50px корректен).
- Скриншот kb_sim_1_after.png: композер с фокусом (синяя рамка) сидит на
  нижнем крае видимой зоны (450), шапка чата скрыта — эталонное поведение.

## Оговорки

1. **Ветка НЕ-typing не эмулировалась отдельно** (blur-после-фазы): по опыту
   прогона 07:06 (основной отчёт) патология живёт в stuck-состоянии после blur,
   а не во время открытой клавиатуры. Этот замер подтверждает: during-фаза
   чистая, все вопросы — к цепочке после blur (gapWatchdog/scrollCure race).
2. **Композер с фокусом обязателен:** без focusin (typing=false) resize
   синтетической клавиатуры НЕ двигает композер вообще — treatment молчит.
   Если симулировать «клавиатуру без фокуса», уезд будет ложноположительным
   (композер останется на 844 при vvH=450 → bottom>450).
3. Headless WebKit рендерит по layout (PAINT-сталость не воспроизводится) —
   основной отчёт, оговорка 1.

## Скрипт (этот замер, /tmp/kb_sim.py — 3 прогона на свежих страницах)

```python
"""Murmur PWA iOS keyboard sim on Playwright WebKit (measurement only, no code edits).
Test contour: https://murmur.senswifi.ru (v160w5v). Composer #message-input.
Synthetic keyboard: focus (typing=true via focusin) -> vv.height 852->450 defineProperty
-> resize on window & vv. v160w5v logic: typing -> --vvh=vv.height -> messenger shrinks.
Criteria: ride = composer rect.bottom > 450; jitter = top spread > 2px.
3 passes on fresh pages.
"""
import json
from playwright.sync_api import sync_playwright

URL = "https://murmur.senswifi.ru"
KB_H = 450
SEL = "#message-input"

STANDALONE_INIT = """
() => {
  try { Object.defineProperty(window.navigator, 'standalone', {get: () => true, configurable: true}); } catch (e) {}
  const orig = window.matchMedia ? window.matchMedia.bind(window) : null;
  if (orig) window.matchMedia = (q) => {
    if (q && q.indexOf('display-mode') >= 0) {
      return {matches: q.indexOf('standalone') >= 0, media: q, onchange: null,
              addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}, dispatchEvent(){return false}};
    }
    return orig(q);
  };
}
"""

SETUP_JS = """
() => {
  const id = document.getElementById('identity-screen');
  if (id) { id.style.display = 'none'; id.hidden = true; }
  const m = document.querySelector('.messenger');
  if (m) { m.hidden = false; m.classList.add('active', 'chat-open'); }
  const cv = document.getElementById('chat-view');
  if (cv) { cv.style.display = 'flex'; cv.hidden = false; }
  const nc = document.getElementById('no-chat');
  if (nc) { nc.hidden = true; nc.style.display = 'none'; }
  const ia = document.getElementById('input-area');
  if (ia) { ia.hidden = false; ia.classList.add('visible'); }
  const pn = document.getElementById('chat-peer-name');
  if (pn) pn.textContent = 'KB-Sim';
  const ma = document.querySelector('.messages-area');
  return {iaHidden: ia ? ia.hidden : null,
          iaRect: ia ? (() => { const r = ia.getBoundingClientRect(); return {top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1), h: +r.height.toFixed(1)}; })() : null,
          vvH: window.visualViewport ? window.visualViewport.height : null, innerH: window.innerHeight};
}
"""

RECT_JS = """
(sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const vv = window.visualViewport;
  const ma = document.querySelector('.messages-area');
  const mar = ma ? ma.getBoundingClientRect() : null;
  return {top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2), height: +r.height.toFixed(2),
          vvH: vv ? vv.height : null, vvOffsetTop: vv ? vv.offsetTop : null,
          innerH: window.innerHeight, scrollY: window.scrollY,
          vvh: getComputedStyle(document.documentElement).getPropertyValue('--vvh').trim(),
          kbInset: document.documentElement.style.getPropertyValue('--kb-inset').trim() || '-',
          kbVisible: document.body.classList.contains('keyboard-visible'),
          maBottom: mar ? +mar.bottom.toFixed(2) : null};
}
"""

RAF_JS = """
(sel) => new Promise(res => {
  const el = document.querySelector(sel);
  const out = [];
  const grab = () => {
    const r = el.getBoundingClientRect();
    out.push({t: Math.round(performance.now()), top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2),
              vvH: window.visualViewport ? window.visualViewport.height : null,
              innerH: window.innerHeight, scrollY: window.scrollY});
  };
  grab();
  let n = 0;
  const iv = setInterval(() => { grab(); n++; if (n >= 10) { clearInterval(iv); res(out); } }, 50);
})
"""

FOCUS_KB = """
() => new Promise(res => {
  const vv = window.visualViewport;
  const el = document.getElementById('message-input');
  el.focus();  // focusin -> typing=true, keyboard-visible class
  // synthetic keyboard: pin vv.height=450, fire resize on window + vv
  Object.defineProperty(vv, 'height', {get: () => 450, configurable: true});
  window.dispatchEvent(new Event('resize'));
  vv.dispatchEvent(new Event('resize'));
  res({focusOk: document.activeElement === el,
       typingFlag: true});
})
"""

BLUR_KB = """
() => new Promise(res => {
  const vv = window.visualViewport;
  const el = document.getElementById('message-input');
  el.blur();
  Object.defineProperty(vv, 'height', {get: () => 852, configurable: true});
  window.dispatchEvent(new Event('resize'));
  vv.dispatchEvent(new Event('resize'));
  res({blurOk: document.activeElement !== el});
})
"""

def run_pass(pw, idx, shots=True):
    browser = pw.webkit.launch(headless=True)
    ctx = browser.new_context(
        viewport={"width": 393, "height": 852}, device_scale_factor=3,
        is_mobile=True, has_touch=True,
        user_agent=("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) "
                    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"),
    )
    ctx.add_init_script(STANDALONE_INIT)
    page = ctx.new_page()
    page.goto(URL + "/?diag=1", wait_until="domcontentloaded", timeout=60000)
    page.wait_for_timeout(6000)
    setup = page.evaluate(SETUP_JS)
    if not setup or setup["iaHidden"]:
        print(f"[pass{idx}] SETUP FAILED: {json.dumps(setup)[:300]}")
        browser.close(); return None
    rect0 = page.evaluate(RECT_JS, SEL)
    if shots: page.screenshot(path=f"/tmp/kb_sim_{idx}_before.png")
    page.evaluate(FOCUS_KB)          # focus + synthetic resize (keyboard open)
    page.wait_for_timeout(100)
    samples = page.evaluate(RAF_JS, SEL)   # rAF every 50ms for 500ms
    if shots: page.screenshot(path=f"/tmp/kb_sim_{idx}_after.png")
    rect_after = page.evaluate(RECT_JS, SEL)
    ride = any(s["bottom"] > KB_H for s in samples)
    tops = [s["top"] for s in samples]
    jitter = (max(tops) - min(tops)) > 2
    print(f"[pass{idx}] sel={SEL}")
    print(f"  setup  : {json.dumps(setup)}")
    print(f"  before : {json.dumps(rect0)}")
    print(f"  during : min_top={min(tops)} max_top={max(tops)} max_bottom={max(s['bottom'] for s in samples)} vvH_set={set(s['vvH'] for s in samples)}")
    print(f"  after  : {json.dumps(rect_after)}")
    print(f"  samples: {json.dumps(samples)}")
    print(f"  ride={ride} jitter={jitter}")
    browser.close()
    return {"idx": idx, "before": rect0, "after": rect_after, "samples": samples,
            "ride": ride, "jitter": jitter, "min_top": min(tops), "max_top": max(tops),
            "max_bottom": max(s["bottom"] for s in samples), "setup": setup}

def main():
    results = []
    with sync_playwright() as pw:
        for i in range(1, 4):
            try:
                r = run_pass(pw, i)
                if r: results.append(r)
            except Exception as e:
                print(f"[pass{i}] ERROR: {e}")
    with open("/tmp/kb_sim_results.json", "w") as f:
        json.dump(results, f, indent=2)
    print(f"Summary: rides={[r['ride'] for r in results]} jitters={[r['jitter'] for r in results]}")

if __name__ == "__main__":
    main()
```

## Артефакты

- Скрипт: /tmp/kb_sim.py (копия целиком в разделе выше)
- Скриншоты: research/kb_sim_1_before.png, research/kb_sim_1_after.png,
  research/kb_sim_2_after.png, research/kb_sim_3_after.png (before/после resize)
- JSON: research/kb_sim_results.json
