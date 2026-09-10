#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { visitMatchingLogs } = require('./traffic-report.cjs');

const AI_LOG_NAME = /^science-lab-ai-access\.log(?:-\d{8}(?:\.gz)?)?$/;
const HASH = /^[a-f0-9]{64}$/;
const DECIMAL = /^\d+(?:\.\d+)?$/;
const FIELDS = ['bytes', 'duration', 'experiment', 'inputChars', 'messages', 'status', 'time'];
const V2_FIELDS = [...FIELDS, 'quotaScope', 'upstreamStatus'].sort();
const QUOTA_SCOPES = ['ip_minute', 'ip_day', 'session_day', 'global_day', 'concurrency'];
const MANIFEST_BYTES_MAX = 1024 * 1024;
const MANIFEST_ITEMS_MAX = 1000;
const missing = value => value === '' || value === '-';

function integer(value, maximum) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number <= maximum ? number : null;
}

function parseIsoTime(value) {
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return NaN;
  const year = +match[1], month = +match[2] - 1, day = +match[3], hour = +match[4], minute = +match[5], second = +match[6];
  const zoneHour = +(match[8] || 0), zoneMinute = +(match[9] || 0);
  if (hour > 23 || minute > 59 || second > 59 || zoneHour > 23 || zoneMinute > 59) return NaN;
  const local = Date.UTC(year, month, day, hour, minute, second);
  const check = new Date(local);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== day) return NaN;
  const direction = match[7] === '-' ? -1 : 1;
  return local - direction * (zoneHour * 60 + zoneMinute) * 60000;
}

function parseAiRecord(line) {
  if (!line.trim()) return null;
  const value = JSON.parse(line);
  const fields = value && Object.keys(value).sort().join('\n');
  const v2 = fields === V2_FIELDS.join('\n');
  if (!value || Array.isArray(value) || !v2 && fields !== FIELDS.join('\n')) {
    throw new Error('AI 日志字段无效');
  }
  if (v2 && (typeof value.quotaScope !== 'string' || !['', '-', ...QUOTA_SCOPES].includes(value.quotaScope) ||
      typeof value.upstreamStatus !== 'string' || value.upstreamStatus.length > 100 ||
      !/^(?:-|[1-5]\d\d(?:[, :] +[1-5]\d\d)*)$/.test(value.upstreamStatus))) throw new Error('AI 日志来源字段无效');
  const timestamp = parseIsoTime(value.time);
  const status = integer(value.status, 599);
  const bytes = integer(value.bytes, Number.MAX_SAFE_INTEGER);
  const messageCount = missing(value.messages) ? null : integer(value.messages, 20);
  const inputChars = missing(value.inputChars) ? null : integer(value.inputChars, 80000);
  const duration = typeof value.duration === 'string' && DECIMAL.test(value.duration) ? Number(value.duration) : NaN;
  if (!Number.isFinite(timestamp) || status === null || status < 100 || bytes === null ||
      !Number.isFinite(duration) || duration < 0 || duration > 86400 ||
      (typeof value.experiment !== 'string' || !missing(value.experiment) && !HASH.test(value.experiment)) ||
      messageCount === null && !missing(value.messages) || inputChars === null && !missing(value.inputChars)) {
    throw new Error('AI 日志数值无效');
  }
  return {
    timestamp,
    status,
    durationMs: Math.round(duration * 1000),
    bytes,
    experimentHash: missing(value.experiment) ? null : value.experiment,
    messageCount,
    inputChars,
    ...(status === 429 ? { limitReason: !v2 ? 'unknown' : value.upstreamStatus === '-' ? 'nginx' :
      QUOTA_SCOPES.includes(value.quotaScope) ? value.quotaScope : 'unknown' } : {}),
  };
}

function loadExperimentMap(manifestFile) {
  const stat = fs.lstatSync(manifestFile);
  if (!stat.isFile()) throw new Error('实验清单必须是普通文件');
  if (stat.size > MANIFEST_BYTES_MAX) throw new Error('实验清单过大');
  let records;
  try { records = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); }
  catch (error) { throw new Error('实验清单格式无效', { cause: error }); }
  if (!Array.isArray(records) || records.length > MANIFEST_ITEMS_MAX) throw new Error('实验清单格式无效');
  const result = new Map();
  for (const record of records) {
    if (!record || Array.isArray(record) || typeof record.path !== 'string' || !record.path || record.path.length > 300 ||
        typeof record.title !== 'string' || !record.title || record.title.length > 300) {
      throw new Error('实验清单条目无效');
    }
    const hash = crypto.createHash('sha256').update(record.path).digest('hex');
    if (result.has(hash) && result.get(hash) !== record.title) throw new Error('实验清单存在冲突');
    result.set(hash, record.title);
  }
  return result;
}

function visitAiLogDirectory(directory, visit) {
  return visitMatchingLogs(directory, AI_LOG_NAME, '未找到匿名 AI 日志', visit);
}

module.exports = { parseAiRecord, loadExperimentMap, visitAiLogDirectory, QUOTA_SCOPES };
