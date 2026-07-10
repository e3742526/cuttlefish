# Giles Feature Ledger — Entry 0014

## Feature ID
`fleetview-ux-phase3-dataview-2026-07-10`

## Short Action Summary
Implemented Phase 3 ("Queue/Table system and analyst customization") of the
FleetView UX/UI implementation plan (`docs/plans/2026-07-10-fleetview-ux-implementation-plan.md`,
ledger entries 0010–0013), scoped strictly to `packages/web`. Branched fresh from
`main` (Phases 1/2 — PRs #26 and #27 — were both still open, not yet merged, at the
time this work started; Phase 3 doesn't depend on their changes).

Built the shared `DataView` component system in `src/components/data-view/` — the
Queue/Table page template's shared body per the plan's Section 5.2/11:

- **`useViewPreferences(surfaceKey)`** — persisted, per-surface density/hidden-columns/
  saved-views state, namespaced `fleetview.prefs.v1:dataview.<surfaceKey>` (the exact
  root the plan's Section 7.4 specifies). Syncs across tabs via the `storage` event,
  degrades gracefully if `localStorage.setItem` throws, has a `resetToDefaults`.
- **`DataTable`** — generic, virtualized (via `@tanstack/react-virtual`, matching
  the existing pattern in `chat-sidebar.tsx`), sortable table. Fully controlled:
  sort/density/column-visibility all live in the caller, not the table.
- **`DensityToggle`**, **`ColumnConfigMenu`** (show/hide columns, required columns
  can't be hidden), **`SavedViewsMenu`** (named filter+sort+column presets, save via
  a naming prompt consistent with other lightweight naming flows already in the app),
  **`ExportMenu`** + `exportRowsAsCsv`/`exportRowsAsJson` (exports exactly the
  caller's already-filtered rows, with a row-count preview before download, never a
  larger unfiltered dataset).

**Reference migration** (the concrete proof this system works, not just scaffolding):
Orchestration's Workers tab is the flagship — full toolbar (search, density, column
config, export) over a sortable/virtualized `DataTable`. The Worktrees and Telemetry
tabs were migrated onto `DataTable`'s rendering too (retiring the page's old
`columns: string[]; rows: string[][]` local `Table` helper entirely, across all three
former call sites), sharing the page's density preference and each gaining working
sort, though without the full toolbar (deliberately deferred — see below).

## Touched Files
- `packages/web/src/components/data-view/use-view-preferences.ts` (new)
- `packages/web/src/components/data-view/data-table.tsx` (new)
- `packages/web/src/components/data-view/density-toggle.tsx` (new)
- `packages/web/src/components/data-view/column-config-menu.tsx` (new)
- `packages/web/src/components/data-view/saved-views-menu.tsx` (new)
- `packages/web/src/components/data-view/export-rows.ts` (new)
- `packages/web/src/components/data-view/export-menu.tsx` (new)
- `packages/web/src/components/data-view/index.ts` (new) — barrel export.
- `packages/web/src/components/data-view/__tests__/use-view-preferences.test.ts` (new)
- `packages/web/src/components/data-view/__tests__/data-table.test.tsx` (new)
- `packages/web/src/components/data-view/__tests__/export-rows.test.ts` (new)
- `packages/web/src/routes/orchestration/page.tsx` — Workers tab rebuilt as
  `WorkersTab` (full DataView toolbar); Worktrees and Telemetry tabs migrated onto
  `DataTable`; `Section` extended with an optional `actions` slot; the local
  `Table` helper deleted.
- `packages/web/src/routes/orchestration/page.test.tsx` — updated one assertion
  from the old generic `"No rows."` default to the new descriptive empty-state copy.
- `packages/web/docs/components.md` — new "DataView" section documenting the whole
  system and the do/don't of each piece.
- `.giles/feature-ledger/giles-ledger-0014-fleetview-ux-phase3-dataview.md` (this entry).

