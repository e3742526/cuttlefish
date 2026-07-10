# Giles Feature Ledger — Entry 0013

## Feature ID
`fleetview-ux-phase2-state-contract-2026-07-10`

## Short Action Summary
Implemented Phase 2 ("The state-contract sweep") of the FleetView UX/UI implementation
plan (`docs/plans/2026-07-10-fleetview-ux-implementation-plan.md`, ledger entries
0010–0012), scoped strictly to `packages/web`. Branched fresh from `main` (Phase 1's
PR #26 was still open, not yet merged, at the time this work started; Phase 2 doesn't
depend on Phase 1's nav/keyboard changes).

Surveyed every remaining core route (Kanban, Archive, Limits, Skills, Organization,
Activity/Logs, plus Command Center and Orchestration as lower-priority extras — Phase
0 already covered Approvals and Cron) for hand-rolled empty/error/loading markup not
using the shared `EmptyState`/`ErrorState`/`Skeleton` primitives, then converted the
sweep's findings:

- **Orchestration page** — the single highest-leverage fix: the page defined its own
  *local* `EmptyState`/`Banner` components (shadowing the shared ones by name) used
  across all 9 tabs (Overview, Workers, Queue, Holds, Continuations, Dual-lane,
  Recovery, Worktrees, Telemetry). Swapped every call site onto the shared
  `EmptyState`/`ErrorState`, split the conflated loading/no-data branch into a real
  `Skeleton`-based loading state plus a distinct empty state, and kept a slimmed-down
  local `Banner` for the amber (non-error) degraded/disabled/queue-paused
  informational rows — deliberately, since `ErrorState`'s contract is "always red."
- **Organization page** — converted the fatal load error to `ErrorState`; added a
  genuinely missing empty state for "department tab has zero employees" (previously
  rendered a blank org-chart canvas with no explanation).
- **Kanban page** — converted the fatal load error and the save-error banner to
  `ErrorState` (left the two amber warning banners — partial-load and
  rejected-ticket — as page-local, non-error banners, same reasoning as
  Orchestration); converted the recycle-bin and per-column (`kanban-column.tsx`)
  empty states to `EmptyState`; added `StalePill` (confirmed via the survey as a
  genuine WS-live surface — it subscribes to `board:updated`).
- **Archive page** — converted both panes' error states (now wired to each query's
  real `refetch`) and both empty states, plus the nested per-session "no transcript
  messages" empty state, to the shared primitives. No `StalePill` — pure TanStack
  Query, not gateway-subscribed.
- **Limits page** — converted the error banner and the zero-engine-data empty state.
- **Skills page** — converted the list error/empty states (wired retry to a new
  `loadSkills` callback extracted from the previously-inline fetch), and gave the
  skill-detail dialog a real error state instead of silently rendering "Failed to
  load skill content" as if it were successful markdown content.
- **Activity/Logs page** — converted the error banner; converted `log-browser.tsx`'s
  dual-purpose ("truly empty" vs "filtered to empty") empty state to `EmptyState`,
  preserving both distinct messages.
- **Command Center page** (lower priority, done anyway since its existing hand-rolled
  shapes already closely matched the primitives) — converted its error and
  zero-agent-activity states.
- **The debounced connection-status hook** (`hooks/use-connection-status.ts`,
  `useDisconnected`) and the **app-level `GatewayOfflineBanner`**
  (`components/gateway-offline-banner.tsx`), mounted once, unconditionally, in
  `PageLayout` — the two biggest single-item Phase 2 AC targets. `useDisconnected`
  also fixed a latent Phase-0 rough edge: `StalePill` previously read raw
  `useGateway().connected`, which is false for a brief moment on every page load
  (before the WS handshake completes), so it would have flashed on nearly every
  navigation; both `StalePill` and the new banner now share the debounced read
  (1.5s grace period before either renders).

## Touched Files
- `packages/web/src/hooks/use-connection-status.ts` (new) — `useDisconnected`.
- `packages/web/src/hooks/__tests__/use-connection-status.test.ts` (new).
- `packages/web/src/components/gateway-offline-banner.tsx` (new).
- `packages/web/src/components/__tests__/gateway-offline-banner.test.tsx` (new).
- `packages/web/src/components/ui/stale-pill.tsx` — reads `useDisconnected()` instead
  of raw `connected`.
- `packages/web/src/components/page-layout.tsx` — mounts `GatewayOfflineBanner`
  unconditionally (including chromeless/chat).
- `packages/web/src/components/page-layout.test.tsx` — mocks `@/hooks/use-gateway`
  (now required since `GatewayOfflineBanner` calls it).
