# Private AI Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add privacy-preserving aggregate statistics for built-in AI requests to the existing password-protected traffic dashboard without storing chat text or request identities.

**Architecture:** The HTTPS AI location writes a dedicated JSON access log containing only status, duration, response bytes and server-derived anonymous metadata. A focused parser feeds the existing rolling dashboard accumulator, which migrates old traffic history without fabricating pre-collection AI zeros; the current manifest maps fixed experiment hashes to display titles only for the rolling window.

**Tech Stack:** Node.js CommonJS, Express, Nginx JSON access logs, systemd, `node:test`, self-contained HTML/CSS/JavaScript.

**Working-directory decision:** The user explicitly chose to continue in the current checkout instead of creating a Git worktree. Preserve all pre-existing untracked files and keep the diff limited to the files listed below.

**Release gate:** Do not commit, push, or modify production until all local verification is complete and the user separately approves those three actions.

---

## File map

- Create `tools/traffic-ai-report.cjs`: strict AI JSON-log parsing, bounded rotated-log reading and manifest hash/title mapping.
- Modify `tools/traffic-report.cjs`: expose its existing bounded file reader as a reusable helper without changing the current report contract.
- Create `server/api/test/traffic-ai-report.js`: parser, rotation, symlink, manifest and privacy tests.
- Modify `tools/traffic-dashboard.cjs`: merge normal and AI logs, add coverage-aware AI buckets and migrate history schema 1 to 2.
- Modify `server/api/test/traffic-dashboard.js`: aggregation, coverage, migration, atomic publishing and privacy tests.
- Modify `tools/traffic-dashboard-view.cjs`: schema 3 rendering, AI summary, status/experiment breakdown and CSV columns.
- Modify `tools/traffic-dashboard-client.js`: nested AI trend metrics and independent AI coverage handling.
- Create `tools/traffic-dashboard-ai.css`: extend the existing observatory visual language for AI metrics on desktop and mobile without rewriting the minified base stylesheet.
- Modify `index.html`: send `context.experimentPath` only for built-in AI calls.
- Modify `server/api/test/frontend-storage.js`: prove built-in metadata inclusion and BYOK exclusion.
- Modify `server/api/server.js`: hash the experiment path and expose only fixed anonymous metric headers to Nginx.
- Modify `server/api/test/smoke.js`: prove metric headers are correct and `context` never reaches DeepSeek.
- Modify `sw.js`, `experiment-scroll.js`, `server/api/test/frontend-scroll.js`: bump the coordinated App shell version to `v0.8.10`.
- Create `server/traffic/nginx-ai-log-format.conf`: repository-owned Nginx `http`-context format for the anonymous AI log.
- Modify `server/traffic/science-lab-traffic.service`: pass the AI log, manifest and collection-start inputs to the generator.
- Modify `server/api/test/frontend-catalog-control.js`: configuration/privacy assertions for the deploy guide and Nginx snippet.
- Modify `server/api/package.json`: add the new parser test to the full test sequence.
- Modify `server/traffic/README.md`, `docs/aliyun-deploy.md`, `README.md`: operations, retention, privacy, interpretation and rollback documentation.

### Task 1: Establish the clean baseline

**Files:**
- Inspect only: repository status and existing test suite

- [ ] **Step 1: Confirm the tracked checkout is clean apart from the two approved planning documents**

Run:

```bash
git status --short
git diff --check
```

Expected: only the new design and plan documents are tracked changes; `.DS_Store`, `.playwright-cli/`, the two review documents, `output/` and `tools/__pycache__/` remain untracked and untouched; `git diff --check` prints nothing.

- [ ] **Step 2: Run the existing full suite**

Run:

```bash
npm test --prefix server/api
```

Expected: exit code 0. If it fails, stop and diagnose the baseline before implementing the feature.

- [ ] **Step 3: Record a no-commit checkpoint**

Run:

```bash
git status --short
```

Expected: no source changes. Do not commit because the approved release gate defers commits until final user approval.

### Task 2: Parse the dedicated anonymous AI log

**Files:**
- Create: `tools/traffic-ai-report.cjs`
- Modify: `tools/traffic-report.cjs`
- Create: `server/api/test/traffic-ai-report.js`
- Modify: `server/api/package.json`

- [ ] **Step 1: Write failing parser and privacy tests**

Create `server/api/test/traffic-ai-report.js` with `node:test` cases that construct this canonical log line and assert the exact parsed record:

