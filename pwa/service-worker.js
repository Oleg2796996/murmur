// murmur service worker — push notifications ONLY.
//
// Lesson #345 (Олег 2026-08-30 14:20 MSK): этот SW больше НЕ управляет
// статикой. История координ: navigate-redirect (?v=), client.navigate()
// в activate, двойной controllerchange reload (index.html + app.js) —
// всё это давало reload-лупы, mix-состояния (старый HTML + новый JS),
// белый экран на iPhone после апдейта. Статика отдаётся сервером с
// no-store (js/css/html/json), браузер сам ходит в сеть каждый раз.
// SW нужен ТОЛЬКО ради Web Push уведомлений.

const SW_VERSION = "murmur-sw3";

self.addEventListener("install", (event) => {
  // Никаких precache — сервер отдаёт всё с no-store.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Удаляем ВСЕ legacy-кэши от старых SW (murmur-v<NNN> и прочее).
    try {
      const names = await caches.keys();
      await Promise.all(names.map((n) => caches.delete(n)));
    } catch (e) { /* ignore */ }
    await self.clients.claim();
  })());
});

// НЕТ fetch-хендлера — SW не перехватывает ни навигации, ни статику.
// (До этого: navigate-redirect на /index.html?v=N вызывал redirect-loops
// на iOS "Load cannot follow more than 20 redirections", Lesson #219/#220.)

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("push", (event) => {
  let payload = { alias: "unknown", title: "Murmur", subtitle: "", body: "Новое сообщение" };
  try {
    if (event.data) {
      payload = event.data.json();
    }
  } catch (e) {
    console.warn("[murmur-sw] push payload not JSON", e);
  }
  const title = payload.title || "Murmur";
  const options = {
    // iOS Web Push uses `subtitle` slot for the sender; supplying it
    // suppresses iOS's auto-injected "from <app name>" line. Other platforms
    // ignore the field. v149: subtitle = short npub (имена — на клиенте).
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