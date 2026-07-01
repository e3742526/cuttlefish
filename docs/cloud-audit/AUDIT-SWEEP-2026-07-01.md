# Cuttlefish Audit Sweep — agent-skills 10_audit Catalog

**Date:** 2026-07-01
**Baseline commit:** `4e77410` (branch `claude/cuttlefish-audit-repair-8ub43c`, HEAD of `main`)
**Trigger:** Run every skill in `agent-skills/10_audit/` against this repo, then run
`agent-skills/20_repair/repair-defect-campaign` to fix findings.
**Status:** Partial — see Coverage below.

## Method

Each `10_audit/<skill-id>/SKILL.md` lens was dispatched as an independent read-only
subagent against this checkout, instructed to cross-reference
[`AUDIT-BASELINE-2026-06-30.md`](./AUDIT-BASELINE-2026-06-30.md),
[`SECURITY-FINDINGS-2026-06-30.md`](./SECURITY-FINDINGS-2026-06-30.md), and
[`../TODO_LEDGER.md`](../TODO_LEDGER.md) so it would not re-report already-tracked
items, and to report only genuinely new, evidence-based findings (or explicitly
confirm a tracked item is still live).

## Coverage

Of the 35 lenses in `10_audit/`, **8 completed** with real findings before this
session's subagent fan-out repeatedly hit provider rate limiting and one container
restart that silently dropped several in-flight lens runs (some produced empty
`API Error: Server is temporarily limiting requests` results; those were not
retried further in this pass). This is disclosed rather than silently treated as
"0 findings, clean":

**Completed (findings below):** `audit-compliance-posture`, `audit-architecture-nodejs`,
`audit-dataflow-cascade`, `audit-contract-crossrepo`, `audit-dataflow-integrity`,
`audit-contract-internalapi`, `audit-dataflow-pipeline-graph`, `audit-dataflow-concurrency`.

**Not completed this pass (infra rate-limiting / restart, not "clean"):**
`audit-architecture-seam`, `audit-contract-internalapi` retries, `audit-dataflow-input-output`,
`audit-dataflow-state-transition`, `audit-dataflow-temporal`, `audit-deadcode-cleanup`,
`audit-dependency-criticality`, `audit-design-webapp`, `audit-equation-sourcebase`,
`audit-failsafe-readiness`, `audit-invariant-sync`, `audit-memory-lifecycle`,
`audit-multiagent-consensus`, `audit-negative-space`, `audit-operator-signal`,
`audit-performance-profile`, `audit-pipeline-externalapi`, `audit-playtest-app`,
`audit-recovery-idempotency`, `audit-reliability`, `audit-security`, `audit-security-code`,
`audit-security-llm`, `audit-security-nodejs`, `audit-security-repo-posture`,
`audit-security-repo-triage`, `audit-security-supabase`, `audit-security-vuln-harness`,
`audit-workflow-gui`.

**Recommended next step:** re-run the remaining 27 lenses (prioritize `audit-security`,
`audit-security-code`, `audit-reliability`, `audit-recovery-idempotency` first) once
subagent throughput/rate-limit headroom allows, then extend the repair campaign below.

## Repair Disposition

Findings are tagged `fixed` (this session, commit `3c7a6fd`), or `open` (cataloged here
for a follow-up repair stage; not yet patched). The repair campaign selected the
highest-confidence, lowest-blast-radius findings for this first wave, per
`repair-defect-campaign`'s locality-grouping and gated-verification method
(typecheck/lint/full test suite green; targeted regression tests added for the two
correctness fixes — see commit `3c7a6fd`).

### audit-compliance-posture

| ID | Severity | Status | Summary |
|---|---|---|---|
| CMP-CF-001 | High | **fixed** | Giles governance CI step silently no-ops (giles never installed); ruleset labels rules `severity: fail` implying enforcement that never runs. Made the no-op a visible CI warning annotation. |
| CMP-CF-002 | Medium | **fixed** | `policy.yaml`'s `giles_artifacts_advisory: true` contradicted the ruleset's `severity: fail` labels with no reconciling note. Documented the advisory-only reality inline. |
| CMP-CF-003 | Medium | open | `governance/policy.yaml`'s `canonical_log` path (`governance/logs/giles_compliance_todo.json`) does not exist; nothing generates it. |
| CMP-CF-004 | Low | open | `tests/test_giles_slot.py` only checks two directories exist; its name implies governance-rule coverage it doesn't provide. |
| CMP-CF-005 | Info | open | `governance/exceptions.yaml` is empty — EXC-004/EXC-005 lifecycle rules are unexercised against a real exception. |

