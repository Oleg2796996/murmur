# Real iOS cycle simulation (webkit-kb-simulation v2, v160w5v)

Дата: 2026-09-30 08:42 GMT+3. Клиент на https://murmur.senswifi.ru: **v160w5v** (мутируемый --vvh путь).
Измерение только, без правок кода и деплоя. Прод (murmurchat.org) не тронут.
Скрипт: /tmp/real_sim.py (целиком ниже). Результаты: /tmp/real_sim_results.json,
скриншоты /tmp/real_sim_*.png (13 шт: before + open/after на каждый цикл).

## 1. Модель РЕАЛЬНОГО iOS (отличие от прошлой симуляции kb_sim.py)

- **window.innerHeight НЕ меняется** при клавиатуре (константа 852) — в прошлой
  симуляции redefine innerHeight=450 был нереалистичен. Здесь проверено:
  innerH=852 на всех ступенях открытия/закрытия и после закрытия (см. таблицу).
- **Открытие ~300мс**: vv.height проходит промежуточные ступени
  852→780→650→600→520→450 (по 50мс), `dispatchEvent('resize')` на window и
  visualViewport на каждой ступени.
- **2 scroll-события scrollY≠0 между ступенями** (`window.scrollTo(0,80)` +
  scroll event) — контр-пан iOS. Гейт: headless-страница физически
  ненаscrollable (scrollHeight<=innerHeight), поэтому после scrollTo(0,80)
  реально 0 — эмулировано патчем window.scrollY-аксессора (own property,
  НЕ Window.prototype — в WebKit дескриптор лежит на window) с восстановлением
  оригинального дескриптора после закрытия (иначе критерий scrollY загрязняется
  самим симулятором — поймано и исправлено в ходе отладки).
- **При закрытии**: обратная анимация 450→520→600→650→780→852 через
  промежуточные ступени + `scrollTo(0,0)` + **финальный vv scroll** (изменение
  offsetTop БЕЗ height: `dispatchEvent('scroll')` на vv после последнего resize).
- `focus(#message-input)` → typing-фаза → `blur()` → анимация закрытия.

## 2. Сценарий

6 циклов подряд БЕЗ reload (reload только один раз в начале). После каждого
закрытия — замер (composer rect top/bottom, vvH, innerH, scrollY, --vvh,
--kb-inset) + ожидание 2600мс (полная цепочка лечения w5v).

Критерии бага после закрытия (innerH 852):
- (а) композер bottom ≠ 844: bottom > 850 или bottom < 830;
- (б) --vvh залип ≠ 852px;
- (в) scrollY ≠ 0 (допуск ±2) через 2600мс.

## 3. Итоговая таблица (6 циклов, все метрики)

| цикл | comp.top | comp.bottom | vvH | innerH | scrollY | --vvh | --kb-inset | innerH-конст | баг-флаги |
|------|----------|-------------|-----|--------|---------|-------|------------|--------------|-----------|
| 1 | 803 | 844 | 852 | 852 | 0 | 852px | 0px | True | **-** |
| 2 | 803 | 844 | 852 | 852 | 0 | 852px | 0px | True | **-** |
| 3 | 802 | 843 | 852 | 852 | 1 | 852px | 0px | True | **-** |
| 4 | 804 | 845 | 852 | 852 | 80 | 933px | 0px | True | **vvh,scrollY** |
| 5 | 803 | 844 | 852 | 852 | 0 | 852px | 0px | True | **-** |
| 6 | 884 | 925 | 852 | 852 | 0 | 933px | 0px | True | **bottom,vvh** |

Служебные sy_t0/sy_t2600 (реальный document scroll после восстановления):
- цикл 3: scrollY=1/dt=1 на t2600 — шум (ниже порога ±2), не баг;
- цикл 4: scrollY=80/dt=80 и на t0, и на t2600 — scrollCure не вернул скролл;
- цикл 6: на t0 scrollY=0, на t2600 scrollY=80/dt=80 — scrollCure сдвинул
  скролл МЕЖДУ замерами (то же, что iter5-after в прошлой симуляции).

В during-фазе все 6 циклов эталонные: приложение корректно отрабатывает
ступени (comp.bottom 772→512→442 при vvH 650/520/450), --vvh=450px,
kb-inset=402px, keyboard-visible=true.

