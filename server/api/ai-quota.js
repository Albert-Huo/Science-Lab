'use strict';

const crypto = require('node:crypto');

const DAY = 86400000;
const SCOPES = ['ip_minute', 'ip_day', 'session_day', 'global_day'];

function result(scope, limit, remaining, resetMs, allowed) {
  return { scope, limit, remaining, retryAfter: Math.max(1, Math.ceil(resetMs / 1000)), allowed };
}

// The in-process store is for local development; capacity exhaustion fails closed.
class MemoryStore {
  constructor({ now = Date.now, maxEntries = 50000 } = {}) {
    this.now = now;
    this.maxEntries = maxEntries;
    this.counters = new Map();
    this.leases = new Map();
    this.sweep = this.counters.entries();
  }

  async connect() {}

  async reserve({ buckets, leaseId, leaseMs, concurrentMax }) {
    const now = this.now();
    for (let i = 0; i < 128; i++) {
      const next = this.sweep.next();
      if (next.done) { this.sweep = this.counters.entries(); break; }
      if (next.value[1].expires <= now) this.counters.delete(next.value[0]);
    }
    for (const [id, expires] of this.leases) if (expires <= now) this.leases.delete(id);
    if (this.leases.size >= concurrentMax) {
      return result('concurrency', concurrentMax, 0, Math.min(...this.leases.values()) - now, false);
    }
    const current = buckets.map(bucket => {
      let counter = this.counters.get(bucket.key);
      if (counter && counter.expires <= now) { this.counters.delete(bucket.key); counter = null; }
      return counter || { used: 0, expires: now + bucket.windowMs };
    });
    for (let i = 0; i < buckets.length; i++) {
      if (current[i].used >= buckets[i].limit) {
        return result(buckets[i].scope, buckets[i].limit, 0, current[i].expires - now, false);
      }
    }
    const newKeys = buckets.filter(bucket => !this.counters.has(bucket.key)).length;
    if (this.counters.size + newKeys > this.maxEntries) throw new Error('quota capacity unavailable');
    buckets.forEach((bucket, i) => {
      current[i].used++;
      this.counters.set(bucket.key, current[i]);
    });
    this.leases.set(leaseId, now + leaseMs);
    let selected = 2;
    for (const i of [1, 3]) {
      if (buckets[i].limit - current[i].used < buckets[selected].limit - current[selected].used) selected = i;
    }
    return result(buckets[selected].scope, buckets[selected].limit,
      buckets[selected].limit - current[selected].used, current[selected].expires - now, true);
  }

  async release(leaseKey, leaseId) { this.leases.delete(leaseId); }
  async close() { this.counters.clear(); this.leases.clear(); }
}

// Every check precedes every counter increment. One script covers all instances.
const RESERVE_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local concurrentMax = tonumber(ARGV[9])
local leaseMs = tonumber(ARGV[10])
redis.call('ZREMRANGEBYSCORE', KEYS[5], '-inf', now)
if redis.call('ZCARD', KEYS[5]) >= concurrentMax then
  local first = redis.call('ZRANGE', KEYS[5], 0, 0, 'WITHSCORES')
  return {0, 5, concurrentMax, 0, math.max(1, tonumber(first[2]) - now)}
end
local used = {}
local ttl = {}
for i = 1, 4 do
  used[i] = tonumber(redis.call('GET', KEYS[i]) or '0')
  ttl[i] = redis.call('PTTL', KEYS[i])
  if ttl[i] < 0 then ttl[i] = tonumber(ARGV[i + 4]) end
  if used[i] >= tonumber(ARGV[i]) then return {0, i, tonumber(ARGV[i]), 0, ttl[i]} end
end
for i = 1, 4 do
  local count = redis.call('INCR', KEYS[i])
  if count == 1 then redis.call('PEXPIRE', KEYS[i], ARGV[i + 4]) end
  used[i] = count
end
redis.call('ZADD', KEYS[5], now + leaseMs, ARGV[11])
local latest = redis.call('ZRANGE', KEYS[5], -1, -1, 'WITHSCORES')
redis.call('PEXPIRE', KEYS[5], math.max(1, tonumber(latest[2]) - now))
local selected = 3
for _, i in ipairs({2, 4}) do
  if tonumber(ARGV[i]) - used[i] < tonumber(ARGV[selected]) - used[selected] then selected = i end
