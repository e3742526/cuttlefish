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

## 2026-07-21 surfaced-navigation repair

### Action summary
Implemented the missing SB-CUT-001 presentation slice after live inspection
confirmed that the merged PR stopped at Gate 0. The sidebar now exposes Team
and Management lanes. Team derives one project per root session and recursively
reachable loaded descendant; Management limits existing grouped conversations
to managers, executives, and the direct Cuttlefish identity. This does not add
or change agent transport, callbacks, transcript ownership, or authority.

### Touched files
- `packages/web/src/components/chat/project-session-tree.ts`
- `packages/web/src/components/chat/sidebar-header.tsx`
- `packages/web/src/components/chat/sidebar-project-row.tsx`
- `packages/web/src/components/chat/chat-sidebar.tsx`
- `packages/web/src/components/chat/sidebar-list-surface.tsx`
- `packages/web/src/components/chat/sidebar-session-rows.tsx`
- `packages/web/src/components/chat/sidebar-storage.ts`
- `packages/web/src/components/chat/sidebar-types.ts`
- `packages/web/src/components/chat/sidebar-view-model.ts`
- `packages/web/src/components/chat/use-sidebar-view-preferences.ts`
- `packages/web/src/components/chat/__tests__/project-session-tree.test.ts`
- `packages/web/src/components/chat/__tests__/sidebar-header.test.tsx`
- `packages/web/src/components/chat/__tests__/sidebar-list-surface.test.tsx`
- `packages/web/src/components/chat/__tests__/sidebar-view-model.test.ts`
- `packages/web/src/components/chat/__tests__/use-sidebar-view-preferences.test.tsx`
- `docs/feature_inventory.md`
- `docs/TODO_LEDGER.md`
- this ledger

### Validation run
- `pnpm --filter @cuttlefish/web typecheck`: passed.
- Focused project/sidebar suite: 5 files, 25 tests passed.
- `pnpm typecheck`: passed across all four workspace tasks.
- `pnpm lint`: passed across all three lint tasks with zero warnings.
- `pnpm test`: passed across all four workspace tasks. The web suite passed
  125 files / 986 tests; the backend suite passed 2,469 tests with 1 skipped
  across 300 files; contracts passed 6 tests.
- `pnpm build`: passed and copied the rebuilt web bundle into
  `packages/cuttlefish/dist/web`.
- `git diff --check`: passed.
- `pnpm --silent cuttlefish restart`: replaced gateway PID 12140 with PID
  62884; `GET /api/healthz` returned `status: ok`.
- Live browser smoke against the rebuilt gateway passed: Team and Management
  controls were visible; real project `#30` reported 21 sessions / 11 agents;
  expanding it exposed one root, six children, and fourteen grandchildren;
  Management selected successfully and exposed eight grouped manager
  conversations; the browser reported no console errors.
- Python Playwright was unavailable in the environment, so the live smoke used
  the repository's installed Node `@playwright/test` driver instead.

### Remaining open items
- Unified Team and Management feed APIs/projections, structured recipients,
  authority scopes, project inspector/URL state, atomic project-tree deletion,
  Talk frontend retirement, hostile audits, and the full release gate remain
  open. The feature is intentionally retained as `in-progress` in the TODO
  ledger.
- The client projection can only group sessions included in the paginated
  session payload. Missing parents remain visible as orphan projects with a
  warning instead of being silently attached to a guessed root.

### Provenance
Direct operator report that project/session consolidation did not surface;
source, Git history, PR #50, local Codex session evidence, and live session
registry inspection confirmed that only Gate 0 documentation had landed.

## 2026-07-21 feature completion

### Action summary
Completed the accepted P0/P1 Project/Session Collaboration Prototype. Added
durable collaboration contracts and projection storage, recursive project
graph/feed services, structured Team and Management dispatch, constrained
one-turn authority, scoped-principal boundaries, atomic inactive-tree deletion,
durable URL and inspector state, project-tab migration, and built-browser E2E
coverage. Retired only the Talk frontend while preserving backend Talk and
shared read-aloud compatibility. A live smoke exposed and repaired an initial
Team-without-project websocket refetch that requested `/api/projects/null/*`.

### Touched files
- Shared contracts: `packages/contracts/src/collaboration.ts` and
  `packages/contracts/src/index.ts`.
