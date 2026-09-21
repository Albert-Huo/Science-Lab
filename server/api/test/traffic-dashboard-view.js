'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { rollingSummary } = require('../../../tools/traffic-dashboard.cjs');
const { toCsv, productAnalyticsToCsv, renderDashboard } = require('../../../tools/traffic-dashboard-view.cjs');
const fixture = () => ({ ...rollingSummary([], {
  now: Date.parse('2026-09-10T04:03:00Z'), collectionStart: '2026-09-01T00:00:00Z',
  aiCollectionStart: '2026-09-10T01:03:25Z',
}), history: [] });
const csvRows = csv => csv.trimEnd().split('\r\n').map(row => [...row.matchAll(/"((?:[^"]|"")*)"/g)].map(match => match[1].replace(/""/g, '"')));

test('页面保留原始入口，展示互斥分类、原因与未标记入口，不宣称真人', () => {
  const data = fixture(), html = renderDashboard(data);
  assert.match(html, /浏览器特征入口/);
  assert.match(html, /访问分类/);
  assert.match(html, /高置信自动特征/);
  assert.match(html, /疑似自动访问/);
  assert.match(html, /未标记入口/);
  assert.match(html, /不等于真人/);
  assert.match(html, /查看判定原因/);
  assert.match(html, /data-metric="automation.suspected"/);
  assert.match(html, /data-metric="automation.entries.unclassified"/);
  assert.match(html, /清单.*不可用/);
  assert.doesNotMatch(html, /真实用户数|真实访客数|<strong>NaN/);
});

test('CSV分类与原指标同源，旧历史未知而非补零', () => {
  const data = fixture();
  data.history = [{ ...data.hours[0], day: '2026-09-09', partial: false }];
  delete data.history[0].automation;
  const [headers, total, ...hours] = csvRows(toCsv(data));
  for (const key of ['已验证爬虫请求','高置信自动特征请求','疑似自动访问请求','未命中自动规则请求','未标记入口','匿名AI未判定请求','自动原因_成组敏感探测']) assert.ok(headers.includes(key), key);
  assert.equal(total[headers.indexOf('自动分类版本')], '1');
  assert.ok([total,...hours].every(row => row.length === headers.length));
  const history = csvRows(toCsv(data, 'history'))[1];
  assert.equal(history[headers.indexOf('自动分类状态')], '未知（旧数据）');
  assert.equal(history[headers.indexOf('高置信自动特征请求')], '');
  assert.match(renderDashboard(data), /旧历史.*未知/);
});

test('输出前拒绝分类漂移而不是发布错误图表', () => {
  const data = fixture(); data.totals.automation.high++;
  assert.throws(() => renderDashboard(data), /分类/);
});

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

test('后台将无身份产品统计与安全流量分区并诚实标注未采集指标', () => {
  const html = renderDashboard(fixture());
  assert.match(html, /网站使用概览/);
  assert.match(html, /页面浏览 PV/);
  assert.match(html, /实验打开次数/);
  assert.match(html, /关键操作/);
  assert.match(html, /UV[\s\S]*未采集/);
  assert.match(html, /会话[\s\S]*未采集/);
  assert.match(html, /实验完成事件[\s\S]*未接入/);
  assert.match(html, /无身份聚合/);
  assert.match(html, /安全流量/);
  assert.match(html, /analytics\.json/);
  assert.match(html, /下载产品统计/);
  assert.doesNotMatch(html, /真人 UV|高置信真人/);
});

test('产品统计 CSV 与安全流量 CSV 分离且不构造 UV 或会话', () => {
  const capturedAt = '2026-09-10T04:00:00.000Z';
  const privacy = { mode: 'identity_free', cookie: false, fingerprint: false, crossPage: false,
    crossDay: false, uv: 'not_collected', sessions: 'not_collected', completion: 'not_connected' };
  const hours = Array.from({ length: 24 }, (_, index) => ({
    start: new Date(Date.parse(capturedAt) - (24 - index) * 3600000).toISOString(),
    end: new Date(Date.parse(capturedAt) - (23 - index) * 3600000).toISOString(),
    coverage: 'recorded', pageViews: index, experimentOpens: index + 1, keyActions: index + 2,
  }));
  const snapshot = { schema: 1, capturedAt, collectionStart: '2026-09-01T00:00:00.000Z', available: true,
    reason: null, privacy, totals: { pageViews: 276, experimentOpens: 300, keyActions: 324,
      sources: { direct: 100, internal: 80, search: 60, external: 36 },
      actions: { catalog_open: 100, profile_open: 80, experiment_previous: 70, experiment_next: 74 },
      topExperiments: [{ id: 'a'.repeat(64), title: '自由落体', count: 25 }] }, hours,
    days: [{ day: '2026-09-09', coverage: 'recorded', pageViews: 200, experimentOpens: 150, keyActions: 50 }] };
  const current = productAnalyticsToCsv(snapshot);
  assert.match(current, /页面浏览_PV/);
  assert.match(current, /自由落体/);
  assert.doesNotMatch(current, /visitor|session|IP|UA|指纹|UV/iu);
  const history = productAnalyticsToCsv(snapshot, 'history');
  assert.match(history, /2026-09-09/);
  assert.doesNotMatch(history, /自由落体/);
});
