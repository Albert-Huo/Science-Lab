# qs Dependency Security Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear the two qs advisories from the production dependency graph without changing Science-Lab application behavior.

**Architecture:** Keep Express 4.22.2 and body-parser 1.20.6. Both currently require qs ~6.15.1, so use an explicit npm override to the verified patched release 6.16.0. Regression tests resolve the qs copies used by both parents, and production installs continue to use package-lock.json with npm ci.

**Tech Stack:** Node.js, npm overrides / lockfile v3, CommonJS, node:assert/strict, node:module, node:test.

---

Working directory: `/Users/lx100/.config/superpowers/worktrees/Science-Lab/qs-security-fix`.
Base commit: `ba669dbda52ec70c9af304cd1e779337d7f4510f`.
Branch: `codex/qs-security-fix`. No push, main merge, server deployment, secrets, database or domain changes are part of this fix.

## Evidence and scope

- Existing graph: express 4.22.2 -> body-parser 1.20.6 -> qs 6.15.3; express also directly requires qs ~6.15.1.
- `npm audit --omit=dev --json` reports 3 moderate affected packages and 0 high / critical; the underlying advisories are GHSA-x5fp-wj9c-mxmx and GHSA-4mjr-xmp4-gh2g.
- Maintainer advisories identify qs 6.16.0 as patched. Registry metadata verifies that release exists. Express 4.x and body-parser 1.x currently have no newer available release widening their qs range.
- These library tests exercise the upstream defect; they do not claim that the current application exposes the vulnerable option combinations.
- Retain this temporary override until both upstream dependency ranges admit a patched qs version; remove it only with equivalent regression and audit evidence.

## Task 1: Regression-first dependency repair

**Files:**
- Create: `server/api/test/dependency-security.js`.
- Modify: `server/api/package.json` (test command and qs override only).
- Regenerate: `server/api/package-lock.json` (qs-related changes only; stop and inspect unrelated churn).
- Update completion status in this plan.

- [x] **Step 1: Install and verify the unchanged baseline.**

From `server/api`, run `npm ci --ignore-scripts --no-audit --no-fund && npm test`.
Expected: all existing functional tests pass; a separate production audit still reports the known 3 moderate affected packages.

- [x] **Step 2: Add the following regression test before changing dependencies.**

```javascript
'use strict';

const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { test } = require('node:test');

const expressRequire = createRequire(require.resolve('express/package.json'));
const bodyParserRequire = createRequire(expressRequire.resolve('body-parser/package.json'));

// Resolve each parent's actual dependency instead of assuming one hoisted qs copy.
for (const [parent, parentRequire] of [['express', expressRequire], ['body-parser', bodyParserRequire]]) {
  const qs = parentRequire('qs');

  test(`${parent}: comma bracket arrays obey arrayLimit`, () => {
    assert.throws(() => qs.parse('a[]=1,2,3,4', {
      comma: true,
      arrayLimit: 3,
      throwOnLimitExceeded: true,
    }), RangeError);
  });

  test(`${parent}: hostile constructor.isBuffer does not throw during a round-trip`, () => {
    const parsed = qs.parse('x[constructor][isBuffer]=y', { plainObjects: true });
    assert.doesNotThrow(() => qs.stringify(parsed));
  });

  test(`${parent}: ordinary query parsing and serialization are preserved`, () => {
    const expected = { topic: 'inertia', steps: ['1', '2'] };
    assert.deepEqual(qs.parse('topic=inertia&steps[]=1&steps[]=2'), expected);
    assert.deepEqual(qs.parse(qs.stringify(expected)), expected);
  });
}
```

Prepend `node test/dependency-security.js && ` to the existing package.json test command, leaving every existing test in place.

- [x] **Step 3: Observe the expected red tests.**

Run `node test/dependency-security.js` in `server/api`.
Expected: 4 failures from the two vulnerabilities through the two parents, 2 ordinary-query passes; no syntax or module-resolution failures. Record the actual evidence before proceeding.

- [x] **Step 4: Apply the minimal configuration repair.**

Add this top-level entry to package.json with apply_patch:

```json
"overrides": {
  "qs": "6.16.0"
}
```

Then run `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` and inspect the lockfile diff before installing.
Expected: qs resolves to 6.16.0, with only metadata or dependency changes needed for that update; no Express major update or unrelated package refresh.

- [x] **Step 5: Verify a clean production install and green tests.**

Run `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`, `node test/dependency-security.js`, `npm test`, `npm audit --omit=dev`, and `npm ls express body-parser qs` in `server/api`.
Expected: 6 regression tests pass, the entire existing suite passes, production audit reports 0 vulnerabilities, and both parent paths resolve qs 6.16.0.
Run `git diff --check` and review the full diff. Verify server.js, db.js, schema.sql, index.html, catalog-control.json, sw.js and .env.example are unchanged from the base.

- [ ] **Step 6: Review and preserve the verified local fix.**

After self-review, commit only the three implementation/test files and this plan to the local fix branch, using `fix(api): patch qs dependency vulnerabilities`. Then complete independent spec review followed by code-quality review. Fix any substantiated findings and rerun relevant checks. Do not push or merge main without further approval.

## Deployment handoff

After the local fix is reviewed and committed, export new candidate archives from that exact commit. Leave the ba669db candidate archives intact but identify them as superseded in the new handoff note. Verify each archive file against Git, verify SHA-256 checksums, and identify the new version as local-only until it is merged/pushed. Server access, environment configuration, backups and real DeepSeek validation remain separate deployment gates.
