# Playtest — Theme System (post-audit theme commits)

**Date:** 2026-07-01
**Skill used:** `agent-skills/10_audit/audit-playtest-app` (exploratory playtest lens,
applied to the theme feature specifically rather than the whole app)
**Scope:** Commits after the last comprehensive audit (PR #10, merged `611a12b`,
`fix(command-center): repair 6 data/GUI-truth defects from the audit scan`):
- `bf5d5f0` — feat: enhance theme management and styling (introduces `signal-dark`,
  `signal-light`, `reef-light`, `reef-dark`; `--accent-bg`/`--accent-glow` gradient
  tokens; theme toggle on `/talk`)
- `337dada` — feat: update theme management and enhance UI styling across
  components (sweeps ~17 files onto `--accent-bg`/`--accent-glow`/`--accent-contrast`;
  changes the default/fallback theme from `signal-dark` to `reef-light`)
- `796b464` — add command status route and dashboard page (the `/command`
  Command Center screen these theme commits also touch)
**Branch:** `claude/audit-playtest-theme-32hfxe`
**Giles/Dory:** waived per `AGENTS.md`/`CLAUDE.md` (cloud/remote agent, no local
Giles/Dory install) and per explicit task instruction.

## Method

1. Read the theme system end to end: `lib/themes.ts`, `routes/providers.tsx`
   (`ThemeProvider`/`useTheme`), the FOUC-prevention inline script in
   `index.html`, and the full 8-theme token table in `routes/globals.css`
   (`--accent`, `--accent-bg`, `--accent-glow`, `--accent-contrast`,
   `--shadow-*`, `--inset-shine`).
2. Diffed `bf5d5f0` and `337dada` file-by-file against the current tree to see
   exactly what the "several commits" changed.
3. Launched the app for real: `pnpm install`, then `vite` dev server
   (`packages/web`) on `:5888`. The full gateway daemon (`pnpm dev` / port
   `8888`) requires an interactive `cuttlefish setup` that provisions real
   engine credentials and calls external services (npx skills fetch, engine
   CLI probing) — running that was out of scope for a sandboxed playtest per
   the skill's safety rails (no real credentials, lowest-risk run mode), so
   this pass exercised the **frontend only**, with `/api/**` calls intercepted
   by a Playwright mock (auth bypassed, empty/plausible JSON for lists) so the
   UI could be reached without a live backend. This is disclosed as a
   limitation, not hidden: **interactive workflows that require live gateway
   data (kanban board contents, org chart data, chat sessions, cron runs) were
   not exercised end-to-end.** What *was* exercised end-to-end: theme
   selection/persistence/cycling, the FOUC bootstrap script, the Settings
   "Appearance" theme+accent picker, the global error-boundary chrome, and
   every route's static theming (chrome, empty/error states) across all 8
   theme ids.
4. Screenshotted `/`, `/command`, `/kanban`, `/org`, `/settings`, `/talk` (plus
   `/cron`, `/archive` for two themes as a regression check) under all 8
   `ThemeId`s (`signal-dark`, `signal-light`, `reef-light`, `reef-dark`,
   `cuttlefish`, `dark`, `light`, `system`) and inspected them for hardcoded
   (non-token) colors, low-contrast text, and console/render errors.
5. Where a suspected contrast defect involved a CSS custom property, computed
   the actual WCAG relative-luminance contrast ratio from the exact hex values
   in `globals.css` rather than eyeballing screenshots alone, then confirmed
   visually with a targeted screenshot on the worst-case theme.
6. Ran `pnpm --filter @cuttlefish/web typecheck|lint|test` after patching.

## Scenario coverage

