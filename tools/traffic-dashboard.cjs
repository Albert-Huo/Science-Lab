#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseRecord, visitLogDirectory } = require('./traffic-report.cjs');
const { parseAiRecord, visitAiLogDirectory, loadExperimentMap } = require('./traffic-ai-report.cjs');
const { renderDashboard } = require('./traffic-dashboard-view.cjs');
const HOUR = 3600000, DAY = 24 * HOUR, PERIOD = 2 * HOUR;
const iso = value => new Date(value).toISOString();
const localDay = time => Math.floor((time + 8 * HOUR) / DAY) * DAY - 8 * HOUR;
const dayName = time => iso(time + 8 * HOUR).slice(0, 10);
const METRICS = ['requests', 'entryRequests', 'visitorEstimate', 'automated', 'clientErrors', 'serverErrors'];
const AI_METRICS = ['requests', 'httpSuccesses', 'invalidRequests', 'rateLimited', 'serverErrors', 'otherStatuses',
  'durationMsTotal', 'durationSamples', 'responseBytes', 'messageCountTotal', 'messageSamples', 'inputCharsTotal', 'inputSamples'];
const DEVICES = ['desktop', 'mobile', 'tablet'], SOURCES = ['internal', 'external', 'unknown'];

function aiBucket(trackExperiments = false) {
  return { requests: 0, httpSuccesses: 0, invalidRequests: 0, rateLimited: 0, serverErrors: 0, otherStatuses: 0,
    durationMsTotal: 0, durationSamples: 0, responseBytes: 0, messageCountTotal: 0, messageSamples: 0,
    inputCharsTotal: 0, inputSamples: 0, experiments: trackExperiments ? new Map() : null };
}
function bucket(trackAiExperiments = false) {
  return { requests: 0, entryRequests: 0, automated: 0, clientErrors: 0, serverErrors: 0,
    devices: { desktop: 0, mobile: 0, tablet: 0 }, sources: { internal: 0, external: 0, unknown: 0 },
    identities: new Set(), ai: aiBucket(trackAiExperiments) };
}
function addStatus(target, status) {
  target.requests++;
  if (status >= 400 && status < 500) target.clientErrors++;
  if (status >= 500) target.serverErrors++;
}
function add(target, record) {
  addStatus(target, record.status);
  if (record.automated) target.automated++;
  if (!record.entry) return;
  target.entryRequests++;
  target.identities.add(record.identity);
  target.devices[record.device]++;
  target.sources[record.source]++;
}
function addAi(target, record, experimentMap) {
  addStatus(target, record.status);
  const ai = target.ai;
  ai.requests++;
  if (record.status >= 200 && record.status < 300) {
    ai.httpSuccesses++;
    ai.durationMsTotal += record.durationMs;
    ai.durationSamples++;
    ai.responseBytes += record.bytes;
    if (record.messageCount !== null) { ai.messageCountTotal += record.messageCount; ai.messageSamples++; }
    if (record.inputChars !== null) { ai.inputCharsTotal += record.inputChars; ai.inputSamples++; }
    if (ai.experiments) {
      const title = experimentMap.get(record.experimentHash) || '未知实验';
      ai.experiments.set(title, (ai.experiments.get(title) || 0) + 1);
    }
  } else if (record.status === 400) ai.invalidRequests++;
  else if (record.status === 429) ai.rateLimited++;
  else if (record.status >= 500) ai.serverErrors++;
  else ai.otherStatuses++;
}
function aiCoverage(start, end, collectionStart) {
  return end <= collectionStart ? 'unavailable' : start < collectionStart ? 'partial' : 'recorded';
}
function finishAi(target, coverage) {
  const { experiments, ...values } = target;
  const result = { coverage, ...values };
  if (experiments) {
    result.experiments = [...experiments].map(([title, requests]) => ({ title, requests }))
      .sort((a, b) => b.requests - a.requests || a.title.localeCompare(b.title, 'zh-CN'))
      .slice(0, 8);
  }
  return result;
}
function finish(target, aiState) {
  const { identities, ai, ...values } = target;
  return { ...values, visitorEstimate: identities.size, ai: finishAi(ai, aiState) };
}

