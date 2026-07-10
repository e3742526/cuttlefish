# Giles Feature Ledger — Entry 0015

## Feature ID
`fleetview-ux-phase4-org-kanban-2026-07-10`

## Short Action Summary
Implemented a scoped slice of Phase 4 ("Organization and Kanban deepening") of the
FleetView UX/UI implementation plan (`docs/plans/2026-07-10-fleetview-ux-implementation-plan.md`,
ledger entries 0010–0014), scoped strictly to `packages/web`. Branched fresh from
`main`, which now has Phases 0–3 merged (PRs #25, #26, #27, #28 — the latter merged
into the Phase 2 branch first, then transitively into `main` via #27).

Ran a read-only survey first (org chart layout/node internals, kanban drag-and-drop,
ticket/employee detail panel anatomy, chat delegation rendering) to ground the scope
in what actually exists before committing to specific deliverables. Delivered four
concrete, real interactions rather than attempting the full Phase 4 wishlist:

- **Mini-map on the org chart** (`org-map.tsx`) — `@xyflow/react`'s `<MiniMap>` was
  already an installed, unused dependency; now renders once the visible node count
  exceeds 25 (the plan's own threshold, Section 6.4).
- **Subtree collapse/expand on manager nodes.** A chevron toggle appears on any
  `EmployeeNode` with `directReports` (rendered on an unclipped outer wrapper so it
  isn't cut off by the card's `overflow-hidden` corners); toggling hides/reveals
  that manager's full descendant subtree, computed via `Employee.chain` (the
  ancestor path the layout engine already produces for selection-highlighting) —
  extracted as a pure, unit-tested helper (`org-map-helpers.ts`).
- **Drag-to-reassign `reportsTo` with explicit confirmation** (plan Section 6.4's
  named interaction). Dropping an employee node onto another uses
  `@tanstack/react-virtual`'s sibling API `getIntersectingNodes` (via `useReactFlow`,
  which required restructuring `OrgMap` into a thin `ReactFlowProvider` wrapper
  around the real `OrgMapInner`) to find the drop target, blocks drops onto the
  current manager or that would create a reporting cycle (also a pure, tested
  helper, `isDescendantOf`), and shows a `ConfirmDialog` ("Move X under Y?") before
  calling `api.updateEmployee(name, { reportsTo: [newManager] })` and reloading.
  Canceling, an invalid drop, or dragging the executive/COO row (no manager slot)
  all snap the node back to its tree-layout position.
- **Kanban: a real optimistic-rollback on ticket drag**, not just a refetch. Moving
  a ticket between columns was already optimistic (`setTickets` updates
  synchronously, in main), but a failed save previously called `loadData()` — a
  full board refetch that would also discard any *other* still-unsaved local edit.
  `persistBoardChange` now accepts an optional targeted `onFailure` callback;
  `handleMoveTicket` uses it to revert just the moved ticket's status. Every other
  mutation (create/delete/restore/assignee/complexity) keeps the existing
  refetch-on-failure behavior unchanged — this was a deliberately narrow fix to the
  one call site the plan names, not a rearchitecture of the whole save path.

## Touched Files
- `packages/web/src/components/org/layout/org-map-helpers.ts` (new) —
  `filterCollapsedEmployees`, `isDescendantOf`.
- `packages/web/src/components/org/layout/org-map-helpers.test.ts` (new).
- `packages/web/src/components/org/org-map.tsx` — `ReactFlowProvider`/`OrgMapInner`
  split, collapse state, drag-to-reassign, `MiniMap`, confirm dialog + error toast.
- `packages/web/src/components/org/employee-node.tsx` — collapse chevron affordance,
  restructured card wrapper (unclipped outer `relative inline-block` div) so the
  toggle isn't clipped by the card's rounded-corner `overflow-hidden`.
- `packages/web/src/components/org/employee-node.test.tsx` — 4 new tests for the
  collapse toggle (absent with no reports, absent when unwired, calls the handler
  without triggering node selection, shows the hidden-report count when collapsed).
