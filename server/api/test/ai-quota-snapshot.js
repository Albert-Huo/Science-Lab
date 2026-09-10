'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { test } = require('node:test');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');

const moduleFile = path.resolve(__dirname, '../../../tools/ai-quota-snapshot.cjs');
const timestamp = 1789034400000;
const iso = value => new Date(value).toISOString();
const env = { AI_REDIS_URL: 'redis://127.0.0.1:6379', AI_GLOBAL_DAY_MAX: '500', AI_GLOBAL_CONCURRENT_MAX: '5' };
function api() {
  assert.ok(fs.existsSync(moduleFile), 'read-only quota snapshot implementation must exist');
  return require(moduleFile);
}
function fakeClient(values, options = {}) {
  return { isOpen: false, on() {}, async connect() { this.isOpen = true; },
    async eval(script, args) { this.script = script; this.args = args; return values; },
    destroy() { this.isOpen = false; this.closed = true; }, ...options };
}
function available() {
  return { schema: 1, capturedAt: iso(timestamp), available: true, reason: null,
    globalUsed: 7, globalLimit: 500, globalRemaining: 493, globalResetAt: iso(timestamp + 60000),
    activeRequests: 2, concurrentLimit: 5 };
}

test('Redis sample uses one read-only script, namespace, server time and rolling TTL', async () => {
  const client = fakeClient([String(timestamp), '7', 60000, 2]);
  let connectionOptions;
  const result = await api().readSnapshot({ env, namespace: 'test-space', now: () => 0,
    createClient(options) { connectionOptions = options; return client; } });
  assert.deepEqual(result, available());
  assert.deepEqual(client.args, { keys: ['test-space:{quota}:global_day:all', 'test-space:{quota}:active'], arguments: [] });
  const commands = [...client.script.matchAll(/redis\.call\('([A-Z]+)'/g)].map(match => match[1]);
  assert.deepEqual(commands, ['TIME', 'GET', 'PTTL', 'ZCOUNT']);
  assert.match(client.script, /'\('\s*\.\.\s*now/);
  assert.equal(connectionOptions.socket.reconnectStrategy, false);
  assert.equal(connectionOptions.disableOfflineQueue, true);
  assert.equal(connectionOptions.socket.connectTimeout, 2000);
  assert.equal(client.closed, true);
});

test('missing global counter is verified zero with unknown reset; exhausted remaining clamps to zero', async () => {
  const missing = await api().readSnapshot({ env, createClient: () => fakeClient([timestamp, false, -2, 0]) });
  assert.equal(missing.globalUsed, 0);
  assert.equal(missing.globalRemaining, 500);
  assert.equal(missing.globalResetAt, null);
  const exhausted = await api().readSnapshot({ env, createClient: () => fakeClient([timestamp, '501', 10, 6]) });
  assert.equal(exhausted.globalRemaining, 0);
  assert.equal(exhausted.activeRequests, 6);
});

test('unconfigured or invalid configuration never fabricates actual usage', async () => {
  for (const [config, reason, globalLimit, concurrentLimit] of [
    [{}, 'redis_not_configured', 500, 5],
    [{ ...env, AI_GLOBAL_DAY_MAX: '-5' }, 'invalid_config', null, 5],
    [{ ...env, AI_GLOBAL_CONCURRENT_MAX: 'Infinity' }, 'invalid_config', 500, null],
  ]) {
    const result = await api().readSnapshot({ env: config, now: () => timestamp,
      createClient() { assert.fail('invalid configuration must not connect'); } });
    assert.equal(result.available, false);
    assert.equal(result.reason, reason);
    assert.equal(result.globalLimit, globalLimit);
    assert.equal(result.concurrentLimit, concurrentLimit);
    for (const field of ['globalUsed', 'globalRemaining', 'globalResetAt', 'activeRequests']) assert.equal(result[field], null);
  }
});

test('collector rejects non-loopback Redis even without a systemd IP firewall', async () => {
  for (const url of ['redis://example.org:6379', 'redis://192.0.2.10:6379', 'https://127.0.0.1:6379', 'not-a-url']) {
    const result = await api().readSnapshot({ env: { ...env, AI_REDIS_URL: url }, createClient() { assert.fail('remote Redis must not connect'); } });
    assert.equal(result.reason, 'invalid_config');
  }
});

test('Redis failures and total deadline are bounded, sanitized and close the client', async () => {
  const failed = fakeClient(null, { async connect() { throw new Error('redis://secret:password@private-host'); } });
  const result = await api().readSnapshot({ env, now: () => timestamp, createClient: () => failed });
  assert.equal(result.reason, 'redis_unavailable');
  assert.doesNotMatch(JSON.stringify(result), /secret|password|private-host/);
  const stalled = fakeClient(null, { async connect() { this.isOpen = true; await new Promise(() => {}); } });
  const started = Date.now();
  const timeout = await api().readSnapshot({ env, createClient: () => stalled, deadlineMs: 30 });
  assert.equal(timeout.reason, 'redis_timeout');
  assert.ok(Date.now() - started < 500);
  assert.equal(stalled.closed, true);
});

test('invalid Redis values fail closed including missing TTL and unsafe integers', async () => {
  for (const values of [[timestamp, '7', -1, 2], [timestamp, 'NaN', 1000, 2],
    [timestamp, '1', 1000, -1], [timestamp, '9007199254740992', 1000, 1],
    [timestamp, false, 1000, 0], [timestamp, '1', -2, 0], [timestamp, '1', 86400001, 0]]) {
    const result = await api().readSnapshot({ env, createClient: () => fakeClient(values) });
    assert.equal(result.available, false);
    assert.equal(result.reason, 'invalid_data');
    assert.equal(result.globalUsed, null);
  }
});

test('validator whitelists fields and rejects inconsistent or unbounded values', () => {
  assert.deepEqual(api().validateSnapshot({ ...available(), secret: 'removed' }), available());
  for (const change of [{ schema: 2 }, { capturedAt: '2026' }, { available: 'true' },
    { reason: 'secret Redis URL' }, { globalUsed: -1 }, { activeRequests: 1.5 },
    { globalLimit: 0 }, { globalRemaining: 999 }, { activeRequests: Number.MAX_SAFE_INTEGER + 1 },
    { globalResetAt: 'bad' }, { available: false, reason: 'redis_timeout' }]) {
    assert.throws(() => api().validateSnapshot({ ...available(), ...change }), /Invalid quota snapshot/);
  }
});

test('publisher atomically replaces only quota.json and rejects symlinks', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-snapshot-test-'));
  const www = path.join(stateDir, 'www');
  fs.mkdirSync(www);
  const target = path.join(www, 'quota.json');
  try {
    fs.writeFileSync(path.join(www, 'index.html'), 'untouched');
    api().publishSnapshot({ stateDir, snapshot: available() });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), available());
    assert.equal(fs.statSync(target).mode & 0o777, 0o644);
    assert.equal(fs.readFileSync(path.join(www, 'index.html'), 'utf8'), 'untouched');
    const next = { ...available(), globalUsed: 8, globalRemaining: 492 };
    api().publishSnapshot({ stateDir, snapshot: next });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), next);
    assert.deepEqual(fs.readdirSync(www).sort(), ['index.html', 'quota.json']);
    fs.unlinkSync(target);
    fs.symlinkSync(path.join(www, 'index.html'), target);
    assert.throws(() => api().publishSnapshot({ stateDir, snapshot: available() }), /regular|directory/i);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('CLI resolves missing API dependency without exposing config and publishes unavailable JSON', () => {
  api();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-cli-test-'));
  fs.mkdirSync(path.join(stateDir, 'www'));
  try {
    const output = execFileSync(process.execPath, [moduleFile, '--state-dir', stateDir], {
      env: { ...process.env, AI_REDIS_URL: 'redis://secret:password@127.0.0.1', SCIENCE_LAB_API_DIR: path.join(stateDir, 'missing-api') },
      encoding: 'utf8', timeout: 5000,
    });
    const result = JSON.parse(fs.readFileSync(path.join(stateDir, 'www/quota.json'), 'utf8'));
    assert.equal(result.reason, 'dependency_unavailable');
    assert.doesNotMatch(output, /secret|password|private-host/);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('isolated authenticated Redis: handshake, active leases and snapshot leave counters and ZSET unchanged', async t => {
  const binary = process.env.REDIS_SERVER_BIN || '/usr/local/bin/redis-server';
  if (!fs.existsSync(binary)) { t.skip('local redis-server unavailable'); return; }
  api();
  const probe = net.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const password = require('node:crypto').randomUUID();
  const child = spawn(binary, ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no', '--requirepass', password], { stdio: ['ignore', 'pipe', 'pipe'] });
  let client;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Owned Redis startup timeout')), 5000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Owned Redis startup failed')); });
      child.stdout.on('data', chunk => { if (String(chunk).includes('Ready to accept connections')) { clearTimeout(timer); resolve(); } });
      child.stderr.resume();
    });
    const { createClient } = require('redis');
    const redisEnv = { ...env, AI_REDIS_URL: `redis://:${password}@127.0.0.1:${port}` };
    client = createClient({ url: redisEnv.AI_REDIS_URL });
    client.on('error', () => t.diagnostic('Owned Redis test client reported a connection error'));
    await client.connect();
    const prefix = 'snapshot-integration:{quota}';
    const global = prefix + ':global_day:all';
    const active = prefix + ':active';
    await client.set(global, '7', { PX: 60000 });
    await client.zAdd(active, [{ score: Date.now() - 1000, value: 'expired' }, { score: Date.now() + 60000, value: 'live' }]);
    const before = await client.sendCommand(['DUMP', active]);
    // Redis 6 has no PEXPIRETIME; an atomic read computes the same absolute deadline.
    const expiry = () => client.eval("local t=redis.call('TIME'); return tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)+redis.call('PTTL',KEYS[1])", { keys: [global], arguments: [] });
    const expiryBefore = await expiry();
    const result = await api().readSnapshot({ env: redisEnv, namespace: 'snapshot-integration' });
    assert.equal(result.available, true);
    assert.equal(result.globalUsed, 7);
    assert.equal(result.activeRequests, 1);
    assert.equal(Date.parse(result.globalResetAt), expiryBefore);
    assert.deepEqual(await client.sendCommand(['DUMP', active]), before);
    assert.equal(await client.get(global), '7');
    assert.equal(await expiry(), expiryBefore);
    const keysBefore = await client.keys('*');
    const empty = await api().readSnapshot({ env: redisEnv, namespace: 'absent' });
    assert.equal(empty.globalUsed, 0);
    assert.equal(empty.activeRequests, 0);
    assert.deepEqual(await client.keys('*'), keysBefore);
  } finally {
    if (client?.isOpen) client.destroy();
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
  }
});
