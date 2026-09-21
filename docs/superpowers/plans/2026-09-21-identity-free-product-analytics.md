# Identity-Free Product Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不创建访客标识、不设置统计 Cookie、不保存 IP/UA/Referer/原始事件的前提下，为实验馆增加页面、实验和固定操作的聚合统计，并在私有后台与安全流量分区展示。

**Architecture:** 公共页面通过独立 `product-analytics.js` 发送固定白名单事件；实验路径先在浏览器内 SHA-256 成稳定内容 ID，网络请求不携带路径。Node 只校验同源元数据和事件枚举，再用 Redis Lua 脚本按 Redis 服务器时间直接增加小时/每日 Hash，绝不写原始事件。独立快照任务只读统计 Redis，发布受 BasicAuth 保护的 `analytics.json`；既有流量 HTML 动态读取该快照并渲染“网站使用概览”，安全日志和自动化分类保持原链路。

**Tech Stack:** Vanilla JavaScript、Node.js 22 / Express 4、Redis 6.2 Lua、Nginx、systemd 239、Node `node:test` / `assert`、现有静态 Service Worker 与私有流量后台。

---

## 文件结构与职责

新建：

- `product-analytics.js`：浏览器端无状态事件客户端、来源分类、实验内容 ID 哈希与尽力发送。
- `privacy.html`：公开隐私说明；区分产品统计与安全日志。
- `server/api/product-analytics.js`：严格 schema、内容目录、Redis 原子聚合和故障隔离。
- `server/api/test/frontend-product-analytics.js`：浏览器客户端无 Cookie/无存储/无原路径契约。
- `server/api/test/product-analytics.js`：事件校验、固定维度和 Lua 调用单元测试。
- `server/api/test/product-analytics-redis.js`：隔离 Redis 中的小时/每日原子计数、TTL、重启持久性和无身份键检查。
- `server/api/test/product-analytics-route.js`：真实 Express 路由的同源、Content-Type、query、大小、响应头及降级测试。
- `tools/product-analytics-snapshot.cjs`：只读 Redis，构造有界、去身份的 24 小时/400 日快照并原子发布。
- `tools/product-analytics-view.cjs`：验证快照并生成后台展示模型。
- `tools/traffic-dashboard-product.css`：产品统计区的卡片、趋势、排行和隐私状态样式。
- `server/api/test/product-analytics-snapshot.js`：只读采样、数据白名单、错误与原子发布测试。
- `server/traffic/nginx-product-analytics.conf`：`http` 上下文匿名日志格式与内存限流 zone。
- `server/traffic/science-lab-analytics-redis.service`：独立本地 Redis 服务，读取服务器私有配置。
- `server/traffic/science-lab-api-analytics.conf`：API 服务加载独立统计环境文件。
- `server/traffic/science-lab-product-analytics-snapshot.service` 与 `.timer`：每五分钟刷新私有快照。

修改：

- `index.html`：加载统计客户端、发送页面/实验/固定操作事件并增加隐私入口。
- `sw.js`：升级壳版本并缓存统计客户端与隐私页；继续绕过所有 POST/API。
- `server/api/server.js`：在通用 256KB JSON 解析器前安装 2KB 专用统计路由。
- `server/api/package.json`：纳入新增测试。
- `tools/traffic-dashboard-view.cjs`、`traffic-dashboard-client.js`：加入产品概览、快照校验与刷新。
- `server/api/test/traffic-dashboard-view.js`、`service-worker-cache.js`：后台语义和静态缓存回归。
- `server/traffic/nginx-locations.conf`：增加精确统计 POST 路由并允许后台读取 `analytics.json`。
- `server/traffic/README.md`、`docs/aliyun-deploy.md`、`README.md`：运行文件、数据边界、部署与回滚。
- `docs/superpowers/specs/2026-09-21-identity-free-product-analytics-design.md`：明确首版完成事件未接入且不使用代理指标。

不修改：AI 提示词、模型配置、AI 配额规则、普通安全日志格式、机器人分类规则、原 6379 Redis 和 `science-lab-quota-redis` 16379 实例。

### Task 1: 浏览器无身份事件客户端

