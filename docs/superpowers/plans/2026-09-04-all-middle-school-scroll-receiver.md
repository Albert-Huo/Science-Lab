# All Middle-School Scroll Receiver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让内容仓库当前全部 70 个初中物理实验统一加载版本化滚动接收器，并通过实验馆右侧手柄控制根页面滚动。

**Architecture:** Science-Lab 保留 `experiment-scroll-receiver.js` 作为规范源，并提供可重复安装／校验工具。HTML 内容仓库新增不可变的 `experiment-scroll-receiver.v1.js`，70 个 `physics-middle` HTML 各引用一次；三个试点的内联代码被同一外部引用替换。只发布内容站，宿主 ECS release 不变。

**Tech Stack:** 原生 JavaScript、Node.js 内置测试运行器、Git worktree、GitHub Pages、Playwright CLI。

---

### Task 1: 为全量安装和发布边界写失败测试

**Files:**
- Create: `server/api/test/scroll-release.js`
- Modify: `server/api/package.json`
- Test: `server/api/test/scroll-release.js`

- [ ] **Step 1: 创建 70 页内容夹具测试**

测试在临时 Git 仓库中生成实验 1–68（用 12-1／12-2 替代 12，并增加 49-1），让 1、35、41 带现有内联接收器，其余页面无接收器。测试调用待实现工具并断言：

```js
const run = (relative, args) => execFileSync(process.execPath, [path.join(ROOT, relative), ...args], {
  encoding: 'utf8'
});
const numbers = Array.from({ length: 68 }, (_, index) => index + 1)
  .filter(number => number !== 12)
  .map(String)
  .concat(['12-1', '12-2', '49-1']);
assert.equal(numbers.length, 70);

run('tools/install-scroll-receiver.mjs', ['--content-root', contentRoot, '--apply']);
run('tools/check-scroll-release.mjs', ['--content-root', contentRoot, '--base-ref', baseline]);

assert.equal(readFileSync(path.join(contentRoot, 'experiment-scroll-receiver.v1.js'), 'utf8'), receiver);
for (const number of numbers) {
  const html = readFileSync(path.join(contentRoot, `physics-middle/初中物理实验${number}.html`), 'utf8');
  assert.equal((html.match(/data-science-lab-scroll/g) || []).length, 1);
  assert.ok(html.includes('<script src="../experiment-scroll-receiver.v1.js" data-science-lab-scroll></script>'));
  assert.ok(!html.includes("const CHANNEL='science-lab.scroll.v1'"));
}
```

再分别制造缺失引用、重复引用、共享文件漂移和额外实验内容改动，断言校验工具拒绝发布。

- [ ] **Step 2: 将测试加入完整测试命令**

在 `server/api/package.json` 的 `test` 命令中，把 `node test/scroll-release.js` 放在 `preview-scroll.js` 之前。

- [ ] **Step 3: 运行测试并确认正确失败**

Run: `node server/api/test/scroll-release.js`

Expected: FAIL，原因是 `tools/install-scroll-receiver.mjs` 尚不存在，且旧校验器仍只接受三个内联试点。

### Task 2: 实现可重复安装器和全量发布校验器

**Files:**
- Create: `tools/install-scroll-receiver.mjs`
- Modify: `tools/check-scroll-release.mjs`
- Test: `server/api/test/scroll-release.js`

- [ ] **Step 1: 实现安装器**

安装器使用以下固定契约：

```js
const EXPECTED_COUNT = 70;
const ASSET = 'experiment-scroll-receiver.v1.js';
const TAG = `<script src="../${ASSET}" data-science-lab-scroll></script>\n`;
const legacyBlock = `<script data-science-lab-scroll>\n${receiver}</script>\n`;
```

它先读取、转换并验证所有目标内容，再在 `--apply` 模式下写入共享文件和 HTML：

- 已有规范外部引用：保持不变；
- 已有精确旧内联块：替换为外部引用；
- 没有接收器且存在 `</body>`：在 `</body>` 前插入；
- 存在未知或重复标记：抛错并停止；
- 非 `--apply` 模式只报告待修改数量，不写文件。

- [ ] **Step 2: 将校验器改为全量外部引用契约**

校验器必须：

```js
assert.equal(targets.length, EXPECTED_COUNT, 'physics-middle experiment count');
assert.equal(sharedReceiver, receiver, `${ASSET}: canonical receiver mismatch`);
assert.equal(markerCount, 1, `${relative}: receiver marker must occur once`);
assert.equal(externalCount, 1, `${relative}: versioned receiver tag must occur once`);
assert.ok(!html.includes(legacyBlock), `${relative}: inline receiver must be removed`);
```

提供 `--base-ref` 时，从该提交读取对应 HTML，分别移除规范外部标签或精确旧内联块后逐字比较，拒绝夹带实验内容改动。

- [ ] **Step 3: 运行专项测试并确认转绿**

Run: `node server/api/test/scroll-release.js`

Expected: PASS；正常安装和五类失败边界均被覆盖。

- [ ] **Step 4: 运行现有滚动及预览专项**

Run:

```bash
node server/api/test/frontend-scroll.js
node server/api/test/preview-scroll.js
```

Expected: 两项退出 0；既有宿主、试点预览和安全边界不回归。

### Task 3: 建立隔离内容工作树并机械接入 70 页

**Files:**
- Create in HTML repository: `experiment-scroll-receiver.v1.js`
- Modify in HTML repository: `physics-middle/初中物理实验*.html`（70 个）

- [ ] **Step 1: 从最新远端 main 建立隔离工作树**

在内容仓库执行远端更新，确认本地主检出目录状态后，以准确的 `origin/main` 建立：

```bash
git worktree add /Users/lx100/.config/superpowers/worktrees/HTML-/all-middle-scroll \
  -b codex/all-middle-scroll origin/main
```

