# 06 — Skills Lifecycle

Skills are reusable markdown playbooks shared across the org, managed via
the `cuttlefish skills` CLI and browsed at `/skills`. These scenarios cover
the full lifecycle — find, add, list, inspect, update — plus the part no
static test can see: whether an installed skill actually changes engine
behavior in a session.

---

### SK-01 — Find, add, list (happy path)
- Goal: install a skill the documented way.
- Category: happy path
- Preconditions: gateway running; network access for the skills registry/source.
- Steps:
  1. `cuttlefish skills find testing` — read the results.
  2. `cuttlefish skills add <package>` for one result.
  3. `cuttlefish skills list` — confirm it appears with sensible metadata.
  4. Open `/skills` in the dashboard — confirm the same skill shows there.
- Expected: find returns useful, readable results; add succeeds with a clear success message and file placement in the Cuttlefish home; CLI list and dashboard agree.
- Variations: `skills find` with no results (gibberish query) — graceful empty result, not an error; `skills find` with no arguments.

### SK-02 — Add seams: duplicates, unknowns, bad packages
- Goal: installation failure modes are polite.
- Category: invalid input / recovery
- Preconditions: SK-01 skill installed.
- Steps / Variations:
  1. `skills add` the same package again — expect idempotent success or a clear "already installed", never a corrupt duplicate.
  2. `skills add nonexistent-package-xyz` — clear not-found error.
  3. `skills add` with the network down (disconnect or bogus proxy) — a network error message, not a hang or a half-installed skill.
- Expected: after every failure, `skills list` still shows a consistent state.

### SK-03 — A skill actually changes behavior
- Goal: the org-wide-playbook promise: engines follow installed skills.
- Category: happy path
- Preconditions: a skill with an observable instruction (install one, or author a trivial local skill per the repo's documented skill format — e.g. "always end reports with the line SKILL-MARKER").
- Steps:
  1. Start a session on an engine and give a task the skill governs.
  2. Check the output for the skill's observable effect.
  3. Repeat on a *second* engine type if available (skills claim to be engine-agnostic).
- Expected: the skill's instructions demonstrably reach the engine's context and shape output on every engine that supports skills.
- Observe: if the effect doesn't appear, distinguish "skill not synced" from "engine ignored it" using whatever the UI/logs expose — the operator needs to be able to tell.

### SK-04 — Update and drift
- Goal: `skills update` refreshes without breaking local state.
- Category: persistence / settings
- Preconditions: at least one installed skill.
- Steps:
  1. `cuttlefish skills update`; read the report of what changed.
  2. Hand-edit an installed skill's markdown locally, then `skills update` again.
- Expected: update reports clearly (updated / already current); the behavior toward local edits is deliberate and stated (overwrite with warning, skip, or merge) — silent clobbering of a hand-edited playbook is a finding.
- Variations: update with the network down.

### SK-05 — Remove a skill in active use
- Goal: uninstall is clean even when the skill is referenced.
- Category: delete-undo
- Preconditions: SK-03's skill installed and demonstrably in use.
- Steps:
  1. Remove the skill (CLI or dashboard, whichever exists; if no removal surface exists, record that as a Note finding).
  2. Run the SK-03 task again — the marker behavior should be gone.
  3. Restart the daemon; confirm the skill stays gone from list and `/skills`.
- Expected: removal takes effect for new sessions; no dangling references crash `/skills`; in-flight sessions that already loaded the skill either finish under it or are handled deliberately.

### SK-06 — Dashboard `/skills` browsing seams
- Goal: the browsing UI holds up with real content.
- Category: navigation / boundary
- Preconditions: several skills installed, including one with long content and one with unusual characters in name/description (author a local one if needed).
- Steps: browse `/skills`; open each skill's detail view; hard-refresh a detail view; view after daemon restart.
- Expected: long markdown renders scrollable and intact; unusual names don't break lists or routes; deep links to a skill survive refresh.
