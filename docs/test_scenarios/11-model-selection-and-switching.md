# 11 — Model Selection and Switching

Engine and model choice is where cost, quality, and continuity collide.
File `02` covers a basic mid-life switch (`CH-03`); this file goes deeper:
aliases, effort tiers, employee defaults vs. session overrides, HR
singleton profile rules, and honesty of the model label after a switch.
Do not re-run `CH-03` here — build on its preconditions if a prior pass
already left multi-engine state.

Feature anchors (source-grounded): session model alias expansion
(`sonnet`/`opus`/`haiku` for Claude only), employee engine/model/effort
on `/org`, same-engine fallback model field, HR singleton same-engine
model/effort persistence and `hr_singleton_profile_conflict` on engine or
cwd change, composer model/effort pickers, and `/limits` model-usage
visibility.

---

### MS-01 — Composer model picker honored on a fresh session
- Goal: the model shown in the composer is the model that actually runs.
- Category: happy path / settings
- Preconditions: gateway running; at least one signed-in engine with two or more selectable models (Claude with Sonnet + Opus, or Ollama with two local tags).
- Steps:
  1. Open `/`; start a new session; select engine A and model M1 explicitly.
  2. Send a short uniquely marked prompt; use persisted session metadata, activity, and engine invocation evidence as the authority. A model self-identification reply may be recorded only as secondary evidence.
  3. Switch the *same* new-session picker (or start another session) to model M2; send the same prompt.
- Expected: each response is attributable to the selected model; the UI model chip / session header never claims M1 while the run used M2 (or the reverse).
- Observe: does the session list or header retain the model after completion and after a hard refresh?

### MS-02 — Same-engine model switch mid-conversation (non-HR)
- Goal: changing model on an existing non-HR session affects the *next* turn only, with honest history.
- Category: settings / persistence
- Preconditions: a multi-turn session on engine A / model M1 with at least one completed reply.
- Steps:
  1. Using the session controls, switch model to M2 (same engine); send a follow-up that depends on prior context.
  2. Inspect history: earlier turns remain labeled as M1; the new turn as M2.
  3. Restart the daemon; reopen the session.
- Expected: next turn uses M2; prior turns are not rewritten; the switch survives restart as the session's current selection; context from M1 turns is still available to the engine when the engine supports resume/history.
- Variations: switch model while a turn is still streaming — expect either a deferred apply-on-next-turn or a clear refusal, never a half-applied hybrid turn.

### MS-03 — Effort tier changes (engines that support them)
- Goal: effort pickers only appear where supported, and the chosen tier is honored.
- Category: settings / boundary
- Preconditions: an engine that documents effort tiers (e.g. Claude / Kiro) and one that does not (e.g. a local Ollama model if available).
- Steps:
  1. On a supporting engine, select each effort tier in turn; send a tiny prompt each time.
  2. Switch to a non-supporting engine; confirm the effort control is hidden, disabled, or clearly no-op per design.
  3. For a supporting engine, change effort mid-session and send again.
- Expected: effort is visible only when meaningful; tier changes apply to the next turn; the UI never shows a tier the engine cannot run.
- Observe: does `/activity` or session metadata record the effort used?

### MS-04 — Claude model alias expansion (`sonnet` / `opus` / `haiku`)
- Goal: short Claude aliases expand before validation and produce a real session.
- Category: boundary / happy path
- Preconditions: Claude engine signed in; API or CLI path that accepts model strings (dashboard picker if it exposes aliases, or `POST /api/sessions` with `{ engine: "claude", model: "sonnet" }` from a disposable shell against the local gateway).
- Steps:
  1. Create a session with model `sonnet`; send a one-line prompt; confirm it runs.
  2. Repeat with `opus` and `haiku`.
  3. Create a session with a nonsense alias (`sonnettt`) and with a full canonical id already expanded.
- Expected: aliases expand to the documented canonical ids and run; invalid aliases fail with an "unknown model" style rejection before any engine process starts; full ids continue to work unchanged.
- Observe: does the dashboard later display the *expanded* id or the alias the user typed? Either is fine if consistent across list, header, and export.

### MS-05 — Employee default model vs. session override
- Goal: org employee defaults seed new sessions, and per-session overrides do not rewrite the employee YAML.
- Category: settings / persistence
- Preconditions: an employee (e.g. Riley) whose org YAML sets model M1; ability to pick M2 in the chat composer when starting as Riley.
- Steps:
  1. From `/org` or quick-chat, open a session as Riley with no override — confirm M1 is preselected and used.
  2. Start another Riley session, override to M2 for that session only; complete a turn.
  3. Open `/org`, inspect Riley's saved model; start a *third* Riley session with defaults again.
- Expected: step 1 uses M1; step 2 uses M2 without changing Riley's YAML default; step 3 still defaults to M1.
- Variations: change Riley's default in `/org` while a Riley session is open on the old model — next *new* session picks up the new default; the open session keeps its selection until the user changes it.

### MS-06 — HR singleton: same-engine model/effort switch succeeds
- Goal: the reusable HR thread honors explicit same-engine model and effort changes on the next queued turn.
- Category: settings / happy path
- Preconditions: `hr-manager` available; Claude (or whatever engine HR is bound to) signed in with at least two models or two effort tiers.
- Steps:
  1. Open the HR chat; note current model/effort; send a short advisory prompt.
  2. Change only model (same engine) or only effort; send another prompt.
  3. Hard-refresh and confirm the HR thread retained the new selection for the subsequent turn.
- Expected: the change is persisted before the next turn; HR continues in the same singleton thread; no `409` and no forced new session.
- Observe: is the new model/effort visible in the composer and in any session metadata after restart?

### MS-07 — HR singleton: engine or cwd change is rejected cleanly
- Goal: profile-breaking HR changes fail closed without corrupting the singleton thread.
- Category: invalid input / recovery
- Preconditions: MS-06 thread exists; a second engine signed in (or a second workspace root) so an engine/cwd change is selectable.
- Steps:
  1. Attempt to change HR's engine to a different engine family, or change the working directory / workspace profile on the HR thread.
  2. Observe UI and, if useful, the API response body.
- Expected: request is refused with a clear conflict (`409` / `hr_singleton_profile_conflict` at the API); the prompt is *not* written into the historical HR thread; the operator is steered toward a non-HR session for that profile.
- Variations: after the rejection, send a normal same-engine message — the HR thread must still be healthy.

### MS-08 — Local-engine model tags (Ollama / Kilo / Aider when present)
- Goal: local engines expose real local model inventories, not a stale hard-coded list.
- Category: settings / empty state
- Preconditions: at least one of `ollama`, `kilo`, or `aider` installed and listed by setup; otherwise mark Not executed — environment unavailable.
- Steps:
  1. In the engine/model picker, select the local engine; inspect the model list.
  2. If the local runtime has a second model tag, switch to it and run a tiny prompt.
  3. Stop the local runtime (e.g. quit Ollama) and try another turn.
- Expected: listed models match what the local runtime actually offers (or the gap is explained); a downed local runtime fails legibly rather than hanging the composer.

### MS-09 — Model label honesty after daemon restart and archive
- Goal: archived and restored sessions keep truthful model attribution.
- Category: persistence / recovery
- Preconditions: two completed sessions on different models.
- Steps:
  1. Note model labels in the active session list.
  2. Archive one session; open it from `/archive`; confirm model attribution.
  3. Restart the daemon; re-check active and archived labels and any exported run bundle's `run.json` / `summary.md` if export is handy.
- Expected: model identity never silently rewrites to "current default"; exports match what ran.
