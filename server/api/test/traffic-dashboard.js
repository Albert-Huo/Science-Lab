'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { test, after } = require('node:test');
const { rollingSummary, mergeHistory, publish, HOUR, DAY } = require('../../../tools/traffic-dashboard.cjs');
const { renderDashboard, toCsv } = require('../../../tools/traffic-dashboard-view.cjs');
const now = Date.parse('2026-09-08T00:03:00+08:00');
const started = '2026-09-05T01:00:00+08:00';
const ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36';
const experimentPath = 'physics-middle/初中物理实验1.html';
const experimentHash = crypto.createHash('sha256').update(experimentPath).digest('hex');
const experimentMap = new Map([[experimentHash, '初中物理实验1']]);
function line(time, { ip = '203.0.113.17', userAgent = ua, uri = '/', status = 200 } = {}) {
  return `${ip} - - [${time}] "GET ${uri} HTTP/2.0" ${status} 123 "https://example.org/private?q=secret" "${userAgent}" "-"`;
}
function aiLine(time, { status = 200, duration = '3.428', bytes = 1532, experiment = experimentHash, messages = 5, inputChars = 820 } = {}) {
  return JSON.stringify({ time, status: String(status), duration: String(duration), bytes: String(bytes),
    experiment, messages: messages === null ? '' : String(messages), inputChars: inputChars === null ? '' : String(inputChars) });
}
const summary = (lines, aiLines = [], options = {}) => rollingSummary(lines, {
  now, collectionStart: started, aiCollectionStart: options.aiCollectionStart || started, experimentMap, aiLines,
});
const data = () => ({ ...summary(
  [line('07/Sep/2026:01:00:00 +0800'), line('07/Sep/2026:23:59:59 +0800')],
  [aiLine('2026-09-07T01:00:00+08:00')]
), history: [] });
const terminal = (values = {}) => JSON.stringify({ version: 1, metricVersion: 2,
  time: '2026-09-07T01:00:00.000Z', outcome: 'completed', scope: '', experiment: '', status: 200,
  messages: 2, inputChars: 50, promptChars: 20, conversationChars: 30, durationMs: 1000, firstTokenMs: 100, ...values });
const eventOptions = { aiEventCollectionStart: '2026-09-07T00:00:00+08:00', aiEventLogDir: '/synthetic-events' };

test('终态独立于 HTTP 计数并单独标记启用覆盖', () => {
  const result = rollingSummary([], { now, collectionStart: started, aiCollectionStart: started,
    ...eventOptions, aiEventLines: [terminal(), terminal({ outcome: 'client_aborted', firstTokenMs: null }),
      terminal({ outcome: 'rate_limited', scope: 'global_day', status: 429, promptChars: null, conversationChars: null, firstTokenMs: null })] });
  assert.equal(result.totals.requests, 0);
  assert.equal(result.totals.ai.requests, 0);
  const observation = result.totals.ai.observation;
  assert.equal(observation.coverage, 'recorded');
  assert.equal(observation.requests, 3);
  assert.equal(observation.outcomes.completed, 1);
  assert.equal(observation.outcomes.client_aborted, 1);
  assert.equal(observation.scopes.global_day, 1);
  assert.equal(observation.durationMsTotal, 3000);
  assert.equal(observation.firstTokenSamples, 1);
  assert.equal(observation.firstTokenMsTotal, 100);
  assert.equal(observation.inputSamples, 2);
  assert.equal(observation.promptCharsTotal, 40);
  assert.equal(observation.conversationCharsTotal, 60);
  assert.equal(result.hours[9].ai.observation.requests, 3);
  assert.equal(summary([]).totals.ai.observation.coverage, 'unavailable');
  assert.throws(() => rollingSummary([], { now, collectionStart: started, aiCollectionStart: started,
    aiEventCollectionStart: eventOptions.aiEventCollectionStart }), /终态/);
  assert.throws(() => rollingSummary([], { now, collectionStart: started, aiCollectionStart: started,
    ...eventOptions, aiEventLines: ['bad'] }), /保留上一份报告/);
});

test('503 分类保留原始5xx，只将已退役 API 503 列为预期不可用', () => {
  const result = summary(['/api/login', '/api/user', '/api/health', '/api/ai/chat/completions', '/index.html'].map(uri =>
    line('07/Sep/2026:01:00:00 +0800', { uri, status: 503 })), [aiLine('2026-09-07T01:00:00+08:00', { status: 503 })]);
  assert.equal(result.totals.serverErrors, 6);
  assert.equal(result.totals.expectedUnavailable, 2);
  assert.equal(result.totals.serviceErrors, 4);
  assert.equal(result.hours[1].serviceErrors, 4);
});