**Files:**
- Create: `product-analytics.js`
- Create: `server/api/test/frontend-product-analytics.js`
- Modify: `server/api/package.json`

- [x] **Step 1: 写失败测试，锁定无状态网络契约**

测试导出的 `classifySource`、`experimentId` 和 `createClient`：

```js
const analytics = require('../../../product-analytics.js');
assert.equal(analytics.classifySource('', 'https://lab.xingnian.net.cn'), 'direct');
assert.equal(analytics.classifySource('https://lab.xingnian.net.cn/a', 'https://lab.xingnian.net.cn'), 'internal');
assert.equal(analytics.classifySource('https://www.baidu.com/s?wd=x', 'https://lab.xingnian.net.cn'), 'search');
assert.equal(analytics.classifySource('https://example.com/path?q=secret', 'https://lab.xingnian.net.cn'), 'external');
assert.match(await analytics.experimentId('physics-middle/初中物理实验1.html', crypto.webcrypto), /^[a-f0-9]{64}$/);

const sent = [];
const client = analytics.createClient({
  endpoint: '/api/analytics/events',
  fetchImpl: async (url, options) => { sent.push({ url, options }); return new Response(null, { status: 204 }); },
  cryptoImpl: crypto.webcrypto,
});
await client.pageView('direct');
await client.experimentOpen('physics-middle/初中物理实验1.html');
await client.keyAction('catalog_open');
assert.equal(sent.every(item => item.options.credentials === 'omit'), true);
assert.equal(sent.every(item => item.options.referrerPolicy === 'no-referrer'), true);
assert.equal(JSON.stringify(sent).includes('初中物理实验1.html'), false);
```

同时以没有 `localStorage`、`document.cookie` 和 IndexedDB 的 VM 运行客户端，证明模块不依赖或创建浏览器状态；网络失败应被吞并为 `false`，不能重试或抛给页面。

- [x] **Step 2: 运行测试并确认因文件缺失失败**

Run: `node --test server/api/test/frontend-product-analytics.js`

Expected: FAIL，错误包含 `Cannot find module '../../../product-analytics.js'`。

- [x] **Step 3: 实现最小客户端**

模块只导出以下固定接口：

```js
const SOURCES = new Set(['direct', 'internal', 'search', 'external']);
const ACTIONS = new Set(['catalog_open', 'profile_open', 'experiment_previous', 'experiment_next']);

function createClient({ endpoint = '/api/analytics/events', fetchImpl = globalThis.fetch,
  cryptoImpl = globalThis.crypto } = {}) {
  async function send(body) {
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return response.status === 204;
    } catch { return false; }
  }
  return {
    pageView: source => SOURCES.has(source) && send({ v: 1, event: 'page_view', page_id: 'home', source }),
    experimentOpen: async path => send({ v: 1, event: 'experiment_open', experiment_id: await experimentId(path, cryptoImpl) }),
    keyAction: action => ACTIONS.has(action) && send({ v: 1, event: 'key_action', page_id: 'home', action_id: action }),
  };
}
```

`classifySource` 只返回四个枚举；无法解析的非空来源归入 `external`。`experimentId` 对 UTF-8 路径执行 SHA-256，不提供弱哈希回退；Web Crypto 不可用时跳过该事件。

- [x] **Step 4: 运行测试确认通过**

Run: `node --test server/api/test/frontend-product-analytics.js`

Expected: PASS，输出 0 failures。

- [x] **Step 5: 提交客户端**

```bash
git add product-analytics.js server/api/test/frontend-product-analytics.js server/api/package.json
git commit -m "feat: add identity-free analytics client"
```

### Task 2: 严格事件校验与 Redis 直接聚合

**Files:**
- Create: `server/api/product-analytics.js`
- Create: `server/api/test/product-analytics.js`
- Create: `server/api/test/product-analytics-redis.js`
- Modify: `server/api/package.json`

- [x] **Step 1: 写校验与 Redis 调用失败测试**

建立目录时只从受信 `ai-context.json` 的路径计算 SHA-256，并验证合法事件：

