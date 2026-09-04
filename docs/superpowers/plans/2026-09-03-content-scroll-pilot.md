# Current Experiment Scroll Pilot Implementation Plan

> Execution: current task, local-only, user approved. Keep the public content repository unchanged.

**Goal:** Provide a narrow touch strip to scroll inside the current experiment without changing experiments.

**Architecture:** A host client communicates with an opt-in iframe receiver using `science-lab.scroll.v1`. A loopback-only preview server injects the receiver into three unmodified experiment responses. Tests exercise both ends and browser validation exercises actual iframe scrolling.

**Tech Stack:** Existing plain JavaScript/CSS, Node built-in tests and HTTP server, isolated Playwright CLI.

- [x] Add failing protocol tests at `server/api/test/frontend-scroll.js`; run `node server/api/test/frontend-scroll.js`.
- [x] Implement `experiment-scroll.js` host API: `createClient(view,onState)` returns `activate(frame)`, `scroll(delta)`, `jump(edge)`, `getState()`, `destroy()`; `bindBand(element,options)` handles pointer/keyboard interactions.
- [x] Implement `experiment-scroll-receiver.js`: validate parent origin/source/session; reply `{channel,type:'state',session,top,max,viewport,blocked}`; handle bounded `{type:'scroll',delta}`, enumerated `jump` to top/bottom, and disconnect. Reuse the document scroll root, do not alter simulation state.
- [x] Integrate right edge CSS and host lifecycle in `index.html`; preserve desktop and left edge behavior, explicitly suppress right-edge mobile flipping.
- [x] Add `tools/preview-scroll.mjs`: serve fixed App allowlist and public content; inject receiver only into experiments 1/35/41, serve all responses no-store, never expose private files. Include `scroll-preview.html` as a mouse-operable phone-sized local review entry; the simulated touch gate exists only in preview responses.
- [x] Run `npm test --prefix server/api`, syntax checks and source-boundary checks.
- [x] Validate real touch scrolling and cross-origin communication in an isolated headless session; retain screenshots under the private reports directory and close only the owned browser session.
- [x] Prepare the local preview URL, changed files, evidence and rollout limitations in `docs/content-scroll-pilot.md`. No release actions.
