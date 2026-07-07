# Giles Feature Ledger 0008 — Agent encapsulation: granular sub-agent selection + hardened deterministic failover

- **Feature id:** `agent-encapsulation-subagent-select`
- **Branch:** `claude/agent-encapsulation-subagent-select-hsq363`
- **Provenance:** authored (cloud/remote agent session, 2026-07-07; Giles/Dory unavailable — requirements waived per AGENTS.md, evidence recorded here)

## Action summary

Hardened the multi-role employee-execution (solo / mid_pair) failover path and
exposed granular per-role sub-agent selection in the web UI:

1. **Types/contract** — `RoleFallbackTarget` now supports defer-to-external-agent
   entries (`employee`, exclusive with `engine`+`model`); added
   `MAX_ROLE_FALLBACK_CHAIN = 5` shared cap.
2. **Validation** — `execution.roles` PATCH/create payloads are now structurally
   validated (unknown keys rejected at every level, chain cap, employee XOR
   engine+model, self-reference and unknown-employee rejection); YAML parsing
   accepts the new target shape and caps chains.
3. **Deterministic failover** — new pure `resolveRoleFailoverTargets` resolver
   (ordered, deduped by engine+model rung, drops primary/self/unavailable/malformed
   targets, resolves external employees via org lookup). The mid-pair orchestrator
   now walks the reviewer's *full* failover chain (previously only
   `fallbackChain[0]`) bounded by child-session budget and wall-clock deadline,
   counts actual spawns, and terminally resolves via `reviewerLossPolicy`
   ("new agent" chain → defer-to-solo degrade → block). Revision passes gained the
   same implementer-chain failover.
4. **Model fallback hardening** — `resolveModelFallbackPlan` returns the full
   ordered deduped backup plan (agent chain → global chain → ladder);
   `resolveModelFallback` now consumes plan[0], guaranteeing plan/decision parity.
5. **UI** — new `RoleAgentConfig` component in the employee editor (mid_pair
   panel): per-role (implementer/reviewer) engine/model/effort override with
   inherit defaults, ordered failover-chain editor with backup-agent or
   defer-to-employee rows, add/remove/reorder, chain cap; clarified reviewer loss
   policy labels; per-role summary in the employee detail panel.

## Touched files

Backend (`packages/cuttlefish`):
- `src/shared/types/operations.ts` — RoleFallbackTarget.employee, MAX_ROLE_FALLBACK_CHAIN
- `src/gateway/org.ts` — parseRoleFallbackTarget, chain cap, validateExecutionRoles, iterator-safe known names
- `src/gateway/employee-execution.ts` — resolveRoleFailoverTargets, ReviewerLossOutcome "replace" simplification
- `src/gateway/mid-pair-orchestrator.ts` — full-chain reviewer failover with budget/deadline bounds, revision-pass failover, accurate spawn accounting, org-backed external-agent resolution
- `src/shared/model-fallback.ts` — policyCandidates, resolveModelFallbackPlan
- Tests: `src/gateway/__tests__/employee-execution.test.ts`, `src/gateway/__tests__/mid-pair-orchestrator.test.ts`, `src/gateway/__tests__/org-update.test.ts`, `src/shared/__tests__/model-fallback.test.ts`

Frontend (`packages/web`):
- `src/lib/api-org.ts` — RoleModelOverride/RoleFallbackTarget/RoleExecutionPolicy mirrors, MAX_ROLE_FALLBACK_CHAIN
- `src/lib/role-policy.ts` (new) — normalizeRolePolicy/normalizeRoles/describeRolePolicy
- `src/components/org/role-agent-config.tsx` (new) — per-role sub-agent + failover chain editor
- `src/components/org/employee-editor.tsx` — role config wiring, roles diffing, clarified loss-policy labels
- `src/components/org/employee-detail.tsx` — per-role execution summary lines
- Tests: `src/components/org/role-agent-config.test.tsx` (new), `src/lib/role-policy.test.ts` (new), `src/components/org/employee-editor.test.tsx`

Docs:
- `docs/feature_inventory.md` — multi-role execution entry updated

## Validation run

- `packages/cuttlefish`: `tsc --noEmit` clean; targeted vitest suites green
  (mid-pair-orchestrator 24, employee-execution incl. new resolver suite,
  org-update 74, model-fallback/model-escalation 21).
- `packages/web`: `tsc --noEmit` clean; org component + lib suites green
  (8 files, 62 tests incl. new role-agent-config 9 and role-policy 8).
- Full-repo `pnpm typecheck && pnpm lint && pnpm test` executed at ship time;
  results recorded in the PR description.

## Follow-up (same feature, post-review — 2026-07-07)

- Applied two PR review findings (gemini-code-assist) on `mid-pair-orchestrator.ts`:
  memoized `scanOrg()` in `resolveFailoverTargets` (at most one disk scan per
  chain walk, none when no external targets), and the review loop now terminates
  as `degraded` when a revision pass fails on every implementer target instead
  of re-reviewing identical unrevised output (new regression test).
- Fixed the pre-existing CI-red `manager-delegation-enforcement.test.ts`
  (fails on main since introduction): `runWebSession` gates on real binary
  availability via PATH lookup, so the test blocked wherever the `claude`/`codex`
  CLIs aren't installed (CI: parent blocked; local: specialist child blocked).
  Test-only fix: point the test config's `engines.*.bin` at `node`, which exists
  in every test environment; engine `run()` functions were already mocked.
- Validation: full `cuttlefish-cli` vitest suite green after these changes
  (243 files, 2009 passed / 1 skipped, 0 failed).

## Remaining open items

- Follow-up messages on an existing session, queue replay, and notification
  dispatch still bypass the mid_pair orchestrator (pre-existing gap documented in
  `mid-pair-orchestrator.ts` docblock) — failover hardening applies to the two
  new-dispatch entry points (chat first message, board dispatch).
- The employee create form still exposes only the basic tier/reviewer fields;
  per-role sub-agent selection is edit-surface only (create, then edit).
- `resolveModelFallbackPlan` is not yet surfaced via an API route for UI plan
  preview; UI shows the configured chain, runtime skips are log-only.