```js
const crypto = require('node:crypto');
const { parseAiRecord, loadExperimentMap, visitAiLogDirectory } = require('../../../tools/traffic-ai-report.cjs');

const aiLine = (overrides = {}) => JSON.stringify({
  time: '2026-09-09T12:00:00+08:00',
  status: '200',
  duration: '3.428',
  bytes: '1532',
  experiment: crypto.createHash('sha256').update('physics-middle/初中物理实验1.html').digest('hex'),
  messages: '5',
  inputChars: '820',
  ...overrides,
});

test('匿名 AI 日志只解析固定聚合字段', () => {
  assert.deepEqual(parseAiRecord(aiLine()), {
    timestamp: Date.parse('2026-09-09T12:00:00+08:00'),
    status: 200,
    durationMs: 3428,
    bytes: 1532,
    experimentHash: crypto.createHash('sha256').update('physics-middle/初中物理实验1.html').digest('hex'),
    messageCount: 5,
    inputChars: 820,
  });
});
```

Add cases proving that extra keys, malformed JSON, invalid dates, non-integer status/bytes/messages/input characters, negative duration, non-empty non-hash experiment values and symlinked log files are rejected. Add a rotated gzip case and prove unrelated files are ignored. Add a manifest fixture and assert that only exact `path` hashes map to bounded titles; verify serialized outputs contain neither the original path nor injected unknown values.

- [ ] **Step 2: Run the new test and observe the missing module failure**

Run:

```bash
node server/api/test/traffic-ai-report.js
```

Expected: FAIL with `Cannot find module '../../../tools/traffic-ai-report.cjs'`.

- [ ] **Step 3: Extract the existing bounded reader without changing its wrapper**

In `tools/traffic-report.cjs`, replace the hard-coded directory body with an exported helper while keeping `visitLogDirectory(directory, visit)` behavior unchanged:

```js
async function visitMatchingLogs(directory, pattern, missingMessage, visit) {
  const names = fs.readdirSync(directory).filter(name => pattern.test(name)).sort();
  if (!names.length) throw new Error(missingMessage);
  const files = [];
  for (const name of names) {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error('独立日志必须是普通文件 (regular file)：' + name);
    files.push({ name, bytes: stat.size });
    if (!stat.size) continue;
    const source = fs.createReadStream(file, {
      flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      end: stat.size - 1,
    });
    const input = name.endsWith('.gz') ? source.pipe(zlib.createGunzip()) : source;
    if (input !== source) source.on('error', error => input.destroy(error));
    const reader = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of reader) visit(line);
    } catch (error) {
      throw new Error('读取独立日志失败：' + name + '（' + error.code + '）', { cause: error });
    } finally {
      reader.close(); source.destroy(); if (input !== source) input.destroy();
    }
  }
  return files;
}

function visitLogDirectory(directory, visit) {
  return visitMatchingLogs(directory, LOG_NAME, '未找到实验馆独立日志；不会使用旧混合日志代替。', visit);
}
```

Export `visitMatchingLogs` alongside the existing exports. Re-run `node server/api/test/traffic-report.js`; expected PASS with the existing count and privacy behavior unchanged.

- [ ] **Step 4: Implement the strict AI parser and manifest mapping**

Create `tools/traffic-ai-report.cjs` with these fixed limits and interfaces:

```js
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { visitMatchingLogs } = require('./traffic-report.cjs');

const AI_LOG_NAME = /^science-lab-ai-access\.log(?:-\d{8}(?:\.gz)?)?$/;
const HASH = /^[a-f0-9]{64}$/;
const FIELDS = ['bytes', 'duration', 'experiment', 'inputChars', 'messages', 'status', 'time'];
const integer = (value, maximum) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) <= maximum ? Number(value) : null;

function parseAiRecord(line) {
  if (!line.trim()) return null;
  const value = JSON.parse(line);
  if (!value || Array.isArray(value) || Object.keys(value).sort().join('\n') !== FIELDS.join('\n')) throw new Error('AI 日志字段无效');
  const timestamp = Date.parse(value.time);
  const status = integer(value.status, 599);
  const bytes = integer(value.bytes, Number.MAX_SAFE_INTEGER);
  const messageCount = value.messages === '' ? null : integer(value.messages, 20);
  const inputChars = value.inputChars === '' ? null : integer(value.inputChars, 80000);
  const duration = Number(value.duration);
  if (!Number.isFinite(timestamp) || status === null || status < 100 || bytes === null || !Number.isFinite(duration) || duration < 0 || duration > 86400 ||
      (value.experiment !== '' && !HASH.test(value.experiment)) || messageCount === null && value.messages !== '' || inputChars === null && value.inputChars !== '') {
    throw new Error('AI 日志数值无效');
  }
  return { timestamp, status, durationMs: Math.round(duration * 1000), bytes,
    experimentHash: value.experiment || null, messageCount, inputChars };
}

function visitAiLogDirectory(directory, visit) {
  return visitMatchingLogs(directory, AI_LOG_NAME, '未找到匿名 AI 日志', visit);
}
```

Implement `loadExperimentMap(manifestFile)` using `lstatSync`, a 1 MiB size limit, strict array/object/string checks, SHA-256 of each exact path and a title limit of 300 characters. Reject duplicate hashes with conflicting titles and return a `Map`. Export all three functions.

