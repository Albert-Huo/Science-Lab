# Science-Lab Predeployment Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four verified release blockers without deploying, pushing, removing legacy APIs, or broadening the product scope.

**Architecture:** Add one small UMD module to resolve experiment content sources with a testable boundary, keep the existing single-page shell, and update the existing Express proxy to DeepSeek V4 Flash in non-thinking mode. Restrict the Service Worker to an explicit shell allowlist, make catalog JSON caching last-known-good, and make static deployment reproducible through an atomic release symlink and a committed npm lockfile.

**Tech Stack:** Vanilla HTML/CSS/JavaScript, Node.js 18+, Express 4, Node `assert`/`vm` tests, Service Worker Cache API, nginx, npm lockfile.

---

### Task 1: Safe experiment content-source resolution

**Files:**
- Create: `content-source.js`
- Create: `server/api/test/frontend-content-source.js`
- Modify: `index.html:291-296`
- Modify: `server/api/package.json:9`

- [ ] **Step 1: Write the failing content-source test**

Create `server/api/test/frontend-content-source.js`:

```js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ContentSource = require(path.resolve(__dirname, '../../../content-source.js'));

const OFFICIAL = 'https://html.xingnian.net.cn/';
assert.strictEqual(ContentSource.resolve({ hostname: 'lab.xingnian.net.cn', requestedBase: null }), OFFICIAL);
assert.strictEqual(ContentSource.resolve({ hostname: 'html.xingnian.net.cn', requestedBase: null }), '');
assert.strictEqual(ContentSource.resolve({ hostname: 'lab.xingnian.net.cn', requestedBase: 'javascript:alert(1)//' }), OFFICIAL);
assert.strictEqual(ContentSource.resolve({ hostname: 'lab.xingnian.net.cn', requestedBase: 'https://evil.example/' }), OFFICIAL);
assert.strictEqual(ContentSource.resolve({ hostname: '127.0.0.1', requestedBase: '/HTML-/' }), '/HTML-/');
assert.strictEqual(ContentSource.resolve({ hostname: 'localhost', requestedBase: '/fixtures' }), '/fixtures/');
assert.strictEqual(ContentSource.resolve({ hostname: 'localhost', requestedBase: '//evil.example/' }), OFFICIAL);
assert.strictEqual(ContentSource.resolve({ hostname: 'localhost', requestedBase: 'data:text/html,boom' }), OFFICIAL);

const html = fs.readFileSync(path.resolve(__dirname, '../../../index.html'), 'utf8');
assert.ok(html.includes('<script src="content-source.js"></script>'));
assert.ok(html.includes('ContentSource.resolve({hostname:location.hostname,requestedBase:qs.get(\'base\')})'));
assert.ok(!html.includes("const CONTENT_BASE = qs.get('base') ??"));
console.log('✓ 内容源边界 8 个场景与首页接入检查通过');
```

Append `node test/frontend-content-source.js` to the `test` script in `server/api/package.json`.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
cd server/api
node test/frontend-content-source.js
```

Expected: fail with `MODULE_NOT_FOUND` for `content-source.js`.

- [ ] **Step 3: Implement the resolver and wire it into the page**

Create `content-source.js`:

```js
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports) module.exports=api;
  else root.ContentSource=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const OFFICIAL_BASE='https://html.xingnian.net.cn/';
  const LOCAL_HOSTS=new Set(['127.0.0.1','localhost']);

  function localBase(value){
    if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')) return null;
    try{
      const parsed=new URL(value,'http://localhost');
      if(parsed.origin!=='http://localhost'||parsed.search||parsed.hash) return null;
      return parsed.pathname.endsWith('/')?parsed.pathname:parsed.pathname+'/';
    }catch(error){ return null; }
  }

  function resolve(options){
    const hostname=options&&typeof options.hostname==='string'?options.hostname:'';
    if(hostname==='html.xingnian.net.cn') return '';
    if(LOCAL_HOSTS.has(hostname)) return localBase(options.requestedBase)||OFFICIAL_BASE;
    return OFFICIAL_BASE;
  }

  return {resolve};
});
```

Load it immediately after `catalog-control.js` and replace the current `CONTENT_BASE` assignment with:

```js
const CONTENT_BASE=ContentSource.resolve({hostname:location.hostname,requestedBase:qs.get('base')});
```

- [ ] **Step 4: Run the targeted and full tests**

Run:

```bash
cd server/api
node test/frontend-content-source.js
npm test
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit Task 1**

