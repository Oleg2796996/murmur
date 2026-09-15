// murmur service worker — push notifications ONLY.
//
// Lesson #345 (Олег 2026-08-30 14:20 MSK): этот SW больше НЕ управляет
// статикой. История координ: navigate-redirect (?v=), client.navigate()
// в activate, двойной controllerchange reload (index.html + app.js) —
// всё это давало reload-лупы, mix-состояния (старый HTML + новый JS),
// белый экран на iPhone после апдейта. Статика отдаётся сервером с
// no-store (js/css/html/json), браузер сам ходит в сеть каждый раз.
// SW нужен ТОЛЬКО ради Web Push уведомлений.

const APP_DISPLAY_NAME = "MurMur";
const SW_VERSION = "murmur-sw18"; // v160y22: fix ReferenceError isDesktop → platform split restored

function pushDebugToClients(event, detail) {
  try {
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        c.postMessage({ type: "push-debug", event, detail: String(detail || "") });
      }
    }).catch(() => {});
  } catch (e) { /* ignore */ }
}

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
  pushDebugToClients("push-received", "data=" + (event.data ? "yes" : "no"));
  // v160y (Олег 19:20): платформенный сплит против дубля заголовка.
  // macOS: title="" → система сама подставляет имя приложения ВТОРОЙ
  // строкой (скриншот 18:45: "murmur / murmur / Новое сообщение").
  // Лечение: title = текст, body = "" → баннер "murmur / Новое сообщение"
  // (первую строку app-name рисует ОС, неустранимо).
  // iOS: title="" как в v160w — чистая одна строка body (Lesson #395:
  // непустой title на iOS → субтитл "from murmur").
  let payload = { alias: "unknown", title: "", subtitle: "", body: "New message — open the app to read it" };
  try {
    if (event.data) {
      payload = event.data.json();
    }
  } catch (e) {
    console.warn("[murmur-sw] push payload not JSON", e);
    pushDebugToClients("push-parse-error", e && e.message || String(e));
  }
  const text = payload.body || "New message — open the app to read it";
  // WorkerNavigator.userAgent доступен в SW; iPad отдаёт Macintosh-UA →
  // исключаем мобильные явно.
  const ua = (self.navigator && self.navigator.userAgent) || "";
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const isMac = /Macintosh|Mac OS X/i.test(ua) && !isIOS;
  // macOS (v160y13): title=text, body="" — иначе баннер пустой/пропадает.
  // iOS: title="", body=text — MurMur / from MurMur (Олег OK после reinstall).
  // Win/HP: title="", body=text — без дубля title (v160y12).
  const title = isMac ? text : "";
  const options = {
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
  pushDebugToClients("push-show", "isMac=" + isMac + " isIOS=" + isIOS + " title='" + title.slice(0, 40) + "' body='" + (options.body || "").slice(0, 40) + "' alias=" + (payload.alias || "?"));
  event.waitUntil(
    self.registration.showNotification(title, options).then(() => {
      pushDebugToClients("push-shown", "ok tag=" + options.tag);
    }).catch((e) => {
      pushDebugToClients("push-show-error", e && e.message || String(e));
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  pushDebugToClients("notificationclick", "tag=" + (event.notification && event.notification.tag || "?"));
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