- [ ] **Step 5: Add the test to the full suite and verify the focused tests**

Insert `node test/traffic-ai-report.js` immediately before the two existing traffic tests in `server/api/package.json`.

Run:

```bash
node server/api/test/traffic-report.js
node server/api/test/traffic-ai-report.js
```

Expected: both commands exit 0 and no assertion output contains an experiment path, IP, User-Agent or chat text.

- [ ] **Step 6: Record a no-commit checkpoint**

Run `git diff --check` and `git status --short`; expected: only Task 2 files plus the approved documents have changed. Do not commit.

### Task 3: Add AI rolling buckets and history migration

**Files:**
- Modify: `tools/traffic-dashboard.cjs`
- Modify: `server/api/test/traffic-dashboard.js`

- [ ] **Step 1: Write failing aggregation and coverage tests**

Extend the test helper so `summary(trafficLines, aiLines, options)` passes `aiLines`, `aiCollectionStart` and an experiment map into `rollingSummary`. Add assertions for:

```js
assert.equal(result.schema, 3);
assert.equal(result.totals.requests, normalTrafficCount + aiLines.length);
assert.deepEqual(result.totals.ai, {
  coverage: 'recorded',
  requests: 5,
  httpSuccesses: 1,
  invalidRequests: 1,
  rateLimited: 1,
  serverErrors: 1,
  otherStatuses: 1,
  durationMsTotal: 3428,
  durationSamples: 1,
  responseBytes: 1532,
  messageCountTotal: 5,
  messageSamples: 1,
  inputCharsTotal: 820,
  inputSamples: 1,
  experiments: [{ title: '初中物理实验1', requests: 1 }],
});
```

Use statuses 200, 400, 429, 503 and 302. Assert AI rows never affect `entryRequests`, `visitorEstimate`, `devices`, `sources` or `automated`. Add hours before, across and after `aiCollectionStart` and assert `unavailable`, `partial`, `recorded`. Migrate a valid schema 1 fixture and assert schema 2 output preserves traffic counts while adding AI `coverage: 'unavailable'` with zero counters.

- [ ] **Step 2: Run the dashboard test and observe the schema/count failure**

Run:

```bash
node server/api/test/traffic-dashboard.js
```

Expected: FAIL because current output remains schema 2 and contains no `ai` bucket.

- [ ] **Step 3: Implement the minimal AI bucket and status grouping**

Add these bucket fields and status rules in `tools/traffic-dashboard.cjs`:

```js
function aiBucket(trackExperiments = false) {
  return { requests: 0, httpSuccesses: 0, invalidRequests: 0, rateLimited: 0,
    serverErrors: 0, otherStatuses: 0, durationMsTotal: 0, durationSamples: 0,
    responseBytes: 0, messageCountTotal: 0, messageSamples: 0,
    inputCharsTotal: 0, inputSamples: 0,
    experiments: trackExperiments ? new Map() : null };
}

function addAi(target, record, experimentMap) {
  target.requests++;
  if (record.status >= 200 && record.status < 300) {
    target.httpSuccesses++;
    target.durationMsTotal += record.durationMs;
    target.durationSamples++;
    target.responseBytes += record.bytes;
    if (record.messageCount !== null) { target.messageCountTotal += record.messageCount; target.messageSamples++; }
    if (record.inputChars !== null) { target.inputCharsTotal += record.inputChars; target.inputSamples++; }
    if (target.experiments) {
      const title = experimentMap.get(record.experimentHash) || '未知实验';
      target.experiments.set(title, (target.experiments.get(title) || 0) + 1);
    }
  } else if (record.status === 400) target.invalidRequests++;
  else if (record.status === 429) target.rateLimited++;
  else if (record.status >= 500) target.serverErrors++;
  else target.otherStatuses++;
}
```

Update the generic request/error counters when an AI record is added, but do not touch visitor identity/device/source fields. Sort current experiment rows by request count descending then title, and cap the rendered array to the known manifest size plus one `未知实验` row.

- [ ] **Step 4: Add independent AI coverage and schema migration**

Validate `aiCollectionStart` separately from the existing site collection start. For each totals/hour/day AI bucket derive coverage with this rule:

```js
const coverage = (start, end, began) => end <= began ? 'unavailable' : start < began ? 'partial' : 'recorded';
```

Emit dashboard schema 3 and history schema 2. `mergeHistory` must accept schema 1 only as an input migration source, sanitize every existing traffic field, synthesize an unavailable AI bucket, and then write schema 2. Schema 2 inputs must validate every non-negative safe integer and `coverage` enum; experiment rows must never enter daily history.

- [ ] **Step 5: Read both logs atomically during publication**

Extend `publish` and CLI parsing with `--ai-log-dir`, `--ai-collection-start` and `--manifest-file`. Load the manifest map first, stream normal logs through `accumulator.add`, stream AI logs through `accumulator.addAi`, and only then call `finish()`. Any parse/read/history error must occur before either atomic output replaces the old files.

