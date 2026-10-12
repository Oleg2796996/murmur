# iOS PWA badge clearing: page-context vs service-worker — research notes

**Date:** 2026-10-11 · **Scope:** MurMur (home-screen PWA, iOS 26.x, Web Push via VAPID, SW shows notification).
**Symptom:** badge set after push (`navigator.setAppBadge(N)` in SW push handler, and/or badge in push payload) persists after the user reads the message; page-context `clearAppBadge()` on resume/visibilitychange/focus/pageshow no longer clears it. Full PWA delete + reinstall did not fix.
**Method:** WebKit source read (sparse clone of WebKit/WebKit @ `bb5913e37d01`, Oct 2026 main), WebKit Bugzilla queries, W3C badging repo issues, MDN, developer.chrome.com. Apple developer docs/forums were not fetchable (404 / human-verification wall) — anything sourced only from there is marked UNVERIFIED.

---

## TL;DR

1. **In WebKit, `clearAppBadge()` is literally `setAppBadge(0)`** — same code path, no semantic difference (`Source/WebCore/page/Navigator.cpp`, `WorkerNavigator.cpp`). "Try setAppBadge(0) instead" is not a real fix on iOS. **CONFIRMED (source).**
2. **Page and SW badge calls take *different IPC routes* on iOS** and both end up at webpushd, which owns the actual badge of the web clip's "PushBundle" (`com.apple.WebKit.PushBundle.<partition>`, via `UISApplicationState.badgeValue`). **CONFIRMED (source).**
3. There are **three silent no-op points** in the page-clear chain (no webpushd connection; no web clip / subscription-set for the origin; origin same-site mismatch). Any one of them silently swallows the clear — promise still resolves. **CONFIRMED (source).** This is the leading explanation for "worked earlier, stopped later": the clear is best-effort fire-and-forget with no error surfaced.
4. **For declarative web push** (`"web_push": 8030` payloads), if the push is *immutable*, **the SW push handler never runs** — webpushd shows the notification and sets the badge **system-side from the payload's `app_badge` member**. If MurMur's relay ever emits declarative payloads with `app_badge`, the badge is system-owned from delivery. **CONFIRMED (source); applicability to MurMur's current relay payload: UNKNOWN — check the relay JSON.**
5. **iOS does not auto-clear the PWA badge on open** — no auto-clear code exists in webpushd/WebKit for web clips (native-app convention is the app itself clearing on launch). Dismissing/tapping the notification banner also does not reset the badge. **CONFIRMED as "no auto-clear in WebKit code"; system-side behavior outside WebKit: COMMUNITY-REPORTED/UNVERIFIED.**
6. **Practical fix for MurMur:** clear the badge from **both** contexts on read: page `clearAppBadge()` **and** postMessage → SW `navigator.clearAppBadge()` (SW route uses a different IPC channel — `workerUpdatedAppBadge` delegate — so it can succeed where the page route silently no-ops). Also stop sending `badge` in the push payload / notification `badge` option so the system never sets a badge we can't reliably retract.

---

## 1. How the badge actually works on iOS (WebKit source)

### 1.1 One JS surface, two very different plumbing routes

**Page context** (`Navigator::setAppBadge`, `Source/WebCore/page/Navigator.cpp:415`):
```
Navigator::setAppBadge → page->badgeClient() (WebBadgeClient)
  → WebProcess::setAppBadge
      if builtInNotificationsEnabled:
          → NetworkProcess: NotificationManagerMessageHandler::SetAppBadge
          → NetworkNotificationManager::setAppBadge
          → webpushd: PushClientConnection::SetAppBadge     (sendWithoutUsingIPCConnection!)
      else (legacy):
          → WebFrameProxy::setAppBadge → UIDelegate::_webView:updatedAppBadge:fromSecurityOrigin:
```
Source: `Source/WebKit/WebProcess/WebProcess.cpp:2455-2471`, `Source/WebKit/NetworkProcess/Notifications/NetworkNotificationManager.cpp:159-166`, `Source/WebKit/UIProcess/WebFrameProxy.cpp:1177-1183`, `Source/WebKit/UIProcess/Cocoa/UIDelegate.mm:2048-2066`.

