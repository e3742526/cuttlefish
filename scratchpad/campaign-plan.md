# Campaign Plan (Gate 1 inventory + Gate 2 grouping)

Baseline: main @ bb31ca3, tests GREEN, git available, commit-to-main (no push).
Source: 35-lens triage sweep (28 applicable) + 2 operator bug investigations. 95 raw isDefect findings.

## Disposition summary
- in-scope defects grouped below
- by-design (NOT patched): SEC IDOR cross-session read/write (intentional delegation model; scopedTokenForbidden deny-list is deliberate, auth.ts:512-532), session-token-in-system-prompt (agents need it), network-exposed/auth-disabled (documented local-first).
- excluded-deferred-arch: SessionManager↔gateway bidirectional coupling, god-object, knowledge-sink/connector coupling → ARC-CUT-001/002 territory; route to dedicated refactor.
- excluded-feature/polish: design-webapp a11y findings (htmlFor/id, skip-nav, aria-labels, color-only tone) — UX improvements, not behavior defects. Note in backlog.
- routed-infra: .github workflow posture (secret scanning, pinned actions, contents:write isolation, docker floating tag) — CI/infra hardening, separate from source defect campaign. Note in backlog.

## Groups (ordered by priority, then blast radius)

### Group 1 — Model alias ↔ registry mismatch (OPERATOR BUG: opus/haiku via CLI)  [P0]
Defects: opus alias 400 (P0), haiku alias 400 (P1) — same root cause.
Files: sessions/session-patch.ts (resolveModelAlias + 2 callers); test session-patch.test.ts.
Modularization: none (229 lines).
Regression surface: validateNewSessionSelection / validateSessionPatch alias resolution against the SHIPPED registry ids (opus, claude-haiku-4-5).
Fix: make alias resolution registry-aware — never rewrite a model id that is already a valid registry id; only expand when the literal is unknown AND the expansion is known. Fix test fixture to use shipped ids.
Commit: 1.

### Group 2 — Employee execution config persistence (OPERATOR BUG: employee editor)  [P1]
Defects: create silently drops execution block (P1, org.ts:779); downgrade mid_pair→solo leaves stale reviewer fields (P2, org.ts:936).
Files: gateway/org.ts (validateEmployeeCreate return object ~779, buildEmployeeCreateData ~974, updateEmployeeYaml execution write); tests org-update / org create tests.
Modularization decision: org.ts is 1121 lines (1000-2000 band). Heavily edited? Group touches 2-3 functions — borderline. Decision: smallest safe fix in place; do NOT split mid-campaign (it has a literal \x00 regex that complicates tooling — note for a dedicated modularization follow-up). Route org.ts split as backlog.
Regression surface: employee create with execution; employee edit downgrade; YAML round-trip.
Commit: 2.

### Group 3 — Session deletion orphans (data integrity)  [P1]
Defects: deleteSession orphans approvals (P1), orphans email_messages (P1). (FK-constraint finding = schema change, treat as add cleanup in deleteSession; FK PRAGMA is higher-risk → note only.)
Files: sessions/registry/sessions.ts (deleteSession, deleteSessions).
Regression surface: delete a session that has approvals + email_messages → no orphans; existing delete tests still pass.
Commit: 3.

### Group 4 — Input/arg validation guards (correctness)  [P2]
Defects: NaN→SQL LIMIT crash (artifacts.ts:99 + registry/files.ts limit clamp).
Files: gateway/api/routes/artifacts.ts, sessions/registry/files.ts.
Regression surface: ?limit=abc returns sane default not 500.
Commit: 4.

### Group 5 — Transport-meta preservation (state integrity)  [P2]
Defects: mergeTransportMeta hardcoded preserve-list silently drops new keys (manager-helpers.ts:64).
Files: sessions/manager-helpers.ts; test merge-transport-meta.test.ts.
Fix: preserve unknown/extra meta keys by default (merge-preserve) instead of an allow-list that must be hand-updated.
Commit: 5.

### Group 6 — Enum drift web↔backend (invariant sync)  [P2]
Defects: OrgChangeType drift, OrgChangeStatus missing 'error' (api-hr.ts).
Files: packages/web/src/lib/api-hr.ts (+ backend shared/types/org-change source of truth).
Commit: 6.

### Group 7 — O(N²) BFS hot loops (performance)  [P2]
Defects: array.shift() in BFS in talk/graph.ts:133 and gateway/org-hierarchy.ts:217.
Files: talk/graph.ts, gateway/org-hierarchy.ts. Fix: index-cursor instead of shift().
Commit: 7.

## Candidate (verify-then-maybe) — lower confidence, may dispose during stage:
- insertMessage return unchecked (manager.ts:495/582) — verify it's truly unchecked & a fix is safe.
- readBody unbounded + missing HTTP server timeouts (responses.ts, transports.ts) — localized hardening; include if low-risk.
- Slack/webhook/IMAP connector timeout & try-catch (several) — localized; include the cheap, safe ones.
These ride along ONLY if same-surface and low-risk; otherwise backlog.

## Cross-stage risks
- Group 1 & 2 both touch model-registry semantics (session-patch vs org validateModelIdForEngine). Keep consistent: registry id is the contract; aliases are an input convenience only.
- org.ts touched by Group 2; ensure no overlap with deferred ARC items.
