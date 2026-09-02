# Science-Lab Local Mode Risk Calibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 校准免登录与生产数据两处表述，并把每日限流、客户端中止和前端本地存储行为固化为自动化回归测试。

**Architecture:** 业务运行逻辑保持不变；文档明确仓库可验证边界和生产上线操作边界。服务端边缘行为使用独立 Node 进程测试，前端本地存储测试直接从 `index.html` 提取现有纯函数片段并在 `vm` 沙箱中执行，避免引入浏览器测试框架或生产模块拆分。

**Tech Stack:** Markdown、Node.js 18+、内置 `assert`/`vm`、现有 Express 冒烟测试。

---

## 文件结构

- Modify: `README.md` — 校准免登录和生产数据表述。
- Modify: `docs/aliyun-deploy.md` — 增加备份、基线核验、回滚和风险解除清单。
- Create: `server/api/test/ai-edge-cases.js` — 独立进程验证每日限流和客户端断开中止。
- Create: `server/api/test/frontend-storage.js` — 验证 `index.html` 中 AI 会话存储的三个边缘行为。
- Modify: `server/api/package.json` — 把新增测试加入现有 `npm test`。

用户已要求本轮不自动创建提交或 push，因此计划不包含 commit 步骤。

### Task 1: 校准 README 的事实边界

**Files:**
- Modify: `README.md:5-7`
- Modify: `README.md:67-69`

- [x] **Step 1: 写入“当前前端免登录”的限定说明**

在“免登录本地版”首段后加入：

```markdown
这里的“免登录”仅指当前 `index.html` 前端体验：页面不展示或调用注册、登录、云同步功能。为兼容已有部署，`server/api/` 仍保留旧账号与进度接口，但当前前端不会使用它们。
```

- [x] **Step 2: 写入生产数据校准说明**

把“旧接口兼容”段落扩展为：

```markdown
`server/api/` 仍保留旧版 `/auth/register`、`/auth/login` 和 `/progress` 接口及 MySQL 数据结构，以免破坏已有部署和历史数据；当前免登录前端不会调用这些接口。内置 AI 代理也由该 Node 服务提供，部署步骤见 `docs/aliyun-deploy.md`。

仓库审查只能确认本次改造没有修改 `server/api/db.js`、`server/api/schema.sql` 和旧接口行为，不能替代对生产 MySQL 内容的核验。升级已有部署前应先备份数据库，并按部署文档记录升级前后的用户数、进度记录数和最近更新时间。
```

- [x] **Step 3: 验证 README 不再产生歧义**

Run:

```bash
rg -n "免登录|旧接口兼容|生产 MySQL|不能替代" README.md
```

Expected: 同时出现“当前前端”“仍保留旧账号与进度接口”和“不能替代生产 MySQL 核验”。

### Task 2: 增加生产数据保护与风险解除运行手册

**Files:**
- Modify: `docs/aliyun-deploy.md:12-17`
- Modify: `docs/aliyun-deploy.md:121-165`

- [x] **Step 1: 在准备阶段增加数据库事实边界**

在“0. 准备”末尾加入：

```markdown
> “本次没有修改数据库代码或表结构”不等于“生产数据已经验证完好”。升级已有部署时，必须先完成下面的备份和只读基线核验；新建部署可跳过旧数据核验。
```

- [x] **Step 2: 增加备份与只读基线命令**

在建库章节末尾加入：

````markdown
### 升级已有部署：备份与基线核验

以下命令不会修改表数据。备份文件应放在仅管理员可读、且不位于 Git 仓库和 Web 根目录的位置：

```bash
sudo install -d -m 700 /var/backups/science-lab
SCIENCE_LAB_BACKUP_TAG=$(date '+%Y%m%d-%H%M%S')
sudo sh -c "umask 077; mysqldump -u sciencelab -p --single-transaction --routines --triggers sciencelab > /var/backups/science-lab/sciencelab-${SCIENCE_LAB_BACKUP_TAG}.sql"
sudo sh -c "umask 077; sha256sum /var/backups/science-lab/sciencelab-${SCIENCE_LAB_BACKUP_TAG}.sql > /var/backups/science-lab/sciencelab-${SCIENCE_LAB_BACKUP_TAG}.sql.sha256"

mysql -u sciencelab -p -N sciencelab -e \
  "SELECT 'users', COUNT(*) FROM users; SELECT 'progress', COUNT(*) FROM progress; SELECT 'latest_progress', COALESCE(MAX(updated_at), 'none') FROM progress;"
```

