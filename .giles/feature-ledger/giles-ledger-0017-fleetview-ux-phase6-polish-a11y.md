# Giles Feature Ledger — Entry 0017

## Feature ID
`fleetview-ux-phase6-polish-a11y-2026-07-10`

## Short Action Summary
Implemented a scoped slice of Phase 6 ("Polish, accessibility, and hardening"),
the final phase of the FleetView UX/UI implementation plan
(`docs/plans/2026-07-10-fleetview-ux-implementation-plan.md`, ledger entries
0010–0016), scoped strictly to `packages/web`. Branched fresh from `main`
(Phases 0–5 merged).

Ran a read-only audit first — grepped for existing `prefers-reduced-motion`/
`motion-reduce:` coverage, skip-link/landmark structure, mobile responsive
handling on `DataTable` and the two slide-over "inspector" panels
(`TicketDetailPanel`, `EmployeeDetail`), the `/redesign` route's actual
content, and whether Playwright/axe-core tooling existed anywhere in the
repo — before deciding what needed real work versus what was already
satisfied. Two audit findings meant no code change was needed there (see
Remaining Open Items); the rest became concrete deliverables:

- **Skip-to-content link (WCAG 2.4.1 Bypass Blocks).** `PageLayout` had none.
  Added a `.sr-only` anchor as the first focusable element in the DOM,
  visible only on keyboard focus, jumping to a new `id="main-content"` /
  `tabIndex={-1}` on the `<main>` landmark.
- **`DataTable` → stacked cards on mobile** (the plan's own named
  responsive-audit line item). Below the `md:` breakpoint, non-virtualized
  tables now render a second, `md:hidden` card list (label/value pairs per
  row) alongside the existing `hidden md:block` grid table, sharing the same
  `visibleColumns`, `rowClassName`, `onRowClick`, and keyboard handling.
  Virtualized tables (row count over `virtualizeThreshold`) keep the
  horizontally-scrollable grid on mobile too — the virtualizer's fixed
  `ROW_HEIGHT` estimate doesn't hold for the card layout's variable height,
  and building a second virtualized path was judged out of scope for this
  pass (see Remaining Open Items).
- **Automated axe-core accessibility smoke coverage.** Added `axe-core` as a
  devDependency and a small `src/test/axe.ts` helper (`runAxe`,
  `formatViolations`) that runs axe against a rendered container with
  `color-contrast` disabled (jsdom has no real paint/layout, so contrast
  checks are meaningless there — this is structural/semantic coverage:
  labels, roles, landmarks, form associations). Wired into 4 existing
  full-page-render test suites as a representative sample: Command Center,
  Approvals, Archive, and Orchestration. All passed with zero violations on
  first run — no defects found or fixed this pass.
- **Deleted `/redesign`.** Removed the dev-only route, its lazy import in
  `main.tsx`, and the single-file `src/routes/redesign/page.tsx`. Archived
  its visual intent (the "Ledger Dock" concept: employee rail, per-agent
  chat list, focused thread pane, command-bar input, ⌘K switcher, two
  themes) into `packages/web/docs/redesign-archive.md`, including which
  ideas from it did (⌘K → `GlobalSearch`) and didn't (the dock's
  employee-rail-plus-chat-list split, the per-turn byline styling) carry
  into the real implementation.

## Touched Files
- `packages/web/src/components/page-layout.tsx` — skip-to-content link,
  `id="main-content"` + `tabIndex={-1}` on `<main>`.
- `packages/web/src/components/page-layout.test.tsx` — new test for the
  skip link's href and target.
- `packages/web/src/components/data-view/data-table.tsx` — `renderCard`,
  `rowInteractionProps` (shared between table/card rows), the `md:hidden`
  card list and `hidden md:block` (non-virtualized only) table wrapper.