Update the publish test fixture with an empty normal log, an AI log, a manifest file and an existing schema 1 history file. Assert the new page/history are written once; then append a bad AI line and verify both old outputs remain byte-identical.

- [ ] **Step 6: Run focused aggregation tests**

Run:

```bash
node server/api/test/traffic-ai-report.js
node server/api/test/traffic-dashboard.js
```

Expected: both commands pass; serialized dashboard/history data contain no IP, User-Agent, experiment path, unknown injected value or chat text.

- [ ] **Step 7: Record a no-commit checkpoint**

Run `git diff --check` and `git status --short`; do not commit.

### Task 4: Render AI metrics in the private dashboard and CSV

**Files:**
- Modify: `tools/traffic-dashboard-view.cjs`
- Modify: `tools/traffic-dashboard-client.js`
- Create: `tools/traffic-dashboard-ai.css`
- Modify: `server/api/test/traffic-dashboard.js`

- [ ] **Step 1: Write failing view, CSV and script tests**

Extend the fixture with schema 3 AI data and assert the rendered page contains:

```js
assert.match(html, /AI 交互/);
assert.match(html, /仅内置模式/);
assert.match(html, /HTTP 2xx/);
assert.match(html, /BYOK 不在统计范围/);
assert.match(html, /不保存问题或回答正文/);
assert.match(html, /初中物理实验1/);
assert.doesNotMatch(html, /[a-f0-9]{64}/);
```

Assert CSV headers include `AI请求`, `AI_HTTP_2xx`, `AI限流_429`, `AI_5xx`, `AI_2xx平均耗时毫秒`, `AI平均上下文消息数`, `AI平均输入字符数` and `AI平均响应字节数`. For unavailable AI hours/history, assert all AI cells are empty rather than `0`.

Add a script assertion proving nested metrics use a helper rather than `hour[metric]` directly, and AI coverage uses `hour.ai.coverage`.

- [ ] **Step 2: Run the dashboard test and observe missing UI/CSV fields**

Run `node server/api/test/traffic-dashboard.js`.

Expected: FAIL on the first missing `AI 交互` or CSV header assertion.

- [ ] **Step 3: Add safe formatting and CSV serialization**

In `tools/traffic-dashboard-view.cjs`, add bounded helpers:

```js
const average = (total, samples) => samples ? Math.round(total / samples) : null;
const duration = value => value === null ? '—' : value >= 1000 ? (value / 1000).toFixed(1) + ' 秒' : value + ' 毫秒';
const bytes = value => value === null ? '—' : value >= 1024 ? (value / 1024).toFixed(1) + ' KB' : value + ' B';
```

Extend `toCsv` with fixed AI columns. Use a dedicated AI coverage check; return eight empty AI cells when coverage is `unavailable`. Never export experiment titles or hashes to the 400-day historical CSV.

- [ ] **Step 4: Add the observatory-style AI section**

Keep the current dark field-observatory aesthetic. Add one restrained cyan-blue accent variable for AI, an `AI / BUILT-IN` eyebrow, compact metrics for requests/2xx/429/2xx average duration, a status distribution, context/response averages and a ranked experiment list. Reuse existing panel, track, metric and responsive grid patterns; avoid a second visual language, external fonts, images or animation libraries.

Add the two trend buttons with exact values `ai.requests` and `ai.httpSuccesses`. In `traffic-dashboard-client.js`, introduce:

```js
const valueOf = (hour, key) => key.startsWith('ai.') ? hour.ai[key.slice(3)] : hour[key];
const coverageOf = (hour, key) => key.startsWith('ai.') ? hour.ai.coverage : hour.coverage;
```

Use these helpers in detail text, bar height, scale and ARIA labels. The 24-hour table gains AI request/2xx columns, with `—` for unavailable AI periods.

- [ ] **Step 5: Update methodology and schema validation**

Require schema 3, 24 hours, history array and a valid nested AI object before rendering. Explain that 2xx is not `[DONE]`, request time includes network delivery, response bytes are not tokens, BYOK is excluded, experiment ranking covers only the rolling raw-log window and no question/answer body is stored.

- [ ] **Step 6: Run focused tests**

Run:

```bash
node server/api/test/traffic-dashboard.js
```

Expected: PASS, including CSP hash equality and absence of raw identifiers/hashes.

- [ ] **Step 7: Record a no-commit checkpoint**

Run `git diff --check`; do not commit.

### Task 5: Send an experiment path only for built-in AI requests

**Files:**
- Modify: `index.html`
- Modify: `server/api/test/frontend-storage.js`
- Modify: `sw.js`
- Modify: `experiment-scroll.js`
- Modify: `server/api/test/frontend-scroll.js`

- [ ] **Step 1: Write failing request-body tests**

Change the frontend harness calls to pass `physics-middle/初中物理实验1.html` as the third argument and assert:

