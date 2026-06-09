// Atlantic Truck Service Worker — v20260604
const CACHE = 'at-v20260604';
const OFFLINE_URLS = [
  '/',
  '/index.html',
  '/services/emergency-towing.html',
  '/contact.html',
  '/assets/css/style.css',
  '/assets/js/site.js',
  '/assets/img/hero-rotator.webp',
  '/assets/img/hero-rotator.jpg',
  '/manifest.json',
  '/assets/img/team.webp',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(OFFLINE_URLS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('netlify/functions')) return; // never cache API calls
  e.respondWith(
    fetch(e.request)
      .then(r => {
        if (r && r.status === 200 && r.type === 'basic') {
          const clone = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return r;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('/index.html')))
  );
});
