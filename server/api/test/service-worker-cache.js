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
    match: async () => cachedResponse,
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
  await waitEvent('activate', {});
  assert.deepStrictEqual(deleted, [staleCache]);

  fetchResponse = new Response('<html>wrong</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  await assert.rejects(waitEvent('install', {}), /invalid_precache_response/);
  assert.ok(added.includes('./index.html'));
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
  console.log('✓ Service Worker 缓存所有权、JSON 回退与 API 绕过检查通过');
})().catch((error) => { console.error(error); process.exit(1); });
