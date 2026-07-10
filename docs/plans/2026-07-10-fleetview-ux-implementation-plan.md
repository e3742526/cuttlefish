# FleetView UX/UI Implementation Plan

**Date:** 2026-07-10
**Status:** Proposed
**Scope:** `packages/web` (the FleetView dashboard) and its presentation-layer contracts only.
**Strictly out of scope:** the orchestration engine, session/delegation semantics, the
multi-agent bus, gateway internals, engine adapters. This plan never proposes changes to
how agents run — only to how their work is presented, labeled, navigated, and operated.

---

## 1. Executive summary

Cuttlefish's promise is *"run your AI agents as a company."* The dashboard must therefore
read like a **corporate operations console**, not a generic observability dashboard: the
user is a CEO/operator reviewing an org, delegating work down a chain of command, and
approving what comes back up.

The current UI (Vite + React 19, Tailwind v4, Radix, TanStack Query, xyflow org chart,
7-theme system) is feature-rich but has four systemic UX debts this plan retires:

1. **Taxonomy drift** — one concept, many names (nav "Activity" → route `/logs` → dir
   `activity/`; rank `executive` relabeled "COO" in exactly one renderer; "Organization"
   vs `org`). Professional users cannot build a mental model from unstable labels.
2. **Hidden surfaces** — `/command` (Command Center) and `/orchestration` are the two
   densest operator dashboards yet are absent from `NAV_ITEMS`; discoverability is zero.
3. **No state-contract** — only `skeleton.tsx` exists as a shared async-state primitive;
   empty, error, stale, and unauthorized states are ad-hoc per page or missing.
4. **No analyst-grade customization** — no saved views, no persistent filters, no density
   control, no column configuration on any tabular surface.

The plan is organized as: principles → personas & journeys → information architecture &
taxonomy → layout architecture → interaction paradigms → state contract → component
system → aesthetics → customization → accessibility → phased roadmap with acceptance
criteria.

---

## 2. Design principles

1. **The org is the interface.** Hierarchy, delegation, and chain-of-command are the
   product's differentiator; every surface should answer "who did this, on whose behalf,
   reporting to whom" within one glance or one click.
2. **Files are the substrate, the UI is the lens.** Employees are YAML on disk; the UI
   edits and visualizes them but never hides that a durable, inspectable artifact exists.
3. **Calm by default, loud on exception.** A healthy org running overnight should render
   as quiet status. Attention (color, motion, badges) is reserved for approvals waiting,
   blocked tickets, failing sessions, and limit exhaustion.
4. **Every noun has exactly one name.** One canonical label per concept, used identically
   in nav, route, page title, API client, and empty-state copy (Section 4).
5. **Never dead-end the user.** Every empty, error, or zero-permission state names the
   cause and offers the next action (Section 7).
6. **Progressive disclosure by role.** The landing experience serves the CEO glance;
   analyst depth (queues, holds, worktrees, telemetry) is one deliberate level down —
   discoverable, never buried.

---

## 3. Personas and core user journeys

### Personas

- **P1 — The Operator ("CEO").** Owns the org. Checks in a few times a day: what
  happened, what needs my sign-off, is anything stuck. Mostly reads Chat, Approvals,
  Command Center. Wants a 30-second scan.
- **P2 — The Analyst.** Studies the org's output and behavior: session outcomes,
  ticket throughput per department, engine/model usage vs limits, cron reliability.
  Lives in tables and timelines; needs filtering, saved views, export, and stable labels.
- **P3 — The Org Designer.** Builds and tunes the workforce: employees, personas,
  ranks, departments, reporting lines, role execution policies. Lives in the Org chart
  and employee editor.
- **P4 — The Ops Engineer.** Diagnoses the machinery when something misbehaves:
  orchestration queues, holds, continuations, worktrees, activity logs. Needs the
  currently-hidden `/orchestration` surface made legible, not powerful (power exists).

### Journey 1 — Morning review (P1, the anchor journey)

1. Open dashboard → land on **Command Center** *when there is pending attention*
   (approvals > 0, blocked tickets, failed crons); otherwise land on Chat as today.
2. Command Center presents a triage strip: *Needs approval (n) · Blocked (n) ·
   Failures overnight (n) · Limits at risk (n)* — each chip deep-links to the filtered
   surface.