function createRolling({ now = Date.now(), collectionStart, aiCollectionStart, experimentMap = new Map() }) {
  const started = Date.parse(collectionStart);
  const aiStarted = Date.parse(aiCollectionStart);
  if (!Number.isFinite(now) || !Number.isFinite(started) || started > now) throw new Error('采集开始时间无效');
  if (!Number.isFinite(aiStarted) || aiStarted > now) throw new Error('AI 采集开始时间无效');
  if (!(experimentMap instanceof Map)) throw new Error('实验映射无效');
  const end = Math.floor(now / PERIOD) * PERIOD, start = end - DAY;
  const totals = bucket(true), hours = Array.from({ length: 24 }, () => bucket()), days = new Map();
  let earliestTraffic = Infinity, earliestAi = Infinity, invalid = 0;
  return {
    add(line) {
      let record;
      try { record = parseRecord(line); } catch { invalid++; return; } // Count malformed input; publishing fails closed below.
      if (!record || record.uri.startsWith('/admin/')) return;
      if (record.timestamp < started || record.timestamp >= end) return;
      earliestTraffic = Math.min(earliestTraffic, record.timestamp);
      const date = localDay(record.timestamp);
      if (!days.has(date)) days.set(date, bucket());
      add(days.get(date), record);
      if (record.timestamp < start) return;
      add(totals, record);
      add(hours[Math.floor((record.timestamp - start) / HOUR)], record);
    },
    addAi(line) {
      let record;
      try { record = parseAiRecord(line); } catch { invalid++; return; }
      if (!record || record.timestamp < aiStarted || record.timestamp >= end) return;
      earliestAi = Math.min(earliestAi, record.timestamp);
      const date = localDay(record.timestamp);
      if (!days.has(date)) days.set(date, bucket());
      addAi(days.get(date), record, experimentMap);
      if (record.timestamp < start) return;
      addAi(totals, record, experimentMap);
      addAi(hours[Math.floor((record.timestamp - start) / HOUR)], record, experimentMap);
    },
    finish() {
      if (invalid) throw new Error(`有 ${invalid} 行日志无法解析，保留上一份报告`);
      // A retained first day may be missing an earlier rotated segment. Never overwrite it as a complete day.
      const firstTrafficDay = Number.isFinite(earliestTraffic) ? localDay(earliestTraffic) : localDay(started);
      const archiveFrom = firstTrafficDay === localDay(started) ? firstTrafficDay : firstTrafficDay + DAY;
      const firstAiDay = Number.isFinite(earliestAi) ? localDay(earliestAi) : localDay(aiStarted);
      const aiArchiveFrom = firstAiDay === localDay(aiStarted) ? firstAiDay : firstAiDay + DAY;
      const daily = [];
      for (let day = Math.max(archiveFrom, localDay(end) - 399 * DAY); day + DAY <= end; day += DAY) {
        // Before AI collection there is no AI gap; after it starts, skip a possibly truncated retained log day.
        if (day + DAY > aiStarted && day < aiArchiveFrom) continue;
        daily.push({ day: dayName(day), start: iso(day), end: iso(day + DAY),
          partial: day < started, ...finish(days.get(day) || bucket(), aiCoverage(day, day + DAY, aiStarted)) });
      }
      return {
        schema: 3, site: 'lab.xingnian.net.cn', generatedAt: iso(now), collectionStart: iso(started), aiCollectionStart: iso(aiStarted),
        windowStart: iso(start), windowEnd: iso(end), nextUpdate: iso(end + PERIOD),
        partial: started > start, totals: finish(totals, aiCoverage(start, end, aiStarted)),
        hours: hours.map((hour, index) => ({ start: iso(start + index * HOUR), end: iso(start + (index + 1) * HOUR),
          coverage: start + (index + 1) * HOUR <= started ? 'unavailable' : start + index * HOUR < started ? 'partial' : 'recorded',
          ...finish(hour, aiCoverage(start + index * HOUR, start + (index + 1) * HOUR, aiStarted)) })),
        daily
      };
    }
  };
}