- `packages/web/src/routes/org/page.tsx` — `handleReassignEmployee` wired to
  `OrgMap`'s new `onReassign` prop.
- `packages/web/src/routes/kanban/page.tsx` — `persistBoardChange` gains an optional
  `onFailure` callback; `handleMoveTicket` uses it for a targeted rollback.
- `.giles/feature-ledger/giles-ledger-0015-fleetview-ux-phase4-org-kanban.md`
  (this entry).

## Validation Run
All run from `packages/web` against a fresh `pnpm install` + `pnpm --filter=@cuttlefish/contracts build`:
- `pnpm exec tsc --noEmit -p tsconfig.json` — clean, zero errors.
- `pnpm exec vitest run` (full package suite) — **107 test files / 892 tests, all
  passing**, including 9 new tests for `org-map-helpers.ts` (collapse filtering at
  multiple tree depths, cycle/descendant detection) and 4 new tests for
  `EmployeeNode`'s collapse toggle. All pre-existing org (70 tests) and kanban
  (16 tests) tests pass unchanged.
- `pnpm --filter=@cuttlefish/web lint` (`eslint --max-warnings=0`) — clean.
- `pnpm build` (Vite production build) — succeeds.
- **Not tested**: `OrgMap`'s full drag-and-drop interaction, the `<MiniMap>`
  render, and the collapse toggle's effect *inside* a mounted `<ReactFlow>` canvas —
  jsdom has no `ResizeObserver` (which `<ReactFlow>` requires internally) and no
  test-setup polyfill for it exists in this repo, so a full-canvas render test was
  not attempted this pass. Coverage instead targets the pure logic
  (`org-map-helpers.ts`) and the node-level UI (`EmployeeNode`) in isolation — the
  actual drag→intersect→confirm→API-call sequence and the kanban rollback's effect
  through a full page render were verified by type-checking and code review, not a
  dedicated integration test. No live browser walkthrough was performed either —
  this environment has no display. Flagging both explicitly per the repo's "don't
  claim UI verification you couldn't perform" convention.

## Remaining Open Items
This is a scoped slice of Phase 4, not the full wishlist from the plan's Section 12
line item ("Inspector pattern on org nodes and tickets, subtree collapse, mini-map,
drag-to-reassign with confirmation, live presence rings, kanban optimistic drag,
delegation blocks in chat cross-linking to org/sessions"):
- **Inspector pattern** (tabbed Overview/Timeline/Related/Raw) for `EmployeeDetail`
  and `TicketDetailPanel` — the survey found both are flat, single-scroll panels
  today, not tabbed. Restructuring either is a real content-preserving rewrite of a
  heavily-used, already-tested component; judged too high-regression-risk to do
  blind (no display to visually verify the result) in this pass. Deferred.
- **Live presence rings on org nodes** — no session-list-wide subscription is
  currently wired to org/employee data (the closest thing, `EmployeeDetail`'s
  session list, is a per-panel fetch on open, not a push/subscribe feed covering
  the whole map). Needs new plumbing beyond a single-file change; deferred.
- **Kanban "WIP counts per column header"** — already present today (each column
  header shows a live ticket count); the plan's phrasing was satisfied by existing
  code, so no new work was needed here. A true WIP *limit* (a configurable cap with
  warning styling) is a distinct, undefined-scope feature not attempted.
- **Delegation blocks in chat cross-linking to org/sessions** — the survey found
  zero existing UI or component-level data plumbing for `parentSessionId`/child
  sessions in the chat message stream (`chat-route-helpers.ts` tracks the concept
  internally only to *exclude* delegated sessions from the top-level list; nothing
  renders it). Building this needs the session/message payload to actually surface
  parent/child/delegate-employee data to a chat component first — a data-shape
  question this presentation-only pass didn't have grounds to resolve unilaterally.
  Deferred.

## Provenance
Authored directly in this session (remote cloud agent) against the live
`packages/web` source tree, branched fresh from `main` (Phases 0–3 merged). Not
reconstructed from archives or prior session logs.