```js
const catalog = buildCatalog(require('../ai-context.json'));
const id = createHash('sha256').update('physics-middle/初中物理实验1.html').digest('hex');
assert.deepEqual(validateEvent({ v: 1, event: 'experiment_open', experiment_id: id }, catalog),
  { event: 'experiment_open', dimension: id });
assert.throws(() => validateEvent({ v: 1, event: 'experiment_complete', experiment_id: id }, catalog), /invalid_event/);
assert.throws(() => validateEvent({ v: 1, event: 'page_view', page_id: 'home', source: 'direct', extra: 'x' }, catalog), /invalid_event/);
```

用假 Redis 客户端断言一次有效事件只有一个 `EVAL`，参数只含固定 namespace、事件名、固定维度和 TTL；传入对象、数组、超长字段、未知实验、自由 action、时间/IP/UA/Cookie/Referer 字段全部拒绝。

- [x] **Step 2: 运行单元测试确认正确失败**

Run: `node --test server/api/test/product-analytics.js`

Expected: FAIL，错误指向缺少服务模块。

- [x] **Step 3: 实现目录、schema 和 Lua 聚合器**

生产模块导出：

```js
module.exports = { buildCatalog, validateEvent, createProductAnalytics, RECORD_SCRIPT,
  ACTIONS, SOURCES, HOUR_TTL_SECONDS, DAY_TTL_SECONDS };
```

允许事件只有：`page_view -> home + source`、`experiment_open -> 受信 64 位内容 ID`、`key_action -> home + 固定 action`。Lua 使用 Redis `TIME` 计算 UTC 小时和北京时间自然日，分别更新以下有界 Hash：

```text
science-lab:analytics:v1:hour:<epoch>:{totals,sources,experiments,actions}
science-lab:analytics:v1:day:<epoch>:{totals,sources,experiments,actions}
```

小时 TTL 48 小时，每日 TTL 为 400 天加 48 小时。`createProductAnalytics` 只接受回环 Redis URL，禁用离线队列，连接与命令有界；未配置或 Redis 故障时 `record` 返回固定 unavailable，不阻止 API 启动。

- [x] **Step 4: 运行单元测试确认通过**

Run: `node --test server/api/test/product-analytics.js`

Expected: PASS。

- [x] **Step 5: 写并运行真实隔离 Redis 测试**

并发记录 24 个页面事件，断言小时/每日均为 24、TTL 正确、所有键和值没有 IP、UA、visitor/session 或原路径；重连后计数保留。系统缺少 `redis-server` 时明确 SKIP。

Run: `node --test server/api/test/product-analytics-redis.js`

Expected: PASS。

- [x] **Step 6: 提交服务核心**

```bash
git add server/api/product-analytics.js server/api/test/product-analytics.js server/api/test/product-analytics-redis.js server/api/package.json
git commit -m "feat: aggregate anonymous product events"
```

### Task 3: 接入公共页面和精确 API 路由

**Files:**
- Modify: `server/api/server.js`
- Create: `server/api/test/product-analytics-route.js`
- Modify: `index.html`
- Modify: `sw.js`
- Modify: `server/api/test/service-worker-cache.js`
- Modify: `server/api/package.json`

- [x] **Step 1: 写路由失败测试**

真实 `server.js` 配合隔离 Redis 验证合法事件 204、无 `Set-Cookie`；query 400、跨源 403、超 2KB 413、错误 Content-Type 415、Redis 不可用 503，且 `/health` 与现有 AI 行为不受影响。

- [x] **Step 2: 运行路由测试确认合法事件当前 404**

Run: `node --test server/api/test/product-analytics-route.js`

Expected: FAIL，合法事件当前返回 404。

- [x] **Step 3: 在通用解析器之前安装专用路由**

使用 `express.json({ limit:'2kb', strict:true, type:'application/json' })`；要求 `req.originalUrl === '/analytics/events'`、Origin 等于 `ANALYTICS_ORIGIN`、`Sec-Fetch-Site` 为 `same-origin`。全局固定 key 内存分钟限流作为第二道保护；成功 204、非法 400/403/415、超限 429、存储不可用 503，均 `Cache-Control:no-store`。

- [x] **Step 4: 运行路由与启动回归**