**Service worker context** (`WorkerNavigator::setAppBadge`, `Source/WebCore/page/WorkerNavigator.cpp:89`):
```
WorkerNavigator::setAppBadge
  (a) if inside a declarative push event: declarativePushEvent->setUpdatedAppBadge(badge)
      → the badge value is folded into the push result payload; the SYSTEM applies it
        after the event ends (see 1.3). No immediate call.
  (b) otherwise: WorkerBadgeProxy → ServiceWorkerThreadProxy::setAppBadge
      → page->badgeClient().setAppBadge(nullptr, origin, badge)   [frame = null!]
      → WebProcess::setAppBadge with frame==null
      → UIProcess: WebProcessProxy::SetAppBadgeFromWorker
      → WebsiteDataStore::workerUpdatedAppBadge
      → _WKWebsiteDataStoreDelegate websiteDataStore:workerOrigin:updatedAppBadge:
```
Source: `Source/WebKit/UIProcess/WebProcessProxy.cpp:3532-3538`, `Source/WebKit/UIProcess/WebsiteData/WebsiteDataStore.cpp:2899-2902`, `Source/WebKit/UIProcess/API/Cocoa/WKWebsiteDataStore.mm:276-287`, `Source/WebKit/UIProcess/API/Cocoa/_WKWebsiteDataStoreDelegate.h:68`.

So on iOS the two contexts reach the badge through **different daemons/delegates**. They ultimately converge on the same system badge store for the web clip (below), but a failure in one route does not affect the other — which is exactly why clearing from *both* contexts is the robust pattern.

### 1.2 Where the badge physically lives on iOS (webpushd)

`Source/WebKit/webpushd/WebPushDaemon.mm:1213-1262` (`WebPushDaemon::setAppBadge`):
- Looks up the **web clip** for the origin: `connection.subscriptionSetIdentifierForOrigin(badgeOriginData)` — i.e. the origin must have a **web push subscription set** registered with webpushd. If not found: log `"No web clip associated with origin"` and **return silently**.
- Origin same-site check against the web clip page URL; mismatch → **return silently**.
- iOS: `UISApplicationState` for bundle ID `com.apple.WebKit.PushBundle.<pushPartition>` gets `badgeValue = appBadge ? N : nil` — `nil` (clear) or `0` both clear.

`clearAppBadge()` semantics: `Navigator.cpp:451-454` — `clearAppBadge` calls `setAppBadge(callingContext, 0, promise)`. `0` → `nil` badgeValue → badge removed. **CONFIRMED: clearAppBadge == setAppBadge(0), one code path.**

### 1.3 The declarative-push badge is system-owned at delivery time

- Push JSON with header `{"web_push": 8030, "notification": {..., "app_badge": N}}` is a *declarative* push (`NotificationJSONParser.cpp:37-49,154-166`; key is `app_badge`).
- **Immutable** declarative push (`"mutable"` not set): webpushd shows the notification itself (`WebPushDaemon.mm:570-585`) and `WebsiteDataStore::processPushMessage` calls `workerUpdatedAppBadge(origin, appBadge)` (`WebsiteDataStore.cpp:3077-3078`). **The SW `push` handler never executes** — badge is applied by the system as part of notification delivery.
- **Mutable** declarative push: SW gets a `declarativepush` event; `navigator.setAppBadge(x)` inside it just records `event.setUpdatedAppBadge` (`WorkerNavigator.cpp:92-99`, `PushEvent.h:58`); after the event, `ServiceWorkerThread.cpp:372-382` folds the final `appBadge` into the result payload → same `workerUpdatedAppBadge` system application.

**Implication:** if the badge arrives via the *payload*, it is applied by the system *after* your SW handler (or instead of it) — a page that was already open and called `clearAppBadge()` *before* the payload badge lands can be re-badged right after. Ordering matters.

