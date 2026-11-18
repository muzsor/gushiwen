// 離線快取。修改任何檔案（例如在 data/poems.json 新增詩文）後，
// 把 VERSION 改成新的值，手機連網開啟一次就會更新。
const VERSION = 'gushiwen-1.1.0';
const FILES = [
  './',
  'index.html',
  'manifest.json',
  'css/style.css',
  'js/app.js',
  'data/poems.json',
  'licenses/moe-dict.html',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(VERSION).then(cache => cache.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 先讀快取，沒有才連網（離線優先）
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(hit => {
      if (hit) return hit;
      return fetch(event.request).catch(() =>
        event.request.mode === 'navigate' ? caches.match('./') : Response.error()
      );
    })
  );
});