3. Approvals queue: keyboard-driven review (j/k navigate, a approve, r reject with
   reason), each item showing requesting employee, chain of command, the diff/action,
   and originating session link.
4. Return path: after the queue drains, an explicit "All clear — back to Command
   Center" terminal state (never a blank list).

### Journey 2 — Delegate and watch (P1/P2)

1. Chat → address the COO → COO fans out to reports.
2. The delegation must be *visible*: a session's message stream shows a **delegation
   block** (child employee, department color, live status chip) that expands into the
   child session inline and links to the Org chart node.
3. Org chart shows live presence: employees with active sessions pulse subtly; clicking
   a node opens a side panel with current session, recent tickets, and usage.

### Journey 3 — Investigate an outcome (P2)

1. Entry from anywhere (ticket, approval, log line) → **Session detail** is the hub.
2. Session detail answers: who ran it, delegated by whom, engine/model/effort, timeline
   of tool activity, artifacts produced, checkpoints, cost/usage.
3. Cross-links are bidirectional: ticket ↔ sessions, session ↔ approvals it raised,
   session ↔ log entries, session ↔ artifacts.

### Journey 4 — Grow the org (P3)

1. Org chart → "Add employee" from a node's context menu (pre-fills `reportsTo`).
2. Editor is a two-pane form: structured fields (name, department, rank, engine, model,
   role policies) left; live YAML preview right, with "the file is the truth" affordance
   (open in file viewer).
3. Validation is inline and pre-save (duplicate name, missing manager, cycle in
   `reportsTo`), never a post-hoc toast.

### Journey 5 — Tune the machine (P4)

1. Orchestration surface promoted into navigation under an **"Ops"** group.
2. Each tab (Queue, Holds, Continuations, Worktrees, Recovery, Telemetry) gets the
   standard state contract and a one-line plain-language definition header, since these
   nouns are internal jargon today.

---

## 4. Information architecture and data taxonomy

### 4.1 Canonical vocabulary (single source of truth)

Create `packages/web/src/lib/vocabulary.ts` exporting the canonical label, plural,
short definition, and icon for every domain noun. All nav items, page titles, empty
states, and column headers consume it. Canonical set:

| Concept | Canonical label | Notes / current drift to retire |
|---|---|---|
| AI worker | **Employee** | Never "agent" in UI copy (docs may say agent). |
| Grouping | **Department** | Keep. Color-coded via `deptHue`. |
| Rank enum | **Executive / Manager / Senior / Employee** | "COO" is a *display name of the single executive*, not a rank label; render as "COO · Executive". |
| Execution role | **Role: Implementer / Reviewer** | Always prefixed "Role:" to disambiguate from rank. |
| Run | **Session** | Keep. |
| Work item | **Ticket** | Keep; statuses Backlog / To do / In progress / Review / Blocked / Done. |
| Human gate | **Approval** | Keep. |
| Schedule | **Cron job** | Keep ("Cron" as nav label). |
| Event stream | **Activity** | Rename route `/logs` → `/activity` (redirect kept); nav, dir, and route all say Activity. |
| Ops console | **Orchestration** | Promoted to nav (Ops group). |
| Overview | **Command Center** | Promoted to nav as home-eligible surface. |
| Whole workforce | **Organization** | "FleetView" is the product codename only, never a screen label. |

### 4.2 Navigation architecture

Reorganize `lib/nav.ts` from a flat 11-item list into three groups (desktop rail shows
groups with dividers; mobile keeps a curated 5):

- **Work:** Chat, Talk, Kanban, Approvals *(badge)*, Archive
- **Organization:** Organization (org chart), Skills, Cron, Limits
- **Ops:** Command Center, Activity, Orchestration, Settings

Rules: every route reachable from nav or from an explicit parent (e.g., `/file` opens
only as a child of a session/artifact context, with breadcrumb back-path — it is a
viewer, not a destination). No route may exist that is reachable *only* by typing a URL.

### 4.3 Labeling standards

- Sentence case everywhere (buttons, headers, tabs); Title Case only for proper nouns
  (Command Center, Cuttlefish).
- Status vocabulary is a closed set with fixed color semantics (Section 9.4); never
  invent per-page synonyms ("failed" vs "errored" vs "dead" → one word: **Failed**).
