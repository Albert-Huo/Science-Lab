'use strict';

const assert = require('node:assert/strict');
const { createQuota, MemoryStore, RedisStore } = require('../ai-quota');

function response() {
  return {
    headers: {}, statusCode: 200,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}
async function request(quota, { ip = '192.0.2.1', cookie = '', secure = false } = {}) {
  const res = response();
  const release = await quota.reserve({ ip, secure, headers: { cookie } }, res);
  return { res, release, cookie: (res.headers['set-cookie'] || cookie).split(';')[0] };
}

(async () => {
  const invalidUrl = 'redis://test-user:fake-secret-do-not-log@[invalid-host';
  assert.throws(() => new RedisStore({ url: invalidUrl }), error => {
    assert.equal(error.message, 'AI quota Redis configuration invalid');
    for (const representation of [String(error), error.stack, JSON.stringify(error), require('node:util').inspect(error)]) {
      assert.doesNotMatch(representation, /fake-secret-do-not-log|test-user|invalid-host/);
    }
    assert.equal(error.cause, undefined);
    assert.equal(error.input, undefined);
    return true;
  });
  let now = 1000000;
  const clock = () => now;
  const make = options => createQuota({ secret: 'test-only-stable-secret-of-at-least-32-characters',
    minuteMax: 100, ipDayMax: 100, globalDayMax: 100, sessionDayMax: 2,
    store: new MemoryStore({ now: clock }), now: clock, ...options });

  const quota = make({});
  const first = await request(quota);
  assert.equal(typeof first.release, 'function');
  assert.match(first.res.headers['set-cookie'], /HttpOnly; SameSite=Lax/);
  assert.equal(first.res.headers['x-ai-quota-remaining'], '1');
  assert.equal(first.res.headers['x-ai-quota-reset'], String(Math.ceil((now + 86400000) / 1000)));
  await first.release();
  const second = await request(quota, { cookie: first.cookie });
  await second.release();
  const denied = await request(quota, { cookie: first.cookie });
  assert.equal(denied.res.statusCode, 429);
  assert.equal(denied.res.body.scope, 'session_day');
  assert.equal(denied.res.headers['retry-after'], '86400');
  const tampered = await request(quota, { cookie: first.cookie.slice(0, -1) + '!' });
  assert.equal(typeof tampered.release, 'function');
  assert.notEqual(tampered.cookie, first.cookie);
  await tampered.release();
  now += 86400000;
  const expired = await request(quota, { cookie: first.cookie });
  assert.notEqual(expired.cookie, first.cookie, 'expired signed cookies must create a new session');
  await expired.release();
  const secure = await request(quota, { secure: true });
  assert.match(secure.cookie, /^__Host-sl_ai=/);
  assert.match(secure.res.headers['set-cookie'], /; Secure/);
  await secure.release();

  const sharedIp = make({ ipDayMax: 2, sessionDayMax: 10, globalDayMax: 3 });
  for (let i = 0; i < 2; i++) await (await request(sharedIp)).release();
  const ipDenied = await request(sharedIp);
  assert.equal(ipDenied.res.body.scope, 'ip_day', 'new cookies cannot bypass IP quota');
  await (await request(sharedIp, { ip: '192.0.2.2' })).release();

  const sharedStore = new MemoryStore({ now: clock });
  const instanceOne = make({ sessionDayMax: 1, store: sharedStore });
  const instanceTwo = make({ sessionDayMax: 1, store: sharedStore });
  const sessionOne = await request(instanceOne);
  await sessionOne.release();
  const movedSession = await request(instanceTwo, { ip: '192.0.2.2', cookie: sessionOne.cookie });
  assert.equal(movedSession.res.body.scope, 'session_day', 'stable signed sessions survive IP and instance changes');

  const concurrency = make({ concurrentMax: 1, globalDayMax: 2, timeoutMs: 100 });
  const active = await request(concurrency);
  assert.equal((await request(concurrency, { ip: '192.0.2.2' })).res.body.scope, 'concurrency');
  await active.release();
  await active.release();
  const afterRelease = await request(concurrency, { ip: '192.0.2.2' });
  assert.equal(typeof afterRelease.release, 'function', 'concurrency denial must not charge daily quota');
  await afterRelease.release();
  assert.equal((await request(concurrency, { ip: '192.0.2.3' })).res.body.scope, 'global_day');

  const minute = make({ minuteMax: 1, globalDayMax: 2 });
  await (await request(minute)).release();
  now += 59999;
  assert.equal((await request(minute)).res.body.scope, 'ip_minute');
  now++;
  await (await request(minute)).release();
  assert.equal((await request(minute, { ip: '192.0.2.2' })).res.body.scope, 'global_day');

  const leases = make({ concurrentMax: 1, timeoutMs: 100 });
  await request(leases);
  now += 5099;
  assert.equal((await request(leases)).res.body.scope, 'concurrency');
  now++;
  await (await request(leases)).release();

  const bounded = make({ store: new MemoryStore({ now: clock, maxEntries: 4 }) });
  await (await request(bounded)).release();
  assert.equal((await request(bounded, { ip: '192.0.2.2' })).res.statusCode, 503);
  now += 86400000;
  await (await request(bounded, { ip: '192.0.2.2' })).release();

  const unavailable = make({ store: { async reserve() { throw new Error('private redis details'); }, async close() {} } });
  const outage = await request(unavailable);
  assert.equal(outage.res.statusCode, 503);
  assert.equal(outage.res.body.error, 'quota_unavailable');
  assert.doesNotMatch(JSON.stringify(outage.res), /private redis/);
  assert.throws(() => createQuota({ production: true }), /Redis/);
  assert.throws(() => createQuota({ production: true, redisUrl: 'redis://localhost', secret: 'short' }), /32/);
  assert.throws(() => make({ globalDayMax: 0 }), /globalDayMax/);
  await quota.close();
  console.log('✓ AI quota memory, signed sessions, atomic denials, leases and fail-closed behavior');
})().catch(error => { console.error(error); process.exitCode = 1; });
