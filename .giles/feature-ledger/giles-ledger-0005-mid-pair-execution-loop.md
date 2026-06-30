# Giles Feature Ledger — Entry 0005

## Feature ID
`mid-pair-execution-loop-2026-06-30`

## Short Action Summary
Implemented the mid_pair (implementer → reviewer) execution loop that F5 (entry 0004) identified
as missing: `employee-execution.ts` defined all the building blocks (verdict parsing, loss-policy
resolution, prompt builders) but nothing ever called them — the chat path only tagged a session's
`transportMeta` and left it frozen at `executionPhase:"implementing"` forever, and the kanban path
didn't even do that. This entry builds the actual orchestration (spawn reviewer/revision child
sessions, parse verdicts, loop revisions, apply loss policy) and wires both dispatch entry points
through it. A same-session double-dispatch bug surfaced during live end-to-end testing was also
found and fixed in `run-web-session.ts`.

## Touched Files
- `packages/cuttlefish/src/gateway/mid-pair-orchestrator.ts` (new, 464 lines) — the orchestration
  loop: `dispatchEmployeeSessionRun` (drop-in `dispatchWebSessionRun` wrapper), `runReviewLoop`,
  `runReviewerPass` (with bounded one-retry fallback), `runRevisionPass`, `spawnRoleSession`,
  `finalizeExecutionState` (re-emits `session:completed` so board-sync re-syncs the kanban card to
  the true final outcome, not just the implementer's own turn).
- `packages/cuttlefish/src/gateway/employee-execution.ts` — added `buildRevisionPrompt`.
- `packages/cuttlefish/src/gateway/api/routes/session-write.ts` — replaced the inline mid_pair
  tagging block with employee resolution + a call to `dispatchEmployeeSessionRun`.
- `packages/cuttlefish/src/gateway/ticket-dispatch.ts` — replaced the direct `dispatchWebSessionRun`
  call with `dispatchEmployeeSessionRun`, passing the already-resolved `employee`.
- `packages/cuttlefish/src/gateway/run-web-session.ts` — fix for the double-dispatch bug found live:
  hoisted an `isRoleChildSession` check (reusing the existing depth-guard) and forced
  `alwaysNotify: false` at all nine `notifyParentSession` call sites for role child sessions.
- New tests: `gateway/__tests__/employee-execution.test.ts`, `gateway/__tests__/mid-pair-orchestrator.test.ts`.
- `CHANGELOG.md` — Unreleased section, "Added" + a second "Fixed" entry for the double-dispatch bug.

## Validation Run
- Unit: 21 new `employee-execution.test.ts` tests (first-ever coverage of that module) + 14 new
  `mid-pair-orchestrator.test.ts` tests covering solo passthrough, implementer failure, approve,
  changes_requested→revision→approve, max-passes-exhausted degrade, blocked, needs_human_review,
  child-session/wall-clock budget exhaustion, and all three reviewer-loss-policy branches. All pass.
- Regression: full monorepo `pnpm test` (cuttlefish-cli ~1130 tests + web 787 tests) green after
  every change, including after the run-web-session.ts fix. `tsc --noEmit` and `eslint` clean.
- Each new regression test proven to fail against pre-fix code where applicable (org.ts / config-schema.ts
  fixes from entry 0004; the orchestrator tests are new code so there is no "pre-fix" baseline to
  diff against, but the wall-clock and budget tests were independently verified by code-reading the
  bound conditions).
- **Live end-to-end** against a sandbox gateway (isolated `CUTTLEFISH_HOME=/tmp/cf-playtest/home`,
  non-live port, deterministic fake `ollama` engine extended to act as a reviewer returning
  parseable JSON verdicts keyed by prompt markers):
  - Board dispatch, clean approve: implementer ran exactly 1 turn, reviewer child spawned and
    approved, ticket → `done`, `executionRunState.phase === "done"`, `childSessionCount: 1`.
  - Board dispatch, changes_requested → revision → approve: reviewer pass 1 rejected, revision
    child spawned, reviewer pass 2 approved; `childSessionCount: 3`, `pass: 2`, full child-session
    tree visible via `/api/sessions/:id/children`.
  - Board dispatch, blocked verdict: kanban card correctly flips to `blocked` (not a silent `done`)
    even though the implementer's own session status stayed `idle`; `lastError` set to the reviewer's
    summary.
  - Chat dispatch (`POST /api/sessions`): same approve flow verified independently of the board path.
  - **Found and fixed live**: before the `run-web-session.ts` fix, every scenario showed the
    top-level session running a spurious *second* turn after the reviewer child completed (traced via
    a temporary stack-trace instrument to `notifyParentSession` → `dispatchSessionNotification`, a
    pre-existing parent/child delegation callback never designed for mid_pair's internal-only role
    children). After the fix, every scenario confirmed exactly 1 turn on the top-level session
    (`grep -c "Web session <id> running engine" daemon.log` == 1 in all cases).

## Remaining Open Items
- Known gap (documented in CHANGELOG, not fixed here): follow-up chat messages
  (`POST /api/sessions/:id/message`), queue-replay after a gateway restart, and notification dispatch
  still call `dispatchWebSessionRun` directly and bypass mid_pair. Only the two new-dispatch entry
  points (first chat message, board dispatch) are wired through the orchestrator.
- `maxToolCalls` and `maxEstimatedCostUsd` (part of `EmployeeExecutionConfig`) remain unenforced by
  this loop, consistent with the rest of the codebase (no engine currently exposes a mid-turn
  tool-call/cost interrupt hook) — not a regression introduced here, an existing gap.
- F6, F2, F3, F7 from ledger entry 0004 remain open/documented, unrelated to this entry.

## Provenance
- Implemented: 2026-06-30 by cloud agent (remote session, no local Giles/Dory access), following
  explicit user authorization ("Take it on") after a corrected scope discussion (the original F5
  finding undersold the gap — the loop was entirely unimplemented, not just skipped on one path).
- Branch: `claude/cuttlefish-workflow-playtest-ojpr4b`.
- Giles/Dory requirements waived per AGENTS.md (cloud/remote agent without local tool access); this
  ledger entry added manually (force-added, `.giles/` is gitignored, matching entries 0001-0004).
