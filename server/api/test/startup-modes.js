'use strict';
/* 真正执行 server.js；隔离 cwd/env，绝不读取开发机 .env 或调用真实 AI。 */
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { setTimeout: delay } = require('timers/promises');

const SERVER_PATH = path.resolve(__dirname, '../server.js');
const TEST_JWT = 'startup_test_only_not_a_real_secret';
const TEST_ORIGIN = 'https://startup.example.test';

async function until(predicate, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error(message);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('测试监听端口未及时关闭')), 5000);
    server.close(error => {
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    });
  });
}

async function unusedPort() {
  const reservation = net.createServer();
  const port = await listen(reservation);
  await close(reservation);
  return port;
}

function request(port, route, { method = 'GET', body, headers = {} } = {}) {
  const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: route, method,
      headers: { ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        let json;
        try { json = text ? JSON.parse(text) : null; }
        catch (error) { reject(new Error('响应不是 JSON：' + error.message)); return; }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.setTimeout(2000, () => req.destroy(new Error('测试 HTTP 请求超时')));
    req.on('error', reject);
    req.end(payload);
  });
}

async function withChild(dbPort, env, run) {
  const port = await unusedPort();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'science-lab-startup-'));
  // 不展开 process.env：避免继承 Key、JWT、NODE_OPTIONS 或 dotenv 配置。
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd,
    env: {
      NODE_ENV: 'test', PORT: String(port),
      DB_HOST: '127.0.0.1', DB_PORT: String(dbPort),
      DB_USER: 'startup_test', DB_NAME: 'startup_test',
      CORS_ORIGINS: TEST_ORIGIN,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let outcome;
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-20000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-20000); });
  child.once('error', error => { output += error.message; });
  child.once('close', (code, signal) => { outcome = { code, signal }; });
  const isListening = () => output.includes('listening on 127.0.0.1:' + port);
  const service = {
    request: (route, options) => request(port, route, options),
    async ready() {
      await until(() => outcome || isListening(), '服务未及时启动');
      assert.strictEqual(outcome, undefined, '服务应启动但提前退出：' + output);
    },
    async fails(pattern) {
      await until(() => outcome || isListening(), '服务未及时拒绝启动');
      assert.ok(outcome, '服务应拒绝启动，但实际开始监听');
      assert.strictEqual(outcome.signal, null);
      assert.notStrictEqual(outcome.code, 0);
      assert.match(output, pattern);
      assert.strictEqual(isListening(), false);
      return output;
    },
  };
  try {
    await run(service);
  } finally {
    if (!outcome) {
      child.kill('SIGTERM');
      try { await until(() => outcome, '子进程未响应 SIGTERM', 1500); }
      catch {
        child.kill('SIGKILL');
        await until(() => outcome, '测试子进程无法清理');
      }
    }
    fs.rmdirSync(cwd);
  }
}

