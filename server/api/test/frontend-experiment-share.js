'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const CatalogControl = require('../../../catalog-control.js');
const ContentSource = require('../../../content-source.js');
const html = fs.readFileSync(path.resolve(__dirname, '../../../index.html'), 'utf8');
const start = html.indexOf('function sharedExperimentIndex(');
const end = html.indexOf("document.documentElement.classList.toggle('catalog-collapsed'", start);
assert.ok(start >= 0 && end > start, '缺少可验证的实验分享逻辑');
const copyStart = html.indexOf('async function copyExperimentLink(');
const copyEnd = html.indexOf("document.getElementById('btnShare').addEventListener('click'", copyStart);
assert.ok(copyStart >= 0 && copyEnd > copyStart, '缺少复制与手动回退逻辑');

function harness(navigator = {}) {
  const events = [];
  const elements = {
    btnShare:{ disabled:false },
    shareTitle:{ textContent:'' },
    shareLink:{ value:'', focus:()=>events.push('focus'), select:()=>events.push('select'), setSelectionRange:()=>events.push('selection') },
    shareDialog:{ showModal:()=>events.push('dialog') },
  };
  const context = vm.createContext({
    URL, URLSearchParams, CatalogControl, ContentSource, navigator,
    document:{ getElementById:id=>elements[id] },
    toast:message=>events.push(message), console:{ warn:()=>events.push('warning') },
  });
  vm.runInContext(html.slice(start, end) + html.slice(copyStart, copyEnd) + '\nthis.api={sharedExperimentIndex,initialExperimentIndex,experimentShareUrl,copyExperimentLink};', context);
  return { api:context.api, elements, events };
}

const source = [
  { path:'physics-middle/初中物理实验1.html' },
  { path:'physics-high/隐藏实验.html' },
  { path:'physics-middle/初中物理实验39.html' },
];
const published = [source[0], source[2]];

test('分享实验优先于本机历史，隐藏、外部和无效路径不进入iframe', () => {
  const { api } = harness();
  const search = '?experiment=' + encodeURIComponent(source[2].path);
  assert.equal(api.initialExperimentIndex(source, published, source[0].path, 0, search), 1);
  assert.equal(api.initialExperimentIndex(source, published, source[2].path, 0, ''), 1);
  for (const value of [source[1].path, '', 'https://evil.example/lab.html', '../private.html', 'javascript:alert(1)']) {
    const invalid = '?experiment=' + encodeURIComponent(value);
    assert.equal(api.sharedExperimentIndex(published, invalid), -1);
    assert.equal(api.initialExperimentIndex(source, published, source[0].path, 0, invalid), 0);
  }
  assert.equal(api.initialExperimentIndex(source, [], '', 0, search), -1);
});

test('中文路径往返且生产分享不携带其他查询、hash或凭据', () => {
  const { api } = harness();
  const shared = new URL(api.experimentShareUrl('https://user:password@lab.xingnian.net.cn/?base=/HTML-/&token=private#chat', source[2].path));
  assert.equal(shared.origin, 'https://lab.xingnian.net.cn');
  assert.equal(shared.username, '');
  assert.equal(shared.password, '');
  assert.equal(shared.hash, '');
  assert.deepEqual([...shared.searchParams.keys()], ['experiment']);
  assert.equal(api.sharedExperimentIndex(published, shared.search), 1);
});

test('本地联调分享只保留已验证的根相对base', () => {
  const { api } = harness();
  for (const hostname of ['localhost', '127.0.0.1']) {
    const local = new URL(api.experimentShareUrl(`http://${hostname}:8788/Science-Lab/index.html?base=/HTML-/&scroll-debug=1`, source[0].path));
    assert.equal(local.searchParams.get('base'), '/HTML-/');
    assert.equal(local.searchParams.has('scroll-debug'), false);
  }
  for (const base of ['//evil.example/', 'https://evil.example/', 'javascript:alert(1)']) {
    const local = new URL(api.experimentShareUrl('http://localhost:8788/Science-Lab/index.html?base=' + encodeURIComponent(base), source[0].path));
    assert.equal(local.searchParams.has('base'), false);
  }
});

test('复制成功反馈目标，权限拒绝或API缺失时可手动复制', async () => {
  const url = 'https://lab.xingnian.net.cn/?experiment=physics-middle%2Ftest.html';
  let copied;
  const success = harness({ clipboard:{ writeText:async value=>{ copied=value; } } });
  assert.equal(await success.api.copyExperimentLink(url, '温度计'), true);
  assert.equal(copied, url);
  assert.equal(success.elements.btnShare.disabled, false);
  assert.ok(success.events.some(message=>message.includes('已复制')));
  for (const navigator of [{}, { clipboard:{ writeText:async()=>{ throw new Error('permission_denied'); } } }]) {
    const fallback = harness(navigator);
    assert.equal(await fallback.api.copyExperimentLink(url, '温度计'), false);
    assert.equal(fallback.elements.shareLink.value, url);
    assert.equal(fallback.elements.shareTitle.textContent, '温度计');
    assert.ok(fallback.events.includes('dialog'));
    assert.ok(fallback.events.includes('select'));
    assert.equal(fallback.elements.btnShare.disabled, false);
  }
});

test('首页使用分享初始化、明显入口及只读回退链接', () => {
  assert.ok(html.includes('initialExperimentIndex(sourceManifest,catalog.experiments,savedPath,savedIndex,location.search)'));
  assert.match(html, /id="btnShare"[^>]*aria-label="分享当前实验"/);
  assert.match(html, /id="shareLink"[^>]*readonly/);
  assert.ok(html.includes('history.replaceState'));
});
