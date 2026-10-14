'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const serviceWorkerSource = fs.readFileSync(path.resolve(__dirname, '../../../sw.js'), 'utf8');
const versionMatch = serviceWorkerSource.match(/const VERSION = '(v\d+\.\d+\.\d+)';/);
assert.ok(versionMatch, 'Service Worker 应声明语义版本');
const currentCache = `sl-shell-${versionMatch[1]}`;
const staleCache = `${currentCache}-stale`;

const handlers = {};
const deleted = [];
const added = [];
const writes = [];
const matched = [];
let fetchResponse;
let cachedResponse;
const cache = {
  addAll: async (paths) => { added.push(...paths); },
  put: async (req, res) => writes.push([typeof req === 'string' ? req : req.url, res]),
};
const context = vm.createContext({
  URL,
  Response,
  location: { origin: 'https://lab.xingnian.net.cn' },
  self: {
    location: { origin: 'https://lab.xingnian.net.cn', href: 'https://lab.xingnian.net.cn/sw.js' },
    addEventListener: (name, handler) => { handlers[name] = handler; },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  },
  caches: {
    open: async () => cache,
    keys: async () => [staleCache, 'other-app-cache', currentCache],
    delete: async (key) => { deleted.push(key); return true; },
    match: async (request) => { matched.push(typeof request === 'string' ? request : request.url); return cachedResponse; },
  },
  fetch: async () => fetchResponse,
});
vm.runInContext(serviceWorkerSource, context);

async function waitEvent(name, event) {
  let pending;
  handlers[name](Object.assign({ waitUntil: (promise) => { pending = promise; } }, event));
  if (pending) await pending;
}

(async () => {
  const offlineHandlers = {};
  const assetCache = new Map();
  let offline = false;
  const base = 'https://lab.xingnian.net.cn/sw.js';
  const cacheKey = request => new URL(typeof request === 'string' ? request : request.url, base).href;
  const readAsset = async request => {
    if (offline) throw new Error('offline');
    const url = new URL(cacheKey(request));
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const body = fs.readFileSync(path.resolve(__dirname, '../../..', relative));
    return new Response(body, { headers:{ 'Content-Type':relative.endsWith('.json') ? 'application/json' : 'text/plain' } });
  };
  const offlineCache = {
    addAll: async assets => {
      for (const asset of assets) assetCache.set(cacheKey(asset), await readAsset(asset));
    },
    put: async (request,response) => { assetCache.set(cacheKey(request),response); },
  };
  const offlineContext = vm.createContext({ URL, fetch:readAsset,
    self:{ location:{ origin:'https://lab.xingnian.net.cn', href:base }, addEventListener:(name,handler)=>{ offlineHandlers[name]=handler; }, skipWaiting:async()=>{}, clients:{ claim:async()=>{} } },
    caches:{ open:async()=>offlineCache, match:async request=>assetCache.get(cacheKey(request))?.clone() },
  });
  vm.runInContext(serviceWorkerSource, offlineContext);
  let installPromise;
  offlineHandlers.install({ waitUntil:promise=>{ installPromise=promise; } });
  await installPromise;
  const catalogUrl = 'https://lab.xingnian.net.cn/catalog-control.js?app='+versionMatch[1];
  assert.ok(assetCache.has(catalogUrl), '安装时必须预缓存首页实际请求的版本化目录模块');
  offline = true;
  let offlineModule;
  offlineHandlers.fetch({ request:{ method:'GET', url:catalogUrl }, respondWith:promise=>{ offlineModule=promise; } });
  assert.ok(offlineModule, '断网刷新必须由SW接管实际版本化目录模块请求');
  const cachedModule = await (await offlineModule).text();
  assert.equal(cachedModule, fs.readFileSync(path.resolve(__dirname, '../../../catalog-control.js'), 'utf8'));
  const moduleContext = vm.createContext({});
  vm.runInContext(cachedModule, moduleContext);
  assert.equal(typeof moduleContext.CatalogControl.catalogIndexes, 'function', '离线命中的应是具有新目录能力的当前模块');

  await waitEvent('activate', {});
  assert.deepStrictEqual(deleted, [staleCache]);

  fetchResponse = new Response('<html>wrong</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  await assert.rejects(waitEvent('install', {}), /invalid_precache_response/);
  assert.ok(added.includes('./index.html'));
  assert.ok(added.includes('./privacy.html'), '公开隐私说明必须可离线访问');
  assert.ok(added.includes(`./product-analytics.js?app=${versionMatch[1]}`), '匿名统计客户端必须以当前 App 版本预缓存');
  assert.ok(added.includes(`./experiment-scroll.js?app=${versionMatch[1]}`), '内容滚动脚本必须以当前 App 版本预缓存');
  assert.ok(added.includes(`./ai-chat.js?app=${versionMatch[1]}`), 'AI 聊天脚本必须随 App 版本预缓存');
  assert.strictEqual(writes.length, 0);

  cachedResponse = new Response('{"version":1}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  fetchResponse = new Response('<html>wrong</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  let responsePromise;
  handlers.fetch({
    request: { method: 'GET', url: 'https://lab.xingnian.net.cn/catalog-control.json' },
    respondWith: (promise) => { responsePromise = promise; },
  });
  assert.strictEqual(await (await responsePromise).text(), '{"version":1}');
  assert.strictEqual(writes.length, 0);

  let intercepted = false;
  handlers.fetch({
    request: { method: 'GET', url: 'https://lab.xingnian.net.cn/api/health' },
    respondWith: () => { intercepted = true; },
  });
  assert.strictEqual(intercepted, false);
  for (const pathname of ['/admin/traffic/', '/admin/traffic/index.html']) {
    handlers.fetch({ request: { method: 'GET', url: 'https://lab.xingnian.net.cn' + pathname },
      respondWith: () => { intercepted = true; } });
  }
  assert.strictEqual(intercepted, false, '私有统计页不得进入公开 App 缓存');
  cachedResponse = new Response('<html>cached shell</html>', { headers:{ 'Content-Type':'text/html' } });
  context.fetch = async () => { throw new Error('offline'); };
  for (const pathname of ['/', '/index.html']) {
    for (const experiment of ['physics-middle/初中物理实验1.html', '../invalid.html']) {
      let navigationResponse;
      handlers.fetch({
        request:{ method:'GET', mode:'navigate', url:'https://lab.xingnian.net.cn' + pathname + '?experiment=' + encodeURIComponent(experiment) },
        respondWith:promise=>{ navigationResponse=promise; },
      });
      assert.ok(navigationResponse, '带分享参数的首页导航必须使用壳缓存');
      assert.equal(await (await navigationResponse).clone().text(), '<html>cached shell</html>');
      assert.equal(matched.at(-1), 'https://lab.xingnian.net.cn' + pathname);
    }
  }
  for (const pathname of ['/api/health', '/admin/traffic/', '/physics-middle/初中物理实验1.html']) {
    let interceptedNavigation = false;
    handlers.fetch({
      request:{ method:'GET', mode:'navigate', url:'https://lab.xingnian.net.cn' + pathname + '?experiment=test' },
      respondWith:()=>{ interceptedNavigation=true; },
    });
    assert.equal(interceptedNavigation, false, '仅归一化壳首页，不缓存 API、管理页或实验内容');
  }
  console.log('✓ Service Worker 缓存所有权、JSON 回退与 API 绕过检查通过');
})().catch((error) => { console.error(error); process.exit(1); });
