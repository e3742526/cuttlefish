# 18 — Orchestration Control Plane

These cards separate observation from mutation across scheduler CLI commands,
the live gateway, and `/orchestration`. They require explicit disposable task,
worker-config, database, git-repository, and Cuttlefish-home paths. Record
`taskId + coordinatorId`, lease/allocation ids, session ids, and before/after
checksums; a task title is never sufficient identity.

Run JSON commands with the source-checkout rule in `README.md`. Restore queue
state, cancel test holds, stop live sessions, and clean only worktrees created by
the card.

**CLI exposure gate:** the current source contains orchestration command
handlers, but the canonical `bin/cuttlefish.ts` does not register the
orchestration command groups. CP-01–CP-03 and CP-12 deliberately begin by
checking top-level help. Until registration lands, record that missing surface
as a Fail and the remaining CLI-only steps as Blocked; importing internal
handlers is module testing, not a user-facing CLI playtest. The live cards use
the implemented authenticated API and `/orchestration` dashboard controls.

---

### CP-01 — Worker discovery and allocation dry-run are inert
- Goal: explicit config produces a parseable allocation without touching live or durable state.
- Category: CLI / happy path / files
- Preconditions: minimal valid worker config with two distinct providers; valid uniquely marked task file; nonexistent disposable DB path; gateway state snapshot.
- Steps:
  1. Run `cuttlefish --help`; require `workers` and `scheduler`, then require their subcommand help to advertise the exact flags used below. If absent, record Fail and stop this card.
  2. Run `cuttlefish workers list --config-dir <dir> --json`; parse and record workers.
  3. Run `cuttlefish scheduler allocate <task> --config-dir <dir> --dry-run --json` twice.
  4. Compare outputs after removing documented volatile fields; inspect DB path, sessions, leases, worktrees, and telemetry.
  5. Repeat with unknown worker reference and malformed task JSON.
- Expected: valid runs are deterministic and create no DB/file/session/lease/worktree/telemetry side effects; invalid inputs fail non-zero with field-specific errors and no partial allocation.
- Observe: unavailable live engines must not affect the inert fake-worker allocation unless the explicit config says so.

### CP-02 — Scheduler simulation is deterministic and rejects illegal transitions
- Goal: in-memory allocation/release/heartbeat/expiry scenarios replay exactly.
- Category: CLI / boundary
- Preconditions: CP-01 CLI exposure gate passed; explicit worker config; scenario file covering allocate, heartbeat, release, and expiry at fixed logical times.
- Steps:
  1. Run `cuttlefish scheduler simulate <scenario> --config-dir <dir> --json` twice and diff canonical JSON.
  2. Reorder independent steps and confirm only causally affected output changes.
  3. Add duplicate release, heartbeat-after-release, unknown lease, and invalid timestamp steps one at a time.
- Expected: identical input yields identical output; state transitions are finite and inspectable; illegal steps return a named simulation error or explicit rejected event without mutating any durable scheduler path.
- Observe: wall clock and installed engine state must not leak into simulation results.

### CP-03 — Plan and observe/list commands do not create state
- Goal: planning and listing remain read-only even when handed a DB path that does not exist.
- Category: CLI / files / observability
- Preconditions: CP-01 CLI exposure gate passed; valid coordinator template/task; one absent DB path and one copy of a populated disposable orchestration DB.
- Steps:
  1. Run `scheduler plan` against the absent path; prove the DB was not created.
  2. Run `leases list` and `queue list` against the absent path; record empty/not-found contract.
  3. Run the same commands against the populated copy; checksum the DB, WAL, and SHM before/after.
  4. Compare CLI lists with authenticated observe APIs and `/orchestration`.
- Expected: plan/list never write or normalize the store; populated results agree by durable id and state across CLI/API/UI; absent-store handling is explicit and non-destructive.
- Observe: a list command must not trigger recovery, allocation expiry, or lease release as a hidden side effect.

### CP-04 — Live single-worker run owns and releases one lease
- Goal: the smallest live run maps task → allocation → lease → session → terminal result exactly once.
- Category: happy path / concurrency
- Preconditions: gateway with orchestration enabled; one healthy worker/engine; valid task within an allowed disposable cwd.
- Steps:
  1. Launch through the `/orchestration` run control or authenticated `POST /api/orchestration/run` with `mode: "single_worker"`; record returned ids.
  2. While running, cross-check `/orchestration`, status/leases/allocations APIs, and the underlying session.
  3. Let the run finish; poll for terminal run and released/terminal lease.
  4. Restart and query the same ids.
- Expected: exactly one live session and owned lease; heartbeat updates while active; terminal result truthfully reflects the session; the lease is released by the run's terminal path; durable history remains observable after restart without resurrecting work.
- Observe: raw prompt/output should be reachable only through the designated artifact surface, not generic scheduler telemetry.