### 1.4 Badge in the notification itself

`WebPushDaemon::showNotification` sets `content.badge = appBadge` (`WebPushDaemon.mm:1026`) — this is the UNUserNotificationCenter notification-content badge that iOS applies to the app badge **at delivery time**. Removing/dismissing the notification later does **not** rewind the app badge (standard UNUserNotificationCenter behavior; iOS only auto-manages badges for some first-party flows). **COMMUNITY-REPORTED for UNUserNotificationCenter; CONFIRMED that WebKit ships the badge inside the notification content.**

### 1.5 No auto-clear on open

Greps across `webpushd/`, `UIProcess/Notifications/`, `WebsiteDataStore` found **no code** that clears a web clip's badge when the web clip is opened/focused. The badge persists until some component issues `SetAppBadge`/clear through webpushd (or the host app's `_WKWebsiteDataStoreDelegate`). Native iOS apps clear their own badge in `-applicationDidBecomeActive`; a home-screen PWA has no equivalent unless WebKit/the web clip host does it — and it doesn't, in the open-source tree. **CONFIRMED (absence in open-source WebKit); note the closed-source web-clip host shell (HomeScreenWebClip / SpringBoard parts) is NOT in this tree, so a system-level auto-clear there can't be fully ruled out — UNVERIFIED.**

### 1.6 Silent no-op points (the "why did it stop working" candidates)

| # | Location | Condition | Effect |
|---|----------|-----------|--------|
| A | `NetworkNotificationManager::setAppBadge` (`NetworkNotificationManager.cpp:159-162`) | no active webpushd connection (`if (!connection) return;`) | page clear dropped, promise still resolves |
| B | `WebPushDaemon::setAppBadge` (`WebPushDaemon.mm:1215-1219`) | `subscriptionSetIdentifierForOrigin` fails — no web clip/push-subscription-set for origin | clear dropped silently |
| C | `WebPushDaemon::setAppBadge` (`WebPushDaemon.mm:1233-1236`) | origin not same-site as web clip page URL | clear dropped silently |
| D | `UIDelegate.mm:2054` (non-built-in-notifications path) | host app doesn't implement `_webView:updatedAppBadge:fromSecurityOrigin:` | clear dropped silently |
| E | `WKWebsiteDataStore.mm:277-279` (SW route) | data-store delegate missing / doesn't implement `workerOrigin:updatedAppBadge:` | SW clear dropped silently |

None of these reject the JS promise. **You will never see an error in DevTools.** This is consistent with "worked earlier today, stopped after": e.g. the webpushd connection/subscription-set state after a push-driven launch can differ from a user-launched session.

### 1.7 `clearAppBadge()` vs `setAppBadge(0)` vs `setAppBadge(undefined)`