| # | Category | Status | Notes |
|---|---|---|---|
| 1 | First launch / empty state | Executed | FOUC script + `ThemeProvider` both default to `reef-light` (post-`337dada`); no theme flash observed. |
| 2 | Primary happy path (pick a theme in Settings) | Executed | `AppearanceSection` theme grid renders and switches correctly for all 8 themes once the auth/data gate is mocked past. |
| 3 | Invalid input | Executed (code read) | `providers.tsx` coerces any `localStorage` value not in `ALL_THEME_IDS` back to `reef-light` — verified by reading the coercion logic; a stale/garbage `cuttlefish-theme` value cannot wedge the UI. |
| 4 | Save/persistence | Executed | `localStorage.setItem('cuttlefish-theme', …)` on every `setTheme` call; confirmed via `addInitScript`-seeded reloads across all 8 themes. |
| 5 | Delete/undo | N/A | No delete concept for theme selection (Reset section clears via `localStorage.removeItem`, not exercised interactively this pass — code-read only). |
| 6 | Settings/preferences | Executed | `/settings` → Appearance section: theme grid + accent-color presets + custom hex input all screenshotted across themes. |
| 7 | Navigation across screens | Executed | 6 primary routes × 8 themes, 2 extra routes × 2 themes. |
| 8 | Close/relaunch | Executed | Fresh browser context per theme (equivalent to full relaunch) + explicit reload; theme persisted correctly every time. |
| 9 | Interrupted/failed workflow | Executed | Backend absent → every gated route's `AuthGate` correctly falls back to the `PairingScreen`; when a data hook received an unexpected shape, several pages correctly rendered a scoped inline error+Retry (kanban/org) — this is what surfaced the Command Center defect below. |
| 10 | Import/export | N/A | No file import/export in the theme surface. |
| 11 | Error recovery | Executed | Found and fixed a real crash-to-top-level-boundary defect (CMD-THEME-001 below). |
| 12 | Edge/boundary input | Executed | Checked every `ThemeId` including `system` (OS-driven) and the two legacy ids (`dark`, `light`) still shipped alongside the 4 new ones. |

## Findings

### CMD-THEME-001 — Command Center crashes the whole app on a partial/degraded API response (High, confirmed by execution, fixed)

`routes/command/page.tsx` read `data?.ticketCounts.blocked`,
`data?.ticketCounts[meta.key]`, `data?.summary.agents/agentsRunning/cronJobs/ticketsOpen`,
`data?.managers.map(...)`, and `data?.availableAgents.length` — each only
optional-chains the *first* property (`data?.`) and then does an unguarded
`.` access one level deeper. `CommandCenterResponse` is a required-fields TS
type, but nothing prevents a live degraded/partial JSON response (or, as
observed directly in this pass, any response object that doesn't carry every
key) from reaching the component. When it does, `CommandPage` throws
synchronously during render, is caught by the **top-level** `AppErrorBoundary`
in `main.tsx` (not a page-scoped boundary — Command Center has no local error
boundary the way Kanban/Org do), and the entire SPA — every route, not just
`/command` — degrades to the "Web UI needs a refresh" screen until a hard
reload.

Reproduction (observed): navigate to `/command` when the command-center API
response is missing `ticketCounts`/`summary`/`managers`/`availableAgents` →
`TypeError: Cannot read properties of undefined (reading 'blocked')` at
`CommandPage`, console shows `[AppErrorBoundary]` catching it, screen shows
"Web UI needs a refresh".

Fix: added the missing `?.` at each access site (`data?.ticketCounts?.[…]`,
`data?.summary?.agents`, `data?.managers?.map`, `data?.availableAgents?.length`,
etc.) — same defensive pattern already used for `data?.availableAgents ?? []`
a few lines away in the same file. No behavior change for well-formed
responses; degraded responses now fall back to `0`/empty instead of crashing
the app shell.

Files: `packages/web/src/routes/command/page.tsx`

### THEME-CONTRAST-001 — Five components hardcode `text-white`/`text-black` on `bg-[var(--accent)]` instead of `text-[var(--accent-contrast)]` (High, confirmed by WCAG math + screenshot, fixed)

The `337dada` sweep converted the overwhelming majority of
`bg-[var(--accent)] text-white`-style buttons to
`text-[var(--accent-contrast)]` (the per-theme token that's specifically
tuned for legible text on `--accent`), but missed five:

