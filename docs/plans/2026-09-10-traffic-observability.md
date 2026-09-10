# Traffic observability implementation

Approved scope: local fixes only; no commit, push, production changes, paid requests, or new personal data.

Subsequent explicit approval authorized commit/push/deployment. Production evidence and the authenticated-Redis compatibility fix are recorded in [deployment acceptance](2026-09-10-traffic-production-deployment.md).

## Plan

- [x] Backend: `server/api/ai-events.js`, `server/api/server.js`, focused tests. Emit one bounded anonymous terminal event, distinguish SSE completion, cancellation, timeout, rejection, and service failure.
- [x] Runtime: `tools/ai-quota-snapshot.cjs`, service/timer and tests. Atomically sample Redis counters read-only; unavailable is not zero.
- [x] Aggregation: traffic parsers/dashboard, tests, Nginx log format. Preserve old logs/history; independently track outcome coverage and HTTP limit reasons.
- [x] Presentation: dashboard view/client/CSS and tests. Separate runtime from history, repair CSV, explain input versions and expected retired-API 503s.
- [x] Verification: focused red/green tests, full API test suite, isolated headless desktop/mobile checks and review. Document rollout without executing it.

## Frozen terminal-event contract

NDJSON basename `ai-events.log`, optional rotations `ai-events.log-YYYYMMDD[.gz]`.
Fields only: `version:1`, `metricVersion:2`, `time` (ISO UTC milliseconds), `outcome`, `scope`, `experiment` (empty or SHA256), `status` (HTTP, null if connection closes before headers), `messages`, `inputChars`, `promptChars`, `conversationChars`, `durationMs`, `firstTokenMs`.
Nullable numeric fields indicate unavailable; durationMs is always a nonnegative integer.
Outcomes: completed, client_aborted, upstream_timeout, upstream_error, stream_incomplete, invalid_request, rate_limited, quota_unavailable, not_configured, internal_error.
Scopes: empty, ip_minute, ip_day, session_day, global_day, concurrency.
Completion means the server observed valid SSE [DONE], not proof of browser delivery. No text or identity may be logged. `AI_EVENT_LOG_PATH` enables collection; unset preserves existing behavior.

## Aggregation contract

Keep dashboard schema 3 and history schema 2 with additive validated fields for backward compatibility.
`ai.observation`: coverage (unavailable/partial/recorded), requests, outcomes (all outcome keys), scopes (five nonempty scope keys), durationMsTotal, firstTokenMsTotal, firstTokenSamples, promptCharsTotal, conversationCharsTotal, inputSamples, metricVersion:2.
Separate optional `aiEventCollectionStart` / CLI `--ai-event-collection-start` and `aiEventLogDir` / `--ai-event-log-dir`; configured but missing/broken logs fail closed. Terminal events never increase HTTP totals.
`ai.limitReasons`: ip_minute, ip_day, session_day, global_day, concurrency, nginx, unknown. HTTP log parser accepts legacy seven fields or new nine fields (extra quotaScope, upstreamStatus strings). Old 429s remain unknown; upstreamStatus '-' identifies Nginx rejection; valid upstream scope identifies Node rejection.
Base aggregates add expectedUnavailable and serviceErrors. Old history without classification keeps both null. Current 503s on retired /api/ paths (excluding /api/health and /api/ai/chat/completions) are expectedUnavailable; raw serverErrors unchanged.

## Quota snapshot contract

`{schema:1,capturedAt,available,reason,globalUsed,globalLimit,globalRemaining,globalResetAt,activeRequests,concurrentLimit}`. Unknown values are null; limits may be null when configuration invalid. reason is null or a fixed nonsecret enum.
Read global_day:all and active ZSET using Redis TIME/GET/PTTL/ZCOUNT in one read-only Lua script; no state changes or quota reservation. Respect namespace and rolling TTL. Redis deadline 2s.
Write `www/quota.json` atomically. Export `validateSnapshot(value)` returning sanitized snapshot or throwing. Resolve redis dependency from configured SCIENCE_LAB_API_DIR or repository server/api.
Collector runs separately every minute; HTML report remains network-isolated on its existing two-hour timer. Root UI fetches authenticated same-origin quota.json, labels samples older than three minutes stale. Only quota.json joins the existing BasicAuth route allowlist.

## Validation commands

Run focused tests with `node --test server/api/test/<new-test>.js`, existing reports with `node --test server/api/test/traffic-ai-report.js server/api/test/traffic-dashboard.js`, then `npm test --prefix server/api` and `npm run test:redis --prefix server/api`. Browser checks use isolated local synthetic data, no paid provider calls.

## Local verification results — 2026-09-10

- `npm test --prefix server/api`: exit 0, including new `test:observability` suite (24/24); existing reports/parser/dashboard focused suite 26/26.
- `npm run test:redis --prefix server/api`: exit 0; quota snapshot suite also validates real isolated Redis leaves counters, sorted set and expiry unchanged.
- Independent read-only review of backend, aggregation, UI, privacy, history and operational configuration found no Critical/Important issues; reviewer additionally ran 37 tests successfully.
- Owned headless browser session `task-9e40fb2a`, synthetic local preview only. Verified widths 390/768/1440 without horizontal overflow, expandable results, fresh quota, stale quota, and HTTP401 fetch failure with explicit unknown-state messaging.
- Real CSV button download verified: 26 rows (header + total +24 hours), 58 equal-width columns; 400 and server completion values present and correct.
- Screenshots and synthetic preview are under `output/playwright/traffic-observability/`, not production data. No user Chrome state used, no paid upstream calls or production writes.
- Cleanup verified: exact named browser session closed; owned local preview process 21304 terminated after verifying its command. No shared browser or unrelated process touched.
- Linux systemd/nginx/logrotate live validation remains an explicit deployment gate; local macOS tests do not claim to verify production permissions or BasicAuth.

## Files changed

- Backend: `server/api/server.js`, `server/api/ai-events.js`, `server/api/.env.example`, `server/api/package.json`.
- Aggregation: `tools/traffic-ai-report.cjs`, `tools/traffic-ai-outcomes.cjs`, `tools/traffic-dashboard.cjs`.
- Runtime/view: `tools/ai-quota-snapshot.cjs`, `tools/traffic-quota-view.cjs`, `tools/traffic-dashboard-view.cjs`, `tools/traffic-dashboard-client.js`, `tools/traffic-dashboard-ai.css`.
- Tests: `server/api/test/ai-events.js`, `ai-stream-outcomes.js`, `ai-quota-snapshot.js`, `traffic-ai-report.js`, `traffic-ai-outcomes.js`, `traffic-dashboard.js`, `traffic-dashboard-view.js` (all under the same test directory).
- Operations: `server/traffic/nginx-ai-log-format.conf`, `nginx-locations.conf`, `ai-events.logrotate`, `science-lab-ai-quota-snapshot.service`, `science-lab-ai-quota-snapshot.timer`, `science-lab-api-observability.conf`, `science-lab-traffic-observability.conf`, `README.md` (all under `server/traffic/`).
- Plan/acceptance: this file. Existing unrelated untracked files retained untouched.
