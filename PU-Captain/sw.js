// Bump VERSION on every deploy that changes cached files.
const VERSION = 'pu-captain-v1';
const SHELL = [
  '/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png',
  '/fonts/inter-latin-400-normal.woff2', '/fonts/inter-latin-600-normal.woff2',
  '/fonts/inter-latin-700-normal.woff2', '/fonts/inter-latin-800-normal.woff2',
  '/fonts/space-grotesk-latin-700-normal.woff2'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return; // API is never cached
  // Stale-while-revalidate for the app shell: instant and offline-safe, refreshed in the background.
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = (await cache.match(req)) || (req.mode === 'navigate' ? await cache.match('/index.html') : undefined);
      const network = fetch(req).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

// Background Sync (Chrome/Android): tell open pages to flush the queue.
self.addEventListener('sync', (e) => {
  if (e.tag === 'pu-sync') {
    e.waitUntil(self.clients.matchAll().then((cs) => cs.forEach((c) => c.postMessage({ type: 'sync' }))));
  }
});
