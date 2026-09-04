# Transparent Navigation Buttons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让右下角上下实验切换按钮默认约 86% 透明，减少正文遮挡，同时保留 40×40px 触摸区和清晰的操作反馈。

**Architecture:** 只修改宿主页面的 `#navBtns button` 表现层，不改变切换事件或实验 iframe。背景、边框和图标分别设置透明度，避免整体 `opacity` 削弱可用性；Service Worker 与版本化滚动脚本统一升级到 `v0.8.4`，确保客户端取得新首页。

**Tech Stack:** 原生 HTML/CSS/JavaScript、Node.js 内置测试运行器、Service Worker、Playwright CLI、nginx 静态 release。

---

### Task 1: 用测试锁定透明样式与触摸尺寸

**Files:**
- Modify: `server/api/test/frontend-scroll.js`
- Test: `server/api/test/frontend-scroll.js`

- [ ] **Step 1: 写入失败测试**

在现有页面手柄测试旁增加静态样式契约：

```js
test('navigation arrows use layered transparency without shrinking touch targets', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const baseRule = html.match(/#navBtns button\{([^}]+)\}/)?.[1] || '';
  assert.ok(baseRule.includes('width:40px;height:40px'));
  assert.ok(baseRule.includes('background:rgba(18,24,38,.14)'));
  assert.ok(baseRule.includes('border:1px solid rgba(147,161,189,.22)'));
  assert.ok(baseRule.includes('color:rgba(232,237,247,.68)'));
  assert.ok(!baseRule.includes('backdrop-filter'));
  assert.match(html, /#navBtns button:active,#navBtns button:focus-visible\{/);
});
```

- [ ] **Step 2: 运行测试并确认因旧样式失败**

Run: `node server/api/test/frontend-scroll.js`

Expected: 新测试因现有 `#121826cc` 背景、实体边框和 `backdrop-filter` 失败；其余测试通过。

### Task 2: 实现分层透明按钮并更新静态缓存版本

**Files:**
- Modify: `index.html`
- Modify: `sw.js`
- Modify: `experiment-scroll.js`
- Test: `server/api/test/frontend-scroll.js`
- Test: `server/api/test/service-worker-cache.js`
- Test: `server/api/test/frontend-catalog-control.js`

- [ ] **Step 1: 修改按钮默认态和交互态**

将按钮样式改为：

```css
#navBtns button{width:40px;height:40px;border-radius:50%;
  border:1px solid rgba(147,161,189,.22);background:rgba(18,24,38,.14);
  color:rgba(232,237,247,.68);font-size:16px;cursor:pointer;
  transition:background .15s,color .15s,border-color .15s;}
#navBtns button:active,#navBtns button:focus-visible{
  border-color:rgba(147,161,189,.5);background:rgba(18,24,38,.34);
  color:rgba(232,237,247,.95);}
#navBtns button:focus-visible{outline:1px solid rgba(232,237,247,.72);outline-offset:2px;}
```

保留现有 `#navBtns button:disabled{opacity:.3;}`，不修改按钮结构、位置和事件绑定。

- [ ] **Step 2: 将统一静态版本升级到 v0.8.4**

修改：

```js
// sw.js
const VERSION = 'v0.8.4';

// experiment-scroll.js
const VERSION='v0.8.4';
```

并把首页脚本 URL 改为：

```html
<script src="experiment-scroll.js?app=v0.8.4"></script>
```

- [ ] **Step 3: 运行专项测试并确认转绿**

Run:

```bash
node server/api/test/frontend-scroll.js
node server/api/test/service-worker-cache.js
node server/api/test/frontend-catalog-control.js
```

Expected: 全部退出 0；滚动与缓存版本契约均通过。

- [ ] **Step 4: 提交功能改动**

```bash
git add index.html sw.js experiment-scroll.js server/api/test/frontend-scroll.js docs/superpowers/plans/2026-09-04-transparent-navigation-buttons.md
git commit -m "style: make experiment navigation translucent"
```

