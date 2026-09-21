'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const modulePath = path.resolve(__dirname, '../../../product-analytics.js');
const ProductAnalytics = require(modulePath);

test('来源只归入固定类别且不会返回原始网址', () => {
  const origin = 'https://lab.xingnian.net.cn';
  assert.equal(ProductAnalytics.classifySource('', origin), 'direct');
  assert.equal(ProductAnalytics.classifySource(origin + '/privacy.html?secret=1', origin), 'internal');
  assert.equal(ProductAnalytics.classifySource('https://www.baidu.com/s?wd=实验', origin), 'search');
  assert.equal(ProductAnalytics.classifySource('https://example.com/path?q=secret', origin), 'external');
  assert.equal(ProductAnalytics.classifySource('not a url', origin), 'external');
});

test('实验路径在发送前变成稳定内容哈希', async () => {
  const first = await ProductAnalytics.experimentId('physics-middle/初中物理实验1.html', crypto.webcrypto);
  const second = await ProductAnalytics.experimentId('physics-middle/初中物理实验1.html', crypto.webcrypto);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, second);
  await assert.rejects(ProductAnalytics.experimentId('', crypto.webcrypto), /invalid_experiment_path/);
  await assert.rejects(ProductAnalytics.experimentId('physics-middle/初中物理实验1.html', null), /crypto_unavailable/);
});

test('事件请求不带凭据、来源或原始实验路径且失败不重试', async () => {
  const sent = [];
  const client = ProductAnalytics.createClient({
    endpoint: '/api/analytics/events',
    fetchImpl: async (url, options) => {
      sent.push({ url, options });
      return new Response(null, { status: 204 });
    },
    cryptoImpl: crypto.webcrypto,
  });
  assert.equal(await client.pageView('direct'), true);
  assert.equal(await client.experimentOpen('physics-middle/初中物理实验1.html'), true);
  assert.equal(await client.keyAction('catalog_open'), true);
  assert.equal(await client.keyAction('unknown_action'), false);
  assert.equal(sent.length, 3);
  for (const request of sent) {
    assert.equal(request.url, '/api/analytics/events');
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.credentials, 'omit');
    assert.equal(request.options.referrerPolicy, 'no-referrer');
    assert.equal(request.options.keepalive, true);
    assert.deepEqual(request.options.headers, { 'Content-Type': 'application/json' });
  }
  assert.equal(JSON.stringify(sent).includes('初中物理实验1.html'), false);

  let attempts = 0;
  const unavailable = ProductAnalytics.createClient({
    fetchImpl: async () => { attempts++; throw new Error('offline'); },
    cryptoImpl: crypto.webcrypto,
  });
  assert.equal(await unavailable.pageView('direct'), false);
  assert.equal(attempts, 1);
});

test('浏览器模块不读取 Cookie 或任何持久存储', () => {
  const source = fs.readFileSync(modulePath, 'utf8');
  const accesses = [];
  const context = vm.createContext({
    globalThis: null,
    TextEncoder,
    fetch: async () => new Response(null, { status: 204 }),
    crypto: crypto.webcrypto,
    document: new Proxy({}, { get(_target, key) { accesses.push('document.' + String(key)); throw new Error('unexpected document access'); } }),
    localStorage: new Proxy({}, { get(_target, key) { accesses.push('localStorage.' + String(key)); throw new Error('unexpected localStorage access'); } }),
    indexedDB: new Proxy({}, { get(_target, key) { accesses.push('indexedDB.' + String(key)); throw new Error('unexpected indexedDB access'); } }),
  });
  context.globalThis = context;
  vm.runInContext(source, context);
  assert.deepEqual(accesses, []);
});

test('首页只接入固定匿名事件且不推断实验完成', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../../index.html'), 'utf8');
  assert.match(html, /<script src="product-analytics\.js\?app=v0\.8\.13"><\/script>/);
  assert.ok(html.indexOf('product-analytics.js?app=v0.8.13') < html.indexOf('const qs = new URLSearchParams'));
  assert.match(html, /ScienceProductAnalytics\.createClient\(\)/);
  assert.match(html, /pageView\(ScienceProductAnalytics\.classifySource\(document\.referrer,location\.origin\)\)/);
  assert.match(html, /experimentOpen\(MANIFEST\[cur\]\.path\)/);
  for (const action of ['catalog_open', 'profile_open', 'experiment_previous', 'experiment_next']) {
    assert.match(html, new RegExp("keyAction\\('" + action + "'\\)"));
  }
  assert.doesNotMatch(html, /experiment_complete|experimentComplete|content_end|dwell|停留.*上报/);
  const mountBody = html.slice(html.indexOf('function mount(i)'), html.indexOf('function unmount(i)'));
  assert.doesNotMatch(mountBody, /experimentOpen|keyAction|pageView/);
});

test('Service Worker 缓存匿名客户端且继续绕过 POST', () => {
  const worker = fs.readFileSync(path.resolve(__dirname, '../../../sw.js'), 'utf8');
  assert.match(worker, /const VERSION = 'v0\.8\.13'/);
  assert.match(worker, /'\.\/product-analytics\.js\?app=' \+ VERSION/);
  assert.match(worker, /if \(request\.method !== 'GET'\) return/);
  assert.doesNotMatch(worker, /analytics\/events/);
});