### audit-architecture-nodejs

| ID | Severity | Status | Summary |
|---|---|---|---|
| ARC-CUT-003 | Medium | open | Engine wiring in `gateway/server.ts` is ~10 hand-duplicated blocks across three structures (`engines` map, `ptyViewEngines`, PID-list literal) instead of a declarative registry. |
| ARC-CUT-004 | Medium | open | Codex/Antigravity/Grok/Hermes/Aider PTY concurrency all silently borrow `engines.claude.maxLivePtys`; no independent config field. |
| ARC-CUT-005 | Low | open | No single engine-adapter registry; `ApiContext.interactiveClaudeEngine` special-cases Claude alongside the generic `ptyViewEngines` map. |
| ARC-CUT-006 | Low | open | `gateway/org.ts` has grown to 1165 lines (was 1121 at RDC-R02) — confirms that already-tracked modularization item is still open and growing. |
| ARC-CUT-007 | Info | open | `packages/web/src/lib/api.ts` barrel facade has no lint rule preventing direct `lib/api-*.ts` imports from bypassing it. |

### audit-dataflow-cascade

| ID | Severity | Status | Summary |
|---|---|---|---|
| CAS-CUT-001 | Medium | open | Content-screening reviewer output with a valid verdict but missing `sanitizedText` silently substitutes heuristic-sanitized text, mixing two authorities' outputs into one decision. |
| CAS-CUT-002 | Low | **fixed** | `/api/status` connectors check reported only an error count, not which connector(s) — two different root causes looked identical across polls. Extracted `summarizeConnectorErrors()` and now names the failing connector(s). |
| CAS-CUT-003 | Medium | open | Run-ledger transition failures in `orchestration/run-ledger-integration.ts` (`finalizeOrchestrationRunCompleted`/`Failed`, `recoverOrchestrationRun`, `sweepOrphanedOrchestrationRuns`) are logged and swallowed with no caller-visible failure signal. |

### audit-contract-crossrepo

| ID | Severity | Status | Summary |
|---|---|---|---|
| CROSS-001 | High | open | Daemon's canonical `WorkState` type is re-declared with a *different* value set under the same name in `packages/web/src/lib/kanban/types.ts`, risking silent cross-type confusion. |
| CROSS-002 | Medium | open | No shared `packages/shared` contract package between daemon and web; every DTO/enum is hand-duplicated. |
| CROSS-003 | Medium | open | `packages/web/src/lib/api-core.ts` `get<T>`/`post<T>` perform no runtime validation of server responses. |
| CROSS-004 | Medium | open | Confirms already-tracked `API-MED-003` (inconsistent error response shapes) from the client side. |
| CROSS-005 | Low | open | WS message payloads (`lib/ws.ts`) are `JSON.parse`d with no schema validation before dispatch. |

### audit-dataflow-integrity (artifact-lineage store)

| ID | Severity | Status | Summary |
|---|---|---|---|
| DAT-INT-001 | High | open | `registerArtifact()` overwrites an existing artifact's content identity with no `artifact_versions` snapshot — that table is defined but never written. |
| DAT-INT-002 | Medium | open | `source_references` table has no writer anywhere; source provenance is permanently unrecoverable. |
| DAT-INT-003 | Medium | open | `deleteFile()` never tombstones the corresponding artifact-lineage record; lineage graph shows stale/orphaned artifacts for deleted files. |
| DAT-INT-004 | Low | open | Email UID dedup's legacy-key fallback has no one-time marker, so a post-UIDVALIDITY-bump UID reuse can resolve to a stale ingest state. |
| DAT-INT-005 | Low | open | `run_artifact_xref` de-dup cleanup runs unconditionally on every store `open()`, picks an arbitrary survivor by UUID min, and logs nothing. |

### audit-contract-internalapi