function rollingSummary(lines, options) {
  const accumulator = createRolling(options);
  for (const line of lines) accumulator.add(line);
  for (const line of options.aiLines || []) accumulator.addAi(line);
  return accumulator.finish();
}

function unavailableAi() {
  const { experiments, ...values } = aiBucket();
  return { coverage: 'unavailable', ...values };
}

function cleanAi(record) {
  if (!record || !['unavailable', 'partial', 'recorded'].includes(record.coverage)) throw new Error('历史 AI 覆盖状态无效');
  const result = { coverage: record.coverage };
  for (const field of AI_METRICS) {
    if (!Number.isSafeInteger(record[field]) || record[field] < 0) throw new Error('历史 AI 计数无效');
    result[field] = record[field];
  }
  return result;
}

function cleanDaily(record, schema) {
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
  result.ai = schema === 1 ? unavailableAi() : cleanAi(record.ai);
  return result;
}
function mergeHistory(previous, daily, cutoff) {
  if (!previous || ![1, 2].includes(previous.schema) || !Array.isArray(previous.days)) throw new Error('历史汇总文件无效');
  const entries = new Map();
  for (const record of previous.days) {
    const clean = cleanDaily(record, previous.schema);
    const day = Date.parse(clean.start);
    if (day >= localDay(cutoff) - 400 * DAY && Date.parse(clean.end) <= cutoff) entries.set(clean.day, clean);
  }
  for (const record of daily) {
    const clean = cleanDaily(record, 2);
    const day = Date.parse(clean.start);
    if (day >= localDay(cutoff) - 400 * DAY && Date.parse(clean.end) <= cutoff) entries.set(clean.day, clean);
  }
  return { schema: 2, days: [...entries.values()].sort((a, b) => a.day.localeCompare(b.day)) };
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

async function publish({ logDir, aiLogDir, manifestFile, stateDir, collectionStart, aiCollectionStart, now = Date.now() }) {
  if (!path.isAbsolute(stateDir) || !fs.lstatSync(stateDir).isDirectory()) throw new Error('汇总目录必须是已存在的普通目录');
  const www = path.join(stateDir, 'www');
  if (!fs.lstatSync(www).isDirectory()) throw new Error('网页目录必须是普通目录');
  const experimentMap = loadExperimentMap(manifestFile);
  const accumulator = createRolling({ now, collectionStart, aiCollectionStart, experimentMap });
  await visitLogDirectory(logDir, line => accumulator.add(line));
  await visitAiLogDirectory(aiLogDir, line => accumulator.addAi(line));
  const data = accumulator.finish();
  const historyFile = path.join(stateDir, 'history.json');
  let previous = { schema: 2, days: [] };
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
    if (!['--log-dir', '--ai-log-dir', '--manifest-file', '--state-dir', '--collection-start', '--ai-collection-start'].includes(args[i]) || !args[i + 1]) throw new Error('统计参数无效');
    options[args[i].slice(2)] = args[i + 1];
  }
  const required = ['log-dir', 'ai-log-dir', 'manifest-file', 'state-dir', 'collection-start', 'ai-collection-start'];
  if (required.some(key => !options[key])) throw new Error('统计参数无效');
  const data = await publish({ logDir: options['log-dir'], aiLogDir: options['ai-log-dir'], manifestFile: options['manifest-file'],
    stateDir: options['state-dir'], collectionStart: options['collection-start'], aiCollectionStart: options['ai-collection-start'] });
  console.log(`统计已更新：${data.windowStart} 至 ${data.windowEnd}；入口 ${data.totals.entryRequests}；访客估算 ${data.totals.visitorEstimate}；AI ${data.totals.ai.requests}`);
}
module.exports = { HOUR, DAY, PERIOD, createRolling, rollingSummary, mergeHistory, publish, atomicWrite };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error('统计更新失败：' + error.message); process.exitCode = 1; });
