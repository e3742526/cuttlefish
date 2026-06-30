# Giles Feature Ledger — Entry 0004

## Feature ID
`workflow-playtest-defect-repair-2026-06-30`

## Short Action Summary
Live workflow playtest of the Cuttlefish org/HR/kanban/cron/dispatch/deletion machinery against
a sandbox gateway (isolated `CUTTLEFISH_HOME`, non-live port, deterministic fake `ollama` engine):
onboarded a studio, built a multi-department org spanning all tiers (executive → manager → senior →
employee) including `mid_pair` embedded reviewers, drove kanban dispatch, escalation, cron, the HR
change-request pipeline, and team deletion. Two correctness defects of the same "validation-layer
drift" class were found, fixed (smallest coherent change), regression-tested, and re-validated
end-to-end against the rebuilt daemon. Remaining findings documented for follow-up.

## Touched Files
- `packages/cuttlefish/src/gateway/org.ts` — F1: materialize the known-names iterable once in
  `validateEmployeeCreate` so the duplicate-name guard no longer exhausts the iterator before the
  `reportsTo` check.
- `packages/cuttlefish/src/shared/config-schema.ts` — F4: add `features` to the top-level allow-list
  and a `validateFeatures` shape validator.
- `packages/cuttlefish/src/gateway/__tests__/org-update.test.ts` — F1 regression tests (iterator roster).
- `packages/cuttlefish/src/shared/__tests__/config.test.ts` — F4 regression tests (`features` block).
- `CHANGELOG.md` — Unreleased section documenting both fixes.

## Validation Run
- Targeted unit tests: `org.test.ts`, `org-update.test.ts`, `org-hierarchy.test.ts`, `config.test.ts`
  pass (incl. 4 new regression tests). Both new tests proven to FAIL against pre-fix HEAD (git-stash
  revert each source file → test fails → restore → test passes).
- `tsc --noEmit` (package typecheck): pass. `eslint` on changed files: pass (0 warnings).
- End-to-end re-validation against the rebuilt gateway daemon:
  - F4: `PUT /api/config {"features":{"multiRoleEmployeeExecution":true}}` → HTTP 200 (was 400).
  - F1: `POST /api/org/employees` with `reportsTo: parliamentarian` → HTTP 201 (was 400);
    `reportsTo: nobody-real` → HTTP 400 (correctly still rejected).

## Remaining Open Items (documented, not auto-fixed)
- F5 [P2, consistency]: kanban-dispatched tickets ignore the employee's `mid_pair` embedded-reviewer
  tier (only the chat/`session-write` path calls `shouldUseMidPairExecution`; `ticket-dispatch` runs
  solo). Behavior change requiring design review + engine-backed validation — routed, not auto-fixed.
- F6 [P3, UX]: a completed ticket's session is hidden by `shouldExposeSessionForTicket` (likely intended).
- F2 [P3]: saving config strips operator comments (YAML round-trip; expected).
- F3 [P3]: onboarding renames the root executive to a portal-name slug; exec not referenceable by id.
- F7 [seam]: no first-class "delete team/department"; deleting employees leaves an orphaned department,
  dangling-assignee board tickets, and orphan session records (graceful — no crashes — but no cascade
  cleanup). Feature-gap, not a code defect.

## Provenance
- Playtest + repair conducted: 2026-06-30 by cloud agent (remote session, no local Giles/Dory access).
- Branch: `claude/cuttlefish-workflow-playtest-ojpr4b`.
- Giles/Dory requirements waived per AGENTS.md (cloud/remote agent without local tool access); this
  ledger entry added manually per the AGENTS.md doc-change requirement.
