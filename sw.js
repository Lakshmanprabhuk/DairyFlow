/* DairyFlow service worker: the app shell works offline; data is fetched fresh when online. */
const SHELL = 'dairyflow-shell-v2', DATA = 'dairyflow-data';
const FILES = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/icon-180.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(n => n !== SHELL && n !== DATA).map(n => caches.delete(n))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('/data/data.json')) {          // network first, last copy when offline
    e.respondWith(fetch(e.request, { cache: 'no-store' }).then(r => { const c = r.clone(); caches.open(DATA).then(x => x.put(e.request, c)); return r; })
      .catch(() => caches.match(e.request)));
    return;
  }
  const page = e.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/');
  if (page) {                                                // the app itself: newest version when online, saved copy offline
    e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => { if (r.ok) { const c = r.clone(); caches.open(SHELL).then(x => x.put(e.request, c)); } return r; })
      .catch(() => caches.match(e.request).then(hit => hit || caches.match('index.html'))));
    return;
  }
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));   // icons and manifest
});