- Counts in nav badges are *actionable* counts only (approvals pending, tickets blocked)
  — never raw totals.
- Timestamps: relative under 24 h ("14 min ago"), absolute + relative on hover after;
  one shared `<Timestamp>` component, UTC toggle honored globally (Command Center's
  UTC clock preference becomes an app-level setting).

---

## 5. Layout architecture

### 5.1 App shell (evolves `page-layout.tsx`)

- **Desktop:** left icon rail (grouped, as above) → optional contextual sidebar
  (per-surface: chat threads, org departments, kanban filters) → content → optional
  right inspector panel (detail-on-select pattern, Section 6.3).
- **Global header strip** inside content: breadcrumb (existing context), page title from
  vocabulary, page-level actions right-aligned, and the **global search / command
  palette** trigger (⌘K) always visible.
- **Mobile:** keep bottom tab bar (Chat, Talk, Org, Approvals, Settings — swap Cron for
  Approvals: attention beats configuration on mobile) + the PillNav popover for the rest.

### 5.2 Page anatomies (standardized templates)

Define four canonical page templates; every route maps to exactly one:

1. **Console** (Command Center): triage strip → KPI tiles → activity feed + manager
   summaries. All tiles deep-link.
2. **Board/Canvas** (Kanban, Organization): full-bleed canvas, floating toolbar
   (zoom/fit/filter for org; group-by/filter for kanban), right inspector on select.
3. **Queue/Table** (Approvals, Activity, Cron, Limits, Archive, Skills, Orchestration
   tabs): toolbar (search, filters, saved views, density, column config) → virtualized
   table/list → right inspector. One shared `DataView` composition powers all of these.
4. **Conversation** (Chat, Talk): thread sidebar → stream → composer; Talk keeps its
   distinct visual identity but shares message primitives and provider contracts with
   Chat so blocks render identically in both.

### 5.3 The inspector pattern

Selection anywhere (org node, ticket, approval, log row, session) opens a right-side
inspector panel — same width, same header anatomy (entity icon + name, status chip,
overflow menu, close), same tab order (Overview / Timeline / Related / Raw). Deep
"open full page" affordance in the header. This gives P2 analysts a consistent
inspect-without-losing-context loop across the entire app.

---

## 6. Interaction paradigms

### 6.1 Buttons and inputs (flawless-interaction contract)

Codify in `components/ui/` and enforce via review checklist:

- **Buttons:** 5 variants (primary, secondary, ghost, destructive, link); exactly one
  primary per view region. Min hit target 40×40 px (44 on touch). Every async button has
  three built-in states: idle → busy (spinner replaces icon, label persists, button
  stays same width — no layout shift) → success/error flash. Disabled buttons always
  carry a tooltip explaining *why*. Destructive actions use the shared `ConfirmDialog`
  with the consequence named ("This stops Jimbo's running session").
- **Inputs:** label always visible (no placeholder-as-label), inline validation on blur,
  error text below the field (never toast-only), described-by wiring for screen readers.
  Debounced search inputs show an inline activity indicator, and Escape clears.
- **Forms:** dirty-state guard (navigation warns on unsaved changes), ⌘Enter submits,
  optimistic save with rollback + toast on failure (Section 7.3).
- **Toasts:** outcome notifications only, never the sole error channel, always paired
  with an in-context state; destructive-success toasts carry Undo when feasible.

### 6.2 Command palette as the power spine

`cmdk` is already present — elevate it to a first-class navigation and action layer:
navigate to any surface, jump to any employee/ticket/session by name, run scoped actions
("approve latest", "pause cron X", "new employee under Y"). Palette entries come from
the same vocabulary module, guaranteeing label consistency.

### 6.3 Keyboard model

- Global: ⌘K palette, `g` then key for go-to (g o → Organization, g a → Approvals…),
  `?` opens shortcut sheet.
- Queue surfaces: j/k move, Enter opens inspector, a/r approve/reject (Approvals),
  Esc closes inspector.
- Board surfaces: arrow-key node navigation on the org chart (accessibility
  requirement, Section 10), +/- zoom, 0 fit-to-view.

### 6.4 Org chart interactions (Board/Canvas template)

- Pan/zoom with fit-to-view and mini-map beyond 25 nodes; department filter tabs
  retained; collapse/expand subtree on manager nodes (essential once depth grows past
  the 4-rank visual assumption).
