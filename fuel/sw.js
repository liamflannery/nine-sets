const CACHE = 'fuel-v6';
const FILES = ['./', 'index.html', 'search.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
const SCANNER = 'https://unpkg.com/@zxing/library@0.20.0/umd/index.min.js';
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('fuel-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (req.mode === 'navigate') {
    // network first so updates arrive, cached copy when offline
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put('index.html', c)); return r; }).catch(() => caches.match('index.html')));
    return;
  }
  if (req.url === SCANNER) {
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => { const c = res.clone(); caches.open(CACHE).then(x => x.put(req, c)); return res; })));
    return;
  }
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // food lookups and sync go straight to the network
  if (url.pathname.includes('/fuel/data/')) return; // the food database is cached by search.js itself
  if (url.pathname.endsWith('/search.js')) { // network first so search fixes arrive
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); return r; }).catch(() => caches.match(req)));
    return;
  }
  e.respondWith(caches.match(req).then(r => r || fetch(req)));
});

// Weigh-in reminder: the Apps Script sends a push with no payload at the chosen time.
self.addEventListener('push', e => {
  let msg = {title: 'Time to weigh in', body: 'Step on the scale and log your morning weight.'};
  try { if (e.data) msg = Object.assign(msg, e.data.json()); } catch (err) {}
  e.waitUntil(self.registration.showNotification(msg.title, {body: msg.body, tag: 'weigh-in', icon: 'icon-192.png', badge: 'icon-192.png', data: {url: './?weigh=1'}}));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  // Leave a flag the page checks whenever it opens or comes to the front. iOS often reloads the
  // app or ignores the URL, so the message alone is not enough.
  e.waitUntil(caches.open('fuel-flags').then(c => c.put('weigh', new Response(String(Date.now())))).then(() => self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(cs => {
    const c = cs.find(x => x.url.includes('/fuel/'));
    if (c) { c.postMessage('weigh'); return c.focus(); }
    return self.clients.openWindow(e.notification.data && e.notification.data.url || './?weigh=1');
  })));
});
