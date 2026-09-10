'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { rollingSummary } = require('../../../tools/traffic-dashboard.cjs');
const { toCsv, renderDashboard } = require('../../../tools/traffic-dashboard-view.cjs');
const fixture = () => ({ ...rollingSummary([], {
  now: Date.parse('2026-09-10T04:03:00Z'), collectionStart: '2026-09-01T00:00:00Z',
  aiCollectionStart: '2026-09-10T01:03:25Z',
}), history: [] });
const csvRows = csv => csv.trimEnd().split('\r\n').map(row => [...row.matchAll(/"((?:[^"]|"")*)"/g)].map(match => match[1].replace(/""/g, '"')));

test('CSV exports complete HTTP categories and independent AI coverage', () => {
  const data = fixture();
  Object.assign(data.totals.ai, { requests: 5, httpSuccesses: 1, invalidRequests: 1, rateLimited: 1, serverErrors: 1, otherStatuses: 1 });
  const [headers, total, ...hours] = csvRows(toCsv(data));
  assert.ok(headers.includes('AI采集状态'));
  assert.equal(total[headers.indexOf('AI采集状态')], '部分时段已采集');
  assert.equal(total[headers.indexOf('AI无效请求_400')], '1');
  assert.equal(total[headers.indexOf('AI其他状态')], '1');
  assert.equal(['AI_HTTP_2xx', 'AI无效请求_400', 'AI限流_429', 'AI_5xx', 'AI其他状态'].reduce((sum, key) => sum + Number(total[headers.indexOf(key)]), 0), 5);
  for (const row of [total, ...hours]) assert.equal(row.length, headers.length);
  assert.equal(hours[0][headers.indexOf('AI采集状态')], '未采集');
  assert.equal(hours[0][headers.indexOf('AI请求')], '');
  assert.equal(hours[0][headers.indexOf('AI服务端完成')], '');
});

test('CSV exports observed outcomes and does not invent legacy classification', () => {
  const data = fixture();
  data.totals.ai.observation = { coverage: 'partial', requests: 2, metricVersion: 2,
    outcomes: { completed: 1, client_aborted: 1 }, scopes: {}, durationMsTotal: 300,
    firstTokenMsTotal: 50, firstTokenSamples: 1, promptCharsTotal: 1000, conversationCharsTotal: 20, inputSamples: 1 };
  data.totals.expectedUnavailable = 49; data.totals.serviceErrors = 0;
  const [headers, total] = csvRows(toCsv(data));
  assert.equal(total[headers.indexOf('AI结果采集状态')], '部分时段已采集');
  assert.equal(total[headers.indexOf('AI服务端完成')], '1');
  assert.equal(total[headers.indexOf('AI客户端中断')], '1');
  assert.equal(total[headers.indexOf('预期停用接口_503')], '49');
  assert.equal(total[headers.indexOf('其他服务端_5xx')], '0');
  delete data.totals.expectedUnavailable; delete data.totals.serviceErrors;
  const legacy = csvRows(toCsv(data))[1];
  assert.equal(legacy[headers.indexOf('预期停用接口_503')], '');
});

test('view separates runtime quota, observed completion and legacy input basis', () => {
  const html = renderDashboard(fixture());
  assert.match(html, /额度与服务状态/);
  assert.match(html, /id="quota-status"/);
  assert.match(html, /服务端完成/);
  assert.match(html, /旧数据.*未知/);
  assert.match(html, /规则.*资料.*历史/);
  assert.match(html, /预期停用接口/);
  assert.doesNotMatch(html, /<strong>NaN/);
});

test('quota presentation handles unavailable, stale, corrupt and future snapshots', () => {
  const { quotaPresentation } = require('../../../tools/traffic-quota-view.cjs');
  const now = Date.parse('2026-09-10T04:00:00Z');
  const valid = { schema: 1, capturedAt: new Date(now).toISOString(), available: true, reason: null,
    globalUsed: 12, globalLimit: 500, globalRemaining: 488, globalResetAt: new Date(now + 3600000).toISOString(), activeRequests: 2, concurrentLimit: 5 };
  assert.equal(quotaPresentation(valid, now).state, 'ready');
  assert.equal(quotaPresentation(valid, now).remaining, '488 / 500');
  assert.equal(quotaPresentation(valid, now + 181000).state, 'stale');
  assert.equal(quotaPresentation({ ...valid, capturedAt: new Date(now + 600000).toISOString() }, now).state, 'invalid');
  assert.equal(quotaPresentation({ ...valid, globalRemaining: -1 }, now).state, 'invalid');
  assert.equal(quotaPresentation({ ...valid, globalRemaining: 499 }, now).state, 'invalid');
  const unavailable = quotaPresentation({ ...valid, available: false, reason: 'redis_unavailable', globalUsed: null, globalRemaining: null, globalResetAt: null, activeRequests: null }, now);
  assert.equal(unavailable.state, 'unavailable');
  assert.equal(unavailable.remaining, '—');
  assert.equal(quotaPresentation(null, now).state, 'missing');
});
