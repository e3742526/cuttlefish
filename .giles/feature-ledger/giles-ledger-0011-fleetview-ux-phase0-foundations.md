# Giles Feature Ledger — Entry 0011

## Feature ID
`fleetview-ux-phase0-foundations-2026-07-10`

## Short Action Summary
Implemented Phase 0 ("Foundations") of the FleetView UX/UI implementation plan
(`docs/plans/2026-07-10-fleetview-ux-implementation-plan.md`, Giles ledger entry
0010), scoped strictly to `packages/web` (presentation layer only — no orchestration
or bus changes). Concretely:

- Added `src/lib/vocabulary.ts`, a single canonical source of label/plural/definition/
  icon per domain noun, and rewired `src/lib/nav.ts` to source `NAV_ITEMS` labels and
  icons from it instead of re-typing strings.
- Retired the "Activity" nav-label-drift gap: the route is now `/activity` (was
  `/logs`), with `/logs` kept as a redirect (`main.tsx`) for old links/bookmarks, and
  `global-search.tsx`'s static page entry updated to match. The route's underlying
  directory (`routes/logs/`) and the backend `/api/logs` REST endpoint were left
  unchanged — out of scope (backend contract, not presentation).
- Added the first five state-contract primitives to `src/components/ui/`: `EmptyState`,
  `ErrorState`, `StatusChip`, `Timestamp`, `StalePill` (the last reads
  `useGateway().connected` and renders nothing while connected — surfaces the
  "partial/stale" async state from plan Section 7.1 whenever the gateway WebSocket
  drops).
- Adopted the new primitives on the two Phase-0 pilot pages named in the plan's
  acceptance criteria — `routes/approvals/page.tsx` (pending-queue empty/error,
  no-selection empty, resolved-queue empty) and `routes/cron/page.tsx` (load-error,
  empty-job-list, plus a `StalePill` next to the existing "Updated Xm ago" indicator)
  — replacing each page's hand-rolled empty/error markup without changing existing
  test-observable copy that tests assert on.
- Wrote `packages/web/docs/components.md`, the lightweight component reference the
  plan's Section 8 calls for (purpose/anatomy/do-don't per primitive, plus the
  vocabulary module).

## Touched Files
- `packages/web/src/lib/vocabulary.ts` (new)
- `packages/web/src/lib/nav.ts` — sources `NAV_ITEMS` from vocabulary; `/logs` → `/activity`.
- `packages/web/src/main.tsx` — route renamed to `/activity`; `/logs` now redirects.
- `packages/web/src/components/global-search.tsx` — static "Activity" entry href fixed.
- `packages/web/src/components/ui/empty-state.tsx` (new)
- `packages/web/src/components/ui/error-state.tsx` (new)
- `packages/web/src/components/ui/status-chip.tsx` (new)
- `packages/web/src/components/ui/timestamp.tsx` (new)
- `packages/web/src/components/ui/stale-pill.tsx` (new)
- `packages/web/src/routes/approvals/page.tsx` — adopts `EmptyState`/`ErrorState`.
- `packages/web/src/routes/cron/page.tsx` — adopts `EmptyState`/`ErrorState`/`StalePill`.
- `packages/web/docs/components.md` (new)
- `.giles/feature-ledger/giles-ledger-0011-fleetview-ux-phase0-foundations.md` (this entry).

## Validation Run
All run from `packages/web` (dependencies installed fresh via `pnpm install` at repo
root; `@cuttlefish/contracts` built via `pnpm --filter=@cuttlefish/contracts build` to
get a clean baseline — that gap is pre-existing/unrelated to this change, not something
this entry introduced):
- `pnpm exec tsc --noEmit -p tsconfig.json` — clean, zero errors.
- `pnpm exec vitest run` (full package suite) — **99 test files / 835 tests, all
  passing**, including the pre-existing `approvals/page.test.tsx` assertions
  (`"approval fetch failed"` error text, checkpoint/approval selection flows) and
  `lib/__tests__/nav.test.ts` / `nav-ribbon*` / `pill-nav.test.ts` (nav-order and
  active-route logic unaffected by the vocabulary refactor).
- `pnpm --filter=@cuttlefish/web lint` (`eslint --max-warnings=0`) — clean.
- `pnpm build` (Vite production build) — succeeds; `error-state` and the other new
  primitives appear as their own chunks in the build manifest.
- Not run: a live browser/Playwright walkthrough of the Approvals and Cron pages —
  this environment has no display; the CI unit/build/lint gates above are the
  verification for this pass. Flagging explicitly per the repo's "don't claim UI
  verification you couldn't perform" convention.

## Remaining Open Items
Phase 0 is scoped, not exhaustive; the plan's own AC for Phase 0 is "state
primitives documented and adopted on ≥2 pilot pages" — met. Explicitly deferred:
- `EntityLink`, `KpiTile`, `TriageChip`, `ShortcutSheet` — later phases per the
  roadmap (Command Center / cross-linking work, Phase 4–5), not required for Phase 0.
- Full three-layer design-token formalization and the contrast-lint script (plan
  Section 9.2) — not started; existing token set was reused as-is.
- The `routes/logs/` directory name and `/api/logs` backend route were intentionally
  left as-is (directory rename is cosmetic/mechanical but touches more surface than
  Phase 0's budget justified; the backend route is out of the presentation-layer scope
  this plan commits to).
- Nav grouping (Work / Organization / Ops), promoting Command Center and Orchestration
  into `NAV_ITEMS`, and the mobile-tab-bar swap (Cron → Approvals) are Phase 1 work per
  the roadmap and were not touched here — `MOBILE_TAB_HREFS` in `nav.ts` is unchanged.
- A per-user `localStorage` nav-order setting that already pins `"/logs"` to a specific
  position will silently fall through `applyNavOrder`'s "unknown href" branch and land
  at its default position after this change — a minor, self-healing regression (the
  item never disappears, it just loses a custom position) acceptable for a route rename.
- Remaining Phase 0 scope from the plan not covered here (full token layering, contrast
  lint) rolls into a future ledger entry when Phase 1+ work begins.

## Provenance
Authored directly in this session (remote cloud agent), same day as the plan (ledger
0010) it implements, against the live `packages/web` source tree. Not reconstructed
from archives or prior session logs.