Run: `node --test server/api/test/product-analytics-route.js server/api/test/startup-modes.js server/api/test/ai-route-policy.js`

Expected: PASS。

- [x] **Step 5: 写前端接入与缓存失败测试**

要求 `index.html` 加载 `product-analytics.js?app=v0.8.13`，页面只发送一次 page view；`render()` 只统计当前实验而不统计相邻预加载；目录/我的/上一实验/下一实验使用固定 action；不存在完成/停留/滚动推断。`sw.js` 升为 `v0.8.13`，缓存客户端，继续绕过 POST/API。

Run: `node --test server/api/test/frontend-product-analytics.js server/api/test/service-worker-cache.js`

Expected: FAIL，缺少接入。

- [x] **Step 6: 实现接入并通过测试**

事件尽力发送且不等待 UI。`goTo` 同一索引不重复计数；预加载 iframe 的 `load` 不上报。上一/下一 action 只在实际切换成功时记录。

Run: `node --test server/api/test/frontend-product-analytics.js server/api/test/service-worker-cache.js`

Expected: PASS。

- [x] **Step 7: 提交端到端事件入口**

```bash
git add server/api/server.js server/api/test/product-analytics-route.js index.html sw.js server/api/test/service-worker-cache.js server/api/package.json
git commit -m "feat: collect anonymous product events"
```

### Task 4: 只读产品统计快照

**Files:**
- Create: `tools/product-analytics-snapshot.cjs`
- Create: `tools/product-analytics-view.cjs`
- Create: `server/api/test/product-analytics-snapshot.js`
- Modify: `server/api/package.json`

- [x] **Step 1: 写快照失败测试**

`validateSnapshot` 必须拒绝未知字段、负数、非安全整数、未知 action/source、重复实验、超长标题和身份字符串。`readSnapshot` 必须得到 24 个小时桶、最多 400 天历史，且：

```js
assert.equal(snapshot.schema, 1);
assert.equal(snapshot.hours.length, 24);
assert.ok(snapshot.days.length <= 400);
assert.deepEqual(snapshot.privacy, {
  mode: 'identity_free', cookie: false, fingerprint: false, crossPage: false,
  crossDay: false, uv: 'not_collected', sessions: 'not_collected', completion: 'not_connected',
});
assert.equal(JSON.stringify(snapshot).includes('physics-middle/'), false);
assert.equal(JSON.stringify(snapshot).includes('192.0.2.'), false);
```

每日历史只保留总量；当前 24 小时保留来源、固定 action 与内容 ID 计数并映射前 10 个公开实验标题。采集前为 unavailable，跨启用时刻为 partial，不能补零。

- [x] **Step 2: 运行测试确认模块缺失**

Run: `node --test server/api/test/product-analytics-snapshot.js`

Expected: FAIL，找不到快照模块。

- [x] **Step 3: 实现有界只读采样和原子发布**

只接受回环 Redis，设置 `disableOfflineQueue:true`、禁重连和 2 秒总截止。以 Redis `TIME` 为基准，批量读取最近 24 小时与 400 个北京时间日总量；总字段、实验数和输出字节均有上限。快照结构固定为：

```js
{
  schema: 1, capturedAt, collectionStart, available: true, reason: null,
  privacy,
  totals: { pageViews, experimentOpens, keyActions, sources, actions, topExperiments },
  hours: [{ start, end, coverage, pageViews, experimentOpens, keyActions }],
  days: [{ day, coverage, pageViews, experimentOpens, keyActions }],
}
```

`publishSnapshot` 用 0600 临时文件、fsync、chmod 0644、rename 原子替换 `www/analytics.json`，拒绝符号链接。Redis 失败且已有有效快照时保留旧文件并退出非零；首次无文件时发布固定 unavailable 状态。

- [x] **Step 4: 运行快照测试确认通过**

Run: `node --test server/api/test/product-analytics-snapshot.js`

Expected: PASS。

- [x] **Step 5: 提交快照功能**

```bash
git add tools/product-analytics-snapshot.cjs tools/product-analytics-view.cjs server/api/test/product-analytics-snapshot.js server/api/package.json
git commit -m "feat: publish private product analytics snapshots"
```