- `components/ui/emoji-picker.tsx:153` ("Set" button, custom avatar URL)
- `components/kanban/employee-picker.tsx:209` (assignee-picker avatar initial)
- `components/stt/whisper-download-modal.tsx:79` ("Download" button)
- `main.tsx:49` (top-level `AppErrorBoundary` "Refresh" button)
- `routes/chat/chat-page-error-boundary.tsx:26` (chat crash "Reload" button)

Computed WCAG contrast of literal white text against each theme's `--accent`:

| Theme | `--accent` | white-text contrast | verdict |
|---|---|---|---|
| dark | `#E0A33C` | 2.22:1 | fail |
| cuttlefish | `#12B8A6` | 2.49:1 | fail |
| signal-dark | `#16C6B2` | 2.15:1 | fail |
| signal-light | `#0EA394` | 3.14:1 | fail (normal text) |
| reef-dark | `#2FD3C2` | **1.87:1** | fail badly |
| light | `#926516` | 5.13:1 | pass (coincidentally) |
| reef-light | `#0D9A94` | 3.46:1 | marginal (matches intended token, which is white here) |

WCAG AA requires 4.5:1 for normal text (3:1 for large/bold UI text). White
text fails outright on 5 of 8 themes — worst on the flagship new `reef-dark`
theme at 1.87:1, which is close to invisible. This was directly observed: the
`main.tsx` `AppErrorBoundary` "Refresh" button (reachable any time a render
throws, including via CMD-THEME-001 above) rendered white-on-teal in
`signal-dark`/`cuttlefish` before the fix; after the fix, the same button
renders dark, clearly legible text on `reef-dark`'s bright mint accent
(screenshot-verified).

Black text (`whisper-download-modal.tsx`) fared better (7.5–11:1 on most dark
themes) but still undershoots AA on `light` (4.10:1 vs. the 4.87:1 the
theme's own `--accent-contrast` token targets) — a smaller but real
regression from the established pattern.

Fix: all five now use `text-[var(--accent-contrast)]`, matching the
convention already used in ~20 other call sites in the codebase
(`components/auth/pairing-screen.tsx`, `routes/talk/page.tsx`,
`routes/kanban/page.tsx`, `routes/org/page.tsx`, etc.).

### Investigated, not a defect — accent-color preset checkmark

`routes/settings/settings-page-sections.tsx`'s accent-color preset swatches
render `<Check color="var(--accent-contrast)" />` on the active preset. At
first glance this looked like the same class of bug (the swatch's background
is a fixed hex like `#EAB308`, not the theme's `--accent`, so the *theme's*
`--accent-contrast` token looked like the wrong reference point — checked
against all 12 presets, up to 1.82:1 for Yellow). This was investigated
further before patching: `settings-provider.tsx` sets
`document.documentElement.style.setProperty('--accent-contrast',
hexToContrastText(settings.accentColor))` (a real per-color relative-luminance
calculator, not a static token) whenever a custom `accentColor` is active —
and the checkmark only renders when `accentColor === preset.value`, i.e.
exactly when that inline override is in effect. So `--accent-contrast` is
already correctly recomputed per-swatch at the moment the checkmark shows.
Confirmed live: selecting "Yellow" on `reef-dark` renders a dark, clearly
legible checkmark. No change made — an initial attempted fix here was applied
and then reverted after finding `hexToContrastText`.

### Confirmed working correctly (no findings)

- `--accent-bg`/`--accent-glow`/`--accent-contrast` are defined for all 9
  theme selector blocks in `globals.css` (`:root`/`dark`, `light`,
  `cuttlefish`, `signal-dark`, `signal-light`, `reef-light`, `reef-dark`,
  `system`×2) — no missing-token fallback-to-transparent case.
  `chat-input-composer.tsx`'s send button, `create-ticket-modal.tsx`,
  `kanban/page.tsx`'s gradient CTAs all rendered correctly (gradient
  background + glow) across every theme screenshotted, including the
  reef themes' `linear-gradient` accent (Tailwind arbitrary `bg-[var()]`
  classes can't render a gradient, which is why these are inline `style`
  — confirmed intentional via the code comment and visual check).
