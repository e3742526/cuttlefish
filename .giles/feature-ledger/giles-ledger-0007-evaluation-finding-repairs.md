# Giles Feature Ledger — Entry 0007

## Feature ID
`evaluation-finding-repairs-2026-07-04`

## Short Action Summary
Repaired a focused, high-confidence batch of findings from the comprehensive system
evaluation (`docs/cloud-audit/SYSTEM-EVALUATION-2026-07-04.md`, entry 0006). Scope was
deliberately limited to surgical, well-understood fixes that do not require architectural
design decisions; each fix ships with a test. Four findings addressed:

1. **Finding 3 (S1) — employee availability enforced at dispatch.** `resolveDispatchEmployee`
   now rejects draft/disabled/retired employees (both the assignee and the routed manager)
   with a new `employee-not-active` reason → HTTP 409. Previously `isActiveEmployee` was
   test-only dead code and inactive employees remained dispatchable.
2. **Finding 1 (S1, security) — scoped-token deny-list widened.** `scopedTokenForbidden` now
   blocks non-GET requests to `/api/approvals/*`, `/api/checkpoints/*`, `/api/cron/*`, and
   `/api/orchestration/*`, so a prompt-injected agent holding its own session token can no
   longer approve its own security checkpoint/approval or drive scheduling. Reads stay open.
   Verified no legitimate agent flow posts to these paths (checkpoints are created in-process
   by `security-review.ts`, not via the HTTP POST).
3. **Finding 24 (S3, security) — exposure re-validated on config reload.** `reloadConfig` now
   re-runs `validateGatewayExposure` and refuses a reload that would expose an unauthenticated
   network gateway, keeping the prior config. Previously the boot-time guard was skipped on
   live `PUT /api/config`.
4. **Finding 15 / F10 (S3, integrity) — atomic dual-lane manifest write.** `writeDualLaneManifest`
   now uses `safeWriteFile` (tmp+fsync+rename) instead of a raw `fs.writeFileSync`. The manifest
   `state` gates whether a lane's patch may be applied, so a torn write could silently lose a
   winner selection.

## Follow-up (PR #21 review — Gemini Code Assist)
5. **Path-traversal bypass in `scopedTokenForbidden` (security-high) — fixed.** The API
   router resolves `req.url` via the WHATWG URL parser (collapsing `..`) before dispatch,
   but the deny-list matched the raw path, so `POST /api/sessions/../approvals/abc/approve`
   reached the approvals handler while evading the check (also affected the pre-existing
   config/org/system entries). Fix: normalize once (`path.posix.normalize` + `toLowerCase`)
   before every check. Added traversal/redundant-slash/case tests.
6. **Email-service restart-on-reload (medium) — false positive, no change.** `EmailService.start()`
   calls `this.stop()` first (`email/service.ts:107`); the poll timer is the only persistent
   resource and IMAP connections are per-poll. `start()` is idempotent; no leak.

## Touched Files
- `packages/cuttlefish/src/gateway/scoped-token.ts` — path normalization in `scopedTokenForbidden`
  (deny-list widening + traversal-bypass fix).
- `packages/cuttlefish/src/gateway/ticket-dispatch.ts` — import `isActiveEmployee`; add
  `employee-not-active` to `DispatchTicketFailureReason`; enforce availability in
  `resolveDispatchEmployee` (manager + assignee branches).
- `packages/cuttlefish/src/gateway/api/routes/org.ts` — map `employee-not-active` → 409.
- `packages/cuttlefish/src/gateway/scoped-token.ts` — extend `scopedTokenForbidden`.
- `packages/cuttlefish/src/gateway/server.ts` — re-validate exposure inside `reloadConfig`.
- `packages/cuttlefish/src/orchestration/dual-lane-state.ts` — atomic manifest write.
- Tests (new/updated): `gateway/__tests__/ticket-dispatch.test.ts` (+3 cases),
  `gateway/__tests__/scoped-token-forbidden.test.ts` (new; +traversal/case bypass cases),
  `orchestration/__tests__/dual-lane-state-write.test.ts` (new).

## Validation Run
- `pnpm typecheck` — PASS (both packages)
- `pnpm lint` — PASS (eslint --max-warnings=0)
- Targeted: `vitest run` on the three touched/new test files — 14 tests PASS
- `pnpm test` — full suite (see PR CI / commit for the final count)
- Node 22.22.2 in container (off-spec vs pinned >=24 <25).

## Remaining Open Items
Deliberately deferred (need design decisions or carry regression risk — recommended for
follow-up, not patched blindly):
- **Finding 2 (S1)** — per-employee/global concurrency cap in the default dispatch path
  (needs a semaphore design + release-on-all-paths handling).
- **Finding 4 (S2)** — manager identity is body-claimed; no per-manager gateway principal
  exists, so a clean fix requires an auth-model change.
- **Finding 5 (S2)** — `/ws` device-cookie double-gate; security-sensitive, easy to weaken.
- **Finding 6 (S2)** — session-write principal scoping; a naive fix would break the legitimate
  cross-session agent-messaging flow the evaluation itself documents.
- All architectural items (Project/Fleet entities, run-ledger GUI, merging the two
  orchestration layers, shared web↔backend types) — see report §11–§12.

## Provenance
Original — implemented directly against the current repository from findings in
`docs/cloud-audit/SYSTEM-EVALUATION-2026-07-04.md`. Not reconstructed from logs.
