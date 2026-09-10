'use strict';

const { visitMatchingLogs } = require('./traffic-report.cjs');
const { QUOTA_SCOPES } = require('./traffic-ai-report.cjs');
const OUTCOMES = ['completed', 'client_aborted', 'upstream_timeout', 'upstream_error', 'stream_incomplete',
  'invalid_request', 'rate_limited', 'quota_unavailable', 'not_configured', 'internal_error'];
const FIELDS = ['version', 'metricVersion', 'time', 'outcome', 'scope', 'experiment', 'status', 'messages',
  'inputChars', 'promptChars', 'conversationChars', 'durationMs', 'firstTokenMs'].sort();
const METRICS = ['requests', 'durationMsTotal', 'firstTokenMsTotal', 'firstTokenSamples',
  'promptCharsTotal', 'conversationCharsTotal', 'inputSamples'];
const counts = keys => Object.fromEntries(keys.map(key => [key, 0]));
const integer = value => Number.isSafeInteger(value) && value >= 0;

function parseAiEvent(line) {
  if (!line.trim()) return null;
  const value = JSON.parse(line);
  if (!value || Array.isArray(value) || Object.keys(value).sort().join('\n') !== FIELDS.join('\n')) throw new Error('AI 终态日志字段无效');
  const timestamp = Date.parse(value.time);
  if (value.version !== 1 || value.metricVersion !== 2 || typeof value.time !== 'string' ||
      !Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value.time ||
      !OUTCOMES.includes(value.outcome) || !['', ...QUOTA_SCOPES].includes(value.scope) ||
      typeof value.experiment !== 'string' || value.experiment !== '' && !/^[a-f0-9]{64}$/.test(value.experiment) ||
      value.status !== null && (!integer(value.status) || value.status < 100 || value.status > 599) || !integer(value.durationMs) ||
      ['messages', 'inputChars', 'promptChars', 'conversationChars', 'firstTokenMs'].some(key => value[key] !== null && !integer(value[key]))) {
    throw new Error('AI 终态日志数值无效');
  }
  const { time, experiment, version, ...metrics } = value;
  return { timestamp, ...metrics };
}

function observationBucket(coverage = 'unavailable') {
  return { coverage, metricVersion: 2, ...counts(METRICS), outcomes: counts(OUTCOMES), scopes: counts(QUOTA_SCOPES) };
}

function addObservation(target, record) {
  target.requests++;
  target.outcomes[record.outcome]++;
  if (record.scope) target.scopes[record.scope]++;
  target.durationMsTotal += record.durationMs;
  if (record.firstTokenMs !== null) { target.firstTokenSamples++; target.firstTokenMsTotal += record.firstTokenMs; }
  if (record.promptChars !== null && record.conversationChars !== null) {
    target.inputSamples++;
    target.promptCharsTotal += record.promptChars;
    target.conversationCharsTotal += record.conversationChars;
  }
}

function cleanObservation(value) {
  if (value === undefined) return observationBucket();
  if (!value || value.metricVersion !== 2 || !['unavailable', 'partial', 'recorded'].includes(value.coverage)) throw new Error('历史 AI 终态覆盖状态无效');
  const result = observationBucket(value.coverage);
  for (const key of METRICS) {
    if (!integer(value[key])) throw new Error('历史 AI 终态计数无效');
    result[key] = value[key];
  }
  for (const [group, keys] of [['outcomes', OUTCOMES], ['scopes', QUOTA_SCOPES]]) for (const key of keys) {
    if (!integer(value[group]?.[key])) throw new Error('历史 AI 终态分类无效');
    result[group][key] = value[group][key];
  }
  if (Object.values(result.outcomes).reduce((sum, number) => sum + number, 0) !== result.requests ||
      Object.values(result.scopes).reduce((sum, number) => sum + number, 0) > result.requests ||
      result.firstTokenSamples > result.requests || result.inputSamples > result.requests) throw new Error('历史 AI 终态计数不一致');
  return result;
}

function visitAiEventLogDirectory(directory, visit) {
  return visitMatchingLogs(directory, /^ai-events\.log(?:-\d{8}(?:\.gz)?)?$/, '未找到 AI 终态日志', visit);
}

module.exports = { OUTCOMES, parseAiEvent, visitAiEventLogDirectory, observationBucket, addObservation, cleanObservation };