### CP-05 — Blocked-resource continuation resumes once when capacity returns
- Goal: missing capacity creates durable paused work rather than loss or a retry storm.
- Category: recovery / persistence
- Preconditions: live runtime; task requiring an unavailable/exhausted worker; ability to restore that resource.
- Steps:
  1. Launch the task; record `blocked_resource`, missing roles, queue item, and continuation ids.
  2. Restart while blocked; confirm all records persist and no engine session exists.
  3. Restore one qualifying worker; observe the documented auto-resume trigger.
  4. Flap resource availability twice during resume and count sessions/continuation attempts.
- Expected: blocked state is durable and operator-readable; restoration resumes at most once; one session/lease serves the continuation; resource flapping cannot create duplicate work; failure becomes a retryable failed continuation rather than disappearing.
- Observe: board-originated work uses the board as backlog and should not be mistaken for this orchestration queue behavior.

### CP-06 — Global queue and per-task pause scopes do not bleed
- Goal: pause controls block only their documented scope and survive restart.
- Category: interruption / authorization / persistence
- Preconditions: two queued task/coordinator pairs A and B; authenticated operator; live runtime.
- Steps:
  1. Pause A through `/orchestration` or `POST /api/orchestration/queue/pause-task`; restore capacity and prove B may resume while A stays paused.
  2. Resume A; then pause the global queue and enqueue/restore capacity for both.
  3. Restart while globally paused; verify neither dispatches; resume globally.
  4. Replay each pause/resume and use an unknown task/coordinator id.
- Expected: task pause affects A only; global pause prevents all new dispatch; both persist as documented; resume releases eligible work once; replay/unknown ids are idempotent or return clear non-success without corrupting queue state.
- Observe: already-running leases follow the stated queue-pause contract and are not silently killed unless explicitly designed.

### CP-07 — Stopping a lease interrupts its mapped session, then releases normally
- Goal: lease stop respects session ownership instead of deleting a live lease underneath its runner.
- Category: interruption / recovery
- Preconditions: long-running CP-04-style lease and mapped session; second terminal lease fixture if available.
- Steps:
  1. Call the UI/CLI/API stop control for the running lease; watch session and lease together.
  2. Repeat stop while shutdown is settling; restart after terminal state.
  3. Call stop for an already-terminal mapped session/lease.
- Expected: running stop interrupts the Cuttlefish session first; the runner's terminal/finally path releases the lease; repeated stop does not double-release or create an error loop; terminal mapping releases immediately or reports already terminal coherently.
- Observe: unrelated leases and sessions remain active.

### CP-08 — Reviewer-family diversity policy is explicit
- Goal: `single_worker_with_review` does not silently choose the same provider family when policy forbids it.
- Category: boundary / recovery
- Preconditions: worker config with implementer plus distinct-family reviewer, and a second config with only same-family reviewer; live runtime.
- Steps:
  1. Run with distinct families; inspect `reviewPolicy.explanations`, allocations, and sessions.
  2. Run same-family-only with default policy; record blocked result and continuation.
  3. Enable `orchestration.sameFamilyReviewerFallback`; rerun the same task.
- Expected: distinct-family run selects independently; default same-family-only run blocks with a named explanation; explicit fallback allows the same-family reviewer and records that exception; no policy mode is inferred silently.
- Observe: UI and JSON output must agree on why a reviewer was selected or blocked.

### CP-09 — Architecture and local-heavy modes reject incompatible role plans
- Goal: mode-specific constraints fail before leases or worktrees are created.
- Category: invalid input / boundary
- Preconditions: valid task fixtures for `architecture` and `local_heavy`; snapshot durable/live state.
- Steps:
  1. Submit `architecture` missing each required role in turn: architect, implementer, independent reviewer, adversarial reviewer, QA.
  2. Submit a complete architecture task as the control.
  3. Submit `local_heavy` with editing/coding roles or a non-local/high-cost worker; then submit a valid local analysis task.
- Expected: invalid plans reject during validation/allocation with missing/incompatible role details and zero leases/sessions/worktrees; valid controls progress; local-heavy never routes editing work merely because a cheap worker is available.
- Observe: dry-run and live validation should agree on hard constraints.

### CP-10 — Dual-lane selection and clean apply preserve operator control
- Goal: two isolated implementations require one explicit winner and apply only its patch as unstaged changes.
- Category: happy path / files / concurrency
- Preconditions: clean disposable git repo; healthy OpenAI and Anthropic lanes; tiny task guaranteed to produce a diff; baseline commit/hash recorded.
- Steps:
  1. Run `dual_lane`; compare lane prompts, worktree paths, outputs, diffs, and selection manifest.
  2. Select one completed winner through `/orchestration` or authenticated `POST /api/orchestration/dual-lane/select`; inspect loser archive and worktree removal.
  3. Apply through the dashboard or `POST /api/orchestration/dual-lane/apply`; inspect base `git status`, diff, and commit history.
  4. Restart and inspect selection/apply history and raw artifacts.
