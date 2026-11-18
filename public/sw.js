// P2PDF service worker: caches the app (including OpenCV) so it opens and scans offline.
// Bump CACHE when you want every user to drop old cached files.
const CACHE = 'p2pdf-v2';
const CORE = ['./', './index.html', './manifest.webmanifest', './opencv.js', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE);
    try { // also cache the hashed JS/CSS files that index.html points to
      const html = await (await fetch('./index.html', { cache: 'no-store' })).text();
      const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^(https?:|data:)/.test(u));
      await cache.addAll(urls.map((u) => new URL(u, self.registration.scope).href));
    } catch { /* offline install of extras is optional */ }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const store = (r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return r; };

  if (req.mode === 'navigate') { // online: always the latest page; offline: the cached one
    e.respondWith(fetch(req).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put('./index.html', copy)); return r; })
      .catch(() => caches.match('./index.html')));
    return;
  }
  if (url.origin === location.origin) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => (r.ok ? store(r) : r))));
    return;
  }
  if (/(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) { // web fonts: cache-first
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then(store).catch(() => hit)));
  }
});