- Node affordances: hover reveals quick actions (chat with, view sessions, edit);
  context menu for add-report/reassign; **reassign `reportsTo` via drag or via a
  keyboard-accessible "Move under…" action in the context menu/inspector, both with
  explicit confirmation** ("Move Growth Scout under Lead Developer?") — structure
  edits are never silently committed, and every structural edit has a pointer-free
  path (WCAG target, Section 10).
- Live presence layer: subtle status ring (working / idle / failed) driven by the
  existing WebSocket feed; motion respects `prefers-reduced-motion`.

### 6.5 Kanban interactions

- Drag between columns with optimistic move + rollback; blocked column visually
  distinct (attention accent); WIP counts per column header; ticket card shows
  assignee avatar (employee), department color edge, and linked-session pulse when a
  session is actively working the ticket.

### 6.6 Approvals interactions

- Approve/reject always require the *content* to have been expanded at least once for
  destructive-class approvals (guard against blind approval); rejection requires a
  reason (routed back to the requesting session); bulk approve only for
  same-type, non-destructive items, behind a confirm.

---

## 7. State management and the async-state contract

### 7.1 The five-state contract

Every data surface must implement all five states, via shared primitives (Section 8):

1. **Loading** — skeleton mirroring final layout (never spinners for full pages).
2. **Empty** — icon + one-line explanation + primary next action ("No employees yet —
   Add your first employee" / "No approvals waiting — all clear").
3. **Error** — plain-language cause, Retry button, collapsible technical detail;
   distinct treatment for *gateway unreachable* (app-level banner, not per-widget).
4. **Partial/stale** — when the WebSocket drops, surfaces show a "Live updates paused —
   reconnecting" pill (backoff already exists in `ws-backoff.ts`; make it visible) and
   data is timestamped rather than silently stale.
5. **Populated** — the happy path.

### 7.2 Server-state conventions (TanStack Query — presentation only)

- Centralize all query keys in `lib/query-keys.ts` (exists — enforce exclusivity, and
  extend it with keys for the promoted domains it doesn't yet cover, e.g. Orchestration
  and Activity).
- Freshness policy per data class: live entities (sessions, approvals) are
  WS-invalidated; slow entities (skills, cron definitions) get sane `staleTime`;
  document the mapping in a short `packages/web/docs/data-freshness.md`.
- WebSocket events invalidate/patch query cache in one reconciliation module; no
  component subscribes to raw WS messages directly.

### 7.3 Mutations

Optimistic-by-default for low-risk, reversible actions (ticket move, theme change,
filter save); pessimistic with busy-state for approvals and org-structure edits.
Every mutation defines its rollback and its failure toast copy at the call site.

### 7.4 Client/UI state

- View preferences (filters, saved views, density, column sets, UTC, landing surface)
  persist per-user in `localStorage` under a versioned, namespaced schema
  (`fleetview.prefs.v1`), with a reset-to-defaults in Settings. Preferences sync
  across open tabs via the window `storage` event so a theme/UTC/density change in
  one tab never leaves siblings stale.
- URL is the source of truth for shareable state: active filters, selected entity
  (inspector), org department tab all serialize to query params so any view is a
  pasteable link.

---

## 8. Component system additions

Extend `components/ui/` (Radix + CVA, matching existing conventions):

- `EmptyState`, `ErrorState`, `StalePill` — the state-contract primitives.
- `DataView` composition: `Toolbar` (search, `FilterBar`, `SavedViews`, `DensityToggle`,
  `ColumnConfig`), virtualized `DataTable` (sortable, resizable, sticky header),
  `Inspector` shell.
- `StatusChip` — the single component allowed to render status colors (closed
  vocabulary in, token color out).
- `EntityLink` — renders any domain entity (employee, session, ticket…) as icon + name
  chip with hover card; the atom that makes cross-linking (Journey 3) cheap and uniform.
- `Timestamp`, `KpiTile`, `TriageChip`, `ShortcutSheet`, `ConfirmDialog` (exists —
  extend with consequence-naming slot).

Document each in a lightweight `packages/web/docs/components.md` (purpose, anatomy,
do/don't) — the style guide the repo currently lacks.

---

## 9. Visual and aesthetic guidelines

### 9.1 Direction

Keep and sharpen the existing identity: **"calm ledger, glass instrumentation"** — the
Apple-HIG-derived type/spacing scale and frosted-pill materials already in
`globals.css` / `pill-nav.tsx` are the brand. The plan systematizes rather than
restyles. The `/redesign` "Ledger Dock" mockup is treated as an idea source, then
deleted from DEV routes (design intent belongs in docs, not shipped dead code).

### 9.2 Tokens

Formalize the CSS-variable set into three layers — primitives (color ramps, type
scale, space scale, radius, blur, shadow) → semantic (`--surface-*`, `--text-*`,
`--accent-*`, `--status-*`) → component tokens. All 7 themes + system map onto the
semantic layer; new components may consume only semantic/component tokens. Contrast
gate: every theme's semantic pairs pass WCAG AA (4.5:1 text, 3:1 UI), verified by a
token-lint script in CI.

### 9.3 Typography and density

- Type scale as-is (HIG-derived); tabular numerals (`font-variant-numeric`) mandated
  for all metrics, tables, and timers.
- Two density modes, **Comfortable** (default) and **Compact** (analyst tables),
  implemented as a root data-attribute scaling row height/padding tokens only.

### 9.4 Color semantics (closed set)

- **Status:** running = accent-animated, success = green, failed = red, blocked/
  attention = amber, idle/queued = neutral, approval-pending = violet. Identical
  meanings on every surface; color never the sole carrier (icon/label always paired).
- **Department hues** (`deptHue`) remain the *identity* channel — used for edges,
  avatar rings, chart series — and are forbidden from overlapping the status set's
  semantic role.
- Data-viz follows the repo's dataviz conventions: single-hue ramps for quantity,
  department hues for categorical series, dark/light parity per theme.

### 9.5 Motion

Purposeful only: 120–200 ms ease-out for panels/popovers, presence pulses on org
nodes, streaming shimmer in chat. No decorative loops; everything honors
`prefers-reduced-motion`. Live-update rows flash-highlight once (300 ms) on change.

### 9.6 Iconography and voice

`lucide-react` only, 1.5 px stroke, one icon per vocabulary noun (registered in the
vocabulary module). Copy voice: plain, verb-first, no exclamation points; empty states
may be warm ("All clear"), errors never cute.

---

## 10. Accessibility and responsiveness

- WCAG 2.2 AA target. Full keyboard operability including the org chart (roving
  tabindex over nodes, arrow-key traversal of the hierarchy, announced as a tree).
- Visible focus rings on all interactive elements in all 7 themes (token-driven).
- Live regions: approval-count changes and session completions announced politely;
  streaming chat uses `aria-live` batching to avoid screen-reader flooding.
- Breakpoints: mobile (bottom tabs, single pane, inspector becomes bottom sheet),
  tablet (rail + content), desktop (rail + sidebar + content + inspector). Tables
  degrade to card lists below the tablet breakpoint rather than horizontal scroll.

---

## 11. Analyst customization features (standard-expectations checklist)

1. **Saved views** on every Queue/Table surface: named filter+sort+column sets,
   pinnable to the surface's tab strip; URL-serializable.
2. **Column configuration**: show/hide, reorder, resize; persisted per surface.
3. **Global filters**: by department, employee, engine, time range — a shared
   `FilterBar` grammar so filtering feels identical everywhere.
4. **Density toggle** (Section 9.3) and **UTC/local time toggle** (global).
5. **Landing surface preference**: Chat (default) or Command Center; plus the
   attention-aware auto-landing rule (Journey 1) as an opt-in.
6. **Export**: CSV/JSON export on every table, clearly labeled with applied filters
   and timestamp. Client-side from the queried set when the full filtered result is
   already local; on paginated/virtualized surfaces the export fetches the complete
   filtered dataset through the existing read API (never silently exporting only the
   loaded page), with a row-count preview before download.
7. **Theme** (exists) + accent/department-palette override for color-vision needs.
8. **Notification preferences** surfaced in Settings: which events badge, toast, or
   stay silent — per event class, not per page.

---

## 12. Phased implementation roadmap

Each phase is independently shippable; acceptance criteria (AC) gate progression.
No phase touches gateway/orchestration code — presentation and web-API-client only.

### Phase 0 — Foundations (vocabulary, tokens, state contract) — ~1–2 weeks
- Build `lib/vocabulary.ts`; sweep nav/titles/empty copy onto it. Route rename
  `/logs`→`/activity` with redirect.
- Formalize token layers; add contrast-lint script; tabular numerals.
- Ship `EmptyState`, `ErrorState`, `StalePill`, `StatusChip`, `Timestamp`,
  `EntityLink`; write `components.md`.
- **AC:** zero label drift across nav/route/title for all nouns; all 8 themes pass
  contrast lint; state primitives documented and adopted on ≥2 pilot pages
  (Approvals, Cron).

### Phase 1 — Shell and navigation — ~1 week
- Grouped nav (Work / Organization / Ops); Command Center and Orchestration in nav;
  `/file` demoted to contextual viewer; mobile tab swap (Approvals in).
- Global header strip with ⌘K trigger; shortcut sheet (`?`); g-then-key navigation.
- **AC:** every route reachable from nav or a breadcrumbed parent; palette navigates
  to all surfaces; keyboard map documented.

### Phase 2 — The state-contract sweep — ~2 weeks
- Apply five-state contract to every remaining surface; app-level gateway-offline
  banner; visible WS-reconnect pill; URL-serialized filters/selection.
- **AC:** per-surface audit checklist (5 states × N surfaces) fully green; killing the
  gateway during a demo produces the banner and per-widget stale treatment, never
  blank panes or uncaught errors.

### Phase 3 — Queue/Table system and analyst customization — ~2–3 weeks
- Build `DataView` (toolbar, virtualized table, inspector shell); migrate Approvals,
  Activity, Cron, Limits, Archive, Skills, Orchestration tabs onto it.
- Saved views, column config, density, export, global FilterBar.
- **AC:** an analyst can create, name, pin, and share (URL) a filtered view on
  Activity and Approvals; tables of 10k rows scroll at 60 fps; export reflects
  applied filters.

### Phase 4 — Organization and Kanban deepening — ~2 weeks
- Inspector pattern on org nodes and tickets; subtree collapse; mini-map; drag-to-
  reassign with confirmation; live presence rings; kanban optimistic drag + WIP
  counts; delegation blocks in chat cross-linking to org/sessions.
- **AC:** Journey 2 and Journey 4 executable end-to-end with keyboard-only and
  mouse-only paths; org chart usable (navigable, legible) at 100+ employees.

### Phase 5 — Command Center as attention hub — ~1–2 weeks
- Triage strip with deep links; KPI tiles on shared `KpiTile`; attention-aware
  landing preference; notification preference matrix in Settings.
- **AC:** Journey 1 (morning review) completes in under 60 seconds in a seeded demo
  org with pending approvals, one blocked ticket, and one failed cron.

### Phase 6 — Polish, accessibility, and hardening — ~1–2 weeks
- Full WCAG 2.2 AA audit + fixes; reduced-motion audit; responsive audit (tables→
  cards on mobile; inspector→bottom sheet); delete `/redesign` route after archiving
  its intent into docs; Playwright coverage for the five-state contract and the
  three anchor journeys (repo already has an e2e harness and showcase tooling).
- **AC:** axe-core clean on all surfaces in light+dark reference themes; anchor
  journeys covered by e2e; no console errors across a full navigation sweep.

---

## 13. Measurement and validation

- **Journey timings** as the north-star UX metric: time-to-triage (Journey 1),
  time-to-locate-a-session-from-a-ticket (Journey 3) — measured in seeded demo
  instances via the existing Playwright/showcase tooling.
- **State-contract audit sheet** kept in `packages/web/docs/` and re-run per release.
- **Label-drift lint**: CI check that nav labels, route paths, and page titles resolve
  through the vocabulary module.
- **Heuristic review** at each phase gate against Section 2's principles, recorded
  alongside the phase's ledger entry.

---

## Appendix A — Explicit non-goals

- No changes to delegation semantics, session lifecycle, engine adapters, connector
  behavior, or the gateway API's meaning (additive, presentation-driven API-client
  fields are in scope only if the gateway already exposes the data).
- No framework migration (stays Vite + React Router SPA); no component-library swap
  (stays Radix + Tailwind v4 + CVA); no visual rebrand — systematization of the
  existing "calm ledger / glass" identity.
