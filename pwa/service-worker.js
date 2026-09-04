// murmur service worker — Push notifications + Offline Shell
//
// Strategy: Stale-While-Revalidate (SWR) for core assets.
// This ensures the app loads instantly from cache while updating in the background.
// To avoid the "reload-loops" from Lesson #345:
// 1. No automatic window.location.reload() on controllerchange.
// 2. No redirect-loops via /index.html?v=N.
// 3. Assets are cached by their exact URL (including ?v= query strings).
// 4. When a new SW is activated, it cleans up old caches but doesn't force a page refresh.
//    The user gets the new version on the next natural load or manual refresh.

const SW_VERSION = "murmur-sw-offline-v1";
const CACHE_NAME = `murmur-shell-${SW_VERSION}`;

// Core assets required for the app to boot offline.
// Note: We include the versioned JS/CSS as they appear in index.html.
const CORE_ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/styles.css", 
  "/app.js",
  "/app-store.js",
  "/blob-cache.js",
  "/render-attachments.js",
  "/i192-2026b.png",
  "/i512-2026b.png",
  "/ati-2026b.png",
  "/favicon-2026b.ico",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  // We don't precache everything here to avoid blocking installation,
  // but we can prime the cache for the most critical files.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll([
        "/",
        "/index.html",
        "/manifest.json",
      ]);
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Clean up old caches
    const names = await caches.keys();
    await Promise.all(
      names.map((n) => {
        if (n !== CACHE_NAME) return caches.delete(n);
      })
    );
    await self.clients.claim();
  })());
});

// Fetch handler implementing Stale-While-Revalidate for the Shell
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  
  // Only handle GET requests for the same origin
  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  // v162c (Олег 04.09 «не ломать UX при обновлениях»): index.html — NETWORK-FIRST,
  // не SWR. SWR отдывал stale index.html с старыми app.js?v=N → iPhone mix
  // старый app-store.js?v=160ke с новым app.js?v=162 = пропажа истории после
  // refresh. Network-first: fresh index.html всегда, cache = offline fallback.
  if (url.pathname === "/" || url.pathname === "/index.html") {
    event.respondWith(
      fetch(event.request).then((networkResponse) => {
        if (networkResponse.ok) {
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse.clone()));
        }
        return networkResponse;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // Define which patterns we want to cache offline (The Shell)
  const isShellAsset = 
    url.pathname === "/" || 
    url.pathname === "/index.html" ||
    url.pathname.endsWith(".js") || 
    url.pathname.endsWith(".css") || 
    url.pathname.endsWith(".json") || 
    url.pathname.match(/\.(png|ico|svg)$/);

  if (!isShellAsset) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cachedResponse = await cache.match(event.request);
      
      // Start the network fetch to update the cache (the "Revalidate" part)
      const networkFetch = fetch(event.request).then((networkResponse) => {
        if (networkResponse.ok) {
          cache.put(event.request, networkResponse.clone());
        }
        return networkResponse;
      }).catch(() => {
        // Silent fail for network fetch; we rely on the cache
      });

      // Return cached response immediately (the "Stale" part), or wait for network if not cached
      return cachedResponse || networkFetch;
    })
  );
});

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
    subtitle: payload.subtitle || "",
    body: payload.body || "Откройте murmur, чтобы прочитать сообщение",
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