```js
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(test.api.buildAiRequestBody({ byok: false, model: 'DeepSeek' }, messages, experimentPath))),
  { stream: true, messages, context: { experimentPath } }
);
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(test.api.buildAiRequestBody({ byok: true, model: 'DeepSeek' }, messages, experimentPath))),
  { model: 'deepseek-v4-flash', stream: true, messages }
);
```

Add a source assertion that `sendChat` passes the current manifest path into `buildAiRequestBody`.

- [ ] **Step 2: Run the frontend storage test and observe failure**

Run `node server/api/test/frontend-storage.js`.

Expected: FAIL because the current helper ignores its third argument.

- [ ] **Step 3: Implement the mode-specific body**

Use this exact branching shape in `index.html`:

```js
function buildAiRequestBody(cfg,messages,experimentPath){
  if(cfg.byok) return {model:resolveAiModel(cfg.model),stream:true,messages};
  return {stream:true,messages,context:{experimentPath:String(experimentPath||'').slice(0,300)}};
}
```

Call it with `path` from the already captured current manifest entry. Do not add headers, beacons, analytics calls or BYOK metadata.

- [ ] **Step 4: Bump the coordinated shell version**

Change all three runtime references from `v0.8.9` to `v0.8.10` in `sw.js`, `experiment-scroll.js` and the `index.html` script URL. Update the exact version assertion in `server/api/test/frontend-scroll.js`.

- [ ] **Step 5: Run focused frontend/cache tests**

Run:

```bash
node server/api/test/frontend-storage.js
node server/api/test/frontend-scroll.js
node server/api/test/service-worker-cache.js
```

Expected: all pass; BYOK bodies contain no `context`, and the three App version locations all equal `v0.8.10`.

- [ ] **Step 6: Record a no-commit checkpoint**

Run `git diff --check`; do not commit.

### Task 6: Derive fixed anonymous metric headers in the API

**Files:**
- Modify: `server/api/server.js`
- Modify: `server/api/test/smoke.js`

- [ ] **Step 1: Write failing API metadata tests**

Import `node:crypto` in the smoke test. Send a valid request containing `context.experimentPath`, then assert:

```js
const expectedHash = crypto.createHash('sha256').update(experimentPath).digest('hex');
assert.strictEqual(r.headers.get('x-science-lab-ai-experiment'), expectedHash);
assert.strictEqual(r.headers.get('x-science-lab-ai-messages'), '2');
assert.strictEqual(r.headers.get('x-science-lab-ai-input-chars'), String('系统'.length + '解释实验'.length));
assert.strictEqual(Object.hasOwn(captured.body, 'context'), false);
```

Add cases for a missing path and a path longer than 300 characters; the experiment header must be empty while numeric headers remain valid. Invalid messages must return 400 without metric headers because no content was accepted.

- [ ] **Step 2: Run the smoke test and observe missing headers**

Run `node server/api/test/smoke.js`.

Expected: FAIL because `x-science-lab-ai-experiment` is currently absent.

- [ ] **Step 3: Implement the metric header helper**

Import `createHash` from `node:crypto` and add:

```js
function setAiMetricHeaders(res, messages, context) {
  const rawPath = context && typeof context.experimentPath === 'string' ? context.experimentPath : '';
  const experiment = rawPath && rawPath.length <= 300
    ? createHash('sha256').update(rawPath).digest('hex')
    : '';
  res.set({
    'X-Science-Lab-AI-Experiment': experiment,
    'X-Science-Lab-AI-Messages': String(messages.length),
    'X-Science-Lab-AI-Input-Chars': String(messages.reduce((sum, item) => sum + item.content.length, 0)),
  });
}
```

Call it only after `sanitizeAiBody` succeeds and before checking `DEEPSEEK_API_KEY`. Continue passing only `parsed.value` to DeepSeek, so `context` cannot leave the server. Do not log any request object or content.

- [ ] **Step 4: Run AI API tests**

Run:

```bash
node server/api/test/smoke.js
node server/api/test/ai-edge-cases.js
node server/api/test/ai-default-limits.js
```

Expected: all pass; rate limiting, timeout, disconnect and secret-redaction behavior remain unchanged.

- [ ] **Step 5: Record a no-commit checkpoint**

Run `git diff --check`; do not commit.

### Task 7: Add deployable Nginx/systemd configuration and documentation

**Files:**
- Create: `server/traffic/nginx-ai-log-format.conf`
- Modify: `server/traffic/science-lab-traffic.service`
- Modify: `server/api/test/frontend-catalog-control.js`
- Modify: `server/traffic/README.md`
- Modify: `docs/aliyun-deploy.md`
- Modify: `README.md`

- [ ] **Step 1: Write failing configuration/privacy assertions**

In `server/api/test/frontend-catalog-control.js`, read the new Nginx source file and assert:

