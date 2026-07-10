# `/redesign` archive — "Ledger Dock" concept

`/redesign` was a dev-only (`import.meta.env.DEV`-gated) single-file visual
mockup (`src/routes/redesign/page.tsx`, ~200 lines of JSX + an inline CSS-in-JS
string), used to explore a different shell layout before FleetView Phases 0–5
were scoped and built. It was never wired into production routing and carried
no real data. Removed in Phase 6 per the plan's own instruction (Section 12,
Phase 6: "delete `/redesign` route after archiving its intent into docs").

## What it explored

A denser three-pane "dock" shell, contrasted with the current wide sidebar +
single-thread layout:

- **Employee rail** (leftmost, icon-only, 64px) — one tile per agent, a
  working-state ring, an unread-count badge, and a `+` affordance at the
  bottom. Functionally similar to today's `NavRibbon`, but scoped to
  *employees* rather than app-wide navigation.
- **Per-agent chat list** (second pane) — once an employee tile is selected,
  a narrow list of that employee's chats/threads, each showing a title,
  snippet, and a running-state indicator.
- **Focused conversation pane** (main) — a single open thread, rendered with
  a byline per turn ("LEAD-DEVELOPER"), lightweight markdown (bold, inline
  code), and a "ran N tools · Ns" tool-execution summary line.
- **Command-bar input** — a single-line, icon-prefixed input pinned to the
  bottom of the conversation pane, with inline keybinding hints (⏎ send, ⌥⏎
  newline, `/` for commands, `@` to mention an agent) instead of a full
  toolbar.
- **⌘K switcher** (`?palette=1`) — a command-palette overlay grouped by
  "EMPLOYEES" and "CHATS", each row showing unread/state metadata and a
  keybinding hint, closable via `Esc`.
- **Two themes, one structure** (`?c=dark|light`) — the mockup proved the
  same "dock" layout could carry both a dark warm-ink palette and a light
  parchment palette without structural changes, only CSS custom-property
  swaps (`--ink`, `--surface`, `--accent`, etc.).

## Disposition

None of this was adopted wholesale — FleetView's actual shell (Phases 0–2)
kept the existing sidebar-based navigation rather than the dock's
employee-rail-plus-chat-list split, judging the existing chat sidebar
(`chat-sidebar.tsx`) already served the "per-agent chat list" role well
enough not to justify a structural rewrite. Two ideas from the mockup *did*
carry forward into the real implementation:

- The **command-bar keybinding-hints pattern** is echoed in the shell's
  keyboard-shortcut affordances (Phase 1, `global-shortcuts.tsx`).
- The **⌘K switcher** concept became the real, wired `GlobalSearch`
  component (Phase 1), grouped and keyboard-navigable in the same spirit as
  the mockup's palette overlay, but backed by live data instead of the
  mockup's hardcoded sample rows.

The tool-execution summary line and per-turn byline styling were not carried
forward; the current chat message rendering (`chat-messages.tsx`) already has
its own, independently-evolved tool-call and turn presentation that wasn't
judged to need the mockup's specific treatment.
