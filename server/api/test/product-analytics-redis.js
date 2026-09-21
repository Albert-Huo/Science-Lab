'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID, createHash } = require('node:crypto');
const { createClient } = require('redis');
const { createProductAnalytics, HOUR_TTL_SECONDS, DAY_TTL_SECONDS } = require('../product-analytics');

const catalog = require('../ai-context.json');

async function main() {
  const redisBin = process.env.REDIS_SERVER_BIN || ['/usr/local/bin/redis-server', '/usr/bin/redis-server'].find(fs.existsSync);
  if (!redisBin) {
    console.log('SKIP product analytics Redis integration: redis-server unavailable');
    return;
  }
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(redisBin, ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let stopped = false;
  async function stopRedis() {
    if (stopped) return;
    stopped = true;
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
  const analyticsClients = [];
  let inspector;
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
    const namespace = `science-lab:analytics:test-${randomUUID()}`;
    const first = createProductAnalytics({ redisUrl, catalog, namespace });
    analyticsClients.push(first);
    assert.equal(await first.connect(), true);
    await Promise.all(Array.from({ length: 24 }, () => first.record({
      v: 1, event: 'page_view', page_id: 'home', source: 'direct',
    })));
    const path = catalog.experiments[0].path;
    const id = createHash('sha256').update(path).digest('hex');
    assert.deepEqual((await first.record({ v: 1, event: 'experiment_open', experiment_id: id })).ok, true);
    await first.close();

    inspector = createClient({ url: redisUrl });
    inspector.on('error', () => {});
    await inspector.connect();
    const keys = (await inspector.keys(namespace + ':*')).sort();
    assert.equal(keys.length, 6);
    assert.equal(keys.some(key => /visitor|session|192\.0\.2|Mozilla|physics-middle/i.test(key)), false);
    const hourTotals = keys.find(key => key.includes(':hour:') && key.endsWith(':totals'));
    const dayTotals = keys.find(key => key.includes(':day:') && key.endsWith(':totals'));
    assert.equal(await inspector.hGet(hourTotals, 'page_view'), '24');
    assert.equal(await inspector.hGet(dayTotals, 'page_view'), '24');
    assert.equal(await inspector.hGet(hourTotals, 'experiment_open'), '1');
    assert.ok(await inspector.ttl(hourTotals) <= HOUR_TTL_SECONDS && await inspector.ttl(hourTotals) > HOUR_TTL_SECONDS - 30);
    assert.ok(await inspector.ttl(dayTotals) <= DAY_TTL_SECONDS && await inspector.ttl(dayTotals) > DAY_TTL_SECONDS - 30);
    const experimentKeys = keys.filter(key => key.endsWith(':experiments'));
    for (const key of experimentKeys) assert.deepEqual({ ...await inspector.hGetAll(key) }, { [id]: '1' });

    const second = createProductAnalytics({ redisUrl, catalog, namespace });
    analyticsClients.push(second);
    assert.equal(await second.connect(), true);
    assert.equal((await second.record({ v: 1, event: 'page_view', page_id: 'home', source: 'direct' })).ok, true);
    assert.equal(await inspector.hGet(hourTotals, 'page_view'), '25');
    console.log('✓ product analytics Redis aggregates, TTLs and reconnect persistence');
  } finally {
    await Promise.all(analyticsClients.map(client => client.close()));
    if (inspector?.isOpen) inspector.destroy();
    await stopRedis();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