test('HTTP 限流来源独立聚合，旧429保留未知', () => {
  const time = '2026-09-07T01:00:00+08:00';
  const base = JSON.parse(aiLine(time, { status: 429 }));
  const result = summary([], [JSON.stringify(base), ...['ip_minute', 'ip_day', 'session_day', 'global_day', 'concurrency'].map(quotaScope =>
    JSON.stringify({ ...base, quotaScope, upstreamStatus: '429' })), JSON.stringify({ ...base, quotaScope: '', upstreamStatus: '-' })]);
  assert.deepEqual(result.totals.ai.limitReasons, { ip_minute: 1, ip_day: 1, session_day: 1, global_day: 1, concurrency: 1, nginx: 1, unknown: 1 });
});

test('旧历史分类未知，历史终态去标识验证且日志截断不覆盖已有观测', () => {
  const initial = rollingSummary([], { now, collectionStart: started, aiCollectionStart: started,
    ...eventOptions, aiEventLines: [terminal()] });
  const archived = initial.daily.find(day => day.day === '2026-09-07');
  const { expectedUnavailable, serviceErrors, ...legacy } = archived;
  const { observation, limitReasons, ...oldAi } = legacy.ai;
  legacy.ai = oldAi;
  const migrated = mergeHistory({ schema: 2, days: [legacy] }, [], Date.parse(initial.windowEnd));
  assert.equal(migrated.days[0].expectedUnavailable, null);
  assert.equal(migrated.days[0].serviceErrors, null);
  assert.equal(migrated.days[0].ai.observation.coverage, 'unavailable');
  const retained = rollingSummary([], { now: now + 2 * DAY, collectionStart: started, aiCollectionStart: started,
    ...eventOptions, aiEventLines: [terminal({ time: '2026-09-09T01:00:00.000Z' })] });
  archived.ai.observation.ip = '203.0.113.17';
  archived.ai.observation.outcomes.private = 'secret';
  const merged = mergeHistory({ schema: 2, days: [archived] }, retained.daily, Date.parse(retained.windowEnd));
  assert.equal(merged.days.find(day => day.day === archived.day).ai.observation.requests, 1);
  assert.ok(!/203\.0\.113|secret/.test(JSON.stringify(merged)));
  const bad = structuredClone(archived);
  bad.ai.observation.outcomes.completed = -1;
  assert.throws(() => mergeHistory({ schema: 2, days: [bad] }, [], Date.parse(initial.windowEnd)), /终态/);
});

test('滚动窗口含开始不含结束，补齐24小时且去重不累加', () => {
  const result = summary([
    line('06/Sep/2026:23:59:59 +0800'), line('07/Sep/2026:00:00:00 +0800'),
    line('07/Sep/2026:01:00:00 +0800'), line('07/Sep/2026:23:59:59 +0800'),
    line('08/Sep/2026:00:00:00 +0800'), line('08/Sep/2026:01:00:00 +0800')
  ]);
  assert.equal(result.windowStart, '2026-09-06T16:00:00.000Z');
  assert.equal(result.windowEnd, '2026-09-07T16:00:00.000Z');
  assert.equal(result.hours.length, 24);
  assert.equal(result.totals.entryRequests, 3);
  assert.equal(result.totals.visitorEstimate, 1);
  assert.equal(result.hours.reduce((sum, h) => sum + h.visitorEstimate, 0), 3);
  assert.equal(result.hours[2].entryRequests, 0);
  const shifted = rollingSummary([line('07/Sep/2026:01:00:00 +0800'), line('08/Sep/2026:01:00:00 +0800')], {
    now: now + 2 * HOUR, collectionStart: started, aiCollectionStart: started,
  });
  assert.equal(shifted.windowStart, '2026-09-06T18:00:00.000Z');
  assert.equal(shifted.totals.entryRequests, 1);
});

test('验收、私有看板和自动请求不会形成入口访客，设备来源正常分类', () => {
  const result = summary([
    line('07/Sep/2026:01:00:00 +0800', { userAgent: 'Mozilla/5.0 ScienceLab-Log-Check/test' }),
    line('07/Sep/2026:01:00:00 +0800', { uri: '/admin/traffic/' }),
    line('07/Sep/2026:01:00:00 +0800', { userAgent: 'Mozilla/5.0 (iPhone) Mobile' }),
    line('07/Sep/2026:01:00:00 +0800', { userAgent: 'Mozilla/5.0 (iPad)' }),
    line('07/Sep/2026:01:00:00 +0800', { status: 500 }),
    line('07/Sep/2026:01:00:00 +0800', { status: 404 })
  ]);
  assert.equal(result.totals.requests, 5);
  assert.equal(result.totals.entryRequests, 2);
  assert.equal(result.totals.serverErrors, 1);
  assert.equal(result.totals.clientErrors, 1);
  assert.deepEqual(result.totals.devices, { desktop: 0, mobile: 1, tablet: 1 });
  assert.equal(result.totals.sources.external, 2);
  assert.ok(!/203\.0\.113|Mozilla|secret|example\.org/.test(JSON.stringify(result)));
});

