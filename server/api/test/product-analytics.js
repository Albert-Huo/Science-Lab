'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const {
  ACTIONS,
  SOURCES,
  RECORD_SCRIPT,
  buildCatalog,
  validateEvent,
  createProductAnalytics,
  HOUR_TTL_SECONDS,
  DAY_TTL_SECONDS,
} = require('../product-analytics');

const sourceCatalog = require('../ai-context.json');
const catalog = buildCatalog(sourceCatalog);
const firstPath = sourceCatalog.experiments[0].path;
const firstId = createHash('sha256').update(firstPath).digest('hex');

test('受信实验目录只暴露稳定内容 ID 与公开标题', () => {
  assert.ok(catalog instanceof Map);
  assert.equal(catalog.size, sourceCatalog.experiments.length);
  assert.deepEqual(catalog.get(firstId), { title: sourceCatalog.experiments[0].title });
  assert.equal(JSON.stringify([...catalog]).includes(firstPath), false);
  assert.throws(() => buildCatalog({ version: 1, experiments: [{ path: firstPath, title: 'x' }, { path: firstPath, title: 'y' }] }), /invalid_analytics_catalog/);
});

test('事件 schema 只接受固定字段和枚举', () => {
  assert.deepEqual(validateEvent({ v: 1, event: 'page_view', page_id: 'home', source: 'direct' }, catalog),
    { event: 'page_view', dimension: 'direct' });
  assert.deepEqual(validateEvent({ v: 1, event: 'experiment_open', experiment_id: firstId }, catalog),
    { event: 'experiment_open', dimension: firstId });
  assert.deepEqual(validateEvent({ v: 1, event: 'key_action', page_id: 'home', action_id: 'catalog_open' }, catalog),
    { event: 'key_action', dimension: 'catalog_open' });
  assert.deepEqual([...SOURCES], ['direct', 'internal', 'search', 'external']);
  assert.deepEqual([...ACTIONS], ['catalog_open', 'profile_open', 'experiment_previous', 'experiment_next']);
});

test('事件 schema 拒绝完成推断、额外身份字段、自由文本和非普通对象', () => {
  const valid = { v: 1, event: 'page_view', page_id: 'home', source: 'direct' };
  for (const body of [
    { ...valid, visitor_id: 'abc' },
    { ...valid, ip: '192.0.2.1' },
    { ...valid, ua: 'Mozilla' },
    { ...valid, referrer: 'https://example.com/private?q=x' },
    { ...valid, timestamp: Date.now() },
    { v: 1, event: 'experiment_complete', experiment_id: firstId },
    { v: 1, event: 'experiment_open', experiment_id: 'f'.repeat(64) },
    { v: 1, event: 'key_action', page_id: 'home', action_id: 'button_text_任意文案' },
    Object.assign(Object.create(null), valid),
    [], null, 'text',
  ]) assert.throws(() => validateEvent(body, catalog), /invalid_event/);
});

test('有效事件通过一次有界 EVAL 写入固定 namespace', async () => {
  const calls = [];
  const fake = {
    isOpen: false,
    on() {},
    async connect() { this.isOpen = true; },
    async eval(script, options) { calls.push({ script, options }); return [1700000000, 1699999200, 1699977600]; },
    destroy() { this.isOpen = false; },
  };
  const analytics = createProductAnalytics({
    redisUrl: 'redis://127.0.0.1:16380',
    catalog: sourceCatalog,
    createClient: () => fake,
    commandTimeoutMs: 500,
  });
  assert.equal(await analytics.connect(), true);
  assert.deepEqual(await analytics.record({ v: 1, event: 'experiment_open', experiment_id: firstId }),
    { ok: true, capturedAt: 1700000000 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].script, RECORD_SCRIPT);
  assert.deepEqual(calls[0].options.keys, []);
  assert.deepEqual(calls[0].options.arguments, [
    'science-lab:analytics:v1', 'experiment_open', firstId,
    String(HOUR_TTL_SECONDS), String(DAY_TTL_SECONDS),
  ]);
  await analytics.close();
});

test('缺配置、远程 Redis 和命令失败只使统计不可用', async () => {
  for (const redisUrl of [undefined, 'redis://example.com:6379', 'http://127.0.0.1:6379']) {
    const analytics = createProductAnalytics({ redisUrl, catalog: sourceCatalog });
    assert.equal(await analytics.connect(), false);
    assert.deepEqual(await analytics.record({ v: 1, event: 'page_view', page_id: 'home', source: 'direct' }),
      { ok: false, reason: 'unavailable' });
  }
  const fake = {
    isOpen: false, on() {}, async connect() { this.isOpen = true; },
    async eval() { throw new Error('redis://:secret@127.0.0.1 failure'); },
    destroy() { this.isOpen = false; },
  };
  const warnings = [];
  const analytics = createProductAnalytics({ redisUrl: 'redis://127.0.0.1:16380', catalog: sourceCatalog,
    createClient: () => fake, warn: message => warnings.push(message) });
  await analytics.connect();
  assert.deepEqual(await analytics.record({ v: 1, event: 'page_view', page_id: 'home', source: 'direct' }),
    { ok: false, reason: 'unavailable' });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0], '[product-analytics] Redis unavailable');
});

test('Redis 脚本只生成聚合键并由服务器时间分桶', () => {
  assert.match(RECORD_SCRIPT, /redis\.call\('TIME'\)/);
  assert.match(RECORD_SCRIPT, /HINCRBY/);
  assert.match(RECORD_SCRIPT, /EXPIRE/);
  assert.doesNotMatch(RECORD_SCRIPT, /visitor|session|remote_addr|user_agent|referer|cookie/i);
  assert.equal(HOUR_TTL_SECONDS, 48 * 60 * 60);
  assert.equal(DAY_TTL_SECONDS, 402 * 24 * 60 * 60);
});
