"""Murmur PWA iOS keyboard sim (stuck-test) on Playwright WebKit — v160w6b deployed client.
URL: https://murmur.senswifi.ru (v160w6b). Composer #message-input. Measurement only.
Approach from pwa/research/webkit-kb-simulation.md "Скрипт" (kb_sim.py):
WebKit iPhone 393x852 DPR3 touch, standalone-imitation, chat-view forced,
focus #message-input -> vv.height 852->450 -> resize -> blur -> 2600ms.
5 iterations on FRESH pages (new browser context each pass).

Criteria (stuck): after blur --vvh/scrollY did NOT return to 852-baseline,
OR composer rect.bottom > vv.height.
jitter: top spread > 2px in during-phase.
vvh-full: getComputedStyle(html).getPropertyValue('--vvh-full') ~852px and
STABLE across cycle (before focus / during / after blur — all three equal).
Baseline v160w5v: 3/5 stuck (--vvh 932-933px after blur). Expect 0/5 on w6b.
"""
import json, sys
from playwright.sync_api import sync_playwright

URL = "https://murmur.senswifi.ru"
KB_H = 450
SEL = "#message-input"
N_ITER = int(sys.argv[1]) if len(sys.argv) > 1 else 5
SHOT_PREFIX = "/tmp/kb_sim_w6b"
OUT_JSON = "/tmp/kb_sim_w6b_results.json"

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
  const cs = getComputedStyle(document.documentElement);
  return {top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2), height: +r.height.toFixed(2),
          vvH: vv ? vv.height : null, vvOffsetTop: vv ? vv.offsetTop : null,
          innerH: window.innerHeight, scrollY: window.scrollY,
          vvh: cs.getPropertyValue('--vvh').trim(),
          vvhFull: cs.getPropertyValue('--vvh-full').trim(),
          kbInset: document.documentElement.style.getPropertyValue('--kb-inset').trim() || '-',
          kbVisible: document.body.classList.contains('keyboard-visible')};
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
  res({focusOk: document.activeElement === el, typingFlag: true});
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

def run_pass(pw, idx):
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
    rect0 = page.evaluate(RECT_JS, SEL)   # BEFORE (incl. vvh-full)
    if rect0 is None:
        print(f"[pass{idx}] no composer {SEL}")
        browser.close(); return None
    baseline_vvh = rect0["vvh"]; baseline_vvhfull = rect0["vvhFull"]
    page.screenshot(path=f"{SHOT_PREFIX}_{idx}_before.png")
    page.evaluate(FOCUS_KB)               # focus + synthetic resize (keyboard open)
    page.wait_for_timeout(100)
    samples = page.evaluate(RAF_JS, SEL)  # 50ms x 10 = 500ms during-phase
    if samples:
        page.screenshot(path=f"{SHOT_PREFIX}_{idx}_during.png")
    rect_during = page.evaluate(RECT_JS, SEL)
    page.evaluate(BLUR_KB)
    page.wait_for_timeout(2600)           # treatment chain (watchdogs + collapseLock)
    rect_after = page.evaluate(RECT_JS, SEL)  # AFTER (incl. vvh-full)
    page.screenshot(path=f"{SHOT_PREFIX}_{idx}_after.png")

    # --- stuck criteria ---
    # 1) --vvh did not return to baseline after blur (e.g. 932-933px on w5v)
    vvh_stuck = False
    if rect_after and rect_after["vvh"] and baseline_vvh:
        try:
            av = int(rect_after["vvh"].replace("px", ""))
            bv = int(baseline_vvh.replace("px", ""))
            vvh_stuck = abs(av - bv) > 4  # e.g. 852 vs 932
        except ValueError:
            vvh_stuck = rect_after["vvh"] != baseline_vvh
    scroll_stuck = False
    if rect_after and rect_after["scrollY"] is not None:
        scroll_stuck = abs(rect_after["scrollY"]) > 4
    overflow_after = (rect_after and rect_after["bottom"] is not None and
                      rect_after["vvH"] and rect_after["bottom"] > rect_after["vvH"] + 2)
    overflow_during = (rect_during and rect_during["bottom"] is not None and
                       rect_during["vvH"] and rect_during["bottom"] > rect_during["vvH"] + 2)
    stuck = bool(vvh_stuck or scroll_stuck or overflow_after)

    # --- jitter (during-phase top spread) ---
    tops = [s["top"] for s in samples] if samples else []
    jitter = (len(tops) > 1) and (max(tops) - min(tops)) > 2

    # --- vvh-full stability ---
    vf_vals = [baseline_vvhfull, rect_during["vvhFull"] if rect_during else None, rect_after["vvhFull"] if rect_after else None]
    vf_clean = [v for v in vf_vals if v]
    vvhfull_stable = len(set(vf_clean)) == 1 and len(vf_clean) == 3
    # numeric sanity ~852px
    vvhfull_852 = False
    if vf_clean:
        try:
            vvhfull_852 = abs(int(vf_clean[0].replace("px", "")) - 852) <= 6
        except ValueError:
            vvhfull_852 = False

    print(f"[pass{idx}] sel={SEL}")
    print(f"  setup  : {json.dumps(setup)}")
    print(f"  before : {json.dumps(rect0)}")
    if samples:
        print(f"  during : min_top={min(tops)} max_top={max(tops)} max_bottom={max(s['bottom'] for s in samples)} vvH_set={set(s['vvH'] for s in samples)}")
        print(f"  duringR: {json.dumps(rect_during)}")
    print(f"  after  : {json.dumps(rect_after)}")
    print(f"  stuck={stuck} (vvh_stuck={vvh_stuck} scroll_stuck={scroll_stuck} overflow_after={overflow_after} overflow_during={overflow_during})")
    print(f"  jitter={jitter} vvhfull_stable={vvhfull_stable} vvhfull_852={vvhfull_852} vfh={vf_vals}")
    browser.close()
    return {"idx": idx, "before": rect0, "during": rect_during, "after": rect_after, "samples": samples,
            "stuck": stuck, "vvh_stuck": vvh_stuck, "scroll_stuck": scroll_stuck,
            "overflow_after": overflow_after, "overflow_during": overflow_during,
            "jitter": jitter, "min_top": min(tops) if tops else None, "max_top": max(tops) if tops else None,
            "vvhfull_stable": vvhfull_stable, "vvhfull_852": vvhfull_852,
            "vvhfull_values": vf_vals, "setup": setup}

def main():
    results = []
    with sync_playwright() as pw:
        for i in range(1, N_ITER + 1):
            try:
                r = run_pass(pw, i)
                if r: results.append(r)
            except Exception as e:
                print(f"[pass{i}] ERROR: {e}")
    with open(OUT_JSON, "w") as f:
        json.dump(results, f, indent=2)
    stuck_n = sum(1 for r in results if r["stuck"])
    jit_n = sum(1 for r in results if r["jitter"])
    vf_n = sum(1 for r in results if r["vvhfull_stable"])
    print(f"\n=== SUMMARY: stuck={stuck_n}/{len(results)} jitter={jit_n}/{len(results)} vvhfull_stable={vf_n}/{len(results)} ===")
    print(f"JSON: {OUT_JSON}")

if __name__ == "__main__":
    main()
