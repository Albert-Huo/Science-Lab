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
function line(time, { ip = '203.0.113.17', userAgent = ua, uri = '/', status = 200 } = {}) {
  return `${ip} - - [${time}] "GET ${uri} HTTP/2.0" ${status} 123 "https://example.org/private?q=secret" "${userAgent}" "-"`;
}
const summary = lines => rollingSummary(lines, { now, collectionStart: started });
const data = () => ({ ...summary([line('07/Sep/2026:01:00:00 +0800'), line('07/Sep/2026:23:59:59 +0800')]), history: [] });

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
  const shifted = rollingSummary([line('07/Sep/2026:01:00:00 +0800'), line('08/Sep/2026:01:00:00 +0800')], { now: now + 2 * HOUR, collectionStart: started });
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

test('采集前空缺和部分小时区分于实际零请求，首日部分归档', () => {
  const result = rollingSummary([line('07/Sep/2026:21:42:00 +0800')], { now, collectionStart: '2026-09-07T21:41:00+08:00' });
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
  const result = { ...rollingSummary([], { now, collectionStart: '2026-09-07T21:41:00+08:00' }), history: [] };
  const csv = toCsv(result);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.equal(csv.trimEnd().split('\r\n').length, 26);
  assert.match(csv, /访客估算_不可跨行相加/);
  assert.match(csv, /"未采集","","",""/);
  assert.match(csv, /2026-09-08 00:00:00\+08:00/);
  assert.ok(!/203\.0\.113|Mozilla|example\.org|secret/.test(csv));
});

test('页面脚本散列与CSP一致，下载和自动刷新仅使用本期汇总', () => {
  const html = renderDashboard(data());
  const script = html.match(/<script>([\s\S]+)<\/script>/)[1];
  const hash = crypto.createHash('sha256').update(script).digest('base64');
  assert.ok(html.includes('sha256-' + hash));
  assert.ok(!/<script[^>]*src=|<link\b|<iframe\b/.test(html));
  assert.match(html, /下载当前数据/);
  assert.match(html, /每次向前滚动 2 小时/);
  assert.ok(!/203\.0\.113|Mozilla\/|example\.org|q=secret/.test(html));
  assert.match(script, /toCsv\(trafficData, scope\)/);
});

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'science-lab-dashboard-'));
after(() => fs.rmSync(fixture, { recursive: true, force: true }));
test('发布为完整文件；坏日志与坏历史均保留上一份页面，并拒绝符号链接', async () => {
  const logDir = path.join(fixture, 'logs'), stateDir = path.join(fixture, 'state');
  fs.mkdirSync(logDir); fs.mkdirSync(stateDir); fs.mkdirSync(path.join(stateDir, 'www'));
  const log = path.join(logDir, 'science-lab-access.log');
  const page = path.join(stateDir, 'www/index.html');
  const options = { logDir, stateDir, collectionStart: started, now };
  fs.writeFileSync(log, line('07/Sep/2026:01:00:00 +0800') + '\n');
  await publish(options);
  const before = fs.readFileSync(page, 'utf8');
  assert.equal(fs.statSync(path.join(stateDir, 'history.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(page).mode & 0o777, 0o644);
  fs.appendFileSync(log, 'bad log\n');
  await assert.rejects(publish(options));
  assert.equal(fs.readFileSync(page, 'utf8'), before);
  fs.writeFileSync(log, line('07/Sep/2026:01:00:00 +0800') + '\n');
  fs.writeFileSync(path.join(stateDir, 'history.json'), '{broken');
  await assert.rejects(publish(options));
  assert.equal(fs.readFileSync(page, 'utf8'), before);
  fs.unlinkSync(path.join(stateDir, 'history.json'));
  fs.unlinkSync(page); fs.symlinkSync(log, page);
  await assert.rejects(publish(options), /普通文件/);
  assert.equal(fs.readFileSync(log, 'utf8'), line('07/Sep/2026:01:00:00 +0800') + '\n');
});
