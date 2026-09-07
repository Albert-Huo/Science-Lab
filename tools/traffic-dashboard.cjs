#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseRecord, visitLogDirectory } = require('./traffic-report.cjs');
const { renderDashboard } = require('./traffic-dashboard-view.cjs');
const HOUR = 3600000, DAY = 24 * HOUR, PERIOD = 2 * HOUR;
const iso = value => new Date(value).toISOString();
const localDay = time => Math.floor((time + 8 * HOUR) / DAY) * DAY - 8 * HOUR;
const dayName = time => iso(time + 8 * HOUR).slice(0, 10);
const METRICS = ['requests', 'entryRequests', 'visitorEstimate', 'automated', 'clientErrors', 'serverErrors'];
const DEVICES = ['desktop', 'mobile', 'tablet'], SOURCES = ['internal', 'external', 'unknown'];

function bucket() {
  return { requests: 0, entryRequests: 0, automated: 0, clientErrors: 0, serverErrors: 0,
    devices: { desktop: 0, mobile: 0, tablet: 0 }, sources: { internal: 0, external: 0, unknown: 0 }, identities: new Set() };
}
function add(target, record) {
  target.requests++;
  if (record.automated) target.automated++;
  if (record.status >= 400 && record.status < 500) target.clientErrors++;
  if (record.status >= 500) target.serverErrors++;
  if (!record.entry) return;
  target.entryRequests++;
  target.identities.add(record.identity);
  target.devices[record.device]++;
  target.sources[record.source]++;
}
function finish(target) {
  const { identities, ...values } = target;
  return { ...values, visitorEstimate: identities.size };
}

function createRolling({ now = Date.now(), collectionStart }) {
  const started = Date.parse(collectionStart);
  if (!Number.isFinite(now) || !Number.isFinite(started) || started > now) throw new Error('采集开始时间无效');
  const end = Math.floor(now / PERIOD) * PERIOD, start = end - DAY;
  const totals = bucket(), hours = Array.from({ length: 24 }, bucket), days = new Map();
  let earliest = Infinity, invalid = 0;
  return {
    add(line) {
      let record;
      try { record = parseRecord(line); } catch { invalid++; return; } // Count malformed input; publishing fails closed below.
      if (!record || record.uri.startsWith('/admin/')) return;
      if (record.timestamp < started || record.timestamp >= end) return;
      earliest = Math.min(earliest, record.timestamp);
      const date = localDay(record.timestamp);
      if (!days.has(date)) days.set(date, bucket());
      add(days.get(date), record);
      if (record.timestamp < start) return;
      add(totals, record);
      add(hours[Math.floor((record.timestamp - start) / HOUR)], record);
    },
    finish() {
      if (invalid) throw new Error(`有 ${invalid} 行日志无法解析，保留上一份报告`);
      // A retained first day may be missing an earlier rotated segment. Never overwrite it as a complete day.
      const firstDay = Number.isFinite(earliest) ? localDay(earliest) : localDay(started);
      const archiveFrom = firstDay === localDay(started) ? firstDay : firstDay + DAY;
      const daily = [];
      for (let day = Math.max(archiveFrom, localDay(end) - 399 * DAY); day + DAY <= end; day += DAY) {
        daily.push({ day: dayName(day), start: iso(day), end: iso(day + DAY),
          partial: day < started, ...finish(days.get(day) || bucket()) });
      }
      return {
        schema: 2, site: 'lab.xingnian.net.cn', generatedAt: iso(now), collectionStart: iso(started),
        windowStart: iso(start), windowEnd: iso(end), nextUpdate: iso(end + PERIOD),
        partial: started > start, totals: finish(totals),
        hours: hours.map((hour, index) => ({ start: iso(start + index * HOUR), end: iso(start + (index + 1) * HOUR),
          coverage: start + (index + 1) * HOUR <= started ? 'unavailable' : start + index * HOUR < started ? 'partial' : 'recorded', ...finish(hour) })),
        daily
      };
    }
  };
}

