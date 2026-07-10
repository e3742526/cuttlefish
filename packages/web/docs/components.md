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
  that gets a persistent top-level banner (Phase 2), not a per-widget card.

## `StalePill`

Renders nothing while the gateway WebSocket is connected (`useGateway().connected
=== true`). Renders an amber "Live updates paused — reconnecting" pill the
moment it drops, so data on screen is visibly non-live rather than silently
stale.

- **Do:** drop `<StalePill />` next to any "Updated Xm ago" / live-refresh
  indicator on a page that relies on WS push updates (see `cron/page.tsx`).
- **Don't:** wrap it in your own loading/error branching — it self-manages
  via `useGateway()` and is safe to render unconditionally.

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
