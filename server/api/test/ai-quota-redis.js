'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { createQuota, RedisStore } = require('../ai-quota');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(quota, ip = '192.0.2.1') {
  const res = { statusCode: 200, headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
  const release = await quota.reserve({ ip, headers: {} }, res);
  return { res, release };
}

(async () => {
  // Reserve an OS-selected loopback port; never touch a pre-existing Redis instance.
  const portProbe = net.createServer();
  portProbe.listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const child = spawn(process.env.REDIS_SERVER_BIN || '/usr/local/bin/redis-server', [
    '--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const clients = [];
  let stopped = false;
  async function stopRedis() {
    if (stopped) return;
    stopped = true;
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Owned test Redis startup timed out')), 5000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Owned test Redis exited before ready')); });
      child.stdout.on('data', chunk => {
        if (String(chunk).includes('Ready to accept connections')) { clearTimeout(timer); resolve(); }
      });
      child.stderr.resume();
    });
    const redisUrl = `redis://127.0.0.1:${port}`;
    const options = { redisUrl, secret: 'redis-test-stable-secret-at-least-32-characters',
      production: true, namespace: `quota-test-${randomUUID()}`,
      minuteMax: 100, ipDayMax: 100, sessionDayMax: 100, globalDayMax: 3, concurrentMax: 100 };
    const first = createQuota(options);
    const second = createQuota(options);
    clients.push(first, second);
    await Promise.all([first.connect(), second.connect()]);
    const attempts = await Promise.all(Array.from({ length: 24 }, (_, i) =>
      request(i % 2 ? first : second, `192.0.2.${i + 1}`)));
    assert.equal(attempts.filter(item => item.release).length, 3, 'two instances must atomically enforce global cap');
    assert.ok(attempts.filter(item => !item.release).every(item => item.res.body.scope === 'global_day'));
    await Promise.all(attempts.filter(item => item.release).map(item => item.release()));
    await Promise.all([first.close(), second.close()]);

    // A fresh Node process and client must see the existing counters.
    const script = `
      const { createQuota } = require('./ai-quota');
      (async () => {
        const quota = createQuota(JSON.parse(process.argv[1]));
        try {
          await quota.connect();
          const res = { setHeader() {}, status(code) { this.code = code; return this; },
            json(body) { process.stdout.write(JSON.stringify({ code: this.code, scope: body.scope })); } };
          const release = await quota.reserve({ ip: '198.51.100.1', headers: {} }, res);
          if (release) { await release(); throw new Error('restart lost quota'); }
        } finally { await quota.close(); }
      })().catch(error => { console.error(error.message); process.exitCode = 1; });
    `;
    const restart = await promisify(execFile)(process.execPath, ['-e', script, JSON.stringify(options)], {
      cwd: require('node:path').resolve(__dirname, '..'), timeout: 5000,
    });
    assert.deepEqual(JSON.parse(restart.stdout), { code: 429, scope: 'global_day' });

    const a = new RedisStore({ url: redisUrl });
    const b = new RedisStore({ url: redisUrl });
    clients.push(a, b);
    await Promise.all([a.connect(), b.connect()]);
    const key = `expiry-test-${randomUUID()}:{quota}`;
    const buckets = ['ip_minute', 'ip_day', 'session_day', 'global_day'].map(scope => ({
      scope, key: `${key}:${scope}`, limit: 2, windowMs: 250,
    }));
    const reserve = (store, leaseId) => store.reserve({ buckets, leaseKey: key + ':active', leaseId,
      leaseMs: 70, concurrentMax: 1 });
    assert.equal((await reserve(a, 'first')).allowed, true);
    assert.equal((await reserve(b, 'denied')).scope, 'concurrency');
    await a.release(key + ':active', 'first');
    assert.equal((await reserve(b, 'second')).allowed, true, 'concurrency rejection must not charge daily counters');
    await delay(90);
    assert.equal((await reserve(a, 'after-lease-expiry')).scope, 'ip_minute');
    await delay(200);
    a.client.destroy();
    assert.equal((await reserve(a, 'after-window-expiry')).allowed, true);
    await a.release(key + ':active', 'after-window-expiry');

    const live = createQuota({ ...options, namespace: `outage-test-${randomUUID()}` });
    clients.push(live);
    await live.connect();
    await stopRedis();
    const started = Date.now();
    const unavailable = await request(live);
    assert.equal(unavailable.res.statusCode, 503);
    assert.equal(unavailable.res.body.error, 'quota_unavailable');
    assert.ok(Date.now() - started < 2500, 'outage must return within a bounded deadline');
    await Promise.all(clients.map(client => client.close()));

    const sockets = new Set();
    const stalledServer = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    stalledServer.listen(0, '127.0.0.1');
    await once(stalledServer, 'listening');
    const stalled = new RedisStore({ url: `redis://127.0.0.1:${stalledServer.address().port}`, commandTimeoutMs: 100 });
    try {
      const begin = Date.now();
      await assert.rejects(stalled.connect(), /unavailable/);
      assert.ok(Date.now() - begin < 1500, 'an unresponsive Redis handshake must time out');
    } finally {
      await stalled.close();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => stalledServer.close(resolve));
    }
    console.log('✓ AI Redis atomic multi-instance cap, process restart, expiry, release and bounded outage');
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await stopRedis();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