### Task 3: 完整回归与移动端视觉验证

**Files:**
- Create outside repository: `HTML-sources-private/reports/visual-regression/2026-09-04-transparent-navigation/output/playwright/`

- [ ] **Step 1: 运行完整自动化检查**

Run:

```bash
node --check experiment-scroll.js
npm test --prefix server/api
npm audit --omit=dev --offline --prefix server/api
git diff --check
```

Expected: 测试零失败、审计零漏洞、语法和空白检查退出 0。

- [ ] **Step 2: 用隔离的 390×844 Android 微信环境验证**

启动任务专属本地预览：

```bash
node tools/preview-scroll.mjs --content-root /Users/lx100/projects/HTML-GitHub/HTML- --port 18984
```

使用独立 Playwright 会话打开 `http://127.0.0.1:18984/?base=/HTML-/`，验证：

```js
const up = document.querySelector('#btnPrev').getBoundingClientRect();
const down = document.querySelector('#btnNext').getBoundingClientRect();
const style = getComputedStyle(document.querySelector('#btnNext'));
({ up, down, background: style.backgroundColor, color: style.color, border: style.borderColor });
```

Expected: 两个按钮均为 40×40px；默认背景 `rgba(18, 24, 38, 0.14)`、图标 `rgba(232, 237, 247, 0.68)`；点击下箭头后编号加一，点击上箭头后回到原实验。保存并目检截图，确认按钮下方正文可辨。

- [ ] **Step 3: 关闭本任务创建的浏览器会话和本地预览**

只关闭本计划登记的 Playwright session 与端口 18984 的预览进程，不触碰其他浏览器或服务。

### Task 4: 推送、原子部署和公网复验

**Files:**
- Modify after deployment: `docs/content-scroll-pilot.md`
- Modify after deployment: `docs/superpowers/plans/2026-09-04-transparent-navigation-buttons.md`

- [ ] **Step 1: 推送功能分支并快进 main**

```bash
git push origin codex/content-scroll-pilot
git -C /Users/lx100/projects/HTML-GitHub/Science-Lab merge --ff-only codex/content-scroll-pilot
git -C /Users/lx100/projects/HTML-GitHub/Science-Lab push origin main
```

Expected: 本地 `main`、远端 `main` 和功能分支指向同一功能提交；保留主检出目录已有未跟踪文件。

- [ ] **Step 2: 上传并原子切换静态 release**

上传以下文件至以功能提交短 SHA 命名的全新 staging 目录：

```text
index.html catalog-control.js content-source.js experiment-scroll.js
catalog-control.json manifest.json manifest.webmanifest sw.js assets/
```

比对本地和服务器 SHA-256，解析两个 JSON，确认 `v0.8.4` 三处一致；保存当前 release 为 previous，再原子切换 `/var/www/science-lab-current`。切换失败或公网校验失败时立即切回 previous。不得重启或修改 API、nginx、数据库及内容站。

- [ ] **Step 3: 公网验证**

使用独立 Android 微信 Playwright 会话打开：

```text
https://lab.xingnian.net.cn/?app=v0.8.4
```

检查 `v0.8.4` 脚本、40×40px 按钮、透明计算样式、上下各切换一次、控制台零错误；同时验证内外网 `/api/health`。

- [ ] **Step 4: 记录部署并提交推送**

在交付文档记录功能提交、release、previous、测试和公网结果，勾选本计划，随后运行：

```bash
git add docs/content-scroll-pilot.md docs/superpowers/plans/2026-09-04-transparent-navigation-buttons.md
git commit -m "docs: record translucent navigation deployment"
git push origin codex/content-scroll-pilot
git -C /Users/lx100/projects/HTML-GitHub/Science-Lab merge --ff-only codex/content-scroll-pilot
git -C /Users/lx100/projects/HTML-GitHub/Science-Lab push origin main
```

Expected: 文档提交在本地和远端 `main`；静态 release 仍指向已验证的功能提交。
