/* 实验馆 Service Worker
 * 策略：App 壳预缓存（离线可用）；实验清单和发布控制网络优先（更新及时生效）；
 * 其余同源资源 stale-while-revalidate；跨域请求（线上实验内容）不拦截。
 */
const VERSION = 'v0.7.0';
const SHELL_CACHE = 'sl-shell-' + VERSION;
const SHELL = [
  './',
  './index.html',
  './catalog-control.js',
  './catalog-control.json',
  './manifest.json',
  './manifest.webmanifest',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // 跨域内容不拦截

  if (url.pathname.endsWith('/manifest.json') ||
      url.pathname.endsWith('/catalog-control.json')) {
    // 实验清单与发布控制：网络优先，离线退回缓存
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // 壳与同源资源：缓存优先 + 后台更新
  e.respondWith(
    caches.match(req).then((cached) => {
      const refresh = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || refresh;
    })
  );
});