- FOUC-prevention inline script in `index.html` and `ThemeProvider`'s
  `localStorage` fallback both agree on `reef-light` as of `337dada`
  (previously the two default values disagreed — inline script said
  `signal-dark`, provider fallback said `signal-dark` per the `bf5d5f0`
  commit message vs. a `dark` context default — that inconsistency is gone
  now).
- `providers.tsx` coerces invalid/stale saved theme ids back to `reef-light`
  instead of leaving `data-theme` unset or crashing.
- `talk/page.tsx`'s and `pill-nav.tsx`'s theme toggle/cycle logic correctly
  covers all 8 `ThemeId`s including `system`.
- `cli-terminal.tsx` and `file-view.tsx`'s dark/light palette resolution was
  correctly generalized from the old two-theme `attr !== "light"` check to
  `isLightTheme(attr)`, so the xterm palette and syntax-highlighter theme
  track the new theme families correctly.
- `pnpm --filter @cuttlefish/web typecheck|lint|test`: 0 errors, 0 lint
  warnings, 790/790 tests passing after the fixes above.

## Out of scope for this pass (disclosed, not silently skipped)

- Full interactive backend (`pnpm dev` + `cuttlefish setup`) was not stood
  up — it requires provisioning real engine credentials and outbound calls to
  fetch the skills CLI, which is out of scope for a sandboxed playtest per
  the skill's safety rails. Kanban board drag/drop, Org chart node
  interactions, live chat streaming, and cron execution under each theme were
  therefore **not** exercised with real data — only their empty/error/loading
  states were observed.
- A broader sweep for the same "second-level unguarded optional chain"
  pattern (`data?.x.y`) outside `command/page.tsx` was not performed; this
  pass fixed every instance found in the one file exercised live during
  playtesting, not a repo-wide static sweep. Recommended as a follow-up
  `audit-dataflow-integrity`-style pass if desired.
- Emoji rendering (e.g. the 🌑 "Ledger Dark" swatch appearing as a blank
  white circle in one screenshot) is a sandbox font-availability artifact
  (no network access to the Google-Fonts-hosted color-emoji font), not an
  app defect — not filed as a finding.

## Files changed

- `packages/web/src/routes/command/page.tsx` — 6 unguarded second-level
  optional-chain accesses fixed.
- `packages/web/src/components/ui/emoji-picker.tsx` — `text-white` →
  `text-[var(--accent-contrast)]`.
- `packages/web/src/components/kanban/employee-picker.tsx` — same.
- `packages/web/src/components/stt/whisper-download-modal.tsx` —
  `text-black` → `text-[var(--accent-contrast)]`.
- `packages/web/src/main.tsx` — same.
- `packages/web/src/routes/chat/chat-page-error-boundary.tsx` — same.

## Validation

```
pnpm --filter @cuttlefish/web typecheck   # 0 errors
pnpm --filter @cuttlefish/web lint        # 0 errors, --max-warnings=0
pnpm --filter @cuttlefish/web test        # 90 files / 790 tests passing
```

Root-level `pnpm build` (which also builds `cuttlefish-cli` and copies
`packages/web/out` into `packages/cuttlefish/dist/web`) was not run this pass
— the change set is web-only and covered by the web package's own
typecheck/lint/test; running the full monorepo build was judged unnecessary
for a frontend-only CSS/JS contrast and null-safety fix. Flagging this as a
residual/unrun check rather than silently omitting it.

## Summary

- **2 findings, both fixed:** CMD-THEME-001 (High — app-wide crash on a
  degraded API response) and THEME-CONTRAST-001 (High — 5 hardcoded-color
  regressions from the theme sweep, failing WCAG AA on 5–7 of 8 themes).
- **1 suspected finding investigated and correctly not fixed** (accent-preset
  checkmark) — documented so the reasoning isn't lost.
- Theme system otherwise fully wired: all 8 themes render correctly across
  every screenshotted route/state, tokens are complete, toggle/cycle logic
  covers all ids, persistence and FOUC handling both work.
