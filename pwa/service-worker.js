// murmur service worker — pushes incoming message notifications.
//
// Payload (from relay push.rs PushPayload::to_json):
// { alias, from_npub, ts, envelope_hash_hex, title, body }

// Cache versioning. Bump CACHE_VERSION on each deploy that changes
// app.js / index.html / styles.css / manifest.json. The activate handler
// below deletes every cache whose name doesn't match the current version,
// so old SW-controlled clients get the fresh files automatically without
// the user needing to add ?v=N to the URL.
const CACHE_VERSION = "murmur-v88";
const PRECACHE = []; // No precache — browser handles HTTP cache naturally.

// Lesson #217 (Олег 2026-08-26 15:21): allow client to request skipWaiting
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("install", (event) => {
  self.skipWaiting();
  // Pre-cache the shell so first paint works offline.
  event.waitUntil(
    caches.open(CACHE_VERSION).then((c) =>
      // Use addAll with individual fallbacks so a single 404 doesn't
      // fail the whole install (icons can be missing in early deploys).
      Promise.all(
        PRECACHE.map((u) => c.add(u).catch(() => null))
      )
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Drop any caches that aren't the current version. This is what
    // makes deployments take effect: when CACHE_VERSION changes, all
    // old caches (including those from the old SW) are evicted.
    const names = await caches.keys();
    await Promise.all(
      names.map((n) => (n === CACHE_VERSION ? null : caches.delete(n)))
    );
    await self.clients.claim();
    // Lesson #217 (Олег 2026-08-26 15:21): на iPhone PWA даже после reinstall
    // остаётся на старом SW (не активируется новый). После activate — force-reload
    // всех controlled clients, чтобы они загрузили свежие app.js?в=v83 из server.
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) {
        try { client.navigate(client.url); } catch (e) { /* ignore */ }
    }
  })());
});

// Lesson #220 (Олег 2026-08-26 15:51): ULTRA-DEFENSIVE fix — предыдущий
// Lesson #219 redirect ломал iPhone с "Load cannot follow more than 20
// redirections" — SW redirectил на ?v=85, SW опять перехватывал, бесконечный loop.
//
// НОВОЕ решение: redirect ТОЛЬКО когда:
// 1. Это navigation request (не sub-resource)
// 2. URL НЕ содержит ?v= query (иначе уже на fresh URL — pass through)
// Это избегает redirect-loop, но всё ещё пробивает iOS HTML cache для initial loads.
self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.mode === "navigate") {
        const url = new URL(req.url);
        // Pass-through если уже версионированный URL (избегаем loop)
        if (url.searchParams.has("v")) {
            return;  // let browser handle normally
        }
        // Pass-through если уже /index.html (на случай если initial URL)
        if (url.pathname.endsWith("/index.html")) {
            return;
        }
        // Pass-through для API routes
        if (url.pathname.startsWith("/api/")) {
            return;
        }
        // Только для root "/" → redirect на versioned index
        if (url.pathname === "/" || url.pathname === "") {
            const target = `${url.origin}/index.html?v=${CACHE_VERSION}`;
            event.respondWith(Response.redirect(target, 302));
        }
    }
    // Остальное: pass-through
});

self.addEventListener("push", (event) => {
  let payload = { alias: "unknown", title: "Murmur", subtitle: "Кто-то", body: "Новое сообщение" };
  try {
    if (event.data) {
      payload = event.data.json();
    }
  } catch (e) {
    console.warn("[murmur-sw] push payload not JSON", e);
  }
  const title = payload.title || "Murmur";
  const options = {
    // iOS Web Push uses `subtitle` slot for the sender alias; supplying it
    // suppresses iOS's auto-injected "from <app name>" line. Other platforms
    // ignore the field.
    subtitle: payload.subtitle || "",
    body: payload.body || "Откройте murmur, чтобы прочитать сообщение",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: "murmur-" + (payload.envelope_hash_hex || "").slice(0, 8),
    renotify: true,
    data: {
      alias: payload.alias,
      from_npub: payload.from_npub,
      ts: payload.ts,
      envelope_hash_hex: payload.envelope_hash_hex,
    },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wcls) => {
      for (const c of wcls) {
        if (c.url.endsWith("/") && "focus" in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
