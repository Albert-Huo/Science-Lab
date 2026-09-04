/* 实验馆 Service Worker
 * - App 壳预缓存
 * - 清单与目录控制网络优先，只缓存有效 JSON
 * - 跨域实验内容与 API 请求不拦截
 */
const VERSION = 'v0.8.3';
const CACHE_PREFIX = 'sl-shell-';
const SHELL_CACHE = CACHE_PREFIX + VERSION;
const SCROLL_ASSET = './experiment-scroll.js?app=' + VERSION;
const SHELL = [
  './',
  './index.html',
  './catalog-control.js',
  './content-source.js',
  SCROLL_ASSET,
  './catalog-control.json',
  './manifest.json',
  './manifest.webmanifest',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon.png',
];
const JSON_SHELL = ['./catalog-control.json', './manifest.json'];
const STATIC_SHELL = SHELL.filter((path) => !JSON_SHELL.includes(path));
const SHELL_URLS = new Set(SHELL.map((path) => new URL(path, self.location.href).href));

function isJson(response) {
  return !!(response && response.ok && (response.headers.get('content-type') || '').includes('application/json'));
}

async function precache() {
  const cache = await caches.open(SHELL_CACHE);
  await cache.addAll(STATIC_SHELL);
  for (const path of JSON_SHELL) {
    const response = await fetch(path, { cache: 'no-store' });
    if (!isJson(response)) throw new Error('invalid_precache_response:' + path);
    await cache.put(path, response);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== SHELL_CACHE)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.endsWith('/manifest.json') ||
      url.pathname.endsWith('/catalog-control.json')) {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (isJson(response)) {
            const cache = await caches.open(SHELL_CACHE);
            await cache.put(request, response.clone());
            return response;
          }
          return (await caches.match(request)) || response;
        })
        .catch(async (error) => {
          const cached = await caches.match(request);
          if (cached) return cached;
          throw error;
        })
    );
    return;
  }

  if (!SHELL_URLS.has(url.href)) return;
  event.respondWith(
    caches.match(request).then((cached) => {
      const refresh = fetch(request)
        .then(async (response) => {
          if (response && response.ok) {
            const cache = await caches.open(SHELL_CACHE);
            await cache.put(request, response.clone());
          }
          return response;
        })
        .catch((error) => {
          if (cached) return cached;
          throw error;
        });
      return cached || refresh;
    })
  );
});