(async () => {
  let connections = 0;
  const dbTrap = net.createServer(socket => {
    connections++;
    socket.destroy();
  });
  const dbPort = await listen(dbTrap);
  let pass = 0;
  let fail = 0;
  async function test(name, env, run) {
    try {
      await withChild(dbPort, env, run);
      console.log('  ✓', name); pass++;
    } catch (error) {
      console.error('  ✗', name + '：' + error.message); fail++;
    }
  }
  try {
    await test('ai-only 无 JWT / 数据库也能真实启动，健康检查 200', { APP_MODE: 'ai-only' }, async service => {
      const before = connections;
      await service.ready();
      const health = await service.request('/health', { headers: { Origin: TEST_ORIGIN } });
      assert.strictEqual(health.status, 200);
      assert.deepStrictEqual(health.json, { ok: true });
      assert.strictEqual(health.headers['access-control-allow-origin'], TEST_ORIGIN);
      assert.strictEqual(connections, before, 'ai-only 不应连接数据库');
    });

    await test('ai-only 即使有 JWT 也不连接数据库；缺 Key 返回 503', {
      APP_MODE: 'ai-only', JWT_SECRET: TEST_JWT,
    }, async service => {
      const before = connections;
      await service.ready();
      const response = await service.request('/ai/chat/completions', {
        method: 'POST', body: { messages: [{ role: 'user', content: '你好' }] },
      });
      assert.strictEqual(response.status, 503);
      assert.strictEqual(response.json.error, 'ai_unavailable');
      assert.strictEqual(connections, before, 'ai-only 不应连接数据库');
    });

    await test('ai-only 禁用旧接口的路径、子路径、方法和预检', {
      APP_MODE: 'ai-only', JWT_SECRET: TEST_JWT, DB_DRIVER: 'memory',
    }, async service => {
      await service.ready();
      const methods = ['OPTIONS', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
      const routes = ['/auth', '/auth/', '/auth/register', '/AUTH/login/', '/auth/unknown',
        '/progress', '/progress/', '/PROGRESS?source=test', '/progress/unknown'];
      for (const route of routes) {
        for (const method of methods) {
          const response = await service.request(route, {
            method,
            headers: { Origin: TEST_ORIGIN, 'Access-Control-Request-Method': 'POST' },
          });
          assert.strictEqual(response.status, 503, method + ' ' + route);
          assert.deepStrictEqual(response.json, method === 'HEAD' ? null : { error: 'sync_disabled' });
        }
      }
      const malformed = await service.request('/auth/register', { method: 'POST', body: '{' });
      assert.strictEqual(malformed.status, 503);
      assert.deepStrictEqual(malformed.json, { error: 'sync_disabled' });
    });

    for (const mode of ['invalid-mode-test-value', 'AI-ONLY', ' ']) {
      await test('未知非空模式拒绝启动：' + JSON.stringify(mode), {
        APP_MODE: mode, JWT_SECRET: TEST_JWT, DB_DRIVER: 'memory',
      }, async service => {
        const output = await service.fails(/APP_MODE/);
        if (mode.trim()) assert.strictEqual(output.includes(mode), false, '不回显未知配置值');
      });
    }

    for (const [name, env] of [['未设置', {}], ['空字符串', { APP_MODE: '' }], ['显式 full', { APP_MODE: 'full' }]]) {
      await test(name + '模式仍要求 JWT', { ...env, DB_DRIVER: 'memory' }, async service => {
        await service.fails(/JWT_SECRET/);
      });
      await test(name + '模式有 JWT 但数据库不可用时失败，不静默降级', {
        ...env, JWT_SECRET: TEST_JWT,
      }, async service => {
        const before = connections;
        await service.fails(/启动失败/);
        assert.ok(connections > before, 'full 必须尝试初始化数据库');
      });
      await test(name + '模式的测试内存库保留注册、登录与进度', {
        ...env, JWT_SECRET: TEST_JWT, DB_DRIVER: 'memory',
      }, async service => {
        await service.ready();
        const credentials = { email: 'startup@example.test', password: 'test-password' };
        const registered = await service.request('/auth/register', { method: 'POST', body: credentials });
        assert.strictEqual(registered.status, 200);
        assert.ok(registered.json.token);
        const loggedIn = await service.request('/auth/login', { method: 'POST', body: credentials });
        assert.strictEqual(loggedIn.status, 200);
        assert.strictEqual(loggedIn.json.email, credentials.email);
        const headers = { Authorization: 'Bearer ' + loggedIn.json.token };
        assert.strictEqual((await service.request('/progress')).status, 401);
        const history = [{ path: 'startup.html', title: 'Startup', ts: 10 }];
        const saved = await service.request('/progress', { method: 'PUT', headers, body: { history } });
        assert.strictEqual(saved.status, 200);
        assert.deepStrictEqual(saved.json, { history });
        const loaded = await service.request('/progress', { headers });
        assert.strictEqual(loaded.status, 200);
        assert.deepStrictEqual(loaded.json, { history });
      });
    }
  } finally {
    await close(dbTrap);
  }
  console.log('\n启动模式测试：' + pass + ' 通过，' + fail + ' 失败');
  if (fail) process.exitCode = 1;
})().catch(error => { console.error('启动模式测试异常：', error); process.exitCode = 1; });
