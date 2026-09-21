'use strict';

const { createHash } = require('node:crypto');

const ACTIONS = new Set(['catalog_open', 'profile_open', 'experiment_previous', 'experiment_next']);
const SOURCES = new Set(['direct', 'internal', 'search', 'external']);
const HOUR_TTL_SECONDS = 48 * 60 * 60;
const DAY_TTL_SECONDS = 402 * 24 * 60 * 60;
const DEFAULT_NAMESPACE = 'science-lab:analytics:v1';

const RECORD_SCRIPT = `
local prefix = ARGV[1]
local event = ARGV[2]
local dimension = ARGV[3]
local hourTtl = tonumber(ARGV[4])
local dayTtl = tonumber(ARGV[5])
local clock = redis.call('TIME')
local now = tonumber(clock[1])
local hour = now - (now % 3600)
local shifted = now + 28800
local day = shifted - (shifted % 86400) - 28800
local roots = {prefix .. ':hour:' .. hour, prefix .. ':day:' .. day}
local ttls = {hourTtl, dayTtl}

for index, root in ipairs(roots) do
  local totals = root .. ':totals'
  redis.call('HINCRBY', totals, event, 1)
  redis.call('EXPIRE', totals, ttls[index])
  local suffix = event == 'page_view' and 'sources' or event == 'experiment_open' and 'experiments' or 'actions'
  local detail = root .. ':' .. suffix
  redis.call('HINCRBY', detail, dimension, 1)
  redis.call('EXPIRE', detail, ttls[index])
end

return {now, hour, day}
`;

function fail(code = 'invalid_event') {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function buildCatalog(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.experiments) || value.experiments.length < 1 || value.experiments.length > 1000) {
    fail('invalid_analytics_catalog');
  }
  const result = new Map();
  const paths = new Set();
  for (const item of value.experiments) {
    if (!item || typeof item.path !== 'string' || item.path.length < 1 || item.path.length > 300 || item.path.includes('\\') ||
        typeof item.title !== 'string' || item.title.length < 1 || item.title.length > 300 || paths.has(item.path)) {
      fail('invalid_analytics_catalog');
    }
    const id = createHash('sha256').update(item.path).digest('hex');
    if (result.has(id)) fail('invalid_analytics_catalog');
    paths.add(item.path);
    result.set(id, { title: item.title });
  }
  return result;
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function validateEvent(body, catalog) {
  if (!(catalog instanceof Map) || body?.v !== 1 || typeof body.event !== 'string') fail();
  if (body.event === 'page_view') {
    if (!exactKeys(body, ['event', 'page_id', 'source', 'v']) || body.page_id !== 'home' || !SOURCES.has(body.source)) fail();
    return { event: body.event, dimension: body.source };
  }
  if (body.event === 'experiment_open') {
    if (!exactKeys(body, ['event', 'experiment_id', 'v']) || typeof body.experiment_id !== 'string' ||
        !/^[a-f0-9]{64}$/.test(body.experiment_id) || !catalog.has(body.experiment_id)) fail();
    return { event: body.event, dimension: body.experiment_id };
  }
  if (body.event === 'key_action') {
    if (!exactKeys(body, ['action_id', 'event', 'page_id', 'v']) || body.page_id !== 'home' || !ACTIONS.has(body.action_id)) fail();
    return { event: body.event, dimension: body.action_id };
  }
  fail();
}

function validRedisUrl(value) {
  if (!value) return false;
  try {
    const endpoint = new URL(value);
    return ['redis:', 'rediss:'].includes(endpoint.protocol) && ['127.0.0.1', '[::1]'].includes(endpoint.hostname);
  } catch {
    return false;
  }
}

function createProductAnalytics({ redisUrl, catalog: sourceCatalog, createClient, namespace = DEFAULT_NAMESPACE,
  commandTimeoutMs = 1000, warn = message => console.warn(message) } = {}) {
  const catalog = buildCatalog(sourceCatalog);
  const configured = validRedisUrl(redisUrl) && typeof namespace === 'string' &&
    /^[a-z0-9:-]{1,128}$/.test(namespace) && Number.isInteger(commandTimeoutMs) && commandTimeoutMs > 0 && commandTimeoutMs <= 2000;
  let client;
  let warned = false;

  function unavailable() {
    if (!warned && configured) {
      warned = true;
      warn('[product-analytics] Redis unavailable');
    }
    return { ok: false, reason: 'unavailable' };
  }

  function makeClient() {
    if (typeof createClient === 'function') return createClient();
    return require('redis').createClient({
      url: redisUrl,
      disableOfflineQueue: true,
      commandsQueueMaxLength: 32,
      socket: { connectTimeout: commandTimeoutMs, reconnectStrategy: false },
    });
  }

  async function connect() {
    if (!configured) return false;
    if (client?.isOpen) return true;
    try {
      client = makeClient();
      client.on('error', () => {});
      await client.connect();
      return true;
    } catch {
      if (client?.isOpen) client.destroy();
      return false;
    }
  }

  async function record(body) {
    const event = validateEvent(body, catalog);
    if (!configured || !client?.isOpen) return unavailable();
    let timer;
    try {
      const values = await Promise.race([
        client.eval(RECORD_SCRIPT, { keys: [], arguments: [namespace, event.event, event.dimension,
          String(HOUR_TTL_SECONDS), String(DAY_TTL_SECONDS)] }),
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('analytics_timeout')), commandTimeoutMs); }),
      ]);
      if (!Array.isArray(values) || values.length !== 3 || !Number.isSafeInteger(Number(values[0])) || Number(values[0]) < 0) {
        throw new Error('invalid_redis_result');
      }
      return { ok: true, capturedAt: Number(values[0]) };
    } catch {
      if (client?.isOpen) client.destroy();
      return unavailable();
    } finally {
      clearTimeout(timer);
    }
  }

  async function close() {
    if (client?.isOpen) client.destroy();
  }

  return Object.freeze({ connect, record, close, catalog });
}

module.exports = { ACTIONS, SOURCES, RECORD_SCRIPT, HOUR_TTL_SECONDS, DAY_TTL_SECONDS,
  buildCatalog, validateEvent, createProductAnalytics };