- Collaboration domain and tests: `packages/cuttlefish/src/collaboration/**`,
  `packages/cuttlefish/src/gateway/api/routes/collaboration.ts`,
  `packages/cuttlefish/src/gateway/__tests__/collaboration-routes.test.ts`, and
  the collaboration route registration in `packages/cuttlefish/src/gateway/api.ts`.
- Session continuation/persistence: `packages/cuttlefish/src/gateway/continue-session.ts`,
  `packages/cuttlefish/src/gateway/session-resources.ts`,
  `packages/cuttlefish/src/gateway/api/routes/session-write.ts`,
  `packages/cuttlefish/src/sessions/registry.ts`,
  `packages/cuttlefish/src/sessions/registry/{schema,sessions,communication-events}.ts`,
  and `packages/cuttlefish/src/sessions/__tests__/registry-collaboration.test.ts`.
- Collaboration UI/API/tests: `packages/web/src/components/chat/collaboration-*.tsx`,
  `packages/web/src/components/chat/{project-delete-dialog,session-inspector}.tsx`,
  `packages/web/src/lib/api-collaboration.ts`,
  `packages/web/src/routes/chat/collaboration-route-state.ts`, and their tests.
- Navigation/tab integration: `packages/web/src/routes/chat/{page,chat-page-shell}.tsx`,
  `packages/web/src/components/chat/{chat-sidebar,sidebar-list-surface,sidebar-project-row}.tsx`,
  `packages/web/src/hooks/use-chat-tabs.ts`, and associated tests.
- Talk frontend retirement: web navigation/provider/vocabulary/search files,
  `packages/web/src/main.tsx`, and the obsolete frontend files under
  `packages/web/src/routes/talk/**`; `audio-player.ts` remains for shared chat
  read-aloud and all backend `packages/cuttlefish/src/talk/**` behavior remains.
- E2E/docs: `e2e/collaboration.spec.ts`, `scripts/start-e2e-server.mjs`,
  `README.md`, `docs/{SPECIFICATION,USER_MANUAL,feature_inventory,TODO_LEDGER,TODO_HISTORY,TEST_LEDGER,INDEX}.md`,
  the final audit/session records, and this ledger.

### Validation run
- Focused collaboration validation passed: 47 backend tests and 27 web tests.
- `pnpm typecheck`: passed, 4/4 tasks.
- `pnpm lint`: passed, 3/3 tasks with zero warnings.
- `pnpm test`: passed; contracts 6/6, web 765/765 across 109 files, backend
  2,490 passed with 1 skipped across 305 files.
- `pnpm test:e2e --reporter=line`: passed, 9/9 scenarios.
- `pnpm build`: passed and copied the production web bundle into the daemon.
- `git diff --check`: passed.
- The largest touched source files are below the 800-line gate:
  `routes/chat/page.tsx` 785, `chat-sidebar.tsx` 785, and
  `session-write.ts` 774 lines.
- Remote synchronization was checked after `git fetch --prune`; local HEAD and
  its upstream are 0 ahead / 0 behind, so no merge was required.
- The rebuilt gateway relaunched as PID 90588 with 0 active sessions and a
  healthy `/api/healthz` response.
- Read-only live UI smoke against project `#66` confirmed the consolidated Team
  feed, session inspectors, global Management feed, HR default, one-turn
  authority controls, `/talk` redirect, and zero failed requests/console errors.
- Live approval-auth proof bootstrapped a revocable local session, received 404
  for Reject against a deliberately nonexistent approval (therefore passed the
  auth gate instead of returning 401), and logged out. No real approval changed.

### Remaining open items
- P2 remains intentionally deferred: explicit project records/rosters,
  workspace identity, durable cross-turn authority, inline tool streams, and
  Talk backend API removal.
- No live engine message or destructive real-project deletion was performed;
  those paths are covered by hostile route/domain tests and isolated browser
  fixtures.
- The in-app browser service and Python Playwright were unavailable. The final
  read-only live smoke used the repository's installed Node Playwright driver.
- No commit or push was performed because this run was not separately
  authorized to publish changes.

### Provenance
Direct operator request and accepted SB-CUT-001 plan; current source, repository
tests, live local registry/UI/API evidence, and upstream Git comparison from
2026-07-21. This is an agent-maintained Giles sidecar entry, not a canonical
compliance declaration.