test('匿名 AI 请求计入总量并按状态聚合，不形成访客或长期实验明细', () => {
  const time = '2026-09-07T01:00:00+08:00';
  const result = summary([line('06/Sep/2026:23:59:59 +0800'), line('07/Sep/2026:01:00:00 +0800')], [
    aiLine(time),
    aiLine(time, { status: 400, experiment: '', messages: null, inputChars: null }),
    aiLine(time, { status: 429, experiment: '', messages: null, inputChars: null }),
    aiLine(time, { status: 503, experiment: '', messages: null, inputChars: null }),
    aiLine(time, { status: 302, experiment: '', messages: null, inputChars: null }),
  ], { aiCollectionStart: '2026-09-07T00:00:00+08:00' });
  assert.equal(result.schema, 3);
  assert.equal(result.totals.requests, 6);
  assert.equal(result.totals.entryRequests, 1);
  assert.equal(result.totals.visitorEstimate, 1);
  assert.equal(result.totals.clientErrors, 2);
  assert.equal(result.totals.serverErrors, 1);
  assert.equal(result.totals.automated, 0);
  const { observation, limitReasons, ...legacyAi } = result.totals.ai;
  assert.equal(observation.coverage, 'unavailable');
  assert.equal(limitReasons.unknown, 1);
  assert.deepEqual(legacyAi, {
    coverage: 'recorded', requests: 5, httpSuccesses: 1, invalidRequests: 1, rateLimited: 1,
    serverErrors: 1, otherStatuses: 1, durationMsTotal: 3428, durationSamples: 1,
    responseBytes: 1532, messageCountTotal: 5, messageSamples: 1,
    inputCharsTotal: 820, inputSamples: 1,
    experiments: [{ title: '初中物理实验1', requests: 1 }],
  });
  assert.ok(!result.daily[0].ai.experiments);
  const output = JSON.stringify(result);
  assert.ok(!output.includes(experimentHash));
  assert.ok(!output.includes(experimentPath));
});

test('当前窗口热门实验只保留请求最多的前 8 项', () => {
  const items = Array.from({ length: 9 }, (_, index) => {
    const itemPath = `physics-middle/实验${index + 1}.html`;
    return {
      hash: crypto.createHash('sha256').update(itemPath).digest('hex'),
      title: `实验${index + 1}`,
      requests: index + 1,
    };
  });
  const aiLines = items.flatMap(item => Array.from({ length: item.requests }, () => aiLine(
    '2026-09-07T01:00:00+08:00', { experiment: item.hash }
  )));
  const result = rollingSummary([], {
    now,
    collectionStart: started,
    aiCollectionStart: started,
    experimentMap: new Map(items.map(item => [item.hash, item.title])),
    aiLines,
  });
  assert.equal(result.totals.ai.experiments.length, 8);
  assert.deepEqual(result.totals.ai.experiments.slice(0, 2), [
    { title: '实验9', requests: 9 },
    { title: '实验8', requests: 8 },
  ]);
  assert.ok(!result.totals.ai.experiments.some(item => item.title === '实验1'));
});

test('AI 采集前、跨启用时刻和启用后分别标为未采集、部分和已采集', () => {
  const result = summary([line('06/Sep/2026:23:59:59 +0800')], [aiLine('2026-09-07T21:42:00+08:00')], {
    aiCollectionStart: '2026-09-07T21:41:00+08:00',
  });
  assert.equal(result.totals.ai.coverage, 'partial');
  assert.equal(result.hours[20].ai.coverage, 'unavailable');
  assert.equal(result.hours[21].ai.coverage, 'partial');
  assert.equal(result.hours[22].ai.coverage, 'recorded');
  assert.equal(result.hours[21].ai.requests, 1);
  assert.equal(result.daily[0].ai.coverage, 'partial');
});

