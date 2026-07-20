# 04 — Kanban Boards and Ticket Dispatch

`/kanban` gives each department a ticket board with dispatch to employees,
a live session inspector, a recycle bin, and optimistic-save protection
(all listed features). These scenarios exercise the ticket lifecycle:
create → edit → dispatch → watch → complete/delete → restore.

---

### KB-01 — Create and edit a ticket (happy path)
- Goal: basic ticket CRUD on a department board.
- Category: happy path
- Preconditions: a department with at least one employee.
- Steps:
  1. Open `/kanban`; select a department board; create a ticket with title, description, and any priority/assignee fields offered.
  2. Reopen the ticket; edit the description; save.
  3. Drag the ticket between columns.
- Expected: the ticket appears instantly, edits persist on reopen, column moves stick after a page reload.
- Observe: the ticket card's time display (a listed feature) — is it correct and does it update sensibly?
- Variations: create with empty title; title of thousands of characters; emoji/non-Latin title; two tickets with identical titles.

### KB-02 — Manual dispatch to an employee and live inspection
- Goal: a ticket becomes real engine work, watchable live.
- Category: happy path / navigation
- Preconditions: KB-01 ticket; employee with a working engine. Note: dispatch is manual-only by design (listed feature) — automatic dispatch not occurring is *correct*.
- Steps:
  1. Dispatch the ticket to an employee.
  2. Open the ticket's live session inspector; watch the run.
  3. Cross-check via the ticket→session API surface (`/api/org/departments/:name/tickets/:id/session`) or the session list that the linked session is the same one.
- Expected: dispatch creates/links a session; the inspector streams the live run; ticket status reflects the run's progress and terminal state.
- Variations: dispatch the same ticket twice rapidly (double-click seam) — expect one run, not two; dispatch to an employee whose engine is unauthenticated — expect a legible failure on the ticket, not a stuck "dispatching".

### KB-03 — Ticket resource context
- Goal: resources attached to a ticket actually reach the engine (ticket resource context is a listed feature).
- Category: files
- Preconditions: a ticket; a small test file.
- Steps:
  1. Attach a resource/file to the ticket; write a description that requires reading it ("summarize the attached file").
  2. Dispatch; read the resulting session output.
- Expected: the engine demonstrably saw the resource content; the resource remains attached and viewable after the run and after a daemon restart.

### KB-04 — Optimistic save under conflict
- Goal: the optimistic-save protection (listed feature) protects rather than surprises.
- Category: concurrency / persistence
- Preconditions: one ticket; two browser tabs on the same board.
- Steps:
  1. Open the same ticket in both tabs.
  2. Edit the description differently in each; save tab A, then save tab B.
  3. Reload both tabs.
- Expected: no silent last-write-wins data loss without warning — the protection should surface a conflict or merge deliberately; final state is coherent and identical in both tabs after reload.
- Variations: edit in one tab while the daemon restarts, then save — the save should fail visibly and the user's typed text should not be lost by the UI.

### KB-05 — Recycle bin round-trip
- Goal: delete and restore behave (kanban recycle bin is a listed feature).
- Category: delete-undo / persistence
- Preconditions: a few disposable tickets, one with a linked dispatched session.
- Steps:
  1. Delete a plain ticket; find it in the recycle bin; restore it; confirm it returns to its column with fields intact.
  2. Delete the ticket that has a linked session; restore it; confirm the session link survives.
  3. Delete a ticket, restart the daemon, then restore.
  4. Permanently purge one (if offered) and confirm it is gone everywhere.
- Expected: restore is lossless (title, description, column, resources, session link); the bin survives restart; purge is explicit and final.
- Variations: delete then immediately restore repeatedly (rapid toggling); delete all tickets in a column and confirm the empty-column state.

### KB-06 — Board reload and cross-screen consistency
- Goal: the board agrees with the rest of the app.
- Category: navigation / persistence
- Preconditions: several tickets in various states, at least one dispatched.
- Steps:
  1. Hard-refresh `/kanban`; compare to pre-refresh state.
  2. Restart the daemon; recompare.
  3. Cross-check the dispatched ticket's status against the session list on `/` and the activity on `/activity` — one story, all screens.
- Expected: no ticket duplication/loss on refresh or restart; ticket status, session status, and activity log tell the same story.
