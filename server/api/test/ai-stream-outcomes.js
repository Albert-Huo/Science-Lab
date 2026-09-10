'use strict';
require('./ai-test-env');
process.env.APP_MODE = 'ai-only';
process.env.NODE_ENV = 'test';
process.env.AI_RATE_LIMIT_MINUTE_MAX = '3';
process.env.AI_RATE_LIMIT_DAY_MAX = '2';
process.env.AI_SESSION_DAY_MAX = '100';
process.env.AI_GLOBAL_DAY_MAX = '100';
process.env.AI_UPSTREAM_TIMEOUT_MS = '120';
process.env.DEEPSEEK_API_KEY = 'private-test-key';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const nativeFetch = global.fetch;

test('HTTP requests each produce exactly one anonymous terminal outcome with local upstream', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-stream-events-'));
  process.env.AI_EVENT_LOG_PATH = path.join(dir, 'ai-events.log');
  let mode = 'complete'; let upstreamSignal; let sent;
  global.fetch = async (_url, options) => {
    sent = JSON.parse(options.body);
    upstreamSignal = options.signal;
    if (mode === 'error') return new Response('private-provider-error', { status: 500 });
    if (mode === 'timeout' || mode === 'abort') return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('private-abort')), { once: true });
    });
    if (mode.startsWith('midstream-')) {
      const currentMode = mode;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"private-answer"}}]}\n\n'
            + (currentMode === 'midstream-done' ? 'data: [DONE]\n\n' : '')));
          if (currentMode === 'midstream-error') setTimeout(() => controller.error(new Error('private-stream-error')), 10);
          options.signal.addEventListener('abort', () => controller.error(new Error('private-stream-abort')), { once: true });
        },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    const payload = 'data: {"choices":[{"delta":{"content":"private-answer"}}]}\n\n'
      + (mode === 'sse-error' ? 'data: {"error":{"message":"private-error"}}\n\ndata: [DONE]\n\n'
        : mode === 'complete' ? 'data: [DONE]\n\n' : '');
    return new Response(payload, { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const app = require('../server');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    global.fetch = nativeFetch;
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/ai/chat/completions`;
  const body = { context: { experimentPath: 'physics-middle/初中物理实验1.html' },
    messages: [{ role: 'system', content: 'discard-private-system' }, { role: 'user', content: 'private-question' }] };
  let ip = 1;
  const post = (data = JSON.stringify(body), options = {}) => nativeFetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `203.0.113.${ip++}` },
    body: data, ...options,
  });
  let count = 0;
  async function nextEvent(outcome) {
    const deadline = Date.now() + 2000;
    let events = [];
    while (Date.now() < deadline) {
      try { events = (await fs.readFile(process.env.AI_EVENT_LOG_PATH, 'utf8')).trim().split('\n').map(JSON.parse); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (events.length >= count + 1) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(events.length, ++count, 'one terminal record per request');
    const event = events.at(-1);
    assert.equal(event.outcome, outcome);
    assert.ok(!JSON.stringify(events).includes('private'));
    return event;
  }
  let response = await post(); const text = await response.text();
  assert.ok(text.endsWith('data: [DONE]\n\n'));
  const event = await nextEvent('completed');
  assert.equal(event.status, 200); assert.equal(event.scope, '');
  assert.equal(event.messages, sent.messages.length);
  assert.equal(event.promptChars, sent.messages[0].content.length);
  assert.equal(event.conversationChars, 'private-question'.length);
  assert.equal(event.inputChars, event.promptChars + event.conversationChars);
  assert.ok(Number.isInteger(event.firstTokenMs));
  mode = 'incomplete'; response = await post(); await response.text(); await nextEvent('stream_incomplete');
  mode = 'sse-error'; response = await post(); await response.text(); await nextEvent('upstream_error');
  mode = 'error'; response = await post(); assert.equal(response.status, 502); await response.text(); await nextEvent('upstream_error');
  mode = 'timeout'; response = await post(); assert.equal(response.status, 504); await response.text(); await nextEvent('upstream_timeout');
  mode = 'midstream-error'; response = await post(); await response.text().catch(() => null);
  assert.equal((await nextEvent('upstream_error')).status, 200);
  mode = 'midstream-timeout'; response = await post(); await response.text().catch(() => null);
  assert.equal((await nextEvent('upstream_timeout')).status, 200);
  mode = 'midstream-abort';
  const streamAbort = new AbortController(); response = await post(undefined, { signal: streamAbort.signal });
  const reader = response.body.getReader(); await reader.read(); streamAbort.abort();
  await reader.read().catch(() => null); await nextEvent('client_aborted');
  mode = 'midstream-done';
  const completedAbort = new AbortController(); response = await post(undefined, { signal: completedAbort.signal });
  const completedReader = response.body.getReader(); await completedReader.read(); completedAbort.abort();
  await completedReader.read().catch(() => null); await nextEvent('completed');
  mode = 'abort'; upstreamSignal = null;
  const controller = new AbortController(); const pending = post(undefined, { signal: controller.signal }).catch(() => null);
  while (!upstreamSignal) await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort(); await pending; await nextEvent('client_aborted');
  response = await post('{bad'); assert.equal(response.status, 400); await response.text();
  assert.equal((await nextEvent('invalid_request')).inputChars, null);
  response = await post(JSON.stringify({ x: 'x'.repeat(270000) })); assert.equal(response.status, 413); await response.text(); await nextEvent('invalid_request');
  response = await post('{}'); assert.equal(response.status, 400); await response.text(); await nextEvent('invalid_request');
  await new Promise(resolve => {
    const partial = http.request(endpoint, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'Content-Length': '100', 'X-Forwarded-For': `203.0.113.${ip++}`,
    } });
    partial.once('error', resolve);
    partial.flushHeaders(); partial.write('{');
    setTimeout(() => partial.destroy(), 20);
  });
  assert.equal((await nextEvent('client_aborted')).status, null);
  delete process.env.DEEPSEEK_API_KEY;
  response = await post(); assert.equal(response.status, 503); await response.text(); await nextEvent('not_configured');
  process.env.DEEPSEEK_API_KEY = 'private-test-key'; mode = 'complete';
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.100' };
  for (let index = 0; index < 2; index++) { response = await post(undefined, { headers }); await response.text(); await nextEvent('completed'); }
  response = await post(undefined, { headers }); await response.text();
  assert.equal((await nextEvent('rate_limited')).scope, 'ip_day');
  response = await post(undefined, { headers }); await response.text();
  assert.equal(response.headers.get('x-ai-quota-scope'), 'ip_minute');
  assert.equal((await nextEvent('rate_limited')).scope, 'ip_minute');
});

test('quota outage and unexpected middleware failure are recorded without error text', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-event-quota-'));
  process.env.AI_EVENT_LOG_PATH = path.join(dir, 'ai-events.log');
  const quotaPath = require.resolve('../ai-quota');
  const serverPath = require.resolve('../server');
  const originalQuota = require.cache[quotaPath];
  let mode = 'outage';
  require.cache[quotaPath] = { id: quotaPath, filename: quotaPath, loaded: true, exports: {
    createQuota: () => ({ async reserve(_req, res) {
      if (mode === 'unexpected') throw new Error('private-diagnostic-secret');
      res.status(503).json({ error: 'quota_unavailable' }); return null;
    } }),
  } };
  delete require.cache[serverPath];
  const server = require('../server').listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    require.cache[quotaPath] = originalQuota; delete require.cache[serverPath];
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  for (const nextMode of ['outage', 'unexpected']) {
    mode = nextMode;
    const response = await nativeFetch(`http://127.0.0.1:${server.address().port}/ai/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { experimentPath: 'physics-middle/初中物理实验1.html' }, messages: [{ role: 'user', content: 'private-input' }] }),
    });
    await response.text();
    assert.equal(response.status, mode === 'outage' ? 503 : 500);
  }
  let events = [];
  for (let tries = 0; tries < 100 && events.length < 2; tries++) {
    try { events = (await fs.readFile(process.env.AI_EVENT_LOG_PATH, 'utf8')).trim().split('\n').map(JSON.parse); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (events.length < 2) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(events.map(event => event.outcome), ['quota_unavailable', 'internal_error']);
  assert.ok(!JSON.stringify(events).includes('private'));
});