test('AI 日志留存边界不跳过采集前流量，也不把轮转首日补成零', () => {
  const firstRun = rollingSummary([], {
    now,
    collectionStart: started,
    aiCollectionStart: '2026-09-07T21:41:00+08:00',
    experimentMap,
    aiLines: [aiLine('2026-09-07T21:42:00+08:00')],
  });
  assert.deepEqual(firstRun.daily.map(day => day.day), ['2026-09-05', '2026-09-06', '2026-09-07']);

  const retained = rollingSummary([], {
    now: Date.parse('2026-09-12T00:03:00+08:00'),
    collectionStart: '2026-09-01T01:00:00+08:00',
    aiCollectionStart: '2026-09-02T01:00:00+08:00',
    experimentMap,
    aiLines: [aiLine('2026-09-09T12:00:00+08:00')],
  });
  assert.deepEqual(retained.daily.map(day => day.day), ['2026-09-01', '2026-09-10', '2026-09-11']);
});

test('旧 schema 1 历史迁移时保留流量并把 AI 标为未采集', () => {
  const current = summary([line('06/Sep/2026:23:59:59 +0800'), line('07/Sep/2026:01:00:00 +0800')]);
  const { ai, ...legacyDay } = current.daily[0];
  const migrated = mergeHistory({ schema: 1, days: [legacyDay] }, [], Date.parse(current.windowEnd));
  assert.equal(migrated.schema, 2);
  assert.equal(migrated.days[0].entryRequests, legacyDay.entryRequests);
  assert.equal(migrated.days[0].ai.coverage, 'unavailable');
  assert.equal(migrated.days[0].ai.requests, 0);
  assert.ok(!('experiments' in migrated.days[0].ai));
});

test('采集前空缺和部分小时区分于实际零请求，首日部分归档', () => {
  const result = rollingSummary([line('07/Sep/2026:21:42:00 +0800')], {
    now, collectionStart: '2026-09-07T21:41:00+08:00', aiCollectionStart: started,
  });
  assert.equal(result.partial, true);
  assert.equal(result.hours[20].coverage, 'unavailable');
  assert.equal(result.hours[21].coverage, 'partial');
  assert.equal(result.hours[22].coverage, 'recorded');
  assert.equal(result.daily.length, 1);
  assert.equal(result.daily[0].partial, true);
});

test('日志格式异常拒绝生成，避免用不完整计数覆盖旧报表', () => {
  assert.throws(() => summary(['broken input']), /保留上一份报告/);
  assert.throws(() => rollingSummary([], { now, collectionStart: 'invalid' }), /开始时间/);
});

test('每日历史按日期替换、去标识、限制400天，不把留存首日误当完整日', () => {
  const result = summary([line('06/Sep/2026:23:59:59 +0800'), line('07/Sep/2026:01:00:00 +0800')]);
  assert.equal(result.daily.length, 1);
  assert.equal(result.daily[0].day, '2026-09-07');
  const first = mergeHistory({ schema: 1, days: [] }, result.daily, Date.parse(result.windowEnd));
  const malicious = { ...first.days[0], unexpectedIp: '203.0.113.17' };
  const merged = mergeHistory({ schema: 1, days: [malicious] }, result.daily, Date.parse(result.windowEnd));
  assert.equal(merged.days.length, 1);
  assert.ok(!JSON.stringify(merged).includes('203.0.113'));
  const pruned = mergeHistory(merged, [], Date.parse(result.windowEnd) + 401 * DAY);
  assert.equal(pruned.days.length, 0);
  assert.throws(() => mergeHistory({ schema: 1, days: [{ ...malicious, requests: -1 }] }, [], now), /计数无效/);
});

test('CSV带UTF-8 BOM并精确包含汇总和24个小时；未采集不导出为零', () => {
  const result = { ...rollingSummary([], {
    now, collectionStart: '2026-09-07T21:41:00+08:00', aiCollectionStart: '2026-09-07T21:41:00+08:00',
  }), history: [] };
  const csv = toCsv(result);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.equal(csv.trimEnd().split('\r\n').length, 26);
  assert.match(csv, /访客估算_不可跨行相加/);
  assert.match(csv, /AI请求/);
  assert.match(csv, /AI_HTTP_2xx/);
  assert.match(csv, /AI限流_429/);
  assert.match(csv, /AI_5xx/);
  assert.match(csv, /AI_2xx平均耗时毫秒/);
  assert.match(csv, /"未采集","","",""/);
  assert.match(csv, /2026-09-08 00:00:00\+08:00/);
  assert.ok(!/203\.0\.113|Mozilla|example\.org|secret/.test(csv));
  const unavailableRow = csv.split('\r\n').find(row => row.includes('"未采集"'));
  const unavailableCells = unavailableRow.match(/"(?:[^"]|"")*"/g);
  assert.deepEqual(unavailableCells.slice(-8), Array(8).fill('""'));
});

