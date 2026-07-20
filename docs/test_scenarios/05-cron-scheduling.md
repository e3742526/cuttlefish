# 05 — Cron and Scheduled Jobs

"Works while you sleep" is a headline promise: hot-reloadable cron schedules
that run background jobs and route output through the org. These scenarios
verify jobs can be created, fire on time, reload without a restart, fail
legibly, and survive the daemon lifecycle. Use short intervals (every
minute where allowed) so a pass completes in reasonable wall-clock time.

---

### CR-01 — Create a job and watch it fire (happy path)
- Goal: schedule a small job and observe an actual firing end to end.
- Category: happy path
- Preconditions: gateway running; a working engine; `/cron` open.
- Steps:
  1. Create a job with the shortest allowed interval and a trivial prompt ("write one line noting the current run").
  2. Note the displayed next-run time.
  3. Wait past the boundary; find the resulting run/session and its output.
- Expected: the job fires within the expected window; the run is attributed to the job; output lands where the UI says it will (e.g. a session owned by the configured employee/COO); next-run time advances.
- Observe: timezone sanity — does the displayed next-run match wall clock?

### CR-02 — Schedule input seams
- Goal: the schedule editor rejects nonsense clearly.
- Category: invalid input / boundary
- Preconditions: `/cron` job editor open.
- Steps / Variations (each a save attempt, if the editor takes cron expressions or equivalents):
  1. Malformed expression (`* * *`, `99 * * * *`, letters in numeric fields).
  2. Valid-but-extreme: every-minute vs. Feb-30-style impossible dates vs. a schedule far in the future.
  3. Empty prompt/task body; extremely long prompt.
  4. Duplicate job names.
- Expected: invalid schedules rejected at save with a message naming the problem; impossible schedules never show a bogus next-run; empty task bodies blocked or explicitly allowed by design.

### CR-03 — Hot reload without restart (headline feature)
- Goal: verify schedules are hot-reloadable as advertised.
- Category: settings / persistence
- Preconditions: CR-01 job exists and is firing.
- Steps:
  1. Without restarting the daemon, edit the job's schedule and prompt (via the UI; additionally via the underlying config/file if that's a documented path).
  2. Confirm the next firing uses the new schedule and new prompt.
  3. Pause/disable the job; wait through a boundary; confirm no firing; re-enable.
- Expected: edits take effect without `cuttlefish restart`; disable genuinely suppresses firing; re-enable resumes with a correct next-run.
- Variations: edit the job *while it is mid-run* — the running instance should finish under the old definition or be handled deliberately, and the UI should not double-fire.

### CR-04 — Missed schedules across downtime
- Goal: what happens to firings that "should have happened" while the daemon was stopped.
- Category: interruption / recovery
- Preconditions: an every-minute job.
- Steps:
  1. Stop the daemon for at least 3 firing windows.
  2. Start it; watch the job's behavior in the first minutes.
- Expected: deliberate behavior, visible to the user — either skipped-with-record or a single catch-up run; **not** a burst of N stacked runs, and not silent schedule drift.
- Observe: does the job's history/last-run display account for the gap honestly?

### CR-05 — Failing job is legible and contained
- Goal: a job whose runs fail doesn't wedge the scheduler.
- Category: recovery / error clarity
- Preconditions: a job routed to an unauthenticated engine, or with a prompt guaranteed to fail.
- Steps:
  1. Let it attempt 2–3 firings.
  2. Inspect the job's status, run history, and `/activity`.
  3. Confirm other jobs keep firing during the failures.
- Expected: each failed run is recorded with a reason; the job shows a failing status rather than pretending success; sibling jobs unaffected; no unbounded retry storm.

### CR-06 — Job lifecycle: delete and restart survival
- Goal: cron state persists and deletion is final.
- Category: delete-undo / persistence
- Preconditions: at least two jobs, one disposable.
- Steps:
  1. Delete the disposable job; wait through its old boundary — no firing, no ghost in history views.
  2. Restart the daemon; confirm surviving jobs are intact (schedule, prompt, enabled state, history) and the deleted one is still gone.
- Expected: deletion takes effect immediately and permanently; restart loses nothing else.
- Variations: delete a job *while its run is executing* — the in-flight run should terminate or complete deliberately, with the outcome recorded somewhere findable.

### CR-07 — Output routing through the org
- Goal: the promised pipeline — background job output routed through the COO for review — is observable.
- Category: happy path / navigation
- Preconditions: a job configured to route output to a reviewing employee (per current design; if routing is fixed to the COO, use that).
- Steps:
  1. Let the job fire with a prompt that produces a short deliverable.
  2. Follow the output: job run → owning session → COO/review surface (→ connector, only if a sandbox connector is configured; see file 07).
- Expected: each hop is discoverable from the previous one in the UI; the operator can reconstruct "what ran last night and where its output went" without reading server logs.