记录 `SCIENCE_LAB_BACKUP_TAG` 和三项查询输出。部署后再次执行相同的只读查询；若用户数、进度记录数意外减少，立即停止验证和写操作，保留现场并回滚应用。不要在原因不明时导入备份覆盖现库。
````

- [x] **Step 3: 增加应用文件回滚准备**

在更新发布章节加入：

````markdown
升级前先保存当前应用文件，数据库备份与应用文件备份分开保管：

```bash
sudo tar -C /opt -czf /var/backups/science-lab/science-lab-api-${SCIENCE_LAB_BACKUP_TAG}.tgz science-lab-api
sudo tar -C /var/www -czf /var/backups/science-lab/science-lab-web-${SCIENCE_LAB_BACKUP_TAG}.tgz science-lab
```

如新版本健康检查或真实 AI 验证失败，先确认当前 shell 中的 `SCIENCE_LAB_BACKUP_TAG` 与备份时记录一致（新会话需重新赋值），再执行：

```bash
sudo tar -C /opt -xzf /var/backups/science-lab/science-lab-api-${SCIENCE_LAB_BACKUP_TAG}.tgz
sudo tar -C /var/www -xzf /var/backups/science-lab/science-lab-web-${SCIENCE_LAB_BACKUP_TAG}.tgz
pm2 restart science-lab-api --update-env
nginx -t && nginx -s reload
```

本次没有数据库迁移，不要为应用回滚而重建或回滚数据库结构。
````

- [x] **Step 4: 增加风险解除清单**

在“安全要点”后增加：

```markdown
## 上线风险解除清单

- **匿名费用风险**：使用服务端专用 Key，并将供应商账户的可用余额或预算控制在可承受范围；监控 429、502 和调用量。CORS 不是访问控制，不能阻止脚本或 `curl` 调用。
- **共享出口 IP**：学校或宿舍用户可能共用一个公网 IP。先保持默认限额；只有确认正常课堂流量出现大量 429 后，才逐步上调分钟上限，同时保留每日费用边界。
- **多实例限流**：未接入 Redis store 或网关全局限流前，只运行一个 PM2 fork 实例，不启用 cluster 或横向副本。
- **真实上游**：配置费用控制后只做一次小额 `curl -N` 验证，确认持续输出和 `[DONE]` 正常结束；失败时先停用 Key，不连续重试。
- **生产数据**：上线前后比较 `users`、`progress` 数量和 `MAX(updated_at)`；仓库文件未变不代表生产数据已经核验。
- **多标签页覆盖**：当前接受极少数同时写入覆盖的边缘风险。若出现真实反馈，再单独设计基于 `storage` 事件和版本戳的合并机制。
- **回归保护**：每次发布前运行 `cd server/api && npm test`，必须同时通过旧接口、AI 边缘行为和前端本地存储测试。
```

- [x] **Step 5: 检查命令引用的表名真实存在**

Run:

```bash
rg -n "CREATE TABLE IF NOT EXISTS (users|progress)|updated_at" server/api/schema.sql
rg -n "mysqldump|COUNT\(\*\)|MAX\(updated_at\)|上线风险解除清单" docs/aliyun-deploy.md
```

Expected: `users`、`progress`、`updated_at` 与 schema 完全一致，风险解除清单七项齐全。

### Task 3: 固化 AI 每日限流和客户端中止测试

**Files:**
- Create: `server/api/test/ai-edge-cases.js`
- Modify: `server/api/package.json:7-10`

- [x] **Step 1: 新建独立边缘测试**

创建 `server/api/test/ai-edge-cases.js`：

```js
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
```

- [x] **Step 2: 单独运行边缘测试**

Run:

```bash
cd server/api
node test/ai-edge-cases.js
```

Expected: `边缘测试通过：2 项`，且没有真实网络调用。

### Task 4: 固化前端本地存储测试

**Files:**
- Create: `server/api/test/frontend-storage.js`
- Modify: `server/api/package.json:7-10`

- [x] **Step 1: 新建前端存储测试**

创建 `server/api/test/frontend-storage.js`：

