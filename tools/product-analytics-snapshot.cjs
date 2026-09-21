#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const HOUR = 3600;
const DAY = 86400;
const MAX_DAYS = 400;
const MAX_BYTES = 2 * 1024 * 1024;
const NAMESPACE = 'science-lab:analytics:v1';
const SOURCES = ['direct', 'internal', 'search', 'external'];
const ACTIONS = ['catalog_open', 'profile_open', 'experiment_previous', 'experiment_next'];
const TOTAL_FIELDS = ['page_view', 'experiment_open', 'key_action'];
const COVERAGE = new Set(['unavailable', 'partial', 'recorded']);
const REASONS = new Set(['redis_not_configured', 'invalid_config', 'redis_unavailable', 'redis_timeout', 'invalid_data', 'dependency_unavailable']);
const TIME_SCRIPT = "local t=redis.call('TIME') return tonumber(t[1])";

function privacyState() {
  return { mode: 'identity_free', cookie: false, fingerprint: false, crossPage: false,
    crossDay: false, uv: 'not_collected', sessions: 'not_collected', completion: 'not_connected' };
}

function count(value) { return Number.isSafeInteger(value) && value >= 0; }
function iso(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}
function invalid() { throw new Error('Invalid product analytics snapshot'); }

function validateSnapshot(value) {
  const top = ['schema', 'capturedAt', 'collectionStart', 'available', 'reason', 'privacy', 'totals', 'hours', 'days'];
  if (!exact(value, top) || value.schema !== 1 || !iso(value.capturedAt) || typeof value.available !== 'boolean' ||
      !exact(value.privacy, ['mode', 'cookie', 'fingerprint', 'crossPage', 'crossDay', 'uv', 'sessions', 'completion']) ||
      JSON.stringify(value.privacy) !== JSON.stringify(privacyState()) || !Array.isArray(value.hours) || !Array.isArray(value.days)) invalid();
  if (!value.available) {
    if (!REASONS.has(value.reason) || (value.collectionStart !== null && !iso(value.collectionStart)) ||
        value.totals !== null || value.hours.length || value.days.length) invalid();
    return value;
  }
  if (value.reason !== null || !iso(value.collectionStart) || value.hours.length !== 24 || value.days.length > MAX_DAYS ||
      !exact(value.totals, ['pageViews', 'experimentOpens', 'keyActions', 'sources', 'actions', 'topExperiments'])) invalid();
  for (const field of ['pageViews', 'experimentOpens', 'keyActions']) if (!count(value.totals[field])) invalid();
  if (!exact(value.totals.sources, SOURCES) || SOURCES.some(key => !count(value.totals.sources[key])) ||
      !exact(value.totals.actions, ACTIONS) || ACTIONS.some(key => !count(value.totals.actions[key])) ||
      !Array.isArray(value.totals.topExperiments) || value.totals.topExperiments.length > 10) invalid();
  const seen = new Set();
  for (const item of value.totals.topExperiments) {
    if (!exact(item, ['id', 'title', 'count']) || typeof item.id !== 'string' || !/^[a-f0-9]{64}$/.test(item.id) ||
        seen.has(item.id) || typeof item.title !== 'string' || item.title.length < 1 || item.title.length > 300 ||
        !count(item.count) || item.count < 1) invalid();
    seen.add(item.id);
  }
  for (const item of value.hours) {
    if (!exact(item, ['start', 'end', 'coverage', 'pageViews', 'experimentOpens', 'keyActions']) ||
        !iso(item.start) || !iso(item.end) || Date.parse(item.end) - Date.parse(item.start) !== HOUR * 1000 ||
        !COVERAGE.has(item.coverage) || !count(item.pageViews) || !count(item.experimentOpens) || !count(item.keyActions)) invalid();
  }
  for (const item of value.days) {
    if (!exact(item, ['day', 'coverage', 'pageViews', 'experimentOpens', 'keyActions']) ||
        typeof item.day !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(item.day) || !COVERAGE.has(item.coverage) ||
        !count(item.pageViews) || !count(item.experimentOpens) || !count(item.keyActions)) invalid();
  }
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) invalid();
  return value;
}

function unavailable(reason, capturedAt, collectionStart = null) {
  return validateSnapshot({ schema: 1, capturedAt: new Date(capturedAt).toISOString(), collectionStart,
    available: false, reason, privacy: privacyState(), totals: null, hours: [], days: [] });
}

function validRedisUrl(value) {
  try {
    const endpoint = new URL(value);
    return ['redis:', 'rediss:'].includes(endpoint.protocol) && ['127.0.0.1', '[::1]'].includes(endpoint.hostname);
  } catch { return false; }
}

