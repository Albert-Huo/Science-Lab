# Catalog Publishing Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add reversible category- and experiment-level publishing controls, with “物理 · 高中” hidden in the preview configuration.

**Architecture:** Keep `manifest.json` as the source of experiment metadata and add `catalog-control.json` as a small, independently deployable control plane. A focused browser/Node-compatible module resolves `published`, `hidden`, and `disabled` states before the existing UI boots; the UI receives only published experiments while retaining state metadata for old history entries.

**Tech Stack:** Static HTML/JavaScript, JSON, Service Worker Cache API, Node.js assertion tests.

---

### Task 1: Publishing-state resolver

**Files:**
- Create: `catalog-control.js`
- Create: `catalog-control.json`
- Create: `server/api/test/frontend-catalog-control.js`

- [x] **Step 1: Write the failing resolver tests**

Create tests that import `catalog-control.js` and assert:

```js
const result = CatalogControl.apply(fixtures, {
  categories: { 'physics-high': { state: 'hidden' } },
  experiments: { 'physics-high/keep.html': { state: 'published' } }
});
assert.deepStrictEqual(result.experiments.map((item) => item.path), [
  'physics-middle/a.html',
  'physics-high/keep.html'
]);
assert.strictEqual(result.states['physics-high/off.html'], 'hidden');
```

Also cover `disabled`, missing configuration, invalid state fallback, duplicate history paths, and visible progress calculations.

- [x] **Step 2: Run the resolver test and verify RED**

Run: `node test/frontend-catalog-control.js` from `server/api`.

Expected: FAIL with `MODULE_NOT_FOUND` for `catalog-control.js`.

- [x] **Step 3: Implement the resolver module**

Expose a small CommonJS/browser API:

```js
CatalogControl.apply(manifest, control)
// => { experiments: [...publishedItems], states: { [path]: state } }

CatalogControl.stats(experiments, history)
// => { total, seen, percent }
```

Resolve category IDs from the first path segment, allow an exact experiment rule to override its category, and treat missing or invalid values as `published`.

- [x] **Step 4: Add the preview control file**

Create:

```json
{
  "version": 1,
  "categories": {
    "physics-high": { "state": "hidden" }
  },
  "experiments": {}
}
```

- [x] **Step 5: Run the resolver test and verify GREEN**

Run: `node test/frontend-catalog-control.js` from `server/api`.

Expected: all resolver and statistics scenarios pass.

### Task 2: Load controls and preserve history

**Files:**
- Modify: `index.html`
- Modify: `server/api/test/frontend-catalog-control.js`

- [x] **Step 1: Add failing integration assertions**

Assert that `index.html` loads `catalog-control.js`, fetches `catalog-control.json` with `cache: 'no-store'`, passes filtered experiments into `boot`, and renders unavailable labels for history entries excluded from the active catalog.

- [x] **Step 2: Run the integration test and verify RED**

Run: `node test/frontend-catalog-control.js` from `server/api`.

Expected: FAIL because the page has not loaded or applied the control plane.

- [x] **Step 3: Wire control loading into the page**

Load the module before the inline script, fetch the manifest as required data, and treat control-file errors as an empty control object:

```js
Promise.all([
  fetchJson('manifest.json'),
  fetchJson('catalog-control.json', { cache: 'no-store' }).catch(() => ({}))
]).then(([sourceManifest, control]) => {
  const catalog = CatalogControl.apply(sourceManifest, control);
  boot(catalog.experiments, catalog.states);
});
```

If no experiment remains published, show a stable “暂无开放实验” empty state instead of indexing an empty array.

- [x] **Step 4: Keep old history but make availability explicit**

Use `CatalogControl.stats` so totals and percentages count only currently published paths. Continue rendering all saved history rows; unresolved `hidden` rows display “已从目录隐藏”, unresolved `disabled` rows display “暂不可用”, and clicking either shows a toast without changing the current experiment.

- [x] **Step 5: Run the integration test and verify GREEN**

Run: `node test/frontend-catalog-control.js` from `server/api`.

Expected: all resolver and page-wiring scenarios pass.

### Task 3: Cache policy and operator documentation

**Files:**
- Modify: `sw.js`
- Modify: `README.md`
- Modify: `server/api/package.json`

- [x] **Step 1: Extend the unified test command**

Append `node test/frontend-catalog-control.js` to the existing `npm test` script.

- [x] **Step 2: Make control updates network-first**

Precache `catalog-control.js` and `catalog-control.json`, apply the same network-first/offline-fallback policy used by `manifest.json` to the control JSON, and bump the cache version from `v0.6.1` to `v0.7.0`.

- [x] **Step 3: Document exact operating steps**

Add a README section describing stable category IDs, all three states, experiment-over-category precedence, the current `physics-high` preview setting, and the limitation that frontend `disabled` cannot block a known direct URL on the separate content host.

- [x] **Step 4: Run the full local suite**

Run: `npm test` from `server/api`.

Expected: the existing 29 scenarios plus the new catalog-control scenarios all pass without contacting the real DeepSeek API.

### Task 4: Preview verification and cleanup

**Files:**
- Verify: `index.html`
- Verify: `catalog-control.json`
- Verify: `sw.js`

- [x] **Step 1: Check source and diff integrity**

Run: `git diff --check`.

Expected: exit code 0 with no whitespace errors.

- [x] **Step 2: Verify the local preview response**

Confirm `http://127.0.0.1:18789/catalog-control.json` returns `physics-high: hidden` and `sw.js` returns cache version `v0.7.0`.

- [x] **Step 3: Validate desktop and mobile layouts headlessly**

Use one unique Playwright CLI session, verify the “物理 · 高中” chip and its 18 experiments are absent, confirm the visible total is 120, capture desktop/mobile screenshots for inspection, then close only that session.

- [x] **Step 4: Report without committing**

Keep the isolated worktree uncommitted and unpushed, provide the existing preview URL, verification totals, changed-file summary, and the direct-URL enforcement caveat.