### Task 5: 私有后台产品概览与口径分区

**Files:**
- Create: `tools/traffic-dashboard-product.css`
- Modify: `tools/traffic-dashboard-view.cjs`
- Modify: `tools/traffic-dashboard-client.js`
- Modify: `server/api/test/traffic-dashboard-view.js`
- Modify: `server/api/test/product-analytics-snapshot.js`

- [x] **Step 1: 写后台语义失败测试**

```js
assert.match(html, /网站使用概览/);
assert.match(html, /页面浏览 PV/);
assert.match(html, /UV[\s\S]*未采集/);
assert.match(html, /实验完成事件[\s\S]*未接入/);
assert.match(html, /匿名事件计数可能包含自动化访问/);
assert.match(html, /安全流量/);
assert.doesNotMatch(html, /疑似真人 UV|高置信真人/);
```

客户端限制 `analytics.json` 为 2MB，先用 `productAnalyticsPresentation` 验证，再渲染卡片、24 小时柱形、来源、固定操作、前 10 实验和隐私状态。失败时显示无法读取，不把数值变成 0。

- [x] **Step 2: 运行测试确认页面缺少产品区**

Run: `node --test server/api/test/traffic-dashboard-view.js server/api/test/product-analytics-snapshot.js`

Expected: FAIL，缺少“网站使用概览”。

- [x] **Step 3: 实现后台区块与客户端刷新**

产品区位于安全流量卡片之前，使用独立背景和标题。初始值为“—/未采集”，载入、恢复可见、手动刷新和每五分钟读取 `analytics.json`。既有 `trafficData`、额度刷新、CSV 和自动化图表逻辑不改。

新增产品 CSV 只导出每日总量和固定维度，与安全流量 CSV 使用不同按钮和文件名；不含 IP、UA、原始路径、事件序列或哈希以外的实验内部标识。

- [x] **Step 4: 运行后台测试确认通过**

Run: `node --test server/api/test/traffic-dashboard-view.js server/api/test/product-analytics-snapshot.js`

Expected: PASS。

- [x] **Step 5: 提交后台展示**

```bash
git add tools/traffic-dashboard-product.css tools/traffic-dashboard-view.cjs tools/traffic-dashboard-client.js server/api/test/traffic-dashboard-view.js server/api/test/product-analytics-snapshot.js
git commit -m "feat: separate product usage from security traffic"
```

### Task 6: 隐私说明与首版完成事件边界

**Files:**
- Create: `privacy.html`
- Modify: `index.html`
- Modify: `sw.js`
- Modify: `server/api/test/frontend-product-analytics.js`
- Modify: `docs/superpowers/specs/2026-09-21-identity-free-product-analytics-design.md`

- [x] **Step 1: 写隐私页面失败测试**

要求页脚有可见 `privacy.html` 链接；隐私页明确包含无统计 Cookie、无访客 ID、无指纹、无 IP 用户轨迹、安全日志分开、保存期限、未成年人、联系渠道和第二层未启用。不得包含外部脚本、统计 SDK、默认同意或“继续使用即同意”。

Run: `node --test server/api/test/frontend-product-analytics.js`

Expected: FAIL，隐私页面不存在。

- [x] **Step 2: 实现静态隐私说明与页脚入口**

使用站点深色视觉语言，纯 HTML/CSS，无 JavaScript 和第三方资源。安全日志期限写“按适用法律与安全需要另行管理”，不在未专项评估时承诺全部原始 Nginx 日志保存六个月；产品每日聚合最多 400 天。

- [x] **Step 3: 固化完成事件未接入规则**

首版后端拒绝 `experiment_complete`，后台显示“未接入”，不把滚动到底、停留时间、页面离开或历史记录当作完成。

- [x] **Step 4: 运行静态与缓存测试**

Run: `node --test server/api/test/frontend-product-analytics.js server/api/test/service-worker-cache.js`

Expected: PASS。

- [x] **Step 5: 提交隐私文案**

```bash
git add privacy.html index.html sw.js server/api/test/frontend-product-analytics.js docs/superpowers/specs/2026-09-21-identity-free-product-analytics-design.md
git commit -m "docs: publish privacy notice for aggregate analytics"
```