## 4. Воспроизводится ли уезд на w5v

**ДА — на циклах 4 и 6 из 6** (у Олега было на ~5-м; здесь 2/6):

- **Цикл 4 (после закрытия): --vvh=933px залип** (innerH=852, vvH=852) +
  scrollY=80 залип (scrollCure не вернул, raching с gapWatchdog) — точная
  сигнатура iter5-after из прошлой симуляции (там 932px + scrollY=80).
  Композер сам по низу (bottom=845), т.к. во время фокуса следующего цикла
  --vvh пересчитался при typing.
- **Цикл 6 (после закрытия): --vvh=933px залип + композер УЕХАЛ**:
  bottom=925 (top=884) при innerH=852 — «строка уезжает под экран»-вариант
  через вытянутый messenger (та же механика MAX(bodyH) из прошлой симуляции,
  933 vs 852). Плюс scrollCure сдвинул scrollY 0→80 между замерами.
- Залипание переживает следующий фокус: цикл 5 после уехавшего цикла 4
  вернулся к норме (852) только потому, что during-фаза typing пересчитала
  --vvh через vv.height=450 — как и в прошлой симуляции (iter4-before/iter5).

## 5. Вывод

1. Модель реального iOS (константный innerH + ступенчатая анимация vv.height
   + scroll-события + финальный vv scroll) **воспроизводит баг w5v**: 2/6
   циклов с залипом --vvh=933px, в одном из них композер уехал за экран
   (bottom=925 > 850). Не детерминированно на 5-м цикле — на 4-м и 6-м
   (ратастривание между циклами, зависит от рачинга лечения).
2. Критерий scrollY≠0 после 2600мс — подтверждён (цикл 4 и 6), но на практике
   scrollCure иногда сам сдвигает скролл между замерами (0→80), так что
   измерять надо и t0, и t2600.
3. Композер-bottom-критерий (844±) ловит уезд только когда messenger уже
   вытянут; чаще баг живёт в --vvh (933px) при визуально-нормальном композере
   (цикл 4) — замер --vvh обязателен.
4. Механика бага та же, что в прошлой симуляции: цепочка лечения
   (gapWatchdog+scrollCure+forceReflow) расширяет body → setVvh берёт
   MAX(innerHeight, vvFull, bodyH) → --vvh=932–933px → messenger растёт за
   экран. Ступенчатая анимация/финальный vv scroll не являются обязательным
   триггером — залип возникает и на простой close-анимации, но реальный
   iOS-цикл дал больше вероятности (2/6 vs детерминированных паттернов нет).

## 6. Скрипт (целиком, /tmp/real_sim.py)

