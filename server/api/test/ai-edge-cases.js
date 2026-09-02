'use strict';
process.env.DB_DRIVER = 'memory';
process.env.JWT_SECRET = 'testsecret_testsecret_0123456789';
process.env.CORS_ORIGINS = '';
process.env.DEEPSEEK_API_KEY = 'mock-key';
process.env.AI_RATE_LIMIT_MINUTE_MAX = '10';
process.env.AI_RATE_LIMIT_DAY_MAX = '1';
process.env.AI_UPSTREAM_TIMEOUT_MS = '5000';

const assert = require('assert');
const clientFetch = global.fetch.bind(globalThis);
let upstreamMode = 'sse';
let upstreamSignal;

global.fetch = async (_url, options) => {
  if (upstreamMode === 'abort') {
    return new Promise((_resolve, reject) => {
      upstreamSignal = options.signal;
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  }
  return new Response('data: [DONE]\n\n', {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
};

const app = require('../server');

function waitFor(predicate, timeoutMs = 500) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error('condition_timeout'));
      setTimeout(check, 5);
    };
    check();
  });
}

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let pass = 0;
  const ok = name => { console.log('  ✓', name); pass++; };

  try {
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'test' }] });
    const request = (ip, signal) => clientFetch(base + '/ai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body,
      signal,
    });

    let response = await request('203.0.113.20');
    assert.strictEqual(response.status, 200);
    response = await request('203.0.113.20');
    assert.strictEqual(response.status, 429);
    ok('AI 每日限流 429');

    upstreamMode = 'abort';
    const controller = new AbortController();
    const pending = request('203.0.113.21', controller.signal).catch(() => null);
    await waitFor(() => upstreamSignal);
    controller.abort();
    await pending;
    await waitFor(() => upstreamSignal.aborted);
    assert.strictEqual(upstreamSignal.aborted, true);
    ok('客户端断开会中止 AI 上游');

    console.log('\n边缘测试通过：' + pass + ' 项');
  } finally {
    global.fetch = clientFetch;
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  console.error('\n边缘测试失败：', error.message);
  process.exit(1);
});
