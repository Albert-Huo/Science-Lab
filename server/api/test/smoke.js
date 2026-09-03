'use strict';
/* 端到端冒烟测试：内存 DB，覆盖注册/登录/鉴权/进度合并/CORS。
 * 运行：DB_DRIVER=memory JWT_SECRET=testsecret_testsecret node test/smoke.js
 */
process.env.DB_DRIVER = 'memory';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecret_testsecret_0123456789';
process.env.CORS_ORIGINS = 'https://albert-huo.github.io';
process.env.AI_RATE_LIMIT_MINUTE_MAX = '2';
process.env.AI_RATE_LIMIT_DAY_MAX = '100';
process.env.AI_UPSTREAM_TIMEOUT_MS = '25';
delete process.env.DEEPSEEK_API_KEY;

const assert = require('assert');
const nativeFetch = global.fetch.bind(globalThis);
const app = require('../server');
const AI_MODEL = 'deepseek-v4-flash';

let base;
function api(path, opts) { return nativeFetch(base + path, opts); }
function aiRequest(body, ip) {
  return api('/ai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify(body),
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
  let pass = 0;
  const ok = (name) => { console.log('  ✓', name); pass++; };

  try {
    // health
    assert.strictEqual((await (await api('/health')).json()).ok, true); ok('health');

    // AI proxy: missing server-side key
    let r = await aiRequest({ model: AI_MODEL, messages: [{ role: 'user', content: '你好' }] }, '203.0.113.1');
    let j = await r.json();
    assert.strictEqual(r.status, 503); assert.strictEqual(j.error, 'ai_unavailable'); ok('AI 缺少服务端 Key 时 503');

    // AI proxy: invalid messages are rejected before reaching upstream
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
    let upstreamCalled = false;
    global.fetch = async () => { upstreamCalled = true; throw new Error('不应调用上游'); };
    r = await aiRequest({ model: AI_MODEL, messages: 'invalid' }, '203.0.113.2');
    j = await r.json();
    assert.strictEqual(r.status, 400); assert.strictEqual(j.error, 'invalid_messages'); assert.strictEqual(upstreamCalled, false); ok('AI 非法 messages 400');

    // AI proxy: only approved fields reach DeepSeek, while SSE is streamed back
    let captured;
    global.fetch = async (url, opts) => {
      captured = { url, opts, body: JSON.parse(opts.body) };
      return new Response('data: {"choices":[{"delta":{"content":"答案"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };
    r = await aiRequest({
      model: AI_MODEL, stream: false, max_tokens: 9999, temperature: 1.5,
      messages: [{ role: 'user', content: '解释实验' }], ignored: 'do-not-forward',
    }, '203.0.113.3');
    const sse = await r.text();
    assert.strictEqual(r.status, 200); assert.match(sse, /答案/);
    assert.strictEqual(captured.url, 'https://api.deepseek.com/chat/completions');
    assert.deepStrictEqual(captured.body, {
      model: AI_MODEL, stream: true, max_tokens: 2048, temperature: 1.5,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: '解释实验' }],
    });
    assert.strictEqual(captured.opts.headers.Authorization, 'Bearer test-deepseek-key'); ok('AI 字段收紧 + SSE 透传');

    // AI proxy: stalled upstream calls are aborted by a total timeout
    let timeoutSignal;
    global.fetch = async (_url, opts) => new Promise((_resolve, reject) => {
      timeoutSignal = opts.signal;
      opts.signal.addEventListener('abort', () => {
        const error = new Error('upstream timeout');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
    r = await aiRequest({ model: AI_MODEL, messages: [{ role: 'user', content: '超时测试' }] }, '203.0.113.5');
    j = await r.json();
    assert.strictEqual(r.status, 504); assert.strictEqual(j.error, 'ai_upstream_timeout');
    assert.strictEqual(timeoutSignal.aborted, true); ok('AI 上游超时会中止请求');

    // AI proxy: arbitrary fetch errors must not leak the server-side key to logs
    const originalConsoleError = console.error;
    const loggedErrors = [];
    console.error = (...args) => loggedErrors.push(args.map(String).join(' '));
    try {
      global.fetch = async () => {
        throw new Error(`invalid authorization header Bearer ${process.env.DEEPSEEK_API_KEY}`);
      };
      r = await aiRequest({ model: AI_MODEL, messages: [{ role: 'user', content: '日志测试' }] }, '203.0.113.6');
    } finally {
      console.error = originalConsoleError;
    }
    assert.strictEqual(r.status, 502);
    assert.strictEqual(loggedErrors.join('\n').includes(process.env.DEEPSEEK_API_KEY), false); ok('AI 错误日志不泄漏 Key');

    // AI proxy: minute limiter is isolated per IP
    global.fetch = async () => new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    assert.strictEqual((await aiRequest({ model: AI_MODEL, messages: [{ role: 'user', content: '1' }] }, '203.0.113.4')).status, 200);
    assert.strictEqual((await aiRequest({ model: AI_MODEL, messages: [{ role: 'user', content: '2' }] }, '203.0.113.4')).status, 200);
    r = await aiRequest({ model: AI_MODEL, messages: [{ role: 'user', content: '3' }] }, '203.0.113.4');
    assert.strictEqual(r.status, 429); ok('AI 每分钟限流 429');
    global.fetch = nativeFetch;

    // register
    r = await api('/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'A@Example.com', password: 'secret1' }) });
    j = await r.json();
    assert.strictEqual(r.status, 200); assert.ok(j.token); assert.strictEqual(j.email, 'a@example.com'); ok('register + 邮箱归一化');
    const token = j.token;

    // duplicate
    r = await api('/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com', password: 'secret1' }) });
    assert.strictEqual(r.status, 409); ok('重复邮箱 409');

    // weak password
    r = await api('/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'b@example.com', password: '123' }) });
    assert.strictEqual(r.status, 400); ok('弱密码 400');

    // login wrong
    r = await api('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com', password: 'wrong' }) });
    assert.strictEqual(r.status, 401); ok('错误密码 401');

    // login ok
    r = await api('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@example.com', password: 'secret1' }) });
    j = await r.json(); assert.strictEqual(r.status, 200); assert.ok(j.token); ok('登录成功');

    // progress requires auth
    r = await api('/progress'); assert.strictEqual(r.status, 401); ok('未授权访问 401');

    // empty progress
    r = await api('/progress', { headers: { Authorization: 'Bearer ' + token } });
    j = await r.json(); assert.deepStrictEqual(j.history, []); ok('初始进度为空');

    // put progress
    const h1 = [{ path: 'a.html', title: 'A', ts: 100 }, { path: 'b.html', title: 'B', ts: 200 }];
    r = await api('/progress', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ history: h1 }) });
    j = await r.json(); assert.strictEqual(j.history.length, 2); assert.strictEqual(j.history[0].path, 'b.html'); ok('上传进度 + 按时间排序');

    // merge: same path newer ts wins, new path added
    const h2 = [{ path: 'a.html', title: 'A2', ts: 300 }, { path: 'c.html', title: 'C', ts: 50 }];
    r = await api('/progress', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ history: h2 }) });
    j = await r.json();
    const byPath = Object.fromEntries(j.history.map(x => [x.path, x]));
    assert.strictEqual(j.history.length, 3); assert.strictEqual(byPath['a.html'].ts, 300); assert.strictEqual(byPath['a.html'].title, 'A2'); assert.ok(byPath['c.html']); ok('合并：并集 + 保留较新');

    // invalid history
    r = await api('/progress', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ history: 'nope' }) });
    assert.strictEqual(r.status, 400); ok('非法 history 400');

    // CORS allowed origin echoed
    r = await api('/health', { headers: { Origin: 'https://albert-huo.github.io' } });
    assert.strictEqual(r.headers.get('access-control-allow-origin'), 'https://albert-huo.github.io'); ok('CORS 白名单放行');

    console.log('\n全部通过：' + pass + ' 项');
    server.close(); process.exit(0);
  } catch (e) {
    global.fetch = nativeFetch;
    console.error('\n测试失败：', e.message); server.close(); process.exit(1);
  }
})();