### Task 7: Nginx、Redis 与 systemd 运行配置

**Files:**
- Create: `server/traffic/nginx-product-analytics.conf`
- Create: `server/traffic/science-lab-analytics-redis.service`
- Create: `server/traffic/science-lab-api-analytics.conf`
- Create: `server/traffic/science-lab-product-analytics-snapshot.service`
- Create: `server/traffic/science-lab-product-analytics-snapshot.timer`
- Modify: `server/traffic/nginx-locations.conf`
- Modify: `server/traffic/README.md`
- Modify: `docs/aliyun-deploy.md`
- Modify: `README.md`
- Create: `server/api/test/product-analytics-operations.js`
- Modify: `server/api/package.json`

- [x] **Step 1: 写配置失败测试**

```js
assert.match(httpConfig, /limit_req_zone \$binary_remote_addr zone=science_lab_analytics:1m rate=10r\/s/);
for (const forbidden of ['remote_addr', 'http_user_agent', 'http_referer', 'http_cookie', 'request_uri', 'request_body'])
  assert.equal(logFormat.includes('$' + forbidden), false);
assert.match(locations, /location = \/api\/analytics\/events/);
assert.match(locations, /proxy_set_header (Cookie|User-Agent|Referer|X-Forwarded-For|X-Real-IP) ""/);
assert.match(locations, /client_max_body_size 2k/);
assert.match(locations, /analytics\.json/);
```

systemd 测试检查独立 Redis 服务、回环网络、受限目录、`MemoryMax=96M`、快照五分钟 timer，以及不引用 AI 的 16379 或 `AI_REDIS_URL`。

- [x] **Step 2: 运行配置测试确认失败**

Run: `node --test server/api/test/product-analytics-operations.js`

Expected: FAIL，新增配置文件不存在。

- [x] **Step 3: 实现匿名 Nginx 入口**

`http` 配置：

```nginx
limit_req_zone $binary_remote_addr zone=science_lab_analytics:1m rate=10r/s;
log_format science_lab_product escape=json '{"time":"$time_iso8601","status":"$status","duration":"$request_time","requestLength":"$request_length","upstreamStatus":"$upstream_status"}';
```

精确 location 只接受 POST、2KB、burst 30；覆盖普通 access log，清空身份头，只传固定 Host、Origin、Sec-Fetch-Site 和 Content-Type，代理到 `127.0.0.1:8970/analytics/events`。私有后台 allowlist 增加 `analytics.json`，仍由相同 BasicAuth、no-store 和禁止索引保护。

- [x] **Step 4: 实现独立服务文件**

Redis 服务读取 `/etc/science-lab-analytics-redis.conf`，使用 `redis` 用户和 `/var/lib/science-lab-analytics-redis`，`MemoryMax=96M`。服务器私有配置在部署时固定为 `127.0.0.1:16380`、32MB `maxmemory`、`noeviction`、AOF everysec、禁用 RDB、独立随机密码。

API drop-in 与快照服务共同读取 root:root 0600 的 `/etc/science-lab-analytics.env`；快照只允许回环网络和写 `/var/lib/science-lab-traffic/www`。Timer 使用 `OnBootSec=2min`、`OnUnitActiveSec=5min`。

- [x] **Step 5: 更新运维文档并通过配置测试**

文档列出新增运行文件、权限、密钥生成但禁止输出、备份、部署顺序、健康验证和回滚。明确 16380 已于 2026-09-21 只读核验未占用，生产启用前仍即时复核。

Run: `node --test server/api/test/product-analytics-operations.js`

Expected: PASS。

- [x] **Step 6: 提交运行配置**

```bash
git add server/traffic server/api/test/product-analytics-operations.js server/api/package.json docs/aliyun-deploy.md README.md
git commit -m "ops: isolate anonymous analytics runtime"
```

### Task 8: 全量验证、计划回填与分支集成

**Files:**
- Modify: `docs/superpowers/plans/2026-09-21-identity-free-product-analytics.md`

- [x] **Step 1: 运行隐私静态扫描**

Run:

```bash
rg -n "visitor_id|session_id|fingerprint|remote_addr|http_user_agent|http_referer|http_cookie|request_body" product-analytics.js server/api/product-analytics.js tools/product-analytics-* server/traffic/nginx-product-analytics.conf server/traffic/nginx-locations.conf
```

Expected: 命中仅出现在拒绝测试、隐私文案或 Nginx 清空头配置；任何存储或日志字段命中都先修复。

- [x] **Step 2: 运行聚焦测试**

Run:

```bash
node --test server/api/test/frontend-product-analytics.js server/api/test/product-analytics.js server/api/test/product-analytics-redis.js server/api/test/product-analytics-route.js server/api/test/product-analytics-snapshot.js server/api/test/product-analytics-operations.js server/api/test/traffic-dashboard-view.js server/api/test/service-worker-cache.js
```

Expected: 0 failures；Redis 可执行文件存在时集成项不得跳过。

- [x] **Step 3: 运行全量与格式验证**

Run:

```bash
npm test --prefix server/api
git diff --check
git status --short
```

Expected: 全量测试退出 0，格式无错误，只显示本计划相关已跟踪改动。

- [x] **Step 4: 隔离无头浏览器验证**

启动本地静态/API/隔离 Redis，使用任务自有无头浏览器上下文验证桌面与手机：公共首页不出现 Banner、不设置 Cookie；页面/实验/操作事件写入聚合；后台显示产品区、UV 未采集、完成未接入；关闭 Redis 后公共实验仍可用且后台显示陈旧/不可用。浏览器只关闭本任务创建的上下文。

- [x] **Step 5: 回填验证证据并提交计划状态**

将完成项标记 `[x]`，记录实际测试数量、浏览器结果、资源用量和已知限制；不写密码、IP 明细或环境文件内容。

```bash
git add docs/superpowers/plans/2026-09-21-identity-free-product-analytics.md
git commit -m "docs: record product analytics verification"
```

**2026-09-21 本地验证证据：**

- 聚焦产品统计测试 32/32 通过；真实隔离 Redis 集成测试已执行，未跳过。
- 后台展示测试 9/9、运行配置测试 3/3、既有可观测性回归 60/60 通过；`npm test --prefix server/api` 全部脚本退出 0。
- 隐私静态扫描未发现持久化或日志化的访客 ID、会话 ID、IP、完整 UA、Referer、Cookie、请求体或派生身份字段；命中仅为隐私能力声明、拒绝规则和 Nginx 内存限流键。
- 隔离无头浏览器验证覆盖桌面与 390px 手机：无横向溢出、无统计同意 Banner、无统计 Cookie；后台正确显示产品统计、`UV 未采集`、`会话未采集`、`实验完成事件未接入`。
- 快照缺失时后台显示“无法读取新产品统计，当前状态未知”，产品数值为 `—`，未将故障误报为 0；测试浏览器会话及临时服务均按任务句柄关闭。
- 首版已知边界：不采集 UV/会话，不生成跨页面或跨天轨迹；实验完成事件没有可靠语义，故明确不接入；独立统计 Redis 上限 32MB，systemd `MemoryMax=96M`。

- [ ] **Step 6: 合并到主分支并推送**

确认原工作区只有既有两份未跟踪审查文件，随后快进合并：

```bash
git checkout main
git merge --ff-only codex/identity-free-analytics
git push origin main
```

Expected: `origin/main` 指向验证后的提交，两份无关文件仍未跟踪且未提交。

### Task 9: 原子生产部署与验收

**Production paths:** `/opt/science-lab-api-releases/<release>/`、`/var/www/science-lab-releases/<release>/`、`/opt/science-lab-traffic/`、`/etc/systemd/system/`、`/etc/nginx/conf.d/`、`/etc/science-lab-analytics.env`、`/etc/science-lab-analytics-redis.conf`、`/var/lib/science-lab-analytics-redis/`。

- [ ] **Step 1: 部署前只读复核与备份**

再次确认 16380 未监听、可用内存大于 1GB、磁盘大于 10GB、四个现有服务 active、当前 Git/静态/API release 指针和 Nginx 配置。创建 root:root 0700 的唯一备份目录，保存 API/静态指针、站点/Nginx http 配置、systemd 单元、统计运行文件、私有后台快照和历史；环境文件只备份到私有目录，不下载、不输出。

