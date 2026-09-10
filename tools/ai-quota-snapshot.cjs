#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const DAY = 86400000;
const REASONS = new Set(['redis_not_configured', 'invalid_config', 'redis_unavailable',
  'redis_timeout', 'invalid_data', 'dependency_unavailable']);
const SNAPSHOT_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local used = redis.call('GET', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
local active = redis.call('ZCOUNT', KEYS[2], '(' .. now, '+inf')
return {now, used, ttl, active}
`;

function count(value) { return Number.isSafeInteger(value) && value >= 0; }
function limit(value) { return count(value) && value > 0; }
function iso(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Validate and whitelist a schema-1 public snapshot; unknown fields never pass through. */
function validateSnapshot(value) {
  const invalid = () => { throw new Error('Invalid quota snapshot'); };
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schema !== 1 ||
      !iso(value.capturedAt) || typeof value.available !== 'boolean') invalid();
  for (const field of ['globalLimit', 'concurrentLimit']) {
    if (value[field] !== null && !limit(value[field])) invalid();
  }
  if (value.available) {
    if (value.reason !== null || !limit(value.globalLimit) || !limit(value.concurrentLimit) ||
        !count(value.globalUsed) || !count(value.globalRemaining) || !count(value.activeRequests) ||
        value.globalRemaining !== Math.max(0, value.globalLimit - value.globalUsed)) invalid();
    if (value.globalResetAt === null) {
      if (value.globalUsed !== 0) invalid();
    } else if (!iso(value.globalResetAt) || Date.parse(value.globalResetAt) < Date.parse(value.capturedAt) ||
        Date.parse(value.globalResetAt) - Date.parse(value.capturedAt) > DAY) invalid();
  } else {
    if (!REASONS.has(value.reason)) invalid();
    for (const field of ['globalUsed', 'globalRemaining', 'globalResetAt', 'activeRequests']) {
      if (value[field] !== null) invalid();
    }
  }
  return { schema: 1, capturedAt: value.capturedAt, available: value.available, reason: value.reason,
    globalUsed: value.globalUsed, globalLimit: value.globalLimit, globalRemaining: value.globalRemaining,
    globalResetAt: value.globalResetAt, activeRequests: value.activeRequests, concurrentLimit: value.concurrentLimit };
}

function configuredLimit(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return limit(parsed) ? parsed : null;
}

/** Sample the quota store within one total deadline. No reservation, pruning or retries occur. */
async function readSnapshot({ env = process.env, namespace = 'science-lab:ai', createClient,
  deadlineMs = 2000, now = Date.now } = {}) {
  const globalLimit = configuredLimit(env.AI_GLOBAL_DAY_MAX, 500);
  const concurrentLimit = configuredLimit(env.AI_GLOBAL_CONCURRENT_MAX, 5);
  const unavailable = reason => validateSnapshot({ schema: 1, capturedAt: new Date(now()).toISOString(),
    available: false, reason, globalUsed: null, globalLimit, globalRemaining: null, globalResetAt: null,
    activeRequests: null, concurrentLimit });
  if (globalLimit === null || concurrentLimit === null || typeof namespace !== 'string' ||
      !namespace.length || namespace.length > 256 || /[\s{}\x00-\x1f]/.test(namespace) ||
      !limit(deadlineMs) || deadlineMs > 2000) return unavailable('invalid_config');
  if (!env.AI_REDIS_URL) return unavailable('redis_not_configured');
  if (!createClient) {
    try {
      const apiDir = env.SCIENCE_LAB_API_DIR || path.resolve(__dirname, '../server/api');
      if (!path.isAbsolute(apiDir)) return unavailable('invalid_config');
      createClient = createRequire(path.join(apiDir, 'package.json'))('redis').createClient;
    } catch { return unavailable('dependency_unavailable'); }
  }
  let client;
  let timer;
  let reason = 'redis_unavailable';
  try {
    client = createClient({ url: env.AI_REDIS_URL, disableOfflineQueue: true, commandsQueueMaxLength: 1,
      socket: { connectTimeout: deadlineMs, reconnectStrategy: false } });
    // The terminal result reports a fixed reason; Redis errors can contain connection credentials.
    client.on('error', () => { reason = 'redis_unavailable'; });
    const values = await Promise.race([
      (async () => {
        await client.connect();
        return client.eval(SNAPSHOT_SCRIPT, { keys: [`${namespace}:{quota}:global_day:all`, `${namespace}:{quota}:active`], arguments: [] });
      })(),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => { reason = 'redis_timeout'; reject(new Error('Quota snapshot deadline')); }, deadlineMs);
      }),
    ]);
    reason = 'invalid_data';
    if (!Array.isArray(values) || values.length !== 4) throw new Error('Invalid Redis sample');
    const [rawTime, rawUsed, rawTtl, rawActive] = values;
    const redisInteger = value => {
      if ((typeof value !== 'number' && typeof value !== 'string') ||
          (typeof value === 'string' && !/^-?\d{1,16}$/.test(value))) throw new Error('Invalid Redis integer');
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) throw new Error('Invalid Redis integer');
      return parsed;
    };
    const captured = redisInteger(rawTime);
    const ttl = redisInteger(rawTtl);
    const missing = rawUsed === false || rawUsed === null;
    const used = missing ? 0 : redisInteger(rawUsed);
    if (captured < 0 || (missing ? ttl !== -2 : ttl < 0 || ttl > DAY)) throw new Error('Invalid Redis TTL');
    return validateSnapshot({ schema: 1, capturedAt: new Date(captured).toISOString(), available: true,
      reason: null, globalUsed: used, globalLimit, globalRemaining: Math.max(0, globalLimit - used),
      globalResetAt: missing ? null : new Date(captured + ttl).toISOString(),
      activeRequests: redisInteger(rawActive), concurrentLimit });
  } catch { return unavailable(reason); }
  finally {
    clearTimeout(timer);
    if (client?.isOpen) {
      try { client.destroy(); }
      catch { console.warn('[ai-quota-snapshot] Redis cleanup unavailable'); }
    }
  }
}

/** Atomically publish validated public data under an existing private report state directory. */
function publishSnapshot({ stateDir, snapshot }) {
  const clean = validateSnapshot(snapshot);
  if (!path.isAbsolute(stateDir) || !fs.lstatSync(stateDir).isDirectory()) throw new Error('State must be a regular directory');
  const www = path.join(stateDir, 'www');
  if (!fs.lstatSync(www).isDirectory()) throw new Error('Web root must be a regular directory');
  const target = path.join(www, 'quota.json');
  try {
    if (!fs.lstatSync(target).isFile()) throw new Error('Snapshot target must be a regular file');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(www, '.quota.json.' + crypto.randomUUID());
  let fd;
  let created = false;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    fs.writeFileSync(fd, JSON.stringify(clean) + '\n');
    fs.fchmodSync(fd, 0o644);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, target);
    created = false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (created) fs.unlinkSync(temporary);
  }
  return clean;
}

async function main(args, env = process.env) {
  if (args.length !== 2 || args[0] !== '--state-dir' || !args[1]) {
    throw new Error('Usage: ai-quota-snapshot.cjs --state-dir /absolute/report-state');
  }
  return publishSnapshot({ stateDir: args[1], snapshot: await readSnapshot({ env }) });
}

if (require.main === module) main(process.argv.slice(2)).catch(() => {
  console.error('[ai-quota-snapshot] Snapshot publication failed');
  process.exitCode = 1;
});

module.exports = { validateSnapshot, readSnapshot, publishSnapshot, main };