```bash
git add content-source.js index.html server/api/package.json server/api/test/frontend-content-source.js
git commit -m "fix(web): constrain experiment content sources"
```

### Task 2: DeepSeek V4 and cross-layer message limits

**Files:**
- Modify: `server/api/test/smoke.js:38-108`
- Modify: `server/api/test/ai-default-limits.js:38-41`
- Modify: `server/api/test/frontend-storage.js:8-71`
- Modify: `server/api/server.js:47-50,106-140`
- Modify: `index.html:259-260,499-503,616`

- [ ] **Step 1: Change the tests to the required V4 contract**

In `server/api/test/smoke.js`, define and use:

```js
const AI_MODEL = 'deepseek-v4-flash';
```

Replace every request model in that test with `AI_MODEL`, and require the captured upstream body to equal:

```js
{
  model: AI_MODEL,
  stream: true,
  max_tokens: 2048,
  temperature: 1.5,
  thinking: { type: 'disabled' },
  messages: [{ role: 'user', content: '解释实验' }],
}
```

Update `server/api/test/ai-default-limits.js` to send `deepseek-v4-flash`.

In `server/api/test/frontend-storage.js`, extend the extracted API:

```js
const source = html.slice(start, end) + '\nthis.chatApi={loadChatStore,persistChat,toAiMessages};';
```

Add assertions:

```js
{
  const test = harness();
  const input = Array.from({length:13},(_,index)=>({role:index%2?'assistant':'user',content:'x'.repeat(5000)}));
  const sent = JSON.parse(JSON.stringify(test.api.toAiMessages(input)));
  assert.strictEqual(sent.length, 12);
  assert.strictEqual(sent[0].content.length, 4000);
  ok('发往内置 AI 的历史限制为最近 12 条且每条不超过 4000 字符');
}
assert.ok(html.includes("model:'deepseek-v4-flash'"), '前端默认模型必须使用 DeepSeek V4 Flash');
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
cd server/api
node test/smoke.js
node test/frontend-storage.js
```

Expected: smoke test fails because the server rejects `deepseek-v4-flash`; storage test fails because `toAiMessages` is missing.

- [ ] **Step 3: Implement the V4 request contract**

In `server/api/server.js` use:

```js
const AI_MODELS = new Set(['deepseek-v4-flash']);
```

Default missing models to `deepseek-v4-flash` and include this field in the sanitized upstream value:

```js
thinking: { type: 'disabled' },
```

In `index.html` use:

```js
const CHAT_TOTAL_MAX=200, CHAT_CONTENT_MAX=6000, AI_MESSAGE_CONTENT_MAX=4000;
const AI_DEFAULTS={byok:false,endpoint:'https://api.deepseek.com/chat/completions',model:'deepseek-v4-flash',key:''};
function toAiMessages(messages){
  return messages.slice(-12).map(({role,content})=>({role,content:String(content).slice(0,AI_MESSAGE_CONTENT_MAX)}));
}
```

Build the request body with:

```js
messages:[{role:'system',content:sys},...toAiMessages(conversation)]
```

Update the model input placeholder to `deepseek-v4-flash`.

- [ ] **Step 4: Run targeted and full tests**