| ID | Severity | Status | Summary |
|---|---|---|---|
| CTR-001 | Medium | open | `transportMeta`'s documented single-writer contract (`mergeTransportMeta`) is bypassed by ~5 direct `updateSession` call sites using `as any` casts. |
| CTR-002 | Low | open | Universal `{ error: string }` result shape has no error-code enum; clients can only substring-match free text. |
| CTR-003 | Low | open | `serializeSession()` spreads the full internal `Session` row (including internal `transportMeta` bookkeeping) into the public API response with no DTO allowlist. |
| CTR-004 | Info | open | Confirms already-tracked `CF-2026-024` (untyped connector-proxy request body). |
| CTR-005 | Low | open | `/api/sessions/:id/reset` hand-rolls its own transportMeta key deletion instead of using the shared preserve-list helper. |

### audit-dataflow-pipeline-graph (orchestration runs)

| ID | Severity | Status | Summary |
|---|---|---|---|
| PIPE-001 | High | **fixed** | `beginOrchestrationRun()` had no try/catch around its ledger writes (every sibling finalize/recover function does); a ledger failure before any lease turn started left already-granted leases dangling. Now releases them and rethrows; regression test added (`run-mode.test.ts`, verified it fails without the fix). |
| PIPE-002 | Medium | open | `orchestration/artifacts.ts` `writeArtifact()` performs filesystem write, DB insert, and lineage registration non-atomically; a DB-insert failure leaves a file on disk untracked by `OrchestrationStore`. |
| PIPE-003 | Low | open | `applyDualLaneWinner()` records the `patch_apply` artifact before attempting the apply; a rejected/conflicting patch's artifact node doesn't self-report failure. |
| PIPE-004 | Medium | open | `recoverOrchestrationRun()` computes its next state from retry count alone with no current-state guard, risking a race with the orphan sweep re-transitioning an already-terminal run. |
| PIPE-005 | Low | open | Dual-lane failure path releases leases/cleans up but never persists the failed lane's prompt/output/diff artifacts, unlike the success path. |

### audit-dataflow-concurrency

| ID | Severity | Status | Summary |
|---|---|---|---|
| CON-001 | High | open | Org-change apply (`/api/approvals/:id/approve`, `/api/org/change-requests/:id/{approve,apply}`) has no single-writer lock across three entry points; near-simultaneous calls can both pass the status check and double-apply an org change. |
| CON-002 | Medium | open | `dispatchTicket()`'s reused-session check races with the async `allocateBoardDispatchLease` call. |
| CON-003 | Low | open | Email `checkInbox`'s `inFlight` re-entrancy guard is per-`EmailService`-instance, not cross-instance/cross-process. |
| CON-004 | Low | open | `dispatchEscalation` in the leader-ack reconciler is fire-and-forget; a later sweep can start before it settles. |
| CON-005 | Low | open | `SessionQueue.pauseQueue`/`resumeQueue` update an in-memory Set and the DB as two non-atomic steps, which can diverge across instances/restarts. |
| CON-006 | Low | **fixed** | Kanban `ticket-detail-panel.tsx`'s live-session poll had no guard against a stale in-flight response landing after the user switched tickets. Added a ticket-id ref check before each state update. |

## Summary

- **4 findings fixed** this session (commit `3c7a6fd`): PIPE-001, CAS-CUT-002, CON-006,
  CMP-CF-001/002 (governance honesty fix, counted together).
- **35 findings remain open**, cataloged above with severity for prioritization.
- Full validation for the fixes: `pnpm typecheck`, `pnpm lint`, `pnpm test`
  (231 test files / 1907 tests, 0 failures) all green on the full monorepo.
- 27 of 35 audit lenses were not completed this pass; see Coverage above.

## Recommended Next Repair Wave (by severity)

1. CROSS-001 (High) — rename the kanban-local `WorkState` to avoid the type-name
   collision with the daemon contract type; cheap, high-value.
2. DAT-INT-001 (High) — either wire `artifact_versions` writes on re-registration or
   reject conflicting re-registration; the schema already exists for the fix.
3. CON-001 (High) — add a single-writer guard to org-change apply; needs care around
   the `finishCritique` auto-apply path.
4. PIPE-004 / CAS-CUT-003 (Medium, same subsystem) — add a state guard to
   `RunLedgerStore.transitionRun` covering both findings in one stage.
5. Re-run the 27 not-yet-completed lenses, prioritizing `audit-security`,
   `audit-security-code`, `audit-reliability`, `audit-recovery-idempotency`.
