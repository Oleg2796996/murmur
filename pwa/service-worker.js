// murmur service worker — pushes incoming message notifications.
//
// Payload (from relay push.rs PushPayload::to_json):
// { alias, from_npub, ts, envelope_hash_hex, title, body }

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = { alias: "unknown", title: "murmur", body: "new encrypted message" };
  try {
    if (event.data) {
      payload = event.data.json();
    }
  } catch (e) {
    console.warn("[murmur-sw] push payload not JSON", e);
  }
  const title = payload.title || "murmur";
  const options = {
    body: payload.body || "new encrypted message",
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