end
return {1, selected, tonumber(ARGV[selected]), tonumber(ARGV[selected]) - used[selected], ttl[selected]}
`;

class RedisStore {
  constructor({ url, commandTimeoutMs = 2000 } = {}) {
    const { createClient } = require('redis');
    this.commandTimeoutMs = commandTimeoutMs;
    try {
      this.client = createClient({ url, disableOfflineQueue: true, commandsQueueMaxLength: 100,
        socket: { connectTimeout: commandTimeoutMs,
          reconnectStrategy: retries => Math.min(100 * (2 ** Math.min(retries, 4)), 1000) } });
    } catch {
      // URL parsing errors may attach the original credential-bearing URL as input.
      throw new Error('AI quota Redis configuration invalid');
    }
    this.lastWarning = 0;
    this.client.on('error', () => this.warn());
  }

  warn() {
    if (Date.now() - this.lastWarning > 30000) {
      this.lastWarning = Date.now();
      console.warn('[ai-quota] Redis unavailable');
    }
  }

  async bounded(operation) {
    let timer;
    try {
      return await Promise.race([operation, new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          if (this.client.isOpen) this.client.destroy();
          reject(new Error('quota operation timed out'));
        }, this.commandTimeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }

  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        if (!this.client.isOpen) await this.bounded(this.client.connect());
        await this.bounded(this.client.ping());
      } catch {
        if (this.client.isOpen) this.client.destroy();
        throw new Error('AI quota Redis unavailable');
      }
    })();
    try { return await this.connecting; }
    finally { this.connecting = null; }
  }

  async reserve({ buckets, leaseKey, leaseId, leaseMs, concurrentMax }) {
    if (!this.client.isOpen) await this.connect();
    if (!this.client.isReady) throw new Error('quota unavailable');
    const values = await this.bounded(this.client.eval(RESERVE_SCRIPT, {
      keys: [...buckets.map(bucket => bucket.key), leaseKey],
      arguments: [...buckets.map(bucket => String(bucket.limit)), ...buckets.map(bucket => String(bucket.windowMs)),
        String(concurrentMax), String(leaseMs), leaseId],
    }));
    return result([...SCOPES, 'concurrency'][Number(values[1]) - 1], Number(values[2]),
      Number(values[3]), Number(values[4]), Number(values[0]) === 1);
  }

  async release(leaseKey, leaseId) {
    if (!this.client.isReady) throw new Error('quota unavailable');
    await this.bounded(this.client.zRem(leaseKey, leaseId));
  }

  async close() { if (this.client.isOpen) this.client.destroy(); }
}

function createQuota({ minuteMax = 10, ipDayMax = 20, sessionDayMax = 20, globalDayMax = 500,
  concurrentMax = 10, timeoutMs = 120000, secret, redisUrl, production = false,
  namespace = 'science-lab:ai', store, now = Date.now } = {}) {
  for (const [name, value] of Object.entries({ minuteMax, ipDayMax, sessionDayMax, globalDayMax, concurrentMax, timeoutMs })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid AI quota ${name}`);
  }
  if (production && !redisUrl) throw new Error('AI quota requires Redis in production');
  if (production && (typeof secret !== 'string' || secret.length < 32)) {
    throw new Error('AI quota session secret must contain at least 32 characters in production');
  }
  if (production && store) throw new Error('Custom AI quota stores are development only');
  const signingKey = secret || crypto.randomBytes(32).toString('hex');
  const backend = store || (redisUrl ? new RedisStore({ url: redisUrl }) : new MemoryStore({ now }));
  const digest = value => crypto.createHmac('sha256', signingKey).update(value).digest('base64url');
  const prefix = `${namespace}:{quota}`;
  const leaseKey = `${prefix}:active`;

  function session(req, res) {
    const cookieName = req.secure ? '__Host-sl_ai' : 'sl_ai';
    const cookieHeader = String(req.headers?.cookie || '');
    const raw = cookieHeader.split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='));
    const token = raw ? raw.slice(cookieName.length + 1) : '';
    const parts = token.split('.');
    if (parts.length === 3 && /^[A-Za-z0-9_-]{43}$/.test(parts[0]) && /^\d{1,16}$/.test(parts[1]) &&
        /^[A-Za-z0-9_-]{43}$/.test(parts[2])) {
      const expires = Number(parts[1]);
      const expected = digest(`cookie:${parts[0]}.${parts[1]}`);
      if (expires > now() && expires <= now() + DAY &&
          crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]))) return parts[0];
    }
    const id = crypto.randomBytes(32).toString('base64url');
    const expires = now() + DAY;
    const payload = `${id}.${expires}`;
    const cookie = `${cookieName}=${payload}.${digest('cookie:' + payload)}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`;
    const existing = typeof res.getHeader === 'function' ? res.getHeader('Set-Cookie') : undefined;
    res.setHeader('Set-Cookie', existing ? [...(Array.isArray(existing) ? existing : [existing]), cookie] : cookie);
    return id;
  }

  function headers(res, quota) {
    res.setHeader('X-AI-Quota-Limit', String(quota.limit));
    res.setHeader('X-AI-Quota-Remaining', String(quota.remaining));
    res.setHeader('X-AI-Quota-Reset', String(Math.ceil(now() / 1000) + quota.retryAfter));
    res.setHeader('X-AI-Quota-Scope', quota.scope);
  }

  return {
    connect: () => backend.connect(),
    close: () => backend.close(),
    async reserve(req, res) {
      res.setHeader('Cache-Control', 'no-store');
      const id = session(req, res);
      const ipHash = digest('ip:' + (req.ip || req.socket?.remoteAddress || 'unknown'));
      const sessionHash = digest('session:' + id);
      const limits = [minuteMax, ipDayMax, sessionDayMax, globalDayMax];
      const identities = [ipHash, ipHash, sessionHash, 'all'];
      const buckets = SCOPES.map((scope, i) => ({ key: `${prefix}:${scope}:${identities[i]}`,
        scope, limit: limits[i], windowMs: i === 0 ? 60000 : DAY }));
      const leaseId = crypto.randomBytes(24).toString('base64url');
      let quota;
      try {
        quota = await backend.reserve({ buckets, leaseKey, leaseId, leaseMs: timeoutMs + 5000, concurrentMax });
      } catch {
        if (!res.destroyed) res.status(503).json({ error: 'quota_unavailable', message: 'AI 配额服务暂不可用，请稍后重试。' });
        return null;
      }
      if (!quota.allowed) {
        if (res.destroyed) return null;
        headers(res, quota);
        res.setHeader('Retry-After', String(quota.retryAfter));
        res.status(429).json({ error: 'rate_limited', scope: quota.scope,
          message: quota.scope === 'concurrency' ? 'AI 正忙，请稍后重试。' : 'AI 使用次数已达上限，请稍后重试。',
          retryAfter: quota.retryAfter });
        return null;
      }
      if (!res.destroyed) headers(res, quota);
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try { await backend.release(leaseKey, leaseId); }
        catch { console.warn('[ai-quota] Lease release unavailable; automatic expiry will reclaim it'); }
      };
    },
  };
}

module.exports = { createQuota, MemoryStore, RedisStore };