## Validation Run
All run from `packages/web` against a fresh `pnpm install` + `pnpm --filter=@cuttlefish/contracts build`:
- `pnpm exec tsc --noEmit -p tsconfig.json` — clean, zero errors.
- `pnpm exec vitest run` (full package suite) — **104 test files / 862 tests, all
  passing**, including 20 new tests for the DataView system itself:
  `use-view-preferences.test.ts` (10 — defaults, per-surface namespacing, persistence
  across remount, saved-view save/pin/delete, reset, multi-tab `storage` sync
  including the "ignores a different surface's key" negative case, corrupt-JSON
  fallback, and graceful degradation when `setItem` throws), `data-table.test.tsx`
  (7 — rendering, empty state, three-state sort-header cycling, actual row
  reordering on sort, column hiding with required-column protection, row-click,
  and a smoke test past the virtualization threshold), `export-rows.test.ts` (3 —
  CSV header/quote-escaping correctness, JSON shape, and confirming export never
  includes more than the rows passed in). Plus the updated Orchestration page test.
- `pnpm --filter=@cuttlefish/web lint` (`eslint --max-warnings=0`) — clean.
- `pnpm build` (Vite production build) — succeeds.
- Not run: a live browser/Playwright walkthrough of the Workers tab's toolbar,
  sorting, virtualization at scroll, or the exported file's actual download
  behavior in a real browser — this environment has no display. The gates above
  are the verification for this pass; flagging explicitly per the repo's "don't
  claim UI verification you couldn't perform" convention. `DataTable`'s
  virtualization was smoke-tested (200 rows, threshold 50, renders without
  crashing) but not visually verified against `chat-sidebar.tsx`'s existing
  virtualized-list behavior side by side.

## Remaining Open Items
Phase 3's stated AC is broad — "migrate Approvals, Activity, Cron, Limits, Archive,
Skills, and Orchestration tabs onto [DataView]; saved views, column config, density,
export, global filter bar" — and this pass delivers the *system* plus one full
reference migration, not an exhaustive sweep:
- **Not migrated onto `DataTable`/the toolbar**: Approvals, Activity, Cron, Limits,
  Archive, Skills, and Orchestration's other six tabs (Queue, Holds, Continuations,
  Dual-lane, Recovery, and the Overview tab's running-leases list) still use their
  Phase-0/Phase-2-era bespoke list markup. Each of those has enough per-row bespoke
  behavior (approvals' approve/reject actions, cron's expand-to-run-history,
  kanban-adjacent ticket cards, etc.) that a mechanical `DataTable` swap needs
  per-page judgment about what becomes a `render` cell vs. what stays custom —
  correctly a follow-up pass per surface, not a single further edit.
- **`SavedViewsMenu` has zero call sites yet.** It's built and unit-tested but not
  wired into Workers or anywhere else this pass — Workers' toolbar currently offers
  search/density/columns/export but not "save this view." Wiring it in is
  straightforward (the hook already exposes `saveView`/`deleteView`/`pinView`) but
  was left for whichever page's migration exercises it first, to avoid designing the
  UX for "current filters" in the abstract before a second real consumer exists.
- **No global `FilterBar` grammar** (plan Section 5.2 — a shared multi-select
  filter component reused across surfaces) — Workers' toolbar uses a plain text
  search input, not a structured filter bar. A shared `FilterBar` needs at least two
  real, differently-shaped filter surfaces to design against without guessing; this
  pass only had one (Workers).
- **URL-serialized filters/selection** (carried over as deferred from Phase 2) —
  still not implemented. `useViewPreferences` persists to `localStorage`, not the
  URL, so a DataView's current state isn't yet a shareable link.
- Column **resizing** and **drag-to-reorder** were explicitly scoped out of
  `DataTable` (show/hide only) — noted as a known gap, not a bug, consistent with
  the plan's own "column configuration: show/hide, reorder, resize" wishlist being
  larger than what a first pass needs to prove the system works.

## Provenance
Authored directly in this session (remote cloud agent) against the live
`packages/web` source tree, branched fresh from `main`. Not reconstructed from
archives or prior session logs.
