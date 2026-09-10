'use strict';
require('./ai-test-env');
process.env.APP_MODE = 'ai-only';
process.env.NODE_ENV = 'test';
process.env.AI_RATE_LIMIT_MINUTE_MAX = '100';
process.env.AI_RATE_LIMIT_DAY_MAX = '100';
process.env.DEEPSEEK_API_KEY = 'test-placeholder';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nativeFetch = global.fetch;
let captured;
let calls = 0;
global.fetch = async (_url, options) => {
  calls++;
  captured = JSON.parse(options.body);
  return new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
};
const app = require('../server');
const experimentPath = 'physics-middle/初中物理实验1.html';

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/ai/chat/completions';
  const post = body => nativeFetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const response = await post({
      context: { experimentPath, title: 'forged-title', liveState: 'forged-live-state' },
      messages: [{ role: 'system', content: 'forged-system-instruction' }, { role: 'user', content: '怎样读数？' }],
    });
    await response.text();
    assert.equal(response.status, 200);
    assert.equal(captured.messages[0].role, 'system');
    assert.match(captured.messages[0].content, /温度计/);
    assert.ok(!JSON.stringify(captured).includes('forged-'));
    assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
    assert.ok(response.headers.get('set-cookie').includes('HttpOnly'));
    assert.ok(response.headers.has('x-ai-quota-remaining'));
    for (const badPath of [undefined, '../escape.html', 'physics-middle/不存在.html']) {
      const rejected = await post({ context: { experimentPath: badPath }, messages: [{ role: 'user', content: 'test' }] });
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json()).error, 'invalid_experiment');
    }
    assert.equal(calls, 1, '无效实验不得触发付费上游');
    const hostileModel = await post({ model: { toString: {} }, context: { experimentPath }, messages: [{ role: 'user', content: 'x' }] });
    assert.equal(hostileModel.status, 400);
    assert.equal((await hostileModel.json()).error, 'invalid_model');
    const invalidJson = await nativeFetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
    assert.equal(invalidJson.status, 400);
    assert.equal((await invalidJson.json()).error, 'invalid_json');
    const tooLarge = await post({ x: 'x'.repeat(270000) });
    assert.equal(tooLarge.status, 413);
    assert.equal((await tooLarge.json()).error, 'request_too_large');

    const workerSource = fs.readFileSync(path.resolve(__dirname, '../../cloudflare-worker.js'), 'utf8');
    const context = vm.createContext({ Response, fetch() { throw new Error('退役 Worker 不应发起网络调用'); } });
    vm.runInContext(workerSource.replace('export default', 'this.worker ='), context);
    assert.equal((await context.worker.fetch()).status, 410);
    console.log('✓ HTTP 实验策略、防伪造、额度头、结构化错误和旧 Worker 退役');
  } finally {
    global.fetch = nativeFetch;
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
