// murmur service worker — push notifications ONLY.
//
// Lesson #345 (Олег 2026-08-30 14:20 MSK): этот SW больше НЕ управляет
// статикой. История координ: navigate-redirect (?v=), client.navigate()
// в activate, двойной controllerchange reload (index.html + app.js) —
// всё это давало reload-лупы, mix-состояния (старый HTML + новый JS),
// белый экран на iPhone после апдейта. Статика отдаётся сервером с
// no-store (js/css/html/json), браузер сам ходит в сеть каждый раз.
// SW нужен ТОЛЬКО ради Web Push уведомлений.

const SW_VERSION = "murmur-sw6";

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
  // v160y (Олег 19:20): платформенный сплит против дубля заголовка.
  // macOS: title="" → система сама подставляет имя приложения ВТОРОЙ
  // строкой (скриншот 18:45: "murmur / murmur / Новое сообщение").
  // Лечение: title = текст, body = "" → баннер "murmur / Новое сообщение"
  // (первую строку app-name рисует ОС, неустранимо).
  // iOS: title="" как в v160w — чистая одна строка body (Lesson #395:
  // непустой title на iOS → субтитл "from murmur").
  let payload = { alias: "unknown", title: "", subtitle: "", body: "Новое сообщение" };
  try {
    if (event.data) {
      payload = event.data.json();
    }
  } catch (e) {
    console.warn("[murmur-sw] push payload not JSON", e);
  }
  const text = payload.body || "Новое сообщение";
  // WorkerNavigator.userAgent доступен в SW; iPad отдаёт Macintosh-UA →
  // исключаем мобильные явно.
  const ua = (self.navigator && self.navigator.userAgent) || "";
  const isMac = /Macintosh|Mac OS X/i.test(ua) && !/iPhone|iPad|iPod/i.test(ua);
  const title = isMac ? text : "";
  const options = {
    // Олег 2026-09-05 20:40: subtitle/sender-превью убрали (минимум текста
    // в пуше). Subtitle пустой → iOS не вставит «from <app>» авто-строку.
    subtitle: "",
    body: isMac ? "" : text,
    icon: "/i192-2026b.png",
    badge: "/i192-2026b.png",
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