function catalogMap(catalog) {
  if (!catalog || catalog.version !== 1 || !Array.isArray(catalog.experiments) || catalog.experiments.length < 1 || catalog.experiments.length > 1000) {
    throw new Error('Invalid analytics catalog');
  }
  const result = new Map();
  for (const item of catalog.experiments) {
    if (!item || typeof item.path !== 'string' || item.path.length < 1 || item.path.length > 300 ||
        typeof item.title !== 'string' || item.title.length < 1 || item.title.length > 300) throw new Error('Invalid analytics catalog');
    const id = crypto.createHash('sha256').update(item.path).digest('hex');
    if (result.has(id)) throw new Error('Invalid analytics catalog');
    result.set(id, item.title);
  }
  return result;
}

function parseHash(value, allowed, limit = allowed.length) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > limit) throw new Error('Invalid Redis analytics data');
  const result = Object.fromEntries(allowed.map(key => [key, 0]));
  for (const [key, raw] of Object.entries(value)) {
    if (!allowed.includes(key) || typeof raw !== 'string' || !/^\d{1,16}$/.test(raw)) throw new Error('Invalid Redis analytics data');
    const parsed = Number(raw);
    if (!count(parsed)) throw new Error('Invalid Redis analytics data');
    result[key] = parsed;
  }
  return result;
}

function parseExperiments(value, catalog) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 1000) throw new Error('Invalid Redis analytics data');
  const result = new Map();
  for (const [id, raw] of Object.entries(value)) {
    if (!/^[a-f0-9]{64}$/.test(id) || !catalog.has(id) || typeof raw !== 'string' || !/^\d{1,16}$/.test(raw)) {
      throw new Error('Invalid Redis analytics data');
    }
    const parsed = Number(raw);
    if (!count(parsed)) throw new Error('Invalid Redis analytics data');
    result.set(id, parsed);
  }
  return result;
}

function coverage(startSeconds, endSeconds, collectionStartMs) {
  const start = startSeconds * 1000, end = endSeconds * 1000;
  return end <= collectionStartMs ? 'unavailable' : start < collectionStartMs ? 'partial' : 'recorded';
}

function dayLabel(epochSeconds) {
  return new Date((epochSeconds + 8 * HOUR) * 1000).toISOString().slice(0, 10);
}

