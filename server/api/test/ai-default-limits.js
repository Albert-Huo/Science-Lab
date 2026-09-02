'use strict';

process.env.DB_DRIVER = 'memory';
process.env.JWT_SECRET = 'testsecret_testsecret_0123456789';
process.env.AI_RATE_LIMIT_MINUTE_MAX = '100';
delete process.env.AI_RATE_LIMIT_DAY_MAX;
process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const envExample = fs.readFileSync(path.resolve(__dirname, '../.env.example'), 'utf8');
assert.match(
  envExample,
  /^AI_RATE_LIMIT_DAY_MAX=20$/m,
  '.env.example 必须与代码默认的每 IP 每 24 小时 20 次保持一致'
);

const nativeFetch = global.fetch.bind(globalThis);
global.fetch = async () => new Response('data: [DONE]\n\n', {
  status: 200,
  headers: { 'Content-Type': 'text/event-stream' },
});

const app = require('../server');

(async () => {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = () => nativeFetch(base + '/ai/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '203.0.113.20',
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: '默认限额测试' }],
    }),
  });

  try {
    for (let count = 1; count <= 20; count++) {
      const response = await request();
      await response.text();
      assert.strictEqual(response.status, 200, `第 ${count} 次请求应被允许`);
    }
    const limited = await request();
    assert.strictEqual(limited.status, 429, '同一 IP 第 21 次请求应触发默认每日限流');
    const body = await limited.json();
    assert.strictEqual(body.error, 'rate_limited');
    console.log('✓ AI 默认每 IP 每 24 小时限制为 20 次');
  } finally {
    global.fetch = nativeFetch;
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  global.fetch = nativeFetch;
  console.error(error);
  process.exit(1);
});
