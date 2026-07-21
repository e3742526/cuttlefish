# Giles Feature Ledger 0022 — SB-CUT-001 Collaboration Prototype

## Feature id
SB-CUT-001

## Action summary
Gate 0 charter and baseline capture for the Project/Session Collaboration Prototype. This entry records the locked presentation-lane decisions, P0/P1/P2 requirement set supplied by the operator, baseline worktree state, initial validation evidence, source-size risks, residual risks, and the rule that no implementation gate advances while required checks are failing or unrecorded.

## Locked decisions
- Replace the Rooms/Focused/All sidebar with two projections: Team and Management.
- Treat a project as a root session plus every recursively reachable descendant; do not introduce a separate project entity for the prototype.
- Preserve existing sessions as the execution and communication transport; feeds are projections over session, delegation, callback, cross-request, and manager-synthesis machinery.
- Retire only the `/talk` frontend during the later UI gate; backend Talk routing, graph, delegate, attachment, callback, and authorization behavior remains protected.
- Use shared contract types for project summaries, feed items, and delivery receipts rather than web-local wire shapes.
- Add an append-only `communication_events` projection table later; projection writes must not become transport and must not suppress existing agent communication.
- Keep route modules thin; graph traversal, feed merge/deduplication, validation, persistence mutation, and routing policy belong in focused domain services.
- Every new or touched source file must be at most 800 lines; touched files already over that limit must be split rather than extended.

## Requirement baseline
- P0: project navigation, unified team feed, session inspection, Team routing, Management feed, manager routing, human authority scopes, permanent project-tree deletion, and protected communication safety.
- P1: durable URL navigation, historical compatibility and integrity warnings, accessibility, and state migration from rooms/modes/tabs.
- P2 deferred: explicit project records/rosters, workspace identity, durable cross-turn authority, inline tool streams, and Talk backend API removal.

## Touched files
- `.giles/feature-ledger/giles-ledger-0022-sb-cut-001-collaboration-prototype.md`
- `docs/logs/session/072026/2026-07-21-sb-cut-001-gate0-baseline.md`
- `docs/audits/072026/2026-07-21-sb-cut-001-gate0-baseline.md`

## Validation run
- `git status --short`: baseline had no tracked changes before this Gate 0 record; ignored local artifacts may exist outside Git status.
- `pnpm --filter cuttlefish-cli test -- src/gateway/__tests__/session-write-routes.test.ts src/gateway/__tests__/session-dispatch-manager-synthesis.test.ts src/gateway/__tests__/leader-ack-reconciler.test.ts src/gateway/__tests__/scoped-token-forbidden.test.ts src/gateway/__tests__/manager-delegation-enforcement.test.ts src/gateway/__tests__/org-cross-request-route.test.ts src/gateway/__tests__/manager-auth.test.ts`: attempted focused backend communication baseline. The invocation expanded into many suites and produced baseline failures before being interrupted to avoid spending the whole run on a known-bad broad invocation. Treat as failed/inconclusive; do not advance beyond Gate 0 on this evidence.
- `pnpm --filter @cuttlefish/web test -- src/components/chat/__tests__/chat-sidebar-helpers.test.ts src/components/chat/__tests__/sidebar-view-model.test.ts src/components/chat/__tests__/sidebar-list-surface.test.tsx src/components/chat/__tests__/sidebar-row-components.test.tsx src/components/chat/__tests__/sidebar-storage.test.ts src/components/__tests__/nav-ribbon.test.tsx src/components/__tests__/pill-nav.test.ts src/routes/chat/page.test.tsx src/routes/chat/chat-page-shell.test.tsx`: attempted focused chat/sidebar/nav baseline. The run produced no result within the observation window and was interrupted; treat as inconclusive.
- `pnpm typecheck`: passed on 2026-07-21.

## Source-size risks recorded at Gate 0
Non-generated source files already over the 800-line cap and therefore must be split rather than extended if touched for SB-CUT-001:
- `packages/cuttlefish/src/gateway/api/routes/session-write.ts` — 1024 lines.
- `packages/cuttlefish/src/gateway/run-web-session.ts` — 1150 lines.
- `packages/cuttlefish/src/gateway/server.ts` — 836 lines.
- `packages/cuttlefish/src/gateway/api/routes/org.ts` — 923 lines.
- `packages/cuttlefish/src/orchestration/runtime.ts` — 817 lines.
- `packages/cuttlefish/src/sessions/context.ts` — 941 lines.
- `packages/cuttlefish/src/shared/config-schema.ts` — 992 lines.
- `packages/web/src/hooks/use-live-session.ts` — 881 lines.
- Existing test files above the cap: `packages/cuttlefish/src/gateway/__tests__/mid-pair-orchestrator.test.ts`, `packages/cuttlefish/src/gateway/__tests__/orchestration-routes.test.ts`, `packages/cuttlefish/src/gateway/__tests__/org-update.test.ts`, and `packages/web/src/hooks/__tests__/use-live-session.test.ts`.

## Remaining open items
- Gate 0 backend focused suite needs a clean, correctly scoped baseline command or explicit baseline-failure capture with failing assertions.
- Gate 0 web chat/sidebar/nav baseline needs a completed non-interrupted result.
- Gate 1 characterization tests are not started.
- Gates 2–8 implementation, UI work, hostile audits, documentation updates, relaunch, and smoke tests are not started.

## Provenance
Direct operator-provided SB-CUT-001 build plan and local command evidence from this 2026-07-21 Gate 0 session. No Giles/Dory canonical scan was run; this is an agent-maintained sidecar record, not a compliance declaration.
