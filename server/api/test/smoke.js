'use strict';
/* 端到端冒烟测试：内存 DB，覆盖注册/登录/鉴权/进度合并/CORS。
 * 运行：DB_DRIVER=memory JWT_SECRET=testsecret_testsecret node test/smoke.js
 */
process.env.DB_DRIVER = 'memory';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecret_testsecret_0123456789';
process.env.CORS_ORIGINS = 'https://albert-huo.github.io';

const assert = require('assert');
const app = require('../server');

let base;
function api(path, opts) { return fetch(base + path, opts); }

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = 'http://127.0.0.1:' + server.address().port;
  let pass = 0;
  const ok = (name) => { console.log('  ✓', name); pass++; };

  try {
    // health
    assert.strictEqual((await (await api('/health')).json()).ok, true); ok('health');

    // register
    let r = await api('/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'A@Example.com', password: 'secret1' }) });
    let j = await r.json();
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
    console.error('\n测试失败：', e.message); server.close(); process.exit(1);
  }
})();
