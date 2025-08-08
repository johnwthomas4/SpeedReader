// Simple cache-first SW for static assets. No PDF caching (user files are local).
// Only registers on HTTPS (GitHub Pages). Not used on file://.
const CACHE = 'rsvp-reader-v1';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json'
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never try to cache blob: or data: or cross-origin worker scripts
  if (url.origin !== location.origin) return;
  if (e.request.method !== 'GET') return;
  if (url.pathname.endsWith('.pdf')) return; // don't cache PDFs
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res=>{
      const copy = res.clone();
      caches.open(CACHE).then(c=>c.put(e.request, copy));
      return res;
    }))
  );
});