```python
"""Murmur PWA REAL iOS-cycle keyboard sim on Playwright WebKit — client v160w5v deployed.
URL: https://murmur.senswifi.ru. Composer #message-input. Measurement only, no code edits.

Real iOS model (diff vs old synthetic sim):
- window.innerHeight NEVER changes (852 constant); only vv.height animates.
- Open: 852->780->650->600->520->450, resize on window+vv at each step (50ms),
  2 page scrolls scrollY!=0 between steps (iOS counter-panel), final vv scroll (offsetTop).
- Close: 450->520->600->650->780->852 reverse steps + scrollTo(0,0) + final vv scroll
  (offsetTop change WITHOUT height: dispatchEvent('scroll') on vv after last resize).
- focus #message-input -> blur() -> close animation.

Scenario: 6 cycles WITHOUT reload (reload only once at start; on cycle 5 Oleg saw drift).
After each close: measure composer rect top/bottom, vvH, innerH, scrollY, --vvh, --kb-inset
+ wait 2600ms (full w5v treatment chain).

Bug criteria after close (innerH 852):
(a) composer bottom != 844: bottom > 850 or bottom < 830
(b) --vvh stuck != 852px
(c) scrollY != 0 after 2600ms
Out: /tmp/real_sim_results.json + /tmp/real_sim_*.png
"""
import json
from playwright.sync_api import sync_playwright

URL = "https://murmur.senswifi.ru"
SEL = "#message-input"
N_CYCLES = int(__import__("sys").argv[1]) if len(__import__("sys").argv) > 1 else 6
SHOT = "/tmp/real_sim"
OUT_JSON = "/tmp/real_sim_results.json"

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
  if (ma) { ma.scrollTop = 400; }  // give page real scroll room like a long chat
  return {iaHidden: ia ? ia.hidden : null,
          vvH: window.visualViewport ? window.visualViewport.height : null, innerH: window.innerHeight,
          scrollable: document.documentElement.scrollHeight > window.innerHeight};
}
"""

RECT_JS = """
(sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const vv = window.visualViewport;
  const cs = getComputedStyle(document.documentElement);
  return {top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2), height: +r.height.toFixed(2),
          vvH: vv ? vv.height : null, vvOffsetTop: vv ? vv.offsetTop : null,
          innerH: window.innerHeight, scrollY: window.scrollY,
          vvh: cs.getPropertyValue('--vvh').trim(),
          kbInset: document.documentElement.style.getPropertyValue('--kb-inset').trim() || '-',
          kbVisible: document.body.classList.contains('keyboard-visible')};
}
"""

# ---- REAL iOS open animation: innerHeight constant, vv.height steps, page scrolls, vv scroll ----
OPEN_ANIM = """
async () => {
  const vv = window.visualViewport;
  const el = document.getElementById('message-input');
  const out = [];
  const grab = (step) => {
    const r = el.getBoundingClientRect();
    out.push({step, top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2),
              vvH: vv.height, innerH: window.innerHeight, scrollY: window.scrollY,
              vvOffsetTop: vv.offsetTop});
  };
  const setH = (h) => {
    Object.defineProperty(vv, 'height', {get: () => h, configurable: true});
    window.dispatchEvent(new Event('resize'));
    vv.dispatchEvent(new Event('resize'));
  };
  const setTop = (o) => {
    Object.defineProperty(vv, 'offsetTop', {get: () => o, configurable: true});
    vv.dispatchEvent(new Event('scroll'));
  };
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  // remember real scrollY descriptor to restore after close (criteria need real scrollY)
  // NB: in WebKit the accessor is an OWN property of window, NOT on Window.prototype
  window.__syDesc = Object.getOwnPropertyDescriptor(window, 'scrollY');
  let patched = false;
  const pageScroll = () => {
    window.scrollTo(0, 80);
    window.dispatchEvent(new Event('scroll'));
    if (window.scrollY === 0 && !patched) {  // headless page unscrollable -> emulate iOS scroll
      Object.defineProperty(window, 'scrollY', {get: () => 80, configurable: true});
      patched = true;
    }
  };
  el.focus();           // focusin -> typing=true, keyboard-visible
  await wait(50);       // real iOS: innerHeight does NOT change, only vv
  setH(780); grab(780); await wait(50);
  setH(650); grab(650); await wait(50);
  pageScroll(); grab('scroll1'); await wait(50);
  setH(600); grab(600); await wait(50);
  setH(520); grab(520); await wait(50);
  pageScroll(); grab('scroll2'); await wait(50);
  setH(450); grab(450); await wait(50);
  setTop(60); grab('vvscroll-open');  // iOS: vv offsetTop>0 while keyboard up
  window.__syPatched = patched;
  return out;
}
"""

# ---- REAL iOS close animation: reverse steps + final vv scroll (offsetTop change, no height) ----
CLOSE_ANIM = """
async () => {
  const vv = window.visualViewport;
  const el = document.getElementById('message-input');
  const out = [];
  const grab = (step) => {
    const r = el.getBoundingClientRect();
    out.push({step, top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2),
              vvH: vv.height, innerH: window.innerHeight, scrollY: window.scrollY,
              vvOffsetTop: vv.offsetTop});
  };
  const setH = (h) => {
    Object.defineProperty(vv, 'height', {get: () => h, configurable: true});
    window.dispatchEvent(new Event('resize'));
    vv.dispatchEvent(new Event('resize'));
  };
  const setTop = (o) => {
    Object.defineProperty(vv, 'offsetTop', {get: () => o, configurable: true});
    vv.dispatchEvent(new Event('scroll'));
  };
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  el.blur();
  await wait(50);
  setH(520); grab(520); await wait(50);
  setH(600); grab(600); await wait(50);
  setH(650); grab(650); await wait(50);
  setH(780); grab(780); await wait(50);
  setH(852); grab(852); await wait(50);
  window.scrollTo(0, 0); window.dispatchEvent(new Event('scroll'));
  setTop(0); grab('vvscroll-close');  // FINAL vv scroll: offsetTop change WITHOUT height change
  // restore real scrollY getter (patched during open because headless page cannot scroll)
  if (window.__syPatched && window.__syDesc) {
    Object.defineProperty(window, 'scrollY', window.__syDesc);
    window.__syPatched = false;
  }
  out.push({step: 'post-restore', scrollY: window.scrollY, realDocTop: document.documentElement.scrollTop});
  return out;
}
"""

def parse_px(s):
    try:
        return int(str(s).replace("px", "").strip())
    except (ValueError, AttributeError):
        return None

def main():
    results = []
    with sync_playwright() as pw:
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
        page.wait_for_timeout(6000)          # ONE reload only here, at the start
        setup = page.evaluate(SETUP_JS)
        print(f"setup: {json.dumps(setup)}")
        if not setup or setup["iaHidden"]:
            print("SETUP FAILED"); browser.close(); return
        rect0 = page.evaluate(RECT_JS, SEL)  # baseline BEFORE any cycle
        page.screenshot(path=f"{SHOT}_0_before.png")
        print(f"before: {json.dumps(rect0)}")

        for i in range(1, N_CYCLES + 1):
            try:
                open_steps = page.evaluate(OPEN_ANIM)
                page.wait_for_timeout(200)
                rect_open = page.evaluate(RECT_JS, SEL)
                page.screenshot(path=f"{SHOT}_{i}_open.png")
                close_steps = page.evaluate(CLOSE_ANIM)
                sy_t0 = page.evaluate("() => ({sy: window.scrollY, dt: document.documentElement.scrollTop, body: document.body.scrollTop})")
                page.wait_for_timeout(2600)   # full w5v treatment chain
                sy_t2600 = page.evaluate("() => ({sy: window.scrollY, dt: document.documentElement.scrollTop, body: document.body.scrollTop})")
                after = page.evaluate(RECT_JS, SEL)
                page.screenshot(path=f"{SHOT}_{i}_after.png")

                bottom_bug = bool(after and (after["bottom"] > 850 or after["bottom"] < 830))
                vvh_bug = (parse_px(after["vvh"]) is not None and abs(parse_px(after["vvh"]) - 852) > 4)
                scroll_bug = bool(after and after["scrollY"] is not None and abs(after["scrollY"]) > 2)
                bug = bool(bottom_bug or vvh_bug or scroll_bug)
                innerh_const = all(s.get("innerH", 852) == 852 for s in (open_steps + close_steps)) and after.get("innerH") == 852
                print(f"[cycle{i}] after: {json.dumps(after)}")
                print(f"[cycle{i}] sy_t0={json.dumps(sy_t0)} sy_t2600={json.dumps(sy_t2600)}")
                print(f"[cycle{i}] BUG={bug} (bottom_bug={bottom_bug} vvh_bug={vvh_bug} scroll_bug={scroll_bug}) innerh_const={innerh_const}")
                print(f"[cycle{i}] openSteps={json.dumps(open_steps)}")
                print(f"[cycle{i}] closeSteps={json.dumps(close_steps)}")
                results.append({"cycle": i, "before": rect0 if i == 1 else None, "open": rect_open,
                                "after": after, "bug": bug, "bottom_bug": bottom_bug,
                                "vvh_bug": vvh_bug, "scroll_bug": scroll_bug,
                                "innerh_const": innerh_const,
                                "open_steps": open_steps, "close_steps": close_steps})
            except Exception as e:
                import traceback; print(f"[cycle{i}] ERROR:"); traceback.print_exc()
        browser.close()

    with open(OUT_JSON, "w") as f:
        json.dump(results, f, indent=2)
    bug_n = sum(1 for r in results if r["bug"])
    cycles_bug = [r["cycle"] for r in results if r["bug"]]
    print(f"\n=== SUMMARY: bug={bug_n}/{len(results)} cycles={cycles_bug} ===")
    print(f"JSON: {OUT_JSON}")

if __name__ == "__main__":
    main()

```
