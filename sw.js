/* 实验馆 Service Worker
 * - App 壳预缓存
 * - 清单与目录控制网络优先，只缓存有效 JSON
 * - 实验内容智能缓存（最近 20 个，网络优先 + 缓存备用）
 */
const VERSION = 'v0.8.24';
const CACHE_PREFIX = 'sl-shell-';
const SHELL_CACHE = CACHE_PREFIX + VERSION;
const EXPERIMENTS_CACHE = 'sl-experiments-v1';
const MAX_EXPERIMENTS = 20;
const SCROLL_ASSET = './experiment-scroll.js?app=' + VERSION;
const SHELL = [
  './',
  './index.html',
  './privacy.html',
  './catalog-control.js?app=' + VERSION,
  './content-source.js',
  './product-analytics.js?app=' + VERSION,
  SCROLL_ASSET,
  './ai-chat.js?app=' + VERSION,
  './catalog-control.json',
  './manifest.json',
  './manifest.webmanifest',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/support/wechat-reward.jpg',
];
const JSON_SHELL = ['./catalog-control.json', './manifest.json'];
const STATIC_SHELL = SHELL.filter((path) => !JSON_SHELL.includes(path));
const SHELL_URLS = new Set(SHELL.map((path) => new URL(path, self.location.href).href));
const NAVIGATION_URLS = new Set(['./', './index.html'].map((path) => new URL(path, self.location.href).href));

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

/* 实验缓存管理：LRU 策略，保留最近 20 个 */
async function cacheExperiment(request, response) {
  const cache = await caches.open(EXPERIMENTS_CACHE);
  await cache.put(request, response.clone());

  const keys = await cache.keys();
  if (keys.length > MAX_EXPERIMENTS) {
    await cache.delete(keys[0]);
  }

  return response;
}

/* 判断是否为实验内容 */
function isExperimentContent(url) {
  return (url.hostname === 'html.xingnian.net.cn' ||
          url.hostname === self.location.hostname) &&
         url.pathname.match(/\/(physics-|biology-|chemistry-).*\.html$/);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  /* 实验内容缓存：网络优先 + 缓存备用 + LRU 淘汰 */
  if (isExperimentContent(url)) {
    event.respondWith(
      caches.open(EXPERIMENTS_CACHE).then((cache) =>
        fetch(request)
          .then((response) => {
            if (response && response.ok) {
              return cacheExperiment(request, response);
            }
            return response;
          })
          .catch(() => cache.match(request))
      )
    );
    return;
  }

  /* 以下为应用壳的原有逻辑 */
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

  const navigationUrl = new URL(url.href);
  navigationUrl.search = '';
  const cacheKey = request.mode === 'navigate' && NAVIGATION_URLS.has(navigationUrl.href)
    ? navigationUrl.href : url.href;
  if (!SHELL_URLS.has(cacheKey)) return;
  event.respondWith(
    caches.match(cacheKey).then((cached) => {
      const refresh = fetch(request)
        .then(async (response) => {
          if (response && response.ok) {
            const cache = await caches.open(SHELL_CACHE);
            await cache.put(cacheKey, response.clone());
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
