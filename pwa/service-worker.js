// murmur service worker — pushes incoming message notifications.
//
// Payload (from relay push.rs PushPayload::to_json):
// { alias, from_npub, ts, envelope_hash_hex, title, body }

// Cache versioning. Bump CACHE_VERSION on each deploy that changes
// app.js / index.html / styles.css / manifest.json. The activate handler
// below deletes every cache whose name doesn't match the current version,
// so old SW-controlled clients get the fresh files automatically without
// the user needing to add ?v=N to the URL.
const CACHE_VERSION = "murmur-v66";
const PRECACHE = []; // No precache — browser handles HTTP cache naturally.

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
  })());
});

// NOTE: fetch handler removed. It was causing UI breakage on iOS PWA
// (stale HTML/JS/CSS served from cache, buttons unclickable). We rely on
// the browser's normal HTTP cache. SW is now only for push notifications.
self.addEventListener("fetch", (event) => {
    // pass-through: do not respondWith, browser handles it normally.
    return;
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
