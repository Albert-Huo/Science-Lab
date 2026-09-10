#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { visitMatchingLogs } = require('./traffic-report.cjs');

const AI_LOG_NAME = /^science-lab-ai-access\.log(?:-\d{8}(?:\.gz)?)?$/;
const HASH = /^[a-f0-9]{64}$/;
const DECIMAL = /^\d+(?:\.\d+)?$/;
const FIELDS = ['bytes', 'duration', 'experiment', 'inputChars', 'messages', 'status', 'time'];
const MANIFEST_BYTES_MAX = 1024 * 1024;
const MANIFEST_ITEMS_MAX = 1000;

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
  if (!value || Array.isArray(value) || Object.keys(value).sort().join('\n') !== FIELDS.join('\n')) {
    throw new Error('AI 日志字段无效');
  }
  const timestamp = parseIsoTime(value.time);
  const status = integer(value.status, 599);
  const bytes = integer(value.bytes, Number.MAX_SAFE_INTEGER);
  const messageCount = value.messages === '' ? null : integer(value.messages, 20);
  const inputChars = value.inputChars === '' ? null : integer(value.inputChars, 80000);
  const duration = typeof value.duration === 'string' && DECIMAL.test(value.duration) ? Number(value.duration) : NaN;
  if (!Number.isFinite(timestamp) || status === null || status < 100 || bytes === null ||
      !Number.isFinite(duration) || duration < 0 || duration > 86400 ||
      (typeof value.experiment !== 'string' || value.experiment !== '' && !HASH.test(value.experiment)) ||
      messageCount === null && value.messages !== '' || inputChars === null && value.inputChars !== '') {
    throw new Error('AI 日志数值无效');
  }
  return {
    timestamp,
    status,
    durationMs: Math.round(duration * 1000),
    bytes,
    experimentHash: value.experiment || null,
    messageCount,
    inputChars,
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

module.exports = { parseAiRecord, loadExperimentMap, visitAiLogDirectory };