```js
assert.match(aiLogFormat, /log_format science_lab_ai escape=json/);
assert.match(aiLogFormat, /\$time_iso8601/);
assert.match(aiLogFormat, /\$request_time/);
assert.match(aiLogFormat, /\$body_bytes_sent/);
assert.match(aiLogFormat, /\$upstream_http_x_science_lab_ai_experiment/);
assert.doesNotMatch(aiLogFormat, /\$remote_addr|\$http_user_agent|\$http_referer|\$request_body|authorization/i);
assert.ok(deployGuide.includes('access_log /var/log/nginx/science-lab-ai-access.log science_lab_ai;'));
assert.ok(deployGuide.includes('proxy_hide_header X-Science-Lab-AI-Experiment;'));
```

Assert the service includes the AI log directory, manifest file and `${AI_COLLECTION_START}` argument, and that operations documentation explicitly says the dedicated AI location must not repeat the normal `main` access log.

- [ ] **Step 2: Run the configuration test and observe the missing file failure**

Run `node server/api/test/frontend-catalog-control.js`.

Expected: FAIL because `server/traffic/nginx-ai-log-format.conf` does not exist.

- [ ] **Step 3: Add the anonymous Nginx log format**

Create `server/traffic/nginx-ai-log-format.conf` with one `http`-context directive:

```nginx
log_format science_lab_ai escape=json '{"time":"$time_iso8601","status":"$status","duration":"$request_time","bytes":"$body_bytes_sent","experiment":"$upstream_http_x_science_lab_ai_experiment","messages":"$upstream_http_x_science_lab_ai_messages","inputChars":"$upstream_http_x_science_lab_ai_input_chars"}';
```

Do not add IP, forwarded-for, User-Agent, Referer, request line, request body, query string, cookie, authorization or request ID variables.

- [ ] **Step 4: Update the documented exact AI location**

In the HTTPS `location = /api/ai/chat/completions` example, add only the dedicated log:

```nginx
access_log /var/log/nginx/science-lab-ai-access.log science_lab_ai;
proxy_hide_header X-Science-Lab-AI-Experiment;
proxy_hide_header X-Science-Lab-AI-Messages;
proxy_hide_header X-Science-Lab-AI-Input-Chars;
```

Explain that a location-level `access_log` replaces inherited server-level logging, so AI requests no longer enter the normal IP/User-Agent log. The dashboard explicitly adds AI rows back into the aggregate “全部请求” and 4xx/5xx totals.

- [ ] **Step 5: Parameterize the traffic service collection start**

Add the optional environment-file directive and exact arguments:

```ini
EnvironmentFile=-/etc/science-lab-traffic.env
ExecStart=/usr/bin/flock -n /var/lib/science-lab-traffic/update.lock /opt/science-lab-runtime/node-v22.23.2-linux-x64/bin/node /opt/science-lab-traffic/traffic-dashboard.cjs --log-dir /var/log/nginx --ai-log-dir /var/log/nginx --manifest-file /var/www/science-lab-current/manifest.json --state-dir /var/lib/science-lab-traffic --collection-start 2026-09-07T13:41:00Z --ai-collection-start ${AI_COLLECTION_START}
```

Document `/etc/science-lab-traffic.env` as root-owned mode 0600 with a single non-secret UTC timestamp written at the actual Nginx activation time. A missing or empty value must make generation fail rather than fabricate coverage.

- [ ] **Step 6: Update operations and user documentation**

Update the exact runtime file list to include `traffic-ai-report.cjs`. Document schema migration, raw-log rotation, 400-day aggregate retention, current-window-only experiment ranking, BYOK exclusion, SSE 2xx limitation, response-byte semantics, fail-closed behavior, backup/rollback order and the fact that no chat body is persisted.

In the root README AI section, add one concise paragraph linking the private dashboard and stating the same privacy boundary.

- [ ] **Step 7: Run configuration and documentation tests**

Run:

```bash
node server/api/test/frontend-catalog-control.js
node server/api/test/traffic-ai-report.js
node server/api/test/traffic-dashboard.js
```

Expected: all pass and the Nginx source assertion proves prohibited identifying variables are absent.

- [ ] **Step 8: Record a no-commit checkpoint**

Run `git diff --check`; do not commit.

### Task 8: Full local verification and UI review

**Files:**
- Verify all changed files
- Create only ignored local review artifacts under `output/`

- [ ] **Step 1: Run the complete automated suite**

Run:

```bash
npm test --prefix server/api
git diff --check
```

Expected: both exit 0; all existing traffic, AI, cache, deployment-guide and frontend tests pass.

- [ ] **Step 2: Generate a representative private dashboard fixture**

Use a temporary directory created by `mktemp -d`, populate a normal log, anonymous AI log, manifest and schema 1 history fixture, then run the real `tools/traffic-dashboard.cjs` CLI with fixed collection timestamps. Copy only the generated HTML into an ignored `output/playwright/private-ai-analytics/` review directory.