```bash
cd server/api
node test/smoke.js
node test/ai-default-limits.js
node test/frontend-storage.js
npm test
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit Task 2**

```bash
git add index.html server/api/server.js server/api/test/smoke.js server/api/test/ai-default-limits.js server/api/test/frontend-storage.js
git commit -m "fix(ai): update built-in proxy to DeepSeek V4"
```

### Task 3: Service Worker cache ownership and last-known-good JSON

**Files:**
- Create: `server/api/test/service-worker-cache.js`
- Modify: `server/api/package.json:9`
- Modify: `server/api/test/frontend-catalog-control.js:127-149`
- Modify: `sw.js:5-67`
- Modify: `index.html:825-829`

- [ ] **Step 1: Write a behavioral Service Worker test**

Create `server/api/test/service-worker-cache.js` with a `vm` harness that executes `sw.js`, records registered handlers, and asserts these behaviors:

```js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const handlers = {};
const deleted = [];
const writes = [];
let fetchResponse;
let cachedResponse;
const cache = { addAll: async()=>{}, put: async(req,res)=>writes.push([req.url,res]) };
const context = vm.createContext({
  URL, Response,
  location:{origin:'https://lab.xingnian.net.cn'},
  self:{
    location:{origin:'https://lab.xingnian.net.cn',href:'https://lab.xingnian.net.cn/sw.js'},
    addEventListener:(name,handler)=>{handlers[name]=handler;},
    skipWaiting:async()=>{}, clients:{claim:async()=>{}},
  },
  caches:{
    open:async()=>cache,
    keys:async()=>['sl-shell-v0.6.0','other-app-cache','sl-shell-v0.7.1'],
    delete:async key=>{deleted.push(key); return true;},
    match:async()=>cachedResponse,
  },
  fetch:async()=>fetchResponse,
});
vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../../../sw.js'),'utf8'),context);

async function waitEvent(name,event){
  let pending;
  handlers[name](Object.assign({waitUntil:p=>{pending=p;}},event));
  if(pending) await pending;
}

(async()=>{
  await waitEvent('activate',{});
  assert.deepStrictEqual(deleted,['sl-shell-v0.6.0']);

  cachedResponse=new Response('{"version":1}',{status:200,headers:{'Content-Type':'application/json'}});
  fetchResponse=new Response('<html>wrong</html>',{status:200,headers:{'Content-Type':'text/html'}});
  let responsePromise;
  handlers.fetch({request:{method:'GET',url:'https://lab.xingnian.net.cn/catalog-control.json'},respondWith:p=>{responsePromise=p;}});
  assert.strictEqual(await (await responsePromise).text(),'{"version":1}');
  assert.strictEqual(writes.length,0);

  let intercepted=false;
  handlers.fetch({request:{method:'GET',url:'https://lab.xingnian.net.cn/api/health'},respondWith:()=>{intercepted=true;}});
  assert.strictEqual(intercepted,false);
  console.log('✓ Service Worker 缓存所有权、JSON 回退与 API 绕过检查通过');
})().catch(error=>{console.error(error);process.exit(1);});
```

Append `node test/service-worker-cache.js` to the package test script. Update the existing catalog test to require cache version `v0.7.1` and `content-source.js` in the shell.

- [ ] **Step 2: Run the test and verify RED**

```bash
cd server/api
node test/service-worker-cache.js
```

Expected: fail because the current activate handler deletes `other-app-cache` and HTML responses are cached.

- [ ] **Step 3: Implement explicit cache ownership**

Refactor `sw.js` around these constants and helpers:

```js
const VERSION='v0.7.1';
const CACHE_PREFIX='sl-shell-';
const SHELL_CACHE=CACHE_PREFIX+VERSION;
const SHELL=[
  './','./index.html','./catalog-control.js','./content-source.js','./catalog-control.json',
  './manifest.json','./manifest.webmanifest','./assets/icons/icon-192.png',
  './assets/icons/icon-512.png','./assets/icons/icon-maskable-512.png','./assets/icons/apple-touch-icon.png',
];
const SHELL_URLS=new Set(SHELL.map(path=>new URL(path,self.location.href).href));
const JSON_PATHS=new Set(['/manifest.json','/catalog-control.json']);
const isJson=response=>response&&response.ok&&(response.headers.get('content-type')||'').includes('application/json');
```

Activation must delete only cache names where `key.startsWith(CACHE_PREFIX) && key !== SHELL_CACHE`. JSON requests must cache only `isJson(response)` results and otherwise return a cached valid response when available. All other requests must return without `respondWith` unless their exact URL is present in `SHELL_URLS`.

Replace the empty Service Worker registration catch in `index.html` with:

```js
.catch(error=>console.warn('Service Worker 注册失败：'+error.message))
```

- [ ] **Step 4: Run targeted and full tests**

```bash
cd server/api
node test/service-worker-cache.js
node test/frontend-catalog-control.js
npm test
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit Task 3**

