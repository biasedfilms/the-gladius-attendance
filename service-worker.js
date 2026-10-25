const CACHE_NAME = "gladius-static-v5-brand-refresh";
const STATIC_ASSETS = [
  "./", "./index.html", "./login.html", "./admin.html", "./check-in.html", "./offline.html",
  "./manifest.json", "./css/styles.css", "./assets/the-gladius-logo.png", "./assets/favicon-64.png", "./assets/icon-192.png", "./assets/icon-512.png", "./assets/icon-maskable-192.png", "./assets/icon-maskable-512.png"
];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("message", (event) => { if (event.data === "SKIP_WAITING") self.skipWaiting(); });
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never cache API/auth responses or dynamic/private Supabase data.
  if (/\/(rest\/v1|auth\/v1|functions\/v1)\//.test(url.pathname)) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(async () => (await caches.match("./offline.html"))));
    return;
  }
  if (/\.(css|js)$/.test(url.pathname)) {
    // Network-first for executable/style assets: deploys must not leave students
    // running stale check-in code. Use the last cached copy when offline only.
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    }).catch(async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      throw new Error("Asset unavailable while offline");
    }));
    return;
  }
  if (/\.(svg|png|woff2?)$/.test(url.pathname) || url.pathname.endsWith("manifest.json")) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok) { const copy = response.clone(); caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)); }
      return response;
    })));
  }
});
