# Content Scroll Pilot Release Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for the existing approved implementation; main agent owns Git and deployment. Use superpowers:requesting-code-review before release.

**Goal:** Publish the accepted single-handle design for experiments 1, 35 and 41, without including concurrent experiment edits or changing API configuration.

**Architecture:** Keep `experiment-scroll-receiver.js` as canonical receiver source. Inline that exact source once before `</body>` in the three published HTML files, preserving standalone operation and all other bytes. Publish the compatible receiver through existing Pages first. Then atomically switch the ECS static release with `experiment-scroll.js` included in the shell and cache version v0.8.0. Unsupported experiments hide the handle. No new network services, credentials, analytics, or API changes.

**Tech Stack:** Existing HTML/JS, Node tests, isolated headless Playwright, GitHub Pages, existing nginx release symlink.

## Scope and baselines

- App worktree: `/Users/lx100/.config/superpowers/worktrees/Science-Lab/content-scroll-pilot`, base `170517e6f1e3ca7d6120fc663c7a58b9bce27fed`.
- Content release worktree: `/Users/lx100/.config/superpowers/worktrees/HTML-/content-scroll-release`, base `88231ce8c7006a65ac6ed58106aef85be5319062`.
- Do not edit or stage the dirty original content checkout. Only the three HTML files belong to this release.
- ECS current static release `/var/www/science-lab-releases/20260903-170517e6f1e3`; API PID 468357 and service/nginx configuration must remain unchanged.

## Tasks

- [x] Verify repository baselines, existing release mechanism, SSH access, API health, and full local baseline tests.
- [x] Add `assert.ok(added.includes('./experiment-scroll.js'))` to `server/api/test/service-worker-cache.js`; run `node server/api/test/service-worker-cache.js` and observe failure. Add that path to `sw.js` SHELL and change VERSION to `v0.8.0`; rerun successfully.
- [x] Add read-only `tools/check-scroll-release.mjs`: require content root; compare each exact inline receiver block with canonical source; optional full baseline SHA checks every other HTML byte remains unchanged. Run against clean content worktree (expected failure), insert exact receiver blocks with apply_patch, rerun (expected success).
- [x] Update `docs/aliyun-deploy.md` static file list, install command, and shell verification list with `experiment-scroll.js` (eleven physical shell files). Do not upload receiver source, preview pages, tests, or docs to ECS.
- [x] Run fresh full `npm test --prefix server/api`, `node --check` for scroll scripts and worker, HTML inline-script parsing, receiver byte checks and `git diff --check`. A stale ten-file test contract failed and was corrected; final full run passed. Production dependency audit reported zero vulnerabilities.
- [x] Use one named headless session with isolated contexts. Serve the exact content release HTML without preview injection; validate three real experiments: boundary drags, fixed handle, horizontal/tap no action, pointer cancellation, keyboard/wheel, panels/modal, unsupported page, apparatus control, reload, portrait/landscape and desktop. Separately test real-origin cross-domain messaging and Service Worker upgrade/offline shell in owned contexts.
- [x] Request independent read-only review of source and release script, fix important findings, and repeat affected tests. The first reviewer service failed twice; a second independent reviewer found no Critical, Important, or Minor release blockers and returned Ready.
- [ ] Commit only explicit file lists. Push compatible content commit to remote main without force; wait for exact Pages build and existing cache refresh, then compare public HTML bytes.
- [ ] Commit/push App changes, fast-forward local main only if unchanged. Build static archive from the committed version and SHA256 manifest, not from a dirty working tree.
- [ ] Upload into a uniquely created remote staging directory. Reuse the existing locked/static-only release sequence with exact preconditions, byte verification and automatic rollback; no nginx reload or API restart is needed.
- [ ] Validate public shell bytes, receiver integration and mobile scrolling, SW version, health/JSON/404 behavior, unchanged API PID and configuration. Keep prior release and both worktrees; record final commits, release target, tests and rollback command.

## Release gate

Any unexpected remote branch change, regression, missing credential, or baseline mismatch stops publication at that step. An inert receiver may stay published if App deployment fails. Restore only this App's prior release symlink for rollback; never clear user storage or modify other sites.