- Expected: lanes receive identical prompts in separate worktrees; nothing applies before selection; selection is attributable; only winner diff becomes unstaged base changes; no commit is created; loser evidence is archived and loser worktree removed.
- Observe: this is the clean-path complement to SX-28's dirty-base refusal.

### CP-11 — Dual-lane replay, wrong winner, and patch conflict fail safely
- Goal: stale or contradictory selection/apply requests cannot clobber the base repo.
- Category: recovery / boundary
- Preconditions: completed dual-lane fixture copied into disposable repos for independent branches.
- Steps:
  1. Select winner A, then attempt winner B for the same ids; replay selection A.
  2. Attempt apply before selection where selection is required; use wrong task/coordinator ids and an empty-patch winner.
  3. Introduce a conflicting base edit after selection and attempt apply.
  4. Compare base bytes, worktrees, and manifest after every refusal.
- Expected: contradictory/stale/unknown/empty/conflicting operations refuse with named reasons; replay is idempotent or clearly already applied; failed operations do not partially change base files or discard the only recoverable lane evidence.
- Observe: the original operator dirty edit must remain byte-for-byte intact.

### CP-12 — Managed worktree create, diff, and cleanup are task-scoped
- Goal: public worktree commands affect only the requested task/lane and preserve user work.
- Category: files / delete-undo
- Preconditions: CP-01 CLI exposure gate passed and top-level help advertises `worktree`; disposable git repo with a clean base plus one unrelated existing worktree; valid task file.
- Steps:
  1. `worktree create` for lanes A and B; record resolved paths and git registrations.
  2. Make distinct edits; run `worktree diff` for each and compare isolation.
  3. Run cleanup for A; verify B and the unrelated worktree remain.
  4. Replay cleanup A; try an invalid lane/path-like task id and a task cwd outside a git repo.
- Expected: create paths are managed and task/lane-scoped; diffs never include sibling/base edits; cleanup removes only the exact managed target; replay/refusals do not broaden deletion scope.
- Observe: retain evidence of any cleanup refusal and move abandoned test worktrees to recoverable cleanup only after resolving exact paths.

### CP-13 — Corrupt orchestration store is quarantined; requeue stays paused
- Goal: store corruption produces an auditable recovery manifest rather than trusting partial state.
- Category: recovery / persistence / files
- Preconditions: stopped gateway; disposable populated orchestration DB with known continuation/hold records; backup; exact DB/WAL/SHM paths resolved.
- Steps:
  1. Corrupt only the disposable DB copy using the repository's test-safe method; start the gateway.
  2. Inspect status, recovery notices, quarantine sidecars, telemetry, and manifest contents.
  3. Requeue one parsed continuation through `/orchestration` or authenticated `POST /api/orchestration/recovery/requeue` using exact manifest/task/coordinator/manager values.
  4. Restart and prove it remains task-paused; explicitly resume it.
- Expected: corrupt DB/WAL/SHM are quarantined; runtime starts from an empty trusted store with `store_corrupt_recovered` evidence; requeue imports only the chosen parsed record and never auto-dispatches; explicit resume creates at most one run.
- Observe: a missing/changed manifest or unauthorized manager must reject without consuming the recovery evidence.

### CP-14 — Telemetry is bounded, redacted, and retention-aware
- Goal: scheduler history remains useful without becoming an unbounded prompt/output/path archive.
- Category: persistence / boundary / privacy
- Preconditions: disposable telemetry store; runs containing unique prompt, output, diff, cwd, header, credential-shaped, and environment markers; controllable timestamps/fixture compactor; boundary fixtures for terminal allocations (24 hours/1,000), internal events (24 hours/2,000), JSONL telemetry (90 days/10,000), and recovery notices (30 days/100 groups).
- Steps:
  1. Complete live runs, board dispatch, and dual-lane selection; inspect JSONL and summarized API/CLI stats.
  2. Search raw telemetry and recovery notices for every sensitive marker.
  3. Generate records around terminal-allocation, internal-event, JSONL, and recovery-notice retention/count boundaries; run normal compaction.
  4. Keep one allocation in running state during compaction.
- Expected: telemetry contains ids, provider/family/role/worker/disposition and bounded cost/timing data, but no raw prompt/output/diff/cwd/credential/header/env markers; old/excess terminal records compact at the stated time/count bounds while running allocations remain protected; summaries reconcile with retained raw records.
- Observe: artifact-view commands may expose authorized raw artifacts; their existence does not permit duplication into generic telemetry.