test('页面脚本散列与CSP一致，下载和自动刷新仅使用本期汇总', () => {
  const html = renderDashboard(data());
  const script = html.match(/<script>([\s\S]+)<\/script>/)[1];
  const hash = crypto.createHash('sha256').update(script).digest('base64');
  assert.ok(html.includes('sha256-' + hash));
  assert.ok(!/<script[^>]*src=|<link\b|<iframe\b/.test(html));
  assert.match(html, /下载当前数据/);
  assert.match(html, /每次向前滚动 2 小时/);
  assert.match(html, /AI 交互/);
  assert.match(html, /仅内置模式/);
  assert.match(html, /HTTP 2xx/);
  assert.match(html, /BYOK 不在统计范围/);
  assert.match(html, /不保存问题或回答正文/);
  assert.match(html, /初中物理实验1/);
  assert.ok(!html.includes(experimentHash));
  assert.ok(!html.includes(experimentPath));
  assert.ok(!/203\.0\.113|Mozilla\/|example\.org|q=secret/.test(html));
  assert.match(script, /toCsv\(trafficData, scope\)/);
  assert.match(script, /valueOf/);
  assert.match(script, /coverageOf/);
  assert.throws(() => renderDashboard({ ...data(), schema: 2 }), /看板数据无效/);
  const invalidExperiment = data();
  invalidExperiment.totals.ai.experiments = [{ title: '<script>', requests: -1 }];
  assert.throws(() => renderDashboard(invalidExperiment), /看板数据无效/);
});

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'science-lab-dashboard-'));
after(() => fs.rmSync(fixture, { recursive: true, force: true }));
test('发布为完整文件；坏日志与坏历史均保留上一份页面，并拒绝符号链接', async () => {
  const logDir = path.join(fixture, 'logs'), stateDir = path.join(fixture, 'state');
  fs.mkdirSync(logDir); fs.mkdirSync(stateDir); fs.mkdirSync(path.join(stateDir, 'www'));
  const log = path.join(logDir, 'science-lab-access.log');
  const aiLog = path.join(logDir, 'science-lab-ai-access.log');
  const manifest = path.join(fixture, 'manifest.json');
  const page = path.join(stateDir, 'www/index.html');
  const options = { logDir, aiLogDir: logDir, manifestFile: manifest, stateDir,
    collectionStart: started, aiCollectionStart: started, now };
  fs.writeFileSync(log, line('07/Sep/2026:01:00:00 +0800') + '\n');
  fs.writeFileSync(aiLog, aiLine('2026-09-07T01:00:00+08:00') + '\n');
  fs.writeFileSync(manifest, JSON.stringify([{ path: experimentPath, title: '初中物理实验1' }]));
  await publish(options);
  const before = fs.readFileSync(page, 'utf8');
  assert.match(before, /初中物理实验1/);
  assert.equal(fs.statSync(path.join(stateDir, 'history.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(page).mode & 0o777, 0o644);
  await assert.rejects(publish({ ...options, aiEventCollectionStart: started }), /终态/);
  await assert.rejects(publish({ ...options, aiEventCollectionStart: started, aiEventLogDir: logDir }), /终态日志/);
  assert.equal(fs.readFileSync(page, 'utf8'), before);
  const eventLog = path.join(logDir, 'ai-events.log');
  fs.writeFileSync(eventLog, 'bad event\n');
  await assert.rejects(publish({ ...options, aiEventCollectionStart: started, aiEventLogDir: logDir }), /保留上一份报告/);
  assert.equal(fs.readFileSync(page, 'utf8'), before);
  fs.appendFileSync(log, 'bad log\n');
  await assert.rejects(publish(options));
  assert.equal(fs.readFileSync(page, 'utf8'), before);
  fs.writeFileSync(log, line('07/Sep/2026:01:00:00 +0800') + '\n');
  fs.appendFileSync(aiLog, 'bad ai log\n');
  await assert.rejects(publish(options));
  assert.equal(fs.readFileSync(page, 'utf8'), before);
  fs.writeFileSync(aiLog, aiLine('2026-09-07T01:00:00+08:00') + '\n');
  fs.writeFileSync(path.join(stateDir, 'history.json'), '{broken');
  await assert.rejects(publish(options));
  assert.equal(fs.readFileSync(page, 'utf8'), before);
  fs.unlinkSync(path.join(stateDir, 'history.json'));
  fs.unlinkSync(page); fs.symlinkSync(log, page);
  await assert.rejects(publish(options), /普通文件/);
  assert.equal(fs.readFileSync(log, 'utf8'), line('07/Sep/2026:01:00:00 +0800') + '\n');
});