```bash
git add sw.js index.html server/api/package.json server/api/test/service-worker-cache.js server/api/test/frontend-catalog-control.js
git commit -m "fix(pwa): isolate and validate shell caches"
```

### Task 4: Exact static routing and atomic release documentation

**Files:**
- Modify: `server/api/test/frontend-catalog-control.js:127-149`
- Modify: `README.md:33-40,91`
- Modify: `docs/aliyun-deploy.md:49-177,190-211`

- [ ] **Step 1: Add failing deployment contract assertions**

Add assertions to `server/api/test/frontend-catalog-control.js`:

```js
assert.ok(deployGuide.includes('npm ci --omit=dev'), '生产依赖必须从 lock 文件安装');
assert.ok(deployGuide.includes('content-source.js'), '内容源模块必须进入静态发布清单');
assert.ok(deployGuide.includes('try_files $uri =404;'), '缺失静态资源必须返回 404');
assert.ok(!deployGuide.includes('try_files $uri $uri/ /index.html;'), '静态站不得把缺失 JSON 回退为首页');
assert.ok(deployGuide.includes('/var/www/science-lab-current'), 'nginx 必须指向原子切换的 release 链接');
assert.ok(deployGuide.includes('science-lab-next'), '发布步骤必须先创建下一版本链接再原子替换');
assert.ok(deployGuide.includes("deepseek-v4-flash"), '真实 AI 验证必须使用当前模型');
```

Replace the existing copy-command assertion with:

```js
assert.ok(
  /install -m 644 index\.html catalog-control\.js content-source\.js catalog-control\.json manifest\.json manifest\.webmanifest sw\.js/.test(deployGuide),
  '原子发布必须复制全部 App 壳文件'
);
```

- [ ] **Step 2: Run the test and verify RED**

```bash
cd server/api
node test/frontend-catalog-control.js
```

Expected: fail on `npm ci --omit=dev` or atomic release assertions.

- [ ] **Step 3: Update the deployment guide**

Make these concrete changes:

```nginx
root /var/www/science-lab-current;

location = /sw.js {
    try_files $uri =404;
    add_header Cache-Control "no-cache" always;
}

location /api/ {
    proxy_pass http://127.0.0.1:8970/;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 300s;
}

location / {
    try_files $uri $uri/ =404;
}
```

Replace mutable static copies with an atomic release flow:

```bash
SCIENCE_LAB_RELEASE_ID=$(date '+%Y%m%d-%H%M%S')
SCIENCE_LAB_RELEASE_DIR="/var/www/science-lab-releases/${SCIENCE_LAB_RELEASE_ID}"
sudo install -d -m 755 "$SCIENCE_LAB_RELEASE_DIR"
sudo install -m 644 index.html catalog-control.js content-source.js catalog-control.json manifest.json manifest.webmanifest sw.js "$SCIENCE_LAB_RELEASE_DIR/"
sudo cp -a assets "$SCIENCE_LAB_RELEASE_DIR/"
test -f "$SCIENCE_LAB_RELEASE_DIR/index.html" && test -f "$SCIENCE_LAB_RELEASE_DIR/catalog-control.json" && test -f "$SCIENCE_LAB_RELEASE_DIR/sw.js"
sudo ln -sfn "$SCIENCE_LAB_RELEASE_DIR" /var/www/science-lab-next
sudo mv -Tf /var/www/science-lab-next /var/www/science-lab-current
```