- `clearAppBadge()` → `setAppBadge(0)` exactly. **CONFIRMED.**
- `setAppBadge()` with no args = "flag" badge (dot), *not* clear — known spec footgun (w3c/badging#60, #19) and WebKit bug 307739 ("An attempt to set the badge to flag should not remove the badge", NEW). Never call `setAppBadge()` bare to clear.
- `setAppBadge(undefined)` coerces to 0 = clear (w3c/badging#60 discussion). Fine, but don't rely on it.

---

## 2. Answers to the research questions

### Q1. Does page-context `clearAppBadge()` clear a badge set from the SW push handler?

**Partially confirmed, with caveats.**
- There is **no architectural block** in WebKit: page and SW calls converge on the same system badge store (`com.apple.WebKit.PushBundle.<partition>`). A page-context clear *can* clear an SW-set badge. **CONFIRMED (source).**
- But the page route has **three silent failure modes** (§1.6 A–C) and the two contexts use **different IPC routes** (§1.1), so in practice a page-only clear is fragile exactly in the scenario MurMur hit: app launched *by push*, webpushd connection/subscription-set state not (yet / no longer) matching the origin.
- I found **no public WebKit bug** saying "page clearAppBadge ignored after SW set" — Bugzilla quicksearch `clearAppBadge` returns zero open bugs; `appBadge` returns only #256241 (iframe origin SecurityError) and #307739 (flag-vs-clear semantics). **CONFIRMED (absence).**

### Q2. SW-set badge vs system badge from push payload; auto-clear behavior?

- **(a) SW `setAppBadge`** (classic push): goes SW route (§1.1b) → `workerUpdatedAppBadge` → host-app delegate → (on iOS home screen) the web clip's PushBundle badge.
- **(b) Payload `app_badge` (declarative)** and **notification-content `badge`** are applied **by the system at delivery time** (§1.3, §1.4) — potentially *independent of anything your JS does*, and applied *after* an already-running page may have cleared.
- **Auto-clear on open:** not implemented in open-source WebKit for web clips (§1.5). **Auto-clear on banner dismiss/tap:** no such code path in webpushd; UNUserNotificationCenter does not rewind badges on dismiss. **COMMUNITY-REPORTED for UIKit behavior; treat as very likely.**
- Effective mental model on iOS: the PWA badge ≈ **"last value any component pushed into the PushBundle's badge store"**, NOT a count of undelivered/undismissed notifications. (On **Android/Chrome** the badge *is* tied to undismissed notifications — developer.chrome.com badging docs state Android shows a badge while there's an unread notification; that mental model does **not** port to iOS.) **CONFIRMED for Chrome/Android, source-derived for iOS.**

### Q3. Known bugs

| Ref | Status | What |
|-----|--------|------|
| WebKit bug **307739** | NEW (updated 2026-02-12) | `setAppBadge()` flag-mode should not *remove* the badge — i.e. WebKit's flag handling is wrong; relevant if you ever call `setAppBadge()` bare |
| WebKit bug **256241** | NEW | `setAppBadge` should reject SecurityError for cross-origin iframe (irrelevant to MurMur top-frame use, shows origin gating) |
| WebKit bug **268797** | (fetched earlier) | `notificationclick` not firing in SW on iOS standalone PWAs (iOS 16.4+) → any clear strategy that depends on `notificationclick`/`notificationclose` is unreliable on iOS |
| w3c/badging **#110** | (checked earlier) | WebKit does **not** implement the spec's "require notification permission before setAppBadge" — badging works without `Notification.permission === 'granted'`; also means permission state tells you nothing about badge behavior |
| w3c/badging **#60 / #19** | spec | `setAppBadge()` bare = flag, `setAppBadge(undefined)` = clear — footgun |
| — | **UNVERIFIED** | Apple developer docs pages for App Badge / conformant APIs returned 404 through the fetcher; Apple forums threads are behind a human-verification wall. Anything "documented" about iOS badging in Apple's docs could not be cited here. |

No WebKit bug found for "page clear doesn't clear SW-set badge" (absence confirmed by Bugzilla search, §Q1). Community threads (StackOverflow 76532998, Apple forums 746254) were blocked by anti-bot walls — **unverified**.

### Q4. Correct pattern to clear on read

**Clear from BOTH contexts, and make the SW the authority:**

1. Page detects "all read" → `navigator.clearAppBadge()` **and** `navigator.serviceWorker.controller.postMessage({type:'clear-badge'})`.
2. SW on `message` → `navigator.clearAppBadge()` (self.navigator). This exercises the **SW route** (`workerUpdatedAppBadge`), which is a *different pipe* than the page route; if the page route silently no-ops (§1.6), the SW route can still succeed, and vice versa.
3. **Timing:** do the clear as early as possible on `visibilitychange`→visible / `focus` / `pageshow` — before heavy rendering — because iOS may suspend the page (promise resolves but IPC may not flush). There is no documented requirement that the page be visible for the API to work (`InvalidStateError` only requires the document be *fully active* — MDN); but a suspended/killed page obviously can't clear at all, which is precisely the reported scenario: if the page never actually resumed to foreground-visible state (user read via notification tap → possibly a *new* page load), the old handlers may never have run. Ensure the clear also runs on initial page load after navigation (`pageshow` with `persisted` false too).
4. **Do not** depend on `notificationclose`/`notificationclick` to clear (WebKit bug 268797: `notificationclick` unreliable on iOS standalone).

Evidence split: nothing in the WebKit source says SW-context clear works *better* than page-context; both are best-effort. The recommendation to use both is **inferred from source architecture (different routes)**, not from a documented Apple statement. Mark: **CONFIRMED (architecture) / SPECULATION (that dual-clear fixes the reported repro)**.

### Q5. Is the badge "count of delivered-but-not-dismissed notifications"?

**No (iOS).** The badge is a single stored value in the PushBundle's application state, set by whatever last called `SetAppBadge` (webpushd, from payload or from JS) — see §1.2. Dismissing the notification does not decrement it; delivering N notifications does not sum to N. The only ways it changes: another `setAppBadge`/`clearAppBadge` call, or (speculative, UNVERIFIED) some closed-source web-clip-host behavior. **`notificationclose` is not a viable clearing mechanism on iOS** — compounded by WebKit bug 268797 (notificationclick/close events unreliable in standalone mode).

### Q6. Workarounds (what production PWAs do)

- **Both-context clearing** (above) — the standard defensive pattern; also what the Chrome docs imply ("badge can be set from the current page, or from the registered service worker"; apps typically keep a single `updateBadge(n)` helper reachable from both sides).
- **Never send `badge` in the web-push payload** unless you use declarative push intentionally: for classic pushes the `badge` member of the *encrypted payload* is just data (harmless), but if the relay also sets APNS-level badge or you adopt declarative format (`web_push: 8030` + `app_badge`), the system applies it at delivery and your page can't reliably retract it. MurMur should verify its relay JSON does not contain `web_push`/`app_badge` keys (§1.3) and that APNS delivery of the push doesn't carry a badge.
- **Also avoid `showNotification({badge: ...})`** confusion: `options.badge` is the *notification icon image* per Notification spec, not the app badge — unrelated; do not use it expecting badge behavior.
- **On read in an open chat:** clear immediately on `visibilitychange`→visible + `pageshow` + `focus` + after message-render; use both contexts; consider re-clearing a second time ~1–2 s later (cheap, covers the race where the payload badge lands after your first clear — §1.3 ordering).
- **`setAppBadge(0)` vs `clearAppBadge()`:** identical in WebKit (§1.7). Call both if you want belt-and-braces across browsers, but don't expect a different outcome on iOS.

---

## 3. Ranked candidate root causes for "badge stays lit after read"

1. **Silent no-op in the page→webpushd clear chain** (§1.6 A/B/C) — e.g. after a push-driven relaunch, webpushd connection or the origin's subscription-set lookup isn't in the state the page route expects; promise resolves, nothing happens. Fits "worked earlier today, broke later" and "reinstall didn't help" (state is per-web-clip/partition, recreated the same way). **Most likely. CONFIRMED mechanism, trigger conditions SPECULATION.**
2. **Declarative/payload badge ordering race** — if any part of the pipeline (relay `app_badge`, APNS badge, `content.badge` from a mutable declarative push result) applies the badge at/after delivery, a page that cleared on resume can be re-badged afterwards; user then reads and clears *once*, but the payload badge from the last push was applied after that clear. **CONFIRMED mechanism exists; applicability to MurMur's current payloads UNKNOWN — audit the relay JSON.**
3. **Page never actually ran the clear** in the failing scenario — user reopens via notification tap while the old page instance was discarded; new load's clear handler not yet wired (or ran while `document` not fully active → `InvalidStateError` rejection swallowed). Fits "swipe away again → badge still lit" (the read session's clear never happened, and there's no auto-clear on next launch). **CONFIRMED as a real possibility; requires client logging to rule in/out.**
4. **Closed-source web-clip host caching the badge value** — the `com.apple.WebKit.PushBundle.*` badge state might be snapshotted by SpringBoard and not refreshed until some event; iOS 26.x regression plausible (user says behavior changed today without app changes). **SPECULATION/UNVERIFIED** (closed source; would explain suddenness + reinstall failure only partially).
5. **WebKit flag-badge bug 307739** interacting with a bare `setAppBadge()` call somewhere in MurMur's code (e.g. `updateBadge()` calling `setAppBadge()` with no arg when count unknown). Flag-mode would *set* a dot badge instead of clearing. **Worth grepping MurMur for bare `setAppBadge()` calls. CONFIRMED bug exists; applicability UNKNOWN.**

---

## 4. Ranked fixes

1. **Dual-context clear with SW as fallback authority** (high confidence, low cost).
   - Page: on read-complete → `clearAppBadge()` + `postMessage` to SW.
   - SW: `message` handler → `navigator.clearAppBadge()`; also clear in the SW `push` handler when the payload says badge=0.
   - Both wrapped in try/catch; log rejections (`InvalidStateError` when document not fully active is a real signal).
2. **Clear early + repeat**: hook `visibilitychange`(visible), `pageshow`(both persisted states), `focus`, and immediately after rendering messages; schedule one delayed re-clear (≈1.5 s) to beat payload-badge ordering (§1.3). Low risk.
3. **Audit & normalize the push payload**: ensure the relay does NOT include `web_push: 8030` / `app_badge` (declarative) keys, and that the APNS-side delivery carries no badge. Badge should only ever be set by explicit `setAppBadge` calls from your JS. Medium confidence this matters — depends on current relay format.
4. **Kill bare `setAppBadge()` calls** in `updateBadge()`: always pass a number (`setAppBadge(n)` with `n≥1`, `setAppBadge(0)`/`clearAppBadge()` for zero). Avoids bug 307739 flag-mode weirdness.
5. **Diagnostics build** (before shipping 1–4 to confirm root cause): log every badge call with timestamp + `document.visibilityState` + promise rejection; optionally call `navigator.setAppBadge(0)` from the SW on `activate` as a self-heal at SW startup.
6. **If all else fails on iOS 26.x**: file a WebKit bug with a minimal repro (page sets badge → SW sets badge → page clears → check icon), citing that both routes resolve their promises. Given no existing Bugzilla entry matches, this may genuinely be an iOS 26 regression worth reporting.

---

## 5. Implementation sketch

### Service worker (`sw.js`)

```js
// ---- badge authority ----------------------------------------------------
async function setBadge(n) {
  try {
    if (n > 0) await self.navigator.setAppBadge(n);
    else       await self.navigator.clearAppBadge(); // === setAppBadge(0) in WebKit
  } catch (e) {
    console.warn('badge op failed in SW', e); // surface in diagnostics
  }
}

// classic push: badge comes from OUR code only, never from payload plumbing
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const badge = Number(data.badge || 0);
  event.waitUntil((async () => {
    await self.registration.showNotification(data.title || 'MurMur', {
      body: data.body || '',
      tag: data.tag || 'murmur-chat',
      data: { url: data.url || '/' },
      // NOTE: do NOT set `badge:` here — that is the notification ICON, not app badge
    });
    if (badge > 0) await setBadge(badge);
  })());
});

// page → SW clear channel (different IPC route than page-context clear)
self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'clear-badge') event.waitUntil(setBadge(0));
  if (msg.type === 'set-badge' && Number.isFinite(msg.count)) {
    event.waitUntil(setBadge(msg.count));
  }
});

// self-heal: if SW restarts with no state, don't leave a stale badge
self.addEventListener('activate', (event) => {
  event.waitUntil(setBadge(0));
});
```

### Page (`updateBadge` / resume hooks)

```js
let lastUnread = 0;

async function updateBadge(n) {
  lastUnread = n;
  try {
    if (n > 0) await navigator.setAppBadge(n);
    else       await navigator.clearAppBadge();
  } catch (e) {
    console.warn('page badge op failed', e); // InvalidStateError ⇒ doc not fully active
  }
  // Belt & braces: also ask the SW to clear via its own IPC route.
  // (On iOS page- and SW-context badge calls travel different routes; see research notes §1.1.)
  if (n === 0 && navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({ type: 'clear-badge' });
  }
}

function clearBadgeOnResume() {
  if (document.visibilityState === 'visible' && lastUnread === 0) {
    updateBadge(0);
    // re-clear once shortly after, to beat any badge the system applied
    // at push-delivery time AFTER our first clear (ordering race, §1.3)
    setTimeout(() => { if (lastUnread === 0) updateBadge(0); }, 1500);
  }
}

addEventListener('visibilitychange', clearBadgeOnResume);
addEventListener('pageshow', clearBadgeOnResume);   // covers both bfcache restore and fresh load
addEventListener('focus', clearBadgeOnResume);
// after rendering messages in an open chat:
// if (unreadInChat === 0) updateBadge(0);
```

### Anti-patterns to remove from MurMur

- `navigator.setAppBadge()` with **no argument** anywhere (flag-mode; WebKit bug 307739).
- Relying on `notificationclick`/`notificationclose` for badge maintenance (WebKit bug 268797).
- A single-context clear only (page XOR SW).
- `badge`/`app_badge` members in the relay's push JSON (verify with a real payload capture).

---

## 6. Sources

- WebKit source (sparse clone, `main` @ bb5913e37d01, 2026-10-11):
  - `Source/WebCore/page/Navigator.cpp:415-454` (setAppBadge/clearAppBadge page path)
  - `Source/WebCore/page/WorkerNavigator.cpp:89-114` (SW path + declarativePushEvent override)
  - `Source/WebCore/Modules/badge/BadgeClient.h`, `EmptyBadgeClient.h`, `NavigatorBadge.idl`
  - `Source/WebKit/WebProcess/WebProcess.cpp:2455-2471` (route split: built-in notifications vs frame)
  - `Source/WebKit/WebProcess/WebCoreSupport/WebBadgeClient.cpp`
  - `Source/WebKit/NetworkProcess/Notifications/NetworkNotificationManager.cpp:159-166` (silent no-op)
  - `Source/WebKit/UIProcess/WebProcessProxy.cpp:3532-3538`, `WebFrameProxy.cpp:1177-1183`
  - `Source/WebKit/UIProcess/WebsiteData/WebsiteDataStore.cpp:2899-2902, 3061-3094` (workerUpdatedAppBadge; declarative push badge application)
  - `Source/WebKit/UIProcess/API/Cocoa/WKWebsiteDataStore.mm:276-287`, `_WKWebsiteDataStoreDelegate.h:68`, `WKUIDelegatePrivate.h:224`
  - `Source/WebKit/webpushd/WebPushDaemon.mm:1213-1262` (setAppBadge; UISApplicationState; silent failures), `:1016-1060` (showNotification; content.badge), `:144-147` (PushBundle bundle id)
  - `Source/WebCore/Modules/notifications/NotificationJSONParser.cpp:37-50, 74-166` (declarative `web_push:8030`, `app_badge`)
  - `Source/WebCore/Modules/push-api/PushEvent.h/.cpp`, `Source/WebCore/workers/service/context/ServiceWorkerThread.cpp:366-385` (badge folding after push event)
- WebKit Bugzilla: bugs 307739, 256241 (buglist quicksearch `appBadge`, `badging`, `clearAppBadge`); bug 268797 (notificationclick on iOS standalone, fetched earlier in this session).
- w3c/badging GitHub: issues #19, #60 (flag-vs-clear semantics), #110 (WebKit skips permission gate, checked earlier).
- MDN: `Navigator.setAppBadge()` / `Navigator.clearAppBadge()` — "Limited availability", InvalidStateError when document not fully active.
- developer.chrome.com: "Badging for app icons" (Android badge-=-unread-notifications model; set-from-page-or-SW guidance).
- Not accessible (fetched, blocked/404 — cited nowhere): Apple developer docs badge pages, Apple forums thread 746254, StackOverflow 76532998, firt.dev/ios-push.
