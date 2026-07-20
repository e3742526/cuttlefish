# 09 — Settings, Files, Limits, Activity, and Cross-Screen Consistency

The surfaces that make Cuttlefish trustworthy day-to-day: settings that
persist, files that stay where policy says, usage that reads truthfully,
and screens that agree with each other. Several scenarios here are
deliberately cross-cutting — they re-check state created by earlier files.

---

### ST-01 — Settings persistence sweep
- Goal: every settings category survives save → reload → daemon restart.
- Category: settings / persistence
- Preconditions: gateway running; earlier files' state available.
- Steps:
  1. In `/settings`, walk each section (gateway, engines, connectors, email, features/orchestration). Change one harmless value per section; save each.
  2. Hard-refresh; verify every change held.
  3. `pnpm cuttlefish restart`; verify again.
  4. Revert everything; verify the reverts also stick.
- Expected: zero silently-dropped settings; saves confirm visibly; no section's save clobbers another section's values.
- Variations: navigate away from `/settings` with unsaved changes — expect a warning or an explicit, consistent discard behavior; save the same form twice rapidly.

### ST-02 — Settings input seams
- Goal: settings validation catches wrong-typed and out-of-range values.
- Category: invalid input / boundary
- Preconditions: `/settings` open; disposable home.
- Steps / Variations (each a save attempt):
  1. Port fields: letters, `0`, `-1`, `65536`, `99999`, another process's port.
  2. Numeric limits/intervals: `0`, negative, absurdly large, decimals where integers expected.
  3. Text fields: leading/trailing whitespace (does it get trimmed?), very long values, unicode.
  4. Credential-shaped fields (IMAP password etc.): wrong values must produce runtime errors that are visible, and the values must never be echoed back into logs/UI in plaintext.
- Expected: invalid values rejected at save with field-level messages; nothing invalid reaches `config.yaml` in a way that breaks the next boot (cross-check LC-08).

### ST-03 — File upload, viewer, and policy edges
- Goal: the gateway files API and `/file` viewer behave with real files and honor allowed-roots policy.
- Category: files / boundary
- Preconditions: gateway running; test files: `.txt`, `.md`, `.png`, `.zip`, an empty file, a ~10–50 MB file, a file named `weird name (α) #1.txt`.
- Steps:
  1. Upload each via the normal UI path; open each in `/file`; download one back and diff it against the original.
  2. Attempt to view a path *outside* the allowed roots via the `/file` route's address bar (e.g. a system file path) — safe-input policy check, expect refusal.
  3. Delete an uploaded file (if offered); confirm viewer and any referencing sessions degrade gracefully.
  4. Restart the daemon; confirm uploads persist and remain viewable.
- Expected: round-trip integrity; text renders, images render, binaries offer download rather than garbage; out-of-root reads refused with a policy message (the documented constraint) — refusal, not a blank page.

### ST-04 — Exportable run bundles and knowledge export
- Goal: export surfaces produce usable artifacts (exportable run bundles and external knowledge export are listed features).
- Category: files / persistence
- Preconditions: a completed session/run with some substance.
- Steps:
  1. Export the run bundle via its documented surface; inspect the artifact's contents (readable, complete, matches the session).
  2. Exercise the knowledge export/lookup surface with a small entry; then look it up.
- Expected: exports contain what the UI implies, open cleanly, and contain no secrets (spot-check for tokens/credentials — their presence is a Critical finding to report, not to exploit).
- Variations: export a session that is still running; export an archived session.

### ST-05 — `/limits` truthfulness
- Goal: usage/rate-limit visibility reflects actual usage.
- Category: navigation / error clarity
- Preconditions: several engine runs completed this pass (files 02–05).
- Steps:
  1. Note `/limits` before and after a burst of a few sessions.
  2. Compare against any engine-native usage surface available; check the Kiro estimated-credit gauge caveat renders as an *estimate* if Kiro is configured.
- Expected: numbers move in the right direction and timeframe; empty state renders when a provider reports nothing (a listed feature); estimates are labeled as estimates.

### ST-06 — `/activity` as the operator's flight recorder
- Goal: the activity/log surface lets an operator reconstruct what happened without shell access.
- Category: navigation / recovery
- Preconditions: a pass's worth of activity, including at least one failure (from CH-07, CR-05, or similar).
- Steps:
  1. Open `/activity`; find the known failure; confirm the entry carries enough to diagnose (what, when, which session/job).
  2. Filter/search if offered; paginate/scroll deep into history.
  3. Confirm `/logs` still redirects here.
- Expected: known events are findable; failures are not sanitized into invisibility; deep history doesn't hang the page.

### ST-07 — Remote pairing round trip
- Goal: `cuttlefish pair` / `unpair` and the pairing-code panel work.
- Category: happy path / settings
- Preconditions: a second browser (or private window) to act as the remote.
- Steps:
  1. `pnpm cuttlefish pair`; use the code/URL in the second browser; confirm it gains dashboard access.
  2. `pnpm cuttlefish unpair --json`; confirm the JSON output is well-formed and the second browser loses access (on next request or per design).
  3. Try a stale/wrong pairing code — clean rejection.
- Expected: pairing is a deliberate, observable grant; unpair actually revokes; codes are single-purpose and expire per design.

### ST-08 — Cross-screen consistency sweep (capstone)
- Goal: one reality, every screen — the single strongest signal only playtesting can produce.
- Category: navigation / cross-screen consistency
- Preconditions: end of a pass, with state accumulated from all earlier files.
- Steps: pick three entities created this pass — one session, one ticket, one cron job — and audit every screen that mentions each: `/`, `/command`, `/kanban`, `/approvals`, `/activity`, `/archive`, `/limits`, `/org`, `/orchestration`.
- Expected: names, statuses, timestamps, and counts agree everywhere; the `/command` command-center overview (a listed feature) summarizes the same totals the detail screens show; nothing exists on one screen but not its siblings.
- Observe: stale caches after all the restarts this pass performed — anything requiring a hard-refresh to become truthful is a finding (Medium by default).

### ST-09 — Browser-level seams
- Goal: normal browser behavior doesn't break the app.
- Category: navigation / boundary
- Preconditions: any accumulated state.
- Steps / Variations:
  1. Back/forward through a deep navigation trail (10+ hops), including into and out of a live session.
  2. Open the dashboard in three tabs; act in one; watch propagation in the others.
  3. Narrow the window to phone width and back (layout must remain operable — visual polish is out of scope, operability is not).
  4. Keyboard-only pass over the primary chat flow: Tab/Enter to reach composer, send, and navigate — accessibility-adjacent operability check.
- Expected: history navigation never produces broken shells or duplicate submissions; multi-tab state converges; the primary flow is completable without a mouse.