function rollingSummary(lines, options) {
  const accumulator = createRolling(options);
  for (const line of lines) accumulator.add(line);
  return accumulator.finish();
}

function cleanDaily(record) {
  if (!record || !/^\d{4}-\d{2}-\d{2}$/.test(record.day) || dayName(Date.parse(record.start)) !== record.day ||
      Date.parse(record.end) - Date.parse(record.start) !== DAY || localDay(Date.parse(record.start)) !== Date.parse(record.start) || typeof record.partial !== 'boolean') throw new Error('历史汇总日期无效');
  const result = { day: record.day, start: record.start, end: record.end, partial: record.partial };
  for (const field of METRICS) {
    if (!Number.isSafeInteger(record[field]) || record[field] < 0) throw new Error('历史汇总计数无效');
    result[field] = record[field];
  }
  for (const [group, keys] of [['devices', DEVICES], ['sources', SOURCES]]) {
    result[group] = {};
    for (const key of keys) {
      if (!Number.isSafeInteger(record[group]?.[key]) || record[group][key] < 0) throw new Error('历史汇总分类无效');
      result[group][key] = record[group][key];
    }
  }
  return result;
}
function mergeHistory(previous, daily, cutoff) {
  if (!previous || previous.schema !== 1 || !Array.isArray(previous.days)) throw new Error('历史汇总文件无效');
  const entries = new Map();
  for (const record of [...previous.days, ...daily]) {
    const clean = cleanDaily(record);
    const day = Date.parse(clean.start);
    if (day >= localDay(cutoff) - 400 * DAY && Date.parse(clean.end) <= cutoff) entries.set(clean.day, clean);
  }
  return { schema: 1, days: [...entries.values()].sort((a, b) => a.day.localeCompare(b.day)) };
}

function atomicWrite(file, value, mode) {
  if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) throw new Error('目标必须是普通文件：' + path.basename(file));
  const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.' + crypto.randomUUID());
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', mode);
    fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, value); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

async function publish({ logDir, stateDir, collectionStart, now = Date.now() }) {
  if (!path.isAbsolute(stateDir) || !fs.lstatSync(stateDir).isDirectory()) throw new Error('汇总目录必须是已存在的普通目录');
  const www = path.join(stateDir, 'www');
  if (!fs.lstatSync(www).isDirectory()) throw new Error('网页目录必须是普通目录');
  const accumulator = createRolling({ now, collectionStart });
  await visitLogDirectory(logDir, line => accumulator.add(line));
  const data = accumulator.finish();
  const historyFile = path.join(stateDir, 'history.json');
  let previous = { schema: 1, days: [] };
  if (fs.existsSync(historyFile)) {
    if (!fs.lstatSync(historyFile).isFile()) throw new Error('历史汇总必须是普通文件');
    previous = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
  }
  const history = mergeHistory(previous, data.daily, Date.parse(data.windowEnd));
  data.history = history.days;
  delete data.daily;
  const html = renderDashboard(data);
  // History is private; the only web-readable output is one self-contained, atomically replaced page.
  atomicWrite(historyFile, JSON.stringify(history), 0o600);
  atomicWrite(path.join(www, 'index.html'), html, 0o644);
  return data;
}

async function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--log-dir', '--state-dir', '--collection-start'].includes(args[i]) || !args[i + 1]) throw new Error('统计参数无效');
    options[args[i].slice(2)] = args[i + 1];
  }
  const data = await publish({ logDir: options['log-dir'], stateDir: options['state-dir'], collectionStart: options['collection-start'] });
  console.log(`统计已更新：${data.windowStart} 至 ${data.windowEnd}；入口 ${data.totals.entryRequests}；访客估算 ${data.totals.visitorEstimate}`);
}
module.exports = { HOUR, DAY, PERIOD, createRolling, rollingSummary, mergeHistory, publish, atomicWrite };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error('统计更新失败：' + error.message); process.exitCode = 1; });