- `packages/web/src/routes/orchestration/page.tsx` — local `EmptyState`/`Banner` →
  shared primitives across all tabs; new `OrchestrationLoadingSkeleton`.
- `packages/web/src/routes/org/page.tsx` — `ErrorState`; new zero-employees
  `EmptyState`.
- `packages/web/src/routes/kanban/page.tsx` — `ErrorState` (load + save errors),
  `EmptyState` (recycle bin), `StalePill`.
- `packages/web/src/components/kanban/kanban-column.tsx` — per-column `EmptyState`.
- `packages/web/src/routes/archive/page.tsx` — `ErrorState`/`EmptyState` across both
  panes and the nested session-transcript empty state; wired real `refetch`.
- `packages/web/src/routes/limits/page.tsx` — `ErrorState`/`EmptyState`.
- `packages/web/src/routes/skills/page.tsx` — `ErrorState`/`EmptyState`; extracted
  `loadSkills`; real error state in the skill-detail dialog.
- `packages/web/src/routes/logs/page.tsx` — `ErrorState`.
- `packages/web/src/components/activity/log-browser.tsx` — `EmptyState`.
- `packages/web/src/routes/command/page.tsx` — `ErrorState`/`EmptyState`; dropped the
  now-unused `RefreshCw` import.
- `packages/web/docs/components.md` — documents `useDisconnected`,
  `GatewayOfflineBanner`, and the refined `StalePill` guidance (including "don't use
  it on poll-based, non-gateway-subscribed pages").
- `.giles/feature-ledger/giles-ledger-0013-fleetview-ux-phase2-state-contract.md`
  (this entry).

## Validation Run
All run from `packages/web` against a fresh `pnpm install` + `pnpm --filter=@cuttlefish/contracts build`:
- `pnpm exec tsc --noEmit -p tsconfig.json` — clean, zero errors.
- `pnpm exec vitest run` (full package suite) — **101 test files / 842 tests, all
  passing**, including new coverage for `useDisconnected` (grace-period timing,
  reconnect reset, custom grace) and `GatewayOfflineBanner` (renders nothing
  connected, alerts when disconnected), plus every pre-existing test for the
  converted pages (archive, kanban, org, orchestration) confirmed passing unchanged
  — none of the converted copy was test-asserted verbatim except Archive's "No
  previous projects." string, which was preserved exactly.
- `pnpm --filter=@cuttlefish/web lint` (`eslint --max-warnings=0`) — clean.
- `pnpm build` (Vite production build) — succeeds.
- Not run: a live browser/Playwright walkthrough, or an actual "kill the gateway
  mid-demo" manual test of the banner/pill — this environment has no display. The
  gates above are the verification for this pass; flagging explicitly per the
  repo's "don't claim UI verification you couldn't perform" convention. The
  debounce timing (1.5s grace period) was verified via fake timers in
  `use-connection-status.test.ts`, not a live network drop.

## Remaining Open Items
Phase 2's stated AC — "apply the five-state contract to every remaining surface;
app-level gateway-offline banner; visible WS-reconnect pill; URL-serialized
filters/selection" — is substantially met on the banner/pill/error/empty fronts but
not exhaustively "every surface," and URL-serialized filter/selection state was not
touched this pass:
- Not swept: Chat, Talk, Settings, and the Orchestration sub-tab components' own
  nested state where distinct from the local `EmptyState`/`Banner` already converted
  (Workers/Queue/Holds/etc. reuse the same `Table`/`EmptyState` helpers already
  converted, so their *shared* plumbing is done, but each tab's bespoke row-level UI
  wasn't individually re-audited beyond what the shared helpers cover).
- URL-serialized filters/selection (Section 7.4 of the plan) — not started. This is
  Phase 3 territory (the `DataView`/saved-views system) and was intentionally left
  for that phase rather than bolted on ad hoc here.
- The "stale" treatment is now real (debounced `StalePill`/banner), but per-widget
  "last updated" timestamps using the shared `Timestamp` component were not
  systematically audited across the newly-converted pages — several still hand-format
  dates inline (e.g. `formatDate` helpers in kanban/orchestration/archive). Worth a
  follow-up pass but out of scope for the empty/error/stale sweep specifically.
- Kanban's two amber warning banners (partial-load, rejected-ticket) and
  Orchestration's amber `Banner` were deliberately left as page-local components
  rather than forced into `ErrorState` (which is contractually "always red"). If the
  plan later wants a shared amber "attention" banner primitive, that's new work, not
  a gap in this sweep.

## Provenance
Authored directly in this session (remote cloud agent) against the live
`packages/web` source tree, branched fresh from `main`. Not reconstructed from
archives or prior session logs.