Document that `/var/www/science-lab-current` must be a symlink and that rollback creates `science-lab-next` pointing to the recorded previous release before the same `mv -Tf` operation. Update Node installation to `npm ci --omit=dev`, model examples to `deepseek-v4-flash`, and the static file inventory to include `content-source.js`.

Update README local-development wording to state that `?base=` is honored only on localhost/127.0.0.1 and only for root-relative paths.

- [ ] **Step 4: Run the documentation contract and full tests**

```bash
cd server/api
node test/frontend-catalog-control.js
npm test
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit Task 4**

```bash
git add README.md docs/aliyun-deploy.md server/api/test/frontend-catalog-control.js
git commit -m "docs: make static releases atomic"
```

### Task 5: Commit and audit the production dependency lock

**Files:**
- Modify: `server/api/.gitignore:1-3`
- Add: `server/api/package-lock.json`
- Modify: `docs/aliyun-deploy.md:49-69` only if the Task 4 wording needs alignment

- [ ] **Step 1: Expose the lockfile to version control**

Remove only this line from `server/api/.gitignore`:

```gitignore
package-lock.json
```

- [ ] **Step 2: Regenerate the lock without lifecycle scripts**

```bash
cd server/api
npm install --package-lock-only --ignore-scripts
```

Expected: `package-lock.json` is visible in `git status` and resolves `body-parser` to `1.20.6` or newer.

- [ ] **Step 3: Verify the locked production tree**

```bash
cd server/api
npm ci --ignore-scripts
npm audit --omit=dev
npm test
```

Expected: clean install succeeds, audit reports `found 0 vulnerabilities`, tests exit 0.

- [ ] **Step 4: Commit Task 5**

```bash
git add server/api/.gitignore server/api/package-lock.json docs/aliyun-deploy.md
git commit -m "build(api): lock audited production dependencies"
```

### Task 6: Final static, browser, and repository verification

**Files:**
- Verify only; no planned source edits

- [ ] **Step 1: Run the complete automated verification**

```bash
cd server/api
npm test
npm audit --omit=dev
cd ../..
for file in $(rg --files -g '*.js' -g '!server/api/node_modules/**'); do node --check "$file"; done
for file in $(rg --files -g '*.json' -g '!server/api/node_modules/**'); do jq empty "$file"; done
zsh -n push.command
python3 -c "compile(open('tools/build-manifest.py', encoding='utf-8').read(), 'tools/build-manifest.py', 'exec')"
git diff --check
```

Expected: every command exits 0 and audit reports zero vulnerabilities.

- [ ] **Step 2: Verify the malicious `base` case in an isolated headless browser**

Use the `browser-lifecycle` and `playwright` skills. Start a task-owned local HTTP server on a free loopback port, open a crafted `?base=javascript:...` URL in a unique named headless session, wait for the first experiment mount, and evaluate:

```js
document.documentElement.dataset.auditPwned || 'not-set'
```

Expected: `not-set`. Also verify the first experiment iframe URL begins with `https://html.xingnian.net.cn/`. Close the exact named Playwright session and stop the exact local server session.

- [ ] **Step 3: Review scope and repository state**

```bash
git status --short --branch
git diff main...HEAD --stat
git diff main...HEAD --check
git log --oneline main..HEAD
```

Expected: only files named in Tasks 1-5 are changed, the branch is not pushed, and no credentials or `.env` files are tracked.

- [ ] **Step 4: Request final code review and address only release-blocking findings**

Apply the `requesting-code-review` checklist to `main...HEAD`. Do not broaden scope into legacy API removal, new admin features, or Cloudflare Worker deployment.

- [ ] **Step 5: Present the deployment-readiness verdict**

Report test/audit/browser evidence, remaining accepted risks, commit list, and the exact worktree path. Do not merge, push, deploy, or use a real DeepSeek Key without a new explicit user instruction.