Expected: one self-contained page and one private history file; the page source contains aggregate titles/counts but no hashes, paths, IP, User-Agent or chat text.

- [ ] **Step 3: Validate the page headlessly with isolated browser ownership**

Before opening a browser, read and follow `browser-lifecycle` and `playwright`. Create a task-owned headless context, load the generated page at 1440×1000 and 390×844, capture screenshots, and verify:

```text
document.documentElement.scrollWidth === document.documentElement.clientWidth
console errors === 0
network requests === 0
AI trend controls update bars and detail text
unavailable AI hours render as unavailable rather than zero
current/history CSV downloads contain the visible snapshot
```

Close only the exact task-owned context and keep screenshots under the ignored review directory.

- [ ] **Step 4: Inspect the final diff for privacy and scope**

Run:

```bash
git diff --stat
git diff -- server/api/server.js index.html tools/traffic-ai-report.cjs tools/traffic-dashboard.cjs tools/traffic-dashboard-view.cjs server/traffic/nginx-ai-log-format.conf
rg -n "request_body|authorization|remote_addr|user_agent|referer" server/traffic/nginx-ai-log-format.conf
git status --short
```

Expected: the `rg` command has no matches; no existing untracked user files changed; no secret, chat text logging, database, external analytics or unrelated refactor appears in the diff.

- [ ] **Step 5: Apply `superpowers:verification-before-completion`**

Read that skill, rerun every evidence command it requires, and report exact pass/fail output. Do not claim completion from earlier cached results.

- [ ] **Step 6: Stop at the release gate**

Present the test summary, screenshots, changed-file list, privacy audit, production configuration changes and rollback plan. Ask the user for one explicit approval covering commit, push and deployment. Do not perform any of those actions in this step.

### Task 9: Production inspection, commit, push and deployment after explicit approval

**Files:**
- Commit the reviewed feature files
- Modify production only after the Task 8 approval

- [x] **Step 1: Inspect production read-only before committing**

Run a non-interactive SSH inspection against `root@47.97.174.49` to collect `nginx -T` include placement, the exact HTTPS AI location, `/etc/logrotate.d/nginx`, `systemctl cat science-lab-api`, `systemctl cat science-lab-traffic`, current release links, file ownership/modes, service/timer status and current report hashes. Do not print environment-file contents or any API key.

Expected: confirm the source Nginx format can be installed in an `http`-context include, `*log` rotation covers the new file, the service can read `nginx:root` mode 0640 logs and every rollback target exists. If any assumption differs, stop and revise the deployment steps before mutation.

- [x] **Step 2: Commit and push the reviewed diff**

After confirming only approved files are staged, run:

```bash
git add README.md docs/aliyun-deploy.md docs/superpowers/specs/2026-09-09-private-ai-analytics-design.md docs/superpowers/plans/2026-09-09-private-ai-analytics.md experiment-scroll.js index.html server/api/package.json server/api/server.js server/api/test/frontend-catalog-control.js server/api/test/frontend-scroll.js server/api/test/frontend-storage.js server/api/test/smoke.js server/api/test/traffic-ai-report.js server/api/test/traffic-dashboard.js server/traffic/README.md server/traffic/nginx-ai-log-format.conf server/traffic/science-lab-traffic.service sw.js tools/traffic-ai-report.cjs tools/traffic-dashboard-ai.css tools/traffic-dashboard-client.js tools/traffic-dashboard-view.cjs tools/traffic-dashboard.cjs tools/traffic-report.cjs
git diff --cached --check
git commit -m "feat: add private AI usage analytics"
git push origin main
```

If an listed file has no change, omit it from `git add` after verifying that the corresponding behavior is covered elsewhere. Expected: one feature commit pushed to `origin/main`; existing untracked files remain uncommitted.

- [x] **Step 3: Back up production and install inactive files**

Create a root-only backup directory with `mktemp -d /var/tmp/science-lab-ai-analytics.XXXXXX`. Copy the active API release reference, seven traffic runtime files, Nginx site/main configuration, logrotate config, traffic unit, environment file if present, current history and current report into it while preserving modes. Upload the new API/static release and traffic/config source files to new inactive paths; do not switch links or reload services yet.

Expected: uploaded file SHA-256 values match the committed local files, backups are readable only by root, and active public/service state is unchanged.

- [x] **Step 4: Validate inactive configuration and establish the collection start**

Write `/etc/science-lab-traffic.env` atomically as root mode 0600 with `AI_COLLECTION_START` set to the UTC timestamp immediately before Nginx activation. Create `/var/log/nginx/science-lab-ai-access.log` as `nginx:root` mode 0640. Install the Nginx log-format include and modified exact AI location, then run `nginx -t`; install the traffic unit and run `systemd-analyze verify` before `daemon-reload`.

Expected: both validators exit 0, the dedicated log format contains no prohibited identifying variables, and no service has been restarted yet.