- `packages/web/src/components/data-view/__tests__/data-table.test.tsx` —
  scoped 2 pre-existing assertions to `within(getByRole("table"))` (both
  table and card copies now exist in jsdom's unstyled DOM); added 4 new
  tests (card mirrors the table, card click fires `onRowClick`, virtualized
  tables render only the table — no second card copy).
- `packages/web/src/test/axe.ts` (new) — `runAxe`, `formatViolations`.
- `packages/web/src/test/axe.test.ts` (new) — 2 tests for the helper itself
  (flags a real violation, passes clean markup).
- `packages/web/src/routes/command/page.test.tsx`,
  `packages/web/src/routes/approvals/page.test.tsx`,
  `packages/web/src/routes/archive/page.test.tsx`,
  `packages/web/src/routes/orchestration/page.test.tsx` — one new axe-core
  smoke test each.
- `packages/web/src/main.tsx` — removed the `/redesign` route and its lazy
  import.
- `packages/web/src/routes/redesign/page.tsx` — deleted.
- `packages/web/docs/redesign-archive.md` (new) — archived intent.
- `packages/web/package.json` — `axe-core` devDependency.
- `.giles/feature-ledger/giles-ledger-0017-fleetview-ux-phase6-polish-a11y.md`
  (this entry).

## Validation Run
All run from `packages/web` against a fresh `pnpm install` +
`pnpm --filter=@cuttlefish/contracts build`:
- `pnpm exec tsc --noEmit -p tsconfig.json` — clean, zero errors.
- `pnpm exec vitest run` (full package suite) — **113 test files / 925 tests,
  all passing**, including all new tests listed above. All pre-existing
  tests pass unchanged (2 were re-scoped to `within(...)`, not weakened —
  they assert the identical thing, just against the table copy specifically
  now that a second, card copy exists in the unstyled test DOM).
- `pnpm --filter=@cuttlefish/web lint` (`eslint --max-warnings=0`) — clean.
- `pnpm build` (Vite production build) — succeeds.
- **Not tested**: no live browser walkthrough was performed (this
  environment has no display) — flagging per the repo's "don't claim UI
  verification you couldn't perform" convention. The mobile card list's
  actual `md:hidden`/`hidden md:block` visual behavior at real viewport
  widths, and the skip-link's actual focus-visible appearance, were verified
  by reading the generated markup/classes and by DOM-structure assertions
  (both renders exist; the CSS deciding which one paints wasn't executed by
  a browser in this pass) — not by an actual resize/keyboard-tab in a
  browser.

## Remaining Open Items
This is a scoped slice of Phase 6, not the full plan wishlist ("Full WCAG 2.2
AA audit + fixes; reduced-motion audit; responsive audit (tables→cards on
mobile; inspector→bottom sheet); delete `/redesign` route after archiving its
intent into docs; Playwright coverage for the five-state contract and the
three anchor journeys"):
- **Reduced-motion audit: already satisfied, no change made.** `globals.css`
  already has a catch-all `@media (prefers-reduced-motion: reduce) { *, ::before,
  ::after { animation-duration: 0.01ms !important; transition-duration:
  0.01ms !important; ... } }` rule covering every CSS-driven transition in
  the app, and the one place with a genuinely custom JS-driven animation
  (Talk's `motion.ts` spring chase + `aura-avatar.tsx`'s canvas raf loop)
  already checks `window.matchMedia("(prefers-reduced-motion: reduce)")` and
  snaps to target / paints a single static frame. Verified during the audit;
  no gaps found.
- **"Inspector → bottom sheet" responsive pattern: already satisfied, no
  change made.** Both slide-over inspectors (`TicketDetailPanel`,
  `EmployeeDetail`'s containing overlay in `org/page.tsx`) already go
  full-screen below the `sm:`/no-breakpoint case (`max-w-[100vw]` /
  `left-0 sm:left-auto`) rather than staying a cramped fixed-width side
  panel on phones. Not literally a bottom-sheet (it's a full-screen
  side/top-slide overlay), but functionally equivalent for the stated
  problem (a fixed-width side panel doesn't fit a phone). Left as-is;
  building a literal bottom-sheet transform was judged not worth the
  regression risk on two heavily-used, already-tested components for a
  cosmetic difference from the existing behavior.
- **Full WCAG 2.2 AA audit: only a representative axe-core smoke sample was
  added** (4 routes: Command Center, Approvals, Archive, Orchestration), not
  every surface the plan's AC calls for ("axe-core clean on all surfaces in
  light+dark reference themes"). Extending to every route, and to both
  themes, is mechanical but was judged too large to do blind in one pass
  (over a dozen more route test files, several needing new mock scaffolding
  they don't currently have — e.g. Settings and Kanban's page test files
  only cover pure helper functions today, not a full page render). Color
  contrast itself is entirely unverified — jsdom can't paint, so
  `color-contrast` was disabled in the axe config; a real contrast audit
  needs a real browser.
- **`DataTable` mobile cards don't cover the virtualized (>50 rows) path.**
  Large tables (e.g. a big cron-job or org list) keep the horizontally-
  scrollable grid on mobile. Documented above; fixing this means teaching
  the virtualizer a second, variable-height card mode, which is a real
  virtualizer-level change, not a presentational one — deferred.
- **Playwright coverage for the five-state contract and three anchor
  journeys: not attempted.** The repo's three existing e2e specs
  (`e2e/smoke.spec.ts`, `e2e/nav-rail-dnd.spec.ts`, `e2e/scroll.spec.ts`) all
  require a manually-started live gateway (and, for `scroll.spec.ts`, a
  manually-started dev preview with a real chat session) — there's no
  `webServer` auto-start in `playwright.config.ts`, and no CI workflow runs
  `e2e/` at all (checked `.github/workflows/`: none reference Playwright or
  `e2e`). This environment has neither a running gateway process nor a
  display. Writing new anchor-journey specs I have no way to run or verify
  against real DOM output risks committing broken, never-executed test code
  that silently rots — judged worse than not adding them. Deferred; flagging
  explicitly rather than claiming coverage that doesn't exist.

## Provenance
Authored directly in this session (remote cloud agent) against the live
`packages/web` source tree, branched fresh from `main` (Phases 0–5 merged).
Not reconstructed from archives or prior session logs.