```js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.resolve(__dirname, '../../../index.html'), 'utf8');
const start = html.indexOf('const CHAT_TOTAL_MAX=200');
const end = html.indexOf("let chatPath='', chatHistory=[], chatBusy=false;", start);
assert.ok(start >= 0 && end > start, '找不到 index.html 中的 AI 存储逻辑');
const source = html.slice(start, end) + '\nthis.chatApi={loadChatStore,persistChat};';

function harness(initial) {
  const values = new Map(Object.entries(initial || {}));
  const control = { failChatWrites: false };
  const toasts = [];
  const localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) {
      if (control.failChatWrites && key === 'expfeed.chat') throw new Error('quota_exceeded');
      values.set(key, String(value));
    },
    removeItem(key) { values.delete(key); },
  };
  const context = vm.createContext({
    localStorage,
    location: { protocol: 'https:', hostname: 'lab.example', origin: 'https://lab.example' },
    LS: { ai: 'expfeed.ai', chat: 'expfeed.chat' },
    toast(message) { toasts.push(message); },
  });
  vm.runInContext(source, context);
  return { api: context.chatApi, localStorage, control, toasts };
}

let pass = 0;
const ok = name => { console.log('  ✓', name); pass++; };

{
  const test = harness({ 'expfeed.chat': '{bad json' });
  assert.strictEqual(JSON.stringify(test.api.loadChatStore()), '{}');
  assert.strictEqual(test.localStorage.getItem('expfeed.chat'), '{}');
  ok('损坏的 AI 会话 JSON 自动重置');
}

{
  const messages = Array.from({ length: 201 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: 'm' + String(index + 1).padStart(3, '0'),
    ts: index + 1,
  }));
  const test = harness({ 'expfeed.chat': JSON.stringify({ experiment: messages }) });
  const clean = JSON.parse(JSON.stringify(test.api.loadChatStore()));
  assert.strictEqual(clean.experiment.length, 200);
  assert.strictEqual(clean.experiment[0].content, 'm002');
  ok('超过 200 条时淘汰最旧记录');
}

{
  const oldRaw = JSON.stringify({
    experiment: [{ role: 'user', content: 'old', ts: 1 }],
  });
  const test = harness({ 'expfeed.chat': oldRaw });
  test.control.failChatWrites = true;
  const saved = test.api.persistChat('experiment', [
    { role: 'user', content: 'new', ts: 2 },
  ]);
  assert.strictEqual(saved, false);
  assert.strictEqual(test.localStorage.getItem('expfeed.chat'), oldRaw);
  assert.deepStrictEqual(test.toasts, ['对话记录保存失败，原有记录已保留']);
  ok('写入失败时保留旧记录并提示');
}

console.log('\n前端存储测试通过：' + pass + ' 项');
```

- [x] **Step 2: 单独运行前端存储测试**

Run:

```bash
cd server/api
node test/frontend-storage.js
```

Expected: `前端存储测试通过：3 项`。

- [x] **Step 3: 把新增测试加入统一入口**

把 `server/api/package.json` 的脚本改为：

```json
"scripts": {
  "start": "node server.js",
  "test": "node test/smoke.js && node test/ai-edge-cases.js && node test/frontend-storage.js"
}
```

### Task 5: 完整验证与交付检查

**Files:**
- Verify: `README.md`
- Verify: `docs/aliyun-deploy.md`
- Verify: `server/api/test/ai-edge-cases.js`
- Verify: `server/api/test/frontend-storage.js`
- Verify: `server/api/package.json`

- [x] **Step 1: 运行统一测试**

Run:

```bash
cd server/api
npm test
```

Expected: 原有 18 项、AI 边缘 2 项、前端存储 3 项全部通过，共 23 项。

- [x] **Step 2: 运行语法与补丁检查**

Run:

```bash
node --check server.js
node --check test/smoke.js
node --check test/ai-edge-cases.js
node --check test/frontend-storage.js
cd ../..
git diff --check
```

Expected: 所有命令退出码为 0，无输出错误。

- [x] **Step 3: 核对变更范围**

Run:

```bash
git status --short
git diff --stat
git diff -- README.md docs/aliyun-deploy.md server/api/package.json server/api/test/ai-edge-cases.js server/api/test/frontend-storage.js
```

Expected: 只有已批准的设计/计划、两份业务文档、两个新增测试和 `package.json`；`server.js`、`index.html`、数据库文件及静态资源均未修改。
