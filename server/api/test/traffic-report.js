'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { test, after } = require('node:test');
const { execFileSync } = require('node:child_process');
const report = require('../../../tools/traffic-report.cjs');

function line({ ip = '203.0.113.17', time = '07/Sep/2026:18:00:00 +0800', method = 'GET', url = '/', status = 200, ref = '-', ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36' } = {}) {
  return `${ip} - - [${time}] "${method} ${url} HTTP/2.0" ${status} 1234 "${ref}" "${ua}" "-"`;
}
const now = '2026-09-07T11:00:00.000Z';
const summarize = lines => report.summarize(lines, { generatedAt: now });

test('入口指标仅计浏览器 GET 成功首页，标识只用于去重不进入输出', () => {
  const result = summarize([
    line({ url: '/?private=secret-token' }), line({ url: '/index.html', status: 304 }),
    line({ ip: '203.0.113.18', ua: 'Mozilla/5.0 (Linux; Android 14) Mobile Chrome/130.0' }),
    line({ url: '/assets/icons/icon-192.png' }), line({ url: '/api/health' }),
    line({ status: 301 }), line({ status: 404 }), line({ method: 'HEAD' }),
    line({ method: 'POST' }), line({ url: '/favicon.ico' })
  ]);
  assert.equal(result.totals.requests, 10);
  assert.equal(result.totals.entryRequests, 3);
  assert.equal(result.totals.visitorEstimate, 2);
  assert.equal(result.days[0].entryRequests, 3);
  assert.equal(result.devices.desktop, 2);
  assert.equal(result.devices.mobile, 1);
  const output = JSON.stringify(result);
  assert.ok(!output.includes('203.0.113.'));
  assert.ok(!output.includes('secret-token'));
  assert.ok(!output.includes('Mozilla/5.0'));
});

test('明显机器人、命令行和本任务验收浏览器不计入入口指标', () => {
  const result = summarize([
    line({ ua: 'curl/8.0' }), line({ ua: 'Mozilla/5.0 Googlebot/2.1' }),
    line({ ua: 'Mozilla/5.0 HeadlessChrome/130.0' }),
    line({ ua: 'Mozilla/5.0 ScienceLab-Log-Check/test' }),
    line({ ua: 'python-requests/2.0' }), line({ ua: '-' })
  ]);
  assert.equal(result.totals.entryRequests, 0);
  assert.equal(result.totals.visitorEstimate, 0);
  assert.equal(result.totals.automated, 5);
});

test('北京时间按日分组，日估算不能累加为期间去重人数', () => {
  const result = summarize([
    line({ time: '06/Sep/2026:16:05:00 +0000' }),
    line({ time: '06/Sep/2026:15:05:00 +0000' }),
    line({ time: '07/Sep/2026:18:00:00 +0800' })
  ]);
  assert.deepEqual(result.days.map(d => [d.day, d.entryRequests, d.visitorEstimate]), [
    ['2026-09-06', 1, 1], ['2026-09-07', 2, 1]
  ]);
  assert.equal(result.totals.visitorEstimate, 1);
});

test('来源只保留固定分类，不输出 URL、查询参数或来源 IP', () => {
  const result = summarize([
    line({ ref: 'https://lab.xingnian.net.cn/?token=private' }),
    line({ ref: 'https://203.0.113.19/private?token=private' }),
    line({ ref: 'https://example.org/' }), line()
  ]);
  assert.deepEqual(result.sources, { internal: 1, external: 2, unknown: 1 });
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.ok(!JSON.stringify(result).includes('203.0.113.'));
});

test('无法解析或无效日期显式计数，不伪装成正常数据', () => {
  const result = summarize(['broken log', line({ time: '99/Sep/2026:18:00:00 +0800' }), line()]);
  assert.equal(result.totals.requests, 1);
  assert.equal(result.totals.invalid, 2);
});

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'science-lab-private-traffic-'));
after(() => fs.rmSync(fixture, { recursive: true, force: true }));

test('只读独立日志及 gzip 轮转，不导入混合日志和其他文件', async () => {
  fs.writeFileSync(path.join(fixture, 'science-lab-access.log'), line() + '\n');
  fs.writeFileSync(path.join(fixture, 'science-lab-access.log-20260907.gz'), zlib.gzipSync(line({ time: '06/Sep/2026:18:00:00 +0800' }) + '\n'));
  fs.writeFileSync(path.join(fixture, 'access.log'), line({ ip: '203.0.113.99' }) + '\n');
  fs.writeFileSync(path.join(fixture, 'science-lab-access.log.backup'), 'not a log\n');
  const result = await report.summarizeDirectory(fixture, { generatedAt: now });
  assert.equal(result.files.length, 2);
  assert.equal(result.totals.requests, 2);
  assert.equal(result.totals.invalid, 0);
  assert.equal(result.totals.visitorEstimate, 1);
});

test('拒绝日志符号链接和损坏的压缩包，不静默漏计', async () => {
  const dir = fs.mkdtempSync(path.join(fixture, 'bad-'));
  const link = path.join(dir, 'science-lab-access.log');
  fs.symlinkSync(path.join(fixture, 'access.log'), link);
  await assert.rejects(report.summarizeDirectory(dir), /regular|普通文件/);
  fs.unlinkSync(link);
  fs.writeFileSync(path.join(dir, 'science-lab-access.log-20260907.gz'), 'bad gzip');
  await assert.rejects(report.summarizeDirectory(dir));
});

test('没有独立日志时明确失败；空日志报告不把验收请求当真实使用', async () => {
  const dir = fs.mkdtempSync(path.join(fixture, 'empty-'));
  await assert.rejects(report.summarizeDirectory(dir), /独立日志/);
  fs.writeFileSync(path.join(dir, 'science-lab-access.log'), '');
  const result = await report.summarizeDirectory(dir, { generatedAt: now });
  const html = report.renderHtml(result);
  assert.match(html, /暂无可计入的入口访问/);
  assert.match(html, /不代表真实人数/);
  assert.match(html, /停留时间/);
  assert.ok(!/<script\b|<iframe\b|<link\b|<img\b/.test(html));
  assert.ok(!/https?:\/\//.test(html));
});

test('通过 SSH 使用的 Node stdin 入口会实际执行并返回有效汇总', () => {
  const dir = fs.mkdtempSync(path.join(fixture, 'stdin-'));
  fs.writeFileSync(path.join(dir, 'science-lab-access.log'), line() + '\n');
  const output = execFileSync(process.execPath, ['-', '--log-dir', dir, '--json'], {
    input: fs.readFileSync(path.resolve(__dirname, '../../../tools/traffic-report.cjs')),
    encoding: 'utf8', timeout: 10000
  });
  assert.ok(output.trim().startsWith('{'), 'stdin 入口应返回 JSON，而不是静默退出');
  assert.equal(JSON.parse(output).totals.entryRequests, 1);
});

test('报告对输出进行转义，包含指标口径和日期，且无原始标识', () => {
  const data = summarize([line()]);
  data.generatedAt = '<script>alert(1)</script>';
  const html = report.renderHtml(data);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('203.0.113.17'));
  assert.match(html, /2026-09-07/);
  assert.match(html, /入口请求/);
  assert.match(html, /GitHub Pages/);
});
