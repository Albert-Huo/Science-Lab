'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, afterEach } = require('node:test');
const {
  readSnapshot,
  publishSnapshot,
  validateSnapshot,
  privacyState,
} = require('../../../tools/product-analytics-snapshot.cjs');
const { productAnalyticsPresentation } = require('../../../tools/product-analytics-view.cjs');

const catalog = require('../ai-context.json');
const temporary = [];
afterEach(() => {
  while (temporary.length) fs.rmSync(temporary.pop(), { recursive: true, force: true });
});

function fakeClient(nowSeconds) {
  return {
    isOpen: false,
    on() {},
    async connect() { this.isOpen = true; },
    async eval() { return nowSeconds; },
    async hGetAll(key) {
      if (key.endsWith(':totals')) return { page_view: '3', experiment_open: '2', key_action: '1' };
      if (key.endsWith(':sources')) return { direct: '2', search: '1' };
      if (key.endsWith(':actions')) return { catalog_open: '1' };
      if (key.endsWith(':experiments')) {
        const crypto = require('node:crypto');
        const id = crypto.createHash('sha256').update(catalog.experiments[0].path).digest('hex');
        return { [id]: '2' };
      }
      return {};
    },
    destroy() { this.isOpen = false; },
  };
}

test('只读快照按服务器时间生成有界小时、每日与热门实验', async () => {
  const now = Date.parse('2026-09-21T04:34:56.000Z') / 1000;
  const snapshot = await readSnapshot({
    env: {
      ANALYTICS_REDIS_URL: 'redis://127.0.0.1:16380',
      ANALYTICS_COLLECTION_START: '2026-09-20T00:00:00.000Z',
    },
    catalog,
    createClient: () => fakeClient(now),
  });
  assert.equal(snapshot.schema, 1);
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.hours.length, 24);
  assert.equal(snapshot.days.length, 400);
  assert.deepEqual(snapshot.privacy, privacyState());
  assert.equal(snapshot.totals.pageViews, 72);
  assert.equal(snapshot.totals.experimentOpens, 48);
  assert.equal(snapshot.totals.keyActions, 24);
  assert.equal(snapshot.totals.topExperiments[0].title, catalog.experiments[0].title);
  assert.match(snapshot.totals.topExperiments[0].id, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(snapshot).includes(catalog.experiments[0].path), false);
  assert.equal(JSON.stringify(snapshot).includes('192.0.2.'), false);
  assert.deepEqual(validateSnapshot(snapshot), snapshot);
});

test('快照校验拒绝身份字段、未知枚举、不安全计数和额外字段', async () => {
  const now = Date.parse('2026-09-21T04:34:56.000Z') / 1000;
  const snapshot = await readSnapshot({
    env: { ANALYTICS_REDIS_URL: 'redis://127.0.0.1:16380', ANALYTICS_COLLECTION_START: '2026-09-20T00:00:00.000Z' },
    catalog, createClient: () => fakeClient(now),
  });
  for (const mutate of [
    value => { value.visitor_id = 'x'; },
    value => { value.totals.pageViews = -1; },
    value => { value.totals.sources.direct = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.totals.actions.unknown = 1; },
    value => { value.totals.topExperiments[0].title = 'x'.repeat(301); },
    value => { value.hours[0].coverage = 'guessed'; },
  ]) {
    const invalid = structuredClone(snapshot); mutate(invalid);
    assert.throws(() => validateSnapshot(invalid), /Invalid product analytics snapshot/);
  }
});

test('Redis 配置或读取失败返回固定不可用状态而不暴露错误', async () => {
  const missing = await readSnapshot({ env: {}, catalog, now: () => Date.parse('2026-09-21T00:00:00Z') });
  assert.equal(missing.available, false);
  assert.equal(missing.reason, 'redis_not_configured');
  assert.equal(missing.totals, null);
  const failed = await readSnapshot({
    env: { ANALYTICS_REDIS_URL: 'redis://127.0.0.1:16380', ANALYTICS_COLLECTION_START: '2026-09-20T00:00:00.000Z' },
    catalog,
    createClient: () => ({ isOpen: false, on() {}, async connect() { throw new Error('redis://:secret@127.0.0.1'); } }),
    now: () => Date.parse('2026-09-21T00:00:00Z'),
  });
  assert.equal(failed.available, false);
  assert.equal(failed.reason, 'redis_unavailable');
  assert.doesNotMatch(JSON.stringify(failed), /secret|127\.0\.0\.1/);
});

test('快照原子发布、拒绝符号链接并生成安全展示模型', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'science-lab-product-snapshot-'));
  temporary.push(root);
  const www = path.join(root, 'www'); fs.mkdirSync(www);
  const unavailable = await readSnapshot({ env: {}, catalog, now: () => Date.parse('2026-09-21T00:00:00Z') });
  publishSnapshot({ stateDir: root, snapshot: unavailable });
  const target = path.join(www, 'analytics.json');
  assert.equal(fs.statSync(target).mode & 0o777, 0o644);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), unavailable);
  const presentation = productAnalyticsPresentation(unavailable, Date.parse('2026-09-21T00:01:00Z'));
  assert.equal(presentation.state, 'unavailable');
  assert.equal(presentation.uv, '未采集');
  assert.equal(presentation.completion, '未接入');

  const symlinkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'science-lab-product-snapshot-link-'));
  temporary.push(symlinkRoot);
  fs.mkdirSync(path.join(symlinkRoot, 'www'));
  fs.symlinkSync(target, path.join(symlinkRoot, 'www', 'analytics.json'));
  assert.throws(() => publishSnapshot({ stateDir: symlinkRoot, snapshot: unavailable }), /regular file/);
});