- [ ] **Step 2: 准备独立 Redis 与密钥**

服务器生成 32 字节随机十六进制密码，不回显。建立 `redis:redis` 0700 数据目录；原子写入 root:redis 0640 配置，固定 16380、32MB、noeviction、AOF everysec。原子写入 root:root 0600 统计环境文件，包含回环 URL、`ANALYTICS_ORIGIN=https://lab.xingnian.net.cn` 和激活时填写的真实 UTC `ANALYTICS_COLLECTION_START`。

安装 Redis unit，运行 `systemd-analyze verify`，启动后只用认证 PING 和临时命名空间验证；删除临时键，确认 6379、16379 的 PID、配置和数据未改变。

- [ ] **Step 3: 上传并验证不活动版本**

上传新 API release、静态 release、统计运行文件和 systemd/Nginx 源文件到不活动路径，逐文件 SHA-256 与 Git 对比。API 以生产环境和统计 Redis 在不公开的本机路径验证健康及合法/非法事件，静态文件进行脚本版本、JSON 和可读性检查；不得调用真实收费模型。

- [ ] **Step 4: 按兼容顺序激活**

顺序固定：

1. 安装统计快照运行文件和 units，但先不启用 timer；
2. 安装 API analytics drop-in 与新 API release，`systemd-analyze verify` 后重启 API；
3. 安装 Nginx `http` 格式/zone 与精确 location，`nginx -t` 后 reload；
4. 记录 reload 前的真实 UTC 为采集开始时间，重启 API 读取最终值；
5. 原子切换静态 release；
6. 手动执行快照服务，确认 `analytics.json` 权限、schema 和无身份字段；
7. 启用五分钟 timer，手动生成流量后台 HTML。

- [ ] **Step 5: 生产验收**

验证公开首页/隐私页/清单 200、API health 200、旧 `/api/` 503 口径不变；合法统计 204，query/跨源/超大请求分别 400/403/413；响应无 Set-Cookie；普通日志没有统计 location 请求，匿名统计日志没有 IP/UA/Referer/Cookie/query/body；私有后台未认证 HTML/JSON 401、敏感路径 404、认证后产品区和安全区正常；Redis 键只含固定 namespace 和内容哈希；AI 全站 500/并发 10 与额度 Redis 数据未改变。

使用隔离无头浏览器打开一次首页、切换一个实验和目录，确认只增加预期匿名计数。验收结束关闭任务自有上下文，不清理共享浏览器状态。

- [ ] **Step 6: 失败回滚**

任何关键验收失败：先禁用新 timer，恢复上一 API/静态指针和 Nginx/systemd 文件，执行 `nginx -t` 后 reload，恢复现有服务；保留独立统计 Redis 数据和匿名日志用于排查，不清库、不覆盖安全日志。若核心站点恢复后统计 Redis 单独异常，可停止新 Redis 而保持产品事件 503，公开实验与 AI 继续服务。

- [ ] **Step 7: 记录部署证据**

在本计划末尾追加生产 release、提交哈希、备份目录、启用时间、服务状态、HTTP 结果、回滚目标和未解决的网络日志合规专项；不得记录密码、密钥、完整 IP/UA 或用户数据。提交并推送最终记录。

## 自审结果

- 规格覆盖：采集最小化、无标识、独立存储、安全日志隔离、后台三分区、UV 未采集、完成未接入、第二层关闭、隐私说明、故障隔离、测试、部署和回滚均对应到任务。
- 类型一致：事件名、字段名、内容 ID、action/source 枚举、Redis namespace、快照 schema 和后台状态在各任务中一致。
- 无占位实现：生产端口已只读确认使用 16380；资源上限、TTL、路由、事件、文件路径、测试命令和部署顺序均给出确定值。唯一运行时生成值是不能写入 Git 的随机密码与真实启用 UTC。
- 用户已选择当前会话内联执行；计划完成后直接使用 `superpowers:executing-plans`，无需再次询问执行方式。
