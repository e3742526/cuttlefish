# FleetView component reference

The lightweight style guide `docs/plans/2026-07-10-fleetview-ux-implementation-plan.md`
(Section 8) calls for. Documents purpose, anatomy, and do/don't for the shared
primitives in `src/components/ui/`. Extend this file as new primitives land;
keep entries short — this is a reference, not a tutorial.

## Vocabulary (`src/lib/vocabulary.ts`)

Not a component, but everything below depends on it: the single source of
truth for what a domain noun is called and drawn with (`VOCABULARY.approval.plural
=== "Approvals"`, etc). Nav labels, page titles, and empty/error copy should
read from `VOCABULARY` rather than re-typing a string, so a concept never
drifts into two names across the app (the historical example: nav said
"Activity" while the route stayed `/logs`).

**Do:** `title={VOCABULARY.cron.label}`, `<Icon icon={VOCABULARY.approval.icon} />`.
**Don't:** hardcode `"Approvals"` in a new page — import it from vocabulary.

## `EmptyState`

Zero-data state: nothing has gone wrong, there's just nothing here yet (or
nothing matches the current filter/selection).

- **Anatomy:** optional icon (muted, 1.5px stroke) → title (required, one line)
  → optional description (one or two lines, explains *why* it's empty) →
  optional action (a `Button` or link — the next thing the user should do).
- **Do:** give every truly-empty collection (no rows at all) both a title and
  an action when there's a clear next step ("Add your first employee").
- **Don't:** use `EmptyState` for "nothing selected yet" *and* "zero results"
  with identical copy — differentiate them (see `approvals/page.tsx` for both
  cases handled distinctly).

## `ErrorState`

A request failed. Distinct from `EmptyState` — always red, always names the
cause, never silently indistinguishable from "no data."

- **Anatomy:** `role="alert"` → plain-language `message` (always visible) →
  optional `Retry` button (`onRetry`) → optional collapsible `detail` (raw
  error text) behind a disclosure toggle.
- **Do:** pass the real error message as `message`; reserve `detail` for
  stack traces or payloads a user doesn't need at a glance.
- **Don't:** use `ErrorState` for the *app-level* "gateway unreachable" case —
  that's `GatewayOfflineBanner`, a persistent top-level banner, not a
  per-widget card.

## `useDisconnected` (`hooks/use-connection-status.ts`)

Not a component — the shared, debounced read of the gateway WebSocket's
connection state that both `StalePill` and `GatewayOfflineBanner` build on.
True only once `connected` has been continuously false for a grace period
(1.5s default). Raw `useGateway().connected` is false for a brief moment on
every page load and can blip during ordinary network hiccups; without this
debounce, disconnected-state UI would flash on nearly every navigation.

- **Do:** use this (not raw `useGateway().connected`) for any new
  disconnected-state UI.
- **Don't:** invent a second grace period — pass a custom `graceMs` to this
  hook if a surface genuinely needs a different threshold, rather than
  rolling your own timer.

## `StalePill`

Renders nothing while `useDisconnected()` is false. Renders an amber "Live
updates paused — reconnecting" pill once a disconnect actually persists, so
data on screen is visibly non-live rather than silently stale.

- **Do:** drop `<StalePill />` next to any "Updated Xm ago" / live-refresh
  indicator on a page that relies on WS push updates (see `cron/page.tsx`,
  `kanban/page.tsx`).
- **Don't:** wrap it in your own loading/error branching — it self-manages
  and is safe to render unconditionally. Don't add it to a page whose data
  comes from TanStack Query polling rather than the gateway WebSocket
  (e.g. `archive/page.tsx`, `limits/page.tsx`) — it would report a
  connection state unrelated to that page's actual data freshness.

## `GatewayOfflineBanner`

The app-level counterpart to `StalePill`: a persistent, impossible-to-miss
banner (fixed to the top of the viewport, `role="alert"`) for when the
gateway itself is unreachable, not just one widget's data going stale.
Mounted once, unconditionally, in `PageLayout` — covers every route
including chat. Shares `useDisconnected()`, so it appears in lockstep with
any `StalePill`s on screen.

- **Do:** leave it exactly where it is (`PageLayout`) — it should never be
  mounted per-page.
- **Don't:** build a second "gateway unreachable" banner elsewhere; this is
  the one, satisfying the Phase 2 acceptance criterion that killing the
  gateway produces the banner everywhere, never blank panes.

## `StatusChip`

The **only** component allowed to render a status color. Closed vocabulary —
`running | success | failed | attention | idle | pending` — so a color always
carries the same meaning everywhere it appears (org chart, kanban, cron runs,
approvals).

- **Do:** map your surface's status strings onto one of the six tones at the
  call site (`state === "error" ? "failed" : ...`); pass `label` only to
  rename the chip's text ("Blocked" instead of "Attention"), never to change
  its color.
- **Don't:** invent a seventh tone or reach for a raw `--system-*` color
  directly when the concept is a status.

## `Timestamp`

Relative under 24h ("14m ago"), absolute after; the absolute form is always
available via the native `title` tooltip. Ticks its relative label every 30s
while mounted.

- **Do:** use for any user-facing "when did this happen" value; pass
  `alwaysAbsolute` for fields where relative time reads oddly (e.g.
  "resolved at" columns sitting next to a "created at" column).
- **Don't:** hand-format dates with `toLocaleString`/`Date.now()` diffing in a
  new component — import `Timestamp` instead.

## DataView (`src/components/data-view/`)

The shared body of the Queue/Table page template (plan Section 5.2/11):
search, sortable + virtualized table, column visibility, density, saved
views, and CSV/JSON export, all backed by one persisted preferences hook.
Import everything from the barrel: `import { DataTable, useViewPreferences,
... } from "@/components/data-view"`.

- **`useViewPreferences(surfaceKey)`** — persisted, per-surface density /
  hidden-columns / saved-views state. Storage key is
  `fleetview.prefs.v1:dataview.<surfaceKey>`; pick a stable, unique
  `surfaceKey` per page (or per tab, if a page's tabs have unrelated column
  sets). Syncs across tabs via the `storage` event and degrades gracefully
  if `localStorage.setItem` throws (private browsing, full quota) — the
  in-memory state still applies for that tab.
- **`DataTable`** — generic table: pass `columns` (each with a `render` and
  an optional `sortValue`; mark the primary identifying column `required`
  so `ColumnConfigMenu` can't hide it), `rows`, and `getRowKey`. Virtualizes
  automatically past `virtualizeThreshold` (default 50) via
  `@tanstack/react-virtual` — the same library and pattern as
  `chat-sidebar.tsx`. Sorting/density/column-visibility are fully
  controlled: the table has no state of its own beyond scroll position.
- **`DensityToggle`**, **`ColumnConfigMenu`** — small controlled inputs over
  `useViewPreferences`' `density`/`hiddenColumns`.
- **`SavedViewsMenu`** — save/apply/delete named presets of a surface's
  current filters + sort + hidden columns. Filters are typed as an opaque
  `TFilters` generic — the surface defines its own filter shape.
- **`ExportMenu`** / **`exportRowsAsCsv`** / **`exportRowsAsJson`** — export
  exactly the rows passed in (the caller's already-filtered set) — never a
  larger unfiltered dataset. `ExportMenu` shows the row count before export
  so what's downloaded is never a surprise.

**Reference implementation:** `routes/orchestration/page.tsx`'s Workers tab
(`WorkersTab`) is the flagship — full toolbar (search, density, columns,
export) over a sortable/virtualized `DataTable`. The Worktrees and Telemetry
tabs share `DataTable`'s rendering (retiring the page's old
`columns: string[]; rows: string[][]` local `Table` helper entirely) but
don't carry the full toolbar — see the Phase 3 ledger entry for what's
deliberately deferred there.

- **Do:** give every `DataTable` an `emptyState` (usually a plain
  `EmptyState`) — it renders instead of the table shell when `rows` is empty.
- **Don't:** build a second ad hoc `<table>` for a new tabular surface —
  migrate onto `DataTable`, even if you don't wire the full toolbar yet.