创建前用 `git rev-parse origin/main` 保存完整 SHA 到 `CONTENT_BASE`。Expected: 新工作树分支起点等于该 SHA，不读取或修改其他内容工作树。

- [ ] **Step 2: 预演并应用机械改写**

Run:

```bash
node tools/install-scroll-receiver.mjs \
  --content-root /Users/lx100/.config/superpowers/worktrees/HTML-/all-middle-scroll
node tools/install-scroll-receiver.mjs \
  --content-root /Users/lx100/.config/superpowers/worktrees/HTML-/all-middle-scroll --apply
```

Expected: 共享文件新增；三个内联块被替换；其余 67 页各新增一个外部引用；第二次预演报告 0 个待修改页面。

- [ ] **Step 3: 运行全量发布边界检查**

Run:

```bash
node tools/check-scroll-release.mjs \
  --content-root /Users/lx100/.config/superpowers/worktrees/HTML-/all-middle-scroll \
  --base-ref "$CONTENT_BASE"
```

Expected: 验证 70/70，规范源一致，去除接入块后所有实验与基线逐字一致。

- [ ] **Step 4: 审查内容差异**

确认：

```text
1 个共享 JS 新文件
70 个 HTML 仅改变接收器块
0 个实验器材、布局、教学逻辑或其他目录文件变化
```

### Task 4: 完整测试和本地全链路验证

**Files:**
- Create outside repositories: `HTML-sources-private/reports/visual-regression/2026-09-04-all-middle-scroll/output/playwright/`

- [ ] **Step 1: 运行 Science-Lab 完整检查**

Run:

```bash
node --check experiment-scroll-receiver.js
node --check tools/install-scroll-receiver.mjs
node --check tools/check-scroll-release.mjs
npm test --prefix server/api
npm audit --omit=dev --offline --prefix server/api
git diff --check
```

Expected: 测试零失败、审计零漏洞、语法和空白检查退出 0。

- [ ] **Step 2: 验证 70 页共享资源可读取**

使用 `tools/preview-scroll.mjs` 指向隔离内容工作树；通过 HTTP 读取共享 JS 和全部 70 个 HTML，确认状态 200、外部引用恰有一个、无内联接收器。若预览服务不能读取根共享 JS，先增加该精确资源的失败测试，再做最小修正。

- [ ] **Step 3: Android 微信移动端抽样**

在隔离 390×844 Android 微信会话中验证实验 1、2、10、35、41、50、68：

- 共享 `v1` 接收器请求成功；
- 宿主收到状态并显示右侧滚动手柄；
- 拖动手柄只滚动当前实验且不切换编号；
- 每页点击一个现有器材／模式控件仍有响应；
- 控制台没有异常。

保存截图和机器可读结果；不判断内部滚动容器，不做逐页溢出审核。

- [ ] **Step 4: 关闭精确的浏览器会话和本地预览**

只关闭本任务登记的 Playwright session 与预览进程，不触碰其他浏览器、Profile 或本地服务。

### Task 5: 提交并发布 HTML 内容站

**Files:**
- Commit in HTML repository: shared receiver + 70 HTML files

- [ ] **Step 1: 提交内容仓库改动**

Run:

```bash
git add experiment-scroll-receiver.v1.js physics-middle
git commit -m "feat: enable scrolling for all middle-school labs"
git push origin codex/all-middle-scroll
```

Expected: 功能分支只包含全量接入改动。

- [ ] **Step 2: 快进内容仓库 main 并推送**

Run:

```bash
git fetch origin main
test "$(git rev-parse origin/main)" = "$CONTENT_BASE"
git -C /Users/lx100/projects/HTML-GitHub/HTML- merge --ff-only codex/all-middle-scroll
git -C /Users/lx100/projects/HTML-GitHub/HTML- push origin main
```

若远端已前进则停止并重新基于新提交验证，不强推。

- [ ] **Step 3: 等待 GitHub Pages 和精确 CDN 刷新任务**

使用 GitHub API 确认 Pages 最新成功构建提交等于内容功能提交；确认 `purge-pages-cache.yml` 对该发布成功。任何失败都停止公网验收，不把“已 push”当成“已部署”。

- [ ] **Step 4: 公网全量验证**

验证：

- `https://html.xingnian.net.cn/experiment-scroll-receiver.v1.js` 与规范源 SHA-256 一致；
- 70 个公开实验 HTML 均返回 200 且引用 `../experiment-scroll-receiver.v1.js` 一次；
- 不残留内联 receiver；
- `lab.xingnian.net.cn` 抽样实验 1、2、10、35、41、50、68 的滚动和实验编号保持正确；
- App/API 健康。

### Task 6: 提交 Science-Lab 工具与发布记录

**Files:**
- Modify: `docs/content-scroll-pilot.md`
- Modify: `docs/superpowers/plans/2026-09-04-all-middle-school-scroll-receiver.md`
- Commit: installer, checker, tests, package script, design and release docs

- [ ] **Step 1: 记录测试、内容提交和 Pages 发布结果**

记录内容仓库功能提交、Pages 状态、CDN 刷新、70/70 公网检查、抽样浏览器结果与回滚提交。

- [ ] **Step 2: 提交并推送 Science-Lab 功能分支**

Run:

```bash
git add tools server/api docs
git commit -m "feat: verify full middle-school scroll rollout"
git push origin codex/content-scroll-pilot
```

- [ ] **Step 3: 快进 Science-Lab main 并推送**

保持主检出目录已有未跟踪文件不变，运行快进合并和完整测试，再推送 `main`。Science-Lab 静态宿主文件未变，因此不切换 ECS release；确认线上仍为已验证的 `v0.8.4` 和健康 API。
