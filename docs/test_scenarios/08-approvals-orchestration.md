# 08 — Approvals, Human Checkpoints, and Orchestration

`/approvals` is the unified queue for pending approvals and human
checkpoints; `/orchestration` is the matrix-orchestration operations
surface (dry-runs, observe routes, leases, holds, recovery). The essence of
these features is *gating*: work pauses until a human acts. That gating is
exactly what unit tests can't experience — these scenarios do.

If `orchestration.enabled` is off in the test home, enable it for this file
(and note it); the troubleshooting docs say controls are disabled when the
runtime is unavailable — verify that disabled state renders honestly too.

---

### AP-01 — A checkpoint actually blocks (core gate happy path)
- Goal: work that requires approval waits, visibly, until approved.
- Category: happy path / interruption
- Preconditions: a flow configured to hit a human checkpoint / approval gate (per the human-checkpoints feature; use the smallest such flow the current build offers).
- Steps:
  1. Start the gated flow from its normal entry point (session, ticket, or orchestration op).
  2. Confirm the work *pauses* and an item appears in `/approvals` with enough context to decide (what, who, why).
  3. Approve it; watch the work resume and complete.
- Expected: nothing gated proceeds before approval; the queue item carries decision-grade context; approval resumes exactly the paused work (no restart-from-zero unless designed).
- Observe: is the requesting session's state honest while waiting ("blocked on approval", not "running")?

### AP-02 — Reject and the aftermath
- Goal: rejection is a real outcome, not an error.
- Category: delete-undo / recovery
- Preconditions: as AP-01.
- Steps:
  1. Trigger the gate again; this time reject/deny.
  2. Follow the requesting flow: what does the session/ticket show? Can the requester retry?
- Expected: the flow terminates or reroutes cleanly with the rejection recorded and attributed; no zombie "pending" item remains in the queue; retrying creates a *new* approval item.
- Variations: approve an item that has already been rejected in another tab (two-tab race) — one decision must win coherently.

### AP-03 — Approval queue survives restart and time
- Goal: pending gates persist.
- Category: persistence / relaunch
- Preconditions: at least one pending approval.
- Steps:
  1. Restart the daemon with the item pending.
  2. Confirm the item is still in `/approvals` and still approvable, and that approving it after restart still resumes the (also-persisted) paused work.
- Expected: the full pause/resume chain survives restart; nothing auto-approves or silently expires without saying so.

### AP-04 — Orchestration dry-run (provider-neutral, CLI + observe)
- Goal: the documented dry-run surface lets an operator preview a matrix orchestration without side effects.
- Category: happy path / files
- Preconditions: orchestration enabled; the CLI dry-run surface per `docs/orchestration` docs and the feature inventory.
- Steps:
  1. Run the smallest documented orchestration dry-run from the CLI.
  2. Read its output/plan; confirm via sessions/tickets/logs that *nothing* actually executed.
  3. Open `/orchestration` and the observe routes; confirm the dry-run is represented (or explicitly absent) per design.
- Expected: dry-run output is a comprehensible plan; zero engine runs, zero tickets, zero side effects in the home; observe surfaces and CLI agree.
- Variations: dry-run with an invalid spec/config — a named validation error, not a stack trace.

### AP-05 — A real orchestration run, observed live
- Goal: run the smallest real matrix orchestration and follow it on `/orchestration`.
- Category: happy path / concurrency
- Preconditions: AP-04 passed; working engines; smallest viable matrix.
- Steps:
  1. Launch the run.
  2. On `/orchestration`, follow lanes/roles/leases as they progress; open at least one underlying session from the operations view.
  3. Let it complete; verify the terminal state and outputs are reachable from the dashboard.
- Expected: live state matches reality (no lanes stuck "running" after their session finished); every element links to inspectable detail; completion is unambiguous.

### AP-06 — Hold and resume mid-orchestration
- Goal: the hold mechanism pauses safely and resumes where it left off.
- Category: interruption
- Preconditions: an orchestration long enough to catch mid-flight.
- Steps:
  1. Start the run; apply a hold from `/orchestration`.
  2. Confirm in-progress work quiesces per design and no *new* work starts.
  3. Release the hold; confirm resumption without duplicated or lost steps.
- Expected: hold semantics are visible and truthful; resume continues rather than restarts.
- Variations: restart the daemon *while held* — the hold must survive; killing an engine process while held must not un-hold anything.

### AP-07 — Recovery manifest is operator-gated
- Goal: the documented recovery contract — recovery requeue leaves work paused until explicitly resumed, and manifests are operator-reviewed.
- Category: recovery
- Preconditions: an orchestration interrupted uncleanly (kill the daemon mid-run, then start it).
- Steps:
  1. After restart, locate the recovery surface (manifest / requeued work) in `/orchestration`.
  2. Confirm the interrupted work is *paused*, not auto-resumed.
  3. Review the manifest; explicitly resume; follow to completion or clean failure.
- Expected: exactly the documented behavior — nothing self-resumes; the manifest gives the operator enough to decide; resuming works.
- Observe: if the operator instead wants to abandon the recovered work, is there a clean discard path?

### AP-08 — Orchestration disabled renders honestly
- Goal: the disabled state is a designed state, not a broken page.
- Category: settings / error clarity
- Preconditions: set `orchestration.enabled` off; restart.
- Steps: visit `/orchestration`; attempt any controls; check `/approvals` for orchestration-dependent items.
- Expected: controls are disabled with an explanation (matching the troubleshooting table), not dead buttons or console errors; re-enabling restores the surface.