- [x] **Step 5: Switch API/static releases and reload logging safely**

Atomically point `/opt/science-lab-api-current` and `/var/www/science-lab-current` to the new commit-based releases, restart `science-lab-api`, verify local health, then reload Nginx so new workers begin the dedicated AI log. Keep the previous release links and configuration backups intact.

Expected: API service active, local/public health return `{"ok":true}`, homepage serves `v0.8.10`, and Nginx master remains running with new workers.

- [x] **Step 6: Generate and validate the first AI-aware report**

Install the seven traffic runtime files as a group, start `science-lab-traffic.service`, and inspect only service status plus sanitized summary output. Use one short real built-in AI request to verify HTTP 200/SSE `[DONE]`, then inspect the dedicated AI log structurally without printing the line: validate its JSON keys/types and assert prohibited fields/known prompt text are absent. Run the traffic service again and verify the private page contains the AI section and the new request count.

Expected: AI request is absent from `science-lab-access.log`, present once in `science-lab-ai-access.log`, no IP/User-Agent/request text is stored in that line, private page remains Basic-Auth protected and all aggregate counts are consistent.

- [x] **Step 7: Verify rotation, timer, public regressions and rollback readiness**

Use `logrotate --debug /etc/logrotate.d/nginx` without forcing rotation. Verify the traffic timer next run, public homepage/security headers, API health, AI malformed-request behavior, old `/api/` 503 behavior, private unauthorized 401/authorized 200 behavior and current file modes. Compare deployed hashes to Git.

Expected: all checks pass, no secret is printed, no unrelated service/config changed, and the backup plus previous release links can restore the prior state.

- [x] **Step 8: Roll back on any failed production check**

If a production validation fails, restore the exact backed-up Nginx/unit/runtime files, atomically restore both previous release links, run `nginx -t`, reload Nginx, restart only the affected API/traffic service, and verify old homepage/API/private dashboard behavior. Preserve the anonymous AI log outside the Web root for audit; do not delete history or the prior report.

- [x] **Step 9: Record final evidence**

Update this plan with the commit SHA, production release paths, backup directory, activation timestamp, sanitized test results and rollback targets. Run `git diff --check`, commit only that evidence update after user-visible deployment succeeds, push it, and report the final URLs and privacy boundary.

#### Production evidence — 2026-09-10

- Feature commit: `a9b2f5337bc7b030bc77607a96b99b7159bd7929`, pushed to `origin/main` before deployment.
- Active releases: API `/opt/science-lab-api-releases/20260910-a9b2f53b`; static `/var/www/science-lab-releases/20260910-a9b2f53b`.
- Rollback releases: API `/opt/science-lab-api-releases/20260909-82332b2e5ea6`; static `/var/www/science-lab-releases/20260909-82332b2e5ea6`; pre-deploy traffic runtime `/opt/science-lab-traffic.predeploy-20260910-a9b2f53b`.
- Root-only backup: `/var/tmp/science-lab-ai-analytics.oOCsIi` (mode 0700). It contains the previous release targets, Nginx site/main and logrotate configuration, traffic unit/runtime, history and generated report.
- AI collection activation: `2026-09-10T01:03:25Z` (`2026-09-10 09:03:25` Asia/Shanghai). `/etc/science-lab-traffic.env` is root:root 0600; the anonymous log is nginx:root 0640.
- Inactive validation: uploaded API/static/traffic archive SHA-256 values matched locally and remotely; `nginx -t` and `systemd-analyze verify` passed before reload; the API service user could read the new release and Node syntax/JSON checks passed.
- A first switch attempt hit the expected service-readiness race because the health request ran before Node bound port 8970. The automatic rollback restored both old releases, the old Nginx config and the old traffic unit; local health then returned `{"ok":true}`. The retry used bounded condition polling and completed successfully.
- Runtime validation: API and Nginx are active; public health/home/manifest returned 200; the shell serves `v0.8.10`; legacy `/api/` remains 503; private traffic without credentials remains 401 with the unchanged Basic-Auth location. An authenticated 200 was not repeated because no plaintext dashboard credential was read or reset; the unchanged location source and generated page file were verified directly.
- AI validation: one short built-in request returned HTTP 200 with SSE `[DONE]`; a malformed request returned 400. Both were absent from the normal log and present in the anonymous log. All anonymous records had exactly the seven approved keys; prompt text, API key material, IP, User-Agent and deployment markers were absent. Internal metric response headers were not exposed publicly.
- Aggregation validation: live data correctly remained at the completed 08:00 window; an isolated next-window publish counted two AI requests, one HTTP 2xx and one invalid 400 without changing the live report. The production timer was active with its next run at 10:00 Asia/Shanghai.
- Retention and integrity: `logrotate --debug` included `science-lab-ai-access.log`; history migrated to schema 2; 20 committed deployed files plus the reviewed Nginx site candidate matched SHA-256; `origin/main` matched local HEAD.