async function readSnapshot({ env = process.env, catalog, createClient, deadlineMs = 2000, now = Date.now } = {}) {
  const localNow = now();
  const redisUrl = env.ANALYTICS_REDIS_URL;
  const collectionStart = env.ANALYTICS_COLLECTION_START;
  if (!redisUrl) return unavailable('redis_not_configured', localNow, iso(collectionStart) ? collectionStart : null);
  if (!validRedisUrl(redisUrl) || !iso(collectionStart) || !Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 2000) {
    return unavailable('invalid_config', localNow, iso(collectionStart) ? collectionStart : null);
  }
  let trusted;
  try { trusted = catalogMap(catalog); }
  catch { return unavailable('invalid_config', localNow, collectionStart); }
  if (!createClient) {
    try {
      const apiDir = env.SCIENCE_LAB_API_DIR || path.resolve(__dirname, '../server/api');
      if (!path.isAbsolute(apiDir)) return unavailable('invalid_config', localNow, collectionStart);
      createClient = createRequire(path.join(apiDir, 'package.json'))('redis').createClient;
    } catch { return unavailable('dependency_unavailable', localNow, collectionStart); }
  }
  let client;
  let timer;
  let reason = 'redis_unavailable';
  try {
    client = createClient({ url: redisUrl, disableOfflineQueue: true, commandsQueueMaxLength: 600,
      socket: { connectTimeout: deadlineMs, reconnectStrategy: false } });
    client.on('error', () => {});
    const snapshot = await Promise.race([
      (async () => {
        await client.connect();
        const rawNow = await client.eval(TIME_SCRIPT, { keys: [], arguments: [] });
        const current = Number(rawNow);
        if (!Number.isSafeInteger(current) || current < 0) throw new Error('Invalid Redis time');
        const hourEnd = current - (current % HOUR) + HOUR;
        const hourStarts = Array.from({ length: 24 }, (_, index) => hourEnd - (24 - index) * HOUR);
        const shifted = current + 8 * HOUR;
        const currentDay = shifted - (shifted % DAY) - 8 * HOUR;
        const dayStarts = Array.from({ length: MAX_DAYS }, (_, index) => currentDay - (MAX_DAYS - 1 - index) * DAY);
        const hourRows = await Promise.all(hourStarts.map(async start => {
          const root = `${NAMESPACE}:hour:${start}`;
          const [totals, sources, actions, experiments] = await Promise.all([
            client.hGetAll(root + ':totals'), client.hGetAll(root + ':sources'),
            client.hGetAll(root + ':actions'), client.hGetAll(root + ':experiments'),
          ]);
          return { start, totals: parseHash(totals, TOTAL_FIELDS), sources: parseHash(sources, SOURCES),
            actions: parseHash(actions, ACTIONS), experiments: parseExperiments(experiments, trusted) };
        }));
        const dayRows = await Promise.all(dayStarts.map(async start => ({ start,
          totals: parseHash(await client.hGetAll(`${NAMESPACE}:day:${start}:totals`), TOTAL_FIELDS) })));
        const collectionStartMs = Date.parse(collectionStart);
        const experimentCounts = new Map();
        const totals = { pageViews: 0, experimentOpens: 0, keyActions: 0,
          sources: Object.fromEntries(SOURCES.map(key => [key, 0])),
          actions: Object.fromEntries(ACTIONS.map(key => [key, 0])), topExperiments: [] };
        const hours = hourRows.map(row => {
          totals.pageViews += row.totals.page_view;
          totals.experimentOpens += row.totals.experiment_open;
          totals.keyActions += row.totals.key_action;
          for (const key of SOURCES) totals.sources[key] += row.sources[key];
          for (const key of ACTIONS) totals.actions[key] += row.actions[key];
          for (const [id, value] of row.experiments) experimentCounts.set(id, (experimentCounts.get(id) || 0) + value);
          return { start: new Date(row.start * 1000).toISOString(), end: new Date((row.start + HOUR) * 1000).toISOString(),
            coverage: coverage(row.start, row.start + HOUR, collectionStartMs), pageViews: row.totals.page_view,
            experimentOpens: row.totals.experiment_open, keyActions: row.totals.key_action };
        });
        totals.topExperiments = [...experimentCounts].filter(([, value]) => value > 0)
          .sort(([leftId, left], [rightId, right]) => right - left || leftId.localeCompare(rightId)).slice(0, 10)
          .map(([id, value]) => ({ id, title: trusted.get(id), count: value }));
        const days = dayRows.map(row => ({ day: dayLabel(row.start), coverage: coverage(row.start, row.start + DAY, collectionStartMs),
          pageViews: row.totals.page_view, experimentOpens: row.totals.experiment_open, keyActions: row.totals.key_action }));
        return validateSnapshot({ schema: 1, capturedAt: new Date(current * 1000).toISOString(), collectionStart,
          available: true, reason: null, privacy: privacyState(), totals, hours, days });
      })(),
      new Promise((resolve, reject) => { timer = setTimeout(() => { reason = 'redis_timeout'; reject(new Error('Snapshot timeout')); }, deadlineMs); }),
    ]);
    return snapshot;
  } catch (error) {
    if (reason !== 'redis_timeout' && client?.isOpen) reason = 'invalid_data';
    return unavailable(reason, localNow, collectionStart);
  } finally {
    clearTimeout(timer);
    if (client?.isOpen) client.destroy();
  }
}

function publishSnapshot({ stateDir, snapshot }) {
  const clean = validateSnapshot(snapshot);
  if (!path.isAbsolute(stateDir) || !fs.lstatSync(stateDir).isDirectory()) throw new Error('State must be a regular directory');
  const www = path.join(stateDir, 'www');
  if (!fs.lstatSync(www).isDirectory()) throw new Error('Web root must be a regular directory');
  const target = path.join(www, 'analytics.json');
  try { if (!fs.lstatSync(target).isFile()) throw new Error('Snapshot target must be a regular file'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(www, '.analytics.json.' + crypto.randomUUID());
  let fd;
  let created = false;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600); created = true;
    fs.writeFileSync(fd, JSON.stringify(clean) + '\n');
    fs.fchmodSync(fd, 0o644); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, target); created = false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (created) fs.unlinkSync(temporary);
  }
  return clean;
}

async function main(args, env = process.env) {
  if (args.length !== 2 || args[0] !== '--state-dir' || !args[1]) {
    throw new Error('Usage: product-analytics-snapshot.cjs --state-dir /absolute/report-state');
  }
  const apiDir = env.SCIENCE_LAB_API_DIR || path.resolve(__dirname, '../server/api');
  const catalog = JSON.parse(fs.readFileSync(path.join(apiDir, 'ai-context.json'), 'utf8'));
  const snapshot = await readSnapshot({ env, catalog });
  const target = path.join(args[1], 'www', 'analytics.json');
  if (!snapshot.available && fs.existsSync(target)) {
    validateSnapshot(JSON.parse(fs.readFileSync(target, 'utf8')));
    throw new Error('Product analytics source unavailable; previous snapshot preserved');
  }
  return publishSnapshot({ stateDir: args[1], snapshot });
}

if (require.main === module) main(process.argv.slice(2)).catch(() => {
  console.error('[product-analytics-snapshot] Snapshot publication failed');
  process.exitCode = 1;
});

module.exports = { readSnapshot, publishSnapshot, validateSnapshot, privacyState, main, NAMESPACE, TIME_SCRIPT };
