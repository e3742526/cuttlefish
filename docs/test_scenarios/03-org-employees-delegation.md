# 03 — Org, Employees, Hierarchy, and Delegation

The org chart is Cuttlefish's differentiator: named employees with personas,
ranks, departments, and a real reporting hierarchy, edited either in the
`/org` dashboard panel or directly as YAML in `~/.cuttlefish/org/`. These
scenarios cover building the org, breaking it gently, and confirming
delegation actually flows down the chart and results flow back up.

---

### ORG-01 — Create an employee via the dashboard (happy path)
- Goal: add a new AI employee end to end from `/org`.
- Category: happy path
- Preconditions: gateway running; at least one signed-in engine.
- Steps:
  1. Open `/org`; use the agent create/edit panel to create "Riley — QA Engineer", pick engine, model, effort, department, and a manager in the hierarchy.
  2. Save; find Riley in the org view.
  3. Start a chat session as Riley; confirm the persona/role shows up in behavior or system context.
- Expected: the employee appears immediately in the org chart under the right manager and department; a session routed to Riley uses Riley's configured engine/model.
- Observe: does the saved employee exist as a readable YAML file under the Cuttlefish home's `org/` directory, matching what the panel shows?

### ORG-02 — Edit an employee and verify the change bites
- Goal: edits (rank, engine, model, persona text) take effect on the next session.
- Category: settings / persistence
- Preconditions: ORG-01 employee exists.
- Steps:
  1. Change Riley's model and persona wording via the panel; save.
  2. Restart the daemon.
  3. Start a fresh session as Riley.
- Expected: the new model is used and visible; the edit survives restart; no duplicate employee appears from the edit.
- Variations: edit the same employee simultaneously in two browser tabs and save both — last-write behavior should be coherent, not a merged corruption.

### ORG-03 — Hand-edited YAML (the documented power path)
- Goal: the "they're just files you can read and edit" promise holds.
- Category: files / invalid input / recovery
- Preconditions: gateway running; disposable org.
- Steps:
  1. Copy an existing employee YAML to a new file, change name/role, save; check whether/when it appears in `/org` (hot reload vs. restart — note which).
  2. Introduce a YAML syntax error into one employee file; observe dashboard and gateway logs.
  3. Create a YAML that references a nonexistent manager and one that references a nonexistent engine.
- Expected: valid hand-added employees are picked up; a broken file disables that employee with a visible, named error — it must not take down the whole org page or the gateway; dangling manager/engine references are surfaced, not silently accepted.
- Observe: does the dashboard ever *overwrite* hand edits without being asked?

### ORG-04 — Employee create/edit input seams
- Goal: the org panel tolerates messy input.
- Category: invalid input / boundary
- Preconditions: `/org` open.
- Steps / Variations (each a save attempt):
  1. Empty name; whitespace-only name; duplicate name; same name different casing.
  2. Very long name and persona (thousands of characters); emoji and non-Latin names ("Zoë 🦑", "田中").
  3. Persona containing YAML-significant characters (`:`, `-`, quotes, newlines).
  4. Department that doesn't exist yet — is it created, rejected, or a dropdown-only field?
- Expected: required fields validated with clear messages; duplicates either rejected or disambiguated deliberately; special characters round-trip to the YAML file and back without mangling.

### ORG-05 — Delete an employee who has history
- Goal: removing a person with sessions, tickets, or reports doesn't corrupt anything.
- Category: delete-undo
- Preconditions: an employee with at least one session and (if kanban is in use) one assigned ticket; ideally with a subordinate in the hierarchy.
- Steps:
  1. Delete the employee from `/org`.
  2. Check: their past sessions (readable? attributed to whom?), their tickets, their subordinates' place in the chart.
  3. Restart and re-check.
- Expected: deletion warns about or handles dependents; history remains readable with a tombstone/former-employee attribution rather than crashing; subordinates are re-parented or flagged, not orphaned invisibly.
- Variations: delete then immediately recreate the same name — old history must not silently graft onto the new employee unless that's the designed behavior.

### ORG-06 — Delegation down the chain (core differentiator happy path)
- Goal: a manager breaks a task down, fans out to reports, and synthesizes results.
- Category: happy path / concurrency
- Preconditions: a three-level org (e.g. COO → manager → two reports), all on working engines; a task that naturally splits ("compare approach A and B; have one report research each, then summarize").
- Steps:
  1. Give the task to the COO in a chat session.
  2. Watch for child sessions being spawned; open them live.
  3. Wait for the synthesis to return to the COO's session.
- Expected: child sessions are visibly linked to the parent (attribution: who delegated what to whom); children report back; the parent's final answer reflects the children's work; the multi-role execution rules (a listed feature) are observable.
- Observe: can the user follow the chain from the parent session without guesswork? What happens in the parent if it must wait — honest "waiting on Riley" state or opaque silence?

### ORG-07 — Delegation with a broken link in the chain
- Goal: delegation fails partially and legibly, not totally and silently.
- Category: recovery / interruption
- Preconditions: same org as ORG-06, but one report's engine unauthenticated or its process killable.
- Steps:
  1. Repeat the ORG-06 task.
  2. Mid-run, kill one child session's engine process (or rely on the unauthenticated engine failing).
- Expected: the failed child is marked failed; the manager either compensates, retries, or reports the gap upward — the parent's final answer must not claim work that never happened; the healthy sibling's work survives.
- Variations: stop the *parent* session while children are still running — what happens to the children (orphaned? cancelled? completed-and-filed)? Whatever the design, the UI must say.

### ORG-08 — `/talk` multi-agent session
- Goal: the multi-agent talk surface works as a user-facing conversation.
- Category: happy path / navigation
- Preconditions: two or more employees on working engines.
- Steps:
  1. Open `/talk`; start a talk session with two employees on a shared topic.
  2. Let a few turns run; then reload the page mid-conversation (rehydration/reconnect is an implemented surface).
  3. Restart the daemon and reopen the talk session.
- Expected: turns attribute clearly to each participant; reload reconnects and rehydrates the transcript (persisted dock labels and dismiss tombstones are listed features — dismissed docks should stay dismissed); restart preserves the session.
- Variations: change an employee's engine/model from `/org` *between* talk turns; dismiss a participant dock, reload, confirm it stays dismissed.

### ORG-09 — Workspace profiles and cross-department requests
- Goal: the workspace-profile and cross-department service-request features (listed in the feature inventory) behave from the operator's seat.
- Category: settings / navigation
- Preconditions: two departments with at least one employee each.
- Steps:
  1. Exercise the workspace-profile switch (if exposed in the UI) and confirm what changes with it.
  2. Trigger a cross-department service request (department A's employee needs department B); follow it to resolution.
- Expected: the request is visible on both sides, attributable, and completes or fails with a trace the operator can follow.
- If either surface is not reachable from the UI in the current build, record as Not applicable with the evidence (where you looked).
