'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const SERVER_PATH = path.resolve(__dirname, '../server.js');
const TEST_ORIGIN = 'https://lab.xingnian.net.cn';

async function freePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

function request(port, route, { method = 'GET', body, headers = {} } = {}) {
  const payload = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method,
      headers: { ...(payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }), ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function main() {
  const redisBin = process.env.REDIS_SERVER_BIN || ['/usr/local/bin/redis-server', '/usr/bin/redis-server'].find(fs.existsSync);
  if (!redisBin) {
    console.log('SKIP product analytics route integration: redis-server unavailable');
    return;
  }
  const redisPort = await freePort();
  const apiPort = await freePort();
  const redis = spawn(redisBin, ['--bind', '127.0.0.1', '--port', String(redisPort), '--save', '', '--appendonly', 'no'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'science-lab-analytics-route-'));
  let api;
  let redisStopped = false;
  async function stopRedis() {
    if (redisStopped) return;
    redisStopped = true;
    if (!redis.pid || redis.exitCode !== null || redis.signalCode !== null) return;
    const exited = once(redis, 'exit'); redis.kill('SIGTERM'); await exited;
  }
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Owned Redis startup timed out')), 5000);
      redis.once('error', error => { clearTimeout(timer); reject(error); });
      redis.stdout.on('data', chunk => {
        if (String(chunk).includes('Ready to accept connections')) { clearTimeout(timer); resolve(); }
      });
      redis.stderr.resume();
    });
    api = spawn(process.execPath, [SERVER_PATH], {
      cwd: isolatedCwd,
      env: { ...process.env, APP_MODE: 'ai-only', NODE_ENV: 'development', PORT: String(apiPort),
        ANALYTICS_REDIS_URL: `redis://127.0.0.1:${redisPort}`, ANALYTICS_ORIGIN: TEST_ORIGIN,
        CORS_ORIGINS: TEST_ORIGIN, DEEPSEEK_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    api.stderr.on('data', chunk => { stderr += String(chunk); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('API startup timed out: ' + stderr)), 5000);
      api.once('error', error => { clearTimeout(timer); reject(error); });
      api.once('exit', code => { clearTimeout(timer); reject(new Error('API exited ' + code + ': ' + stderr)); });
      api.stdout.on('data', chunk => {
        if (String(chunk).includes('science-lab-api listening')) { clearTimeout(timer); resolve(); }
      });
    });
    const headers = { Origin: TEST_ORIGIN, 'Sec-Fetch-Site': 'same-origin' };
    const page = { v: 1, event: 'page_view', page_id: 'home', source: 'direct' };
    const valid = await request(apiPort, '/analytics/events', { method: 'POST', headers, body: page });
    assert.equal(valid.status, 204);
    assert.equal(valid.headers['set-cookie'], undefined);
    assert.match(valid.headers['cache-control'] || '', /no-store/);
    assert.equal(valid.body, '');
    assert.equal((await request(apiPort, '/analytics/events?x=1', { method: 'POST', headers, body: page })).status, 400);
    assert.equal((await request(apiPort, '/analytics/events', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: page })).status, 403);
    assert.equal((await request(apiPort, '/analytics/events', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: JSON.stringify(page) })).status, 415);
    assert.equal((await request(apiPort, '/analytics/events', { method: 'POST', headers, body: 'x'.repeat(3000) })).status, 413);
    assert.equal((await request(apiPort, '/analytics/events', { method: 'POST', headers,
      body: { v: 1, event: 'experiment_complete', experiment_id: 'a'.repeat(64) } })).status, 400);

    await stopRedis();
    assert.equal((await request(apiPort, '/health')).status, 200);
    assert.equal((await request(apiPort, '/analytics/events', { method: 'POST', headers, body: page })).status, 503);
    assert.doesNotMatch(stderr, /redis:\/\/|ANALYTICS_REDIS_URL|direct|page_view/);
    console.log('✓ product analytics route strict input, no cookie and isolated outage');
  } finally {
    if (api?.pid && api.exitCode === null && api.signalCode === null) {
      const exited = once(api, 'exit'); api.kill('SIGTERM'); await exited;
    }
    await stopRedis();
    fs.rmSync(isolatedCwd, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
