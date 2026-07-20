# 15 — Stress, Load, and Adversarial-but-Safe Seams

These cards push Cuttlefish the way an impatient fleet operator will:
many sessions, flapping config, full disks of history, racing UIs, and
recovery under load. They intentionally overlap surfaces covered in files
01–14 but change the *intensity* and *combination*. Prefer a disposable
home; cap engine spend with local models when possible; stop if the host
itself is unsafe (thermal, disk < 1 GiB free).

None of these scenarios are exploits. "Adversarial" means wrong order,
duplicate clicks, and hostile scheduling — not vulnerability research.

---

### SX-01 — Concurrent-run cap (`sessions.maxConcurrentRuns`)
- Goal: exhausting the gateway-wide concurrent-run cap fails new work with a retryable signal instead of queue corruption.
- Category: concurrency / boundary
- Preconditions: disposable home; set `sessions.maxConcurrentRuns` to a low test value (e.g. 2); restart; engines that can hold a run open (long prompt).
- Steps:
  1. Start two long-running sessions; confirm both run.
  2. Attempt a third via UI and via `POST /api/sessions`.
  3. Finish one; immediately start another.
- Expected: third create returns `429` with `retryAfterMs` (API) or an equivalent UI refusal; no half-created session rows; after a slot frees, new work proceeds.
- Observe: does the dashboard explain the cap, or only surface a generic error?

### SX-02 — Session stampede (20 short chats)
- Goal: a burst of short sessions leaves the gateway healthy and the session list coherent.
- Category: concurrency
- Preconditions: working engine (prefer local/cheap); cap concurrency reasonably if SX-01 is still at 2 — restore a higher cap first.
- Steps:
  1. Rapidly create ~20 sessions with distinct one-line prompts (scripted API or fast UI).
  2. Wait for all to terminal state.
  3. Restart daemon; count sessions; open five at random.
- Expected: all sessions accounted for (no silent drops, no duplicates with identical ids); history intact; `cuttlefish status` healthy; dashboard remains responsive enough to scroll the list.

### SX-03 — Multi-tab composer race on one session
- Goal: two tabs sending into the same session do not corrupt turn order.
- Category: concurrency
- Preconditions: one open session; two browsers/tabs.
- Steps:
  1. Send different messages from each tab within the same second ("TAB-A", "TAB-B").
  2. Refresh both; inspect full history.
- Expected: both messages appear exactly once in a defined order; no merged/garbled turns; at most one active engine run at a time per design (second may queue).

### SX-04 — Rapid model thrash under an active stream
- Goal: hammering the model/effort picker during a run cannot wedge the session.
- Category: interruption / settings
- Preconditions: multi-model engine; long-running prompt.
- Steps:
  1. Start a long task.
  2. Alternate models/effort as fast as the UI allows for ~10 seconds.
  3. Stop or let complete; send one clean follow-up on a chosen model.
- Expected: no crash; final selection is well-defined; follow-up runs; no zombie "running" state.

### SX-05 — Org YAML hot-edit while sessions are live
- Goal: rewriting employee files underfoot fails closed for the affected employee, not the whole gateway.
- Category: files / recovery
- Preconditions: live session as employee Riley; shell access to the disposable home `org/` tree.
- Steps:
  1. While Riley is mid-run, introduce a YAML syntax error into Riley's file.
  2. Observe `/org`, gateway logs, and the live session.
  3. Fix the YAML; confirm recovery without restart if hot-reload is designed, else after restart.
- Expected: gateway stays up; other employees unaffected; Riley shows a named config error; the in-flight session either finishes on the old in-memory profile or fails honestly — never applies a half-parsed persona.

### SX-06 — Large org chart navigation stress
- Goal: a crowded org remains usable.
- Category: navigation / boundary
- Preconditions: create ~30 disposable employees across several departments (scripted create API or duplicated YAML with unique ids); no need for all engines to work.
- Steps:
  1. Open `/org`; pan/scroll/search if available; open several detail panels.
  2. Rename a department with many members; switch workspace/department tabs.
  3. Load `/command` and confirm counts remain plausible.
- Expected: UI stays interactive; no multi-second freezes on every click; rename does not orphan employees; command-center counts match reality within documented semantics.

### SX-07 — Kanban dispatch storm
- Goal: many tickets dispatched close together do not double-run or cross-link sessions.
- Category: concurrency
- Preconditions: department board; 10 small tickets; working assignee; prefer `manualOnly` tickets so background workers do not surprise you.
- Steps:
  1. Create ten tickets with unique titles.
  2. Dispatch them back-to-back (or double-click a few).
  3. Inspect each ticket's linked session and terminal status.
- Expected: one session per successful dispatch; double-click does not create twin runs; ticket→session links remain 1:1; board stays consistent after refresh and restart.

### SX-08 — Cron stampede at the same minute
- Goal: multiple jobs due at once all fire without deadlock.
- Category: concurrency / recovery
- Preconditions: `/cron` with 5 jobs scheduled for the next 1–2 minutes (stagger if the UI forces unique times, or accept same-minute overlap); short prompts; cheap engine.
- Steps:
  1. Wait for the window; watch `/cron`, `/activity`, and session creation.
  2. Force one job's employee engine to be bad; leave others healthy.
- Expected: healthy jobs complete; bad job records a failure without blocking siblings; next scheduled times advance correctly; no permanent "running" cron row.

### SX-09 — Daemon restart under full active load
- Goal: restart during peak activity recovers to an honest world.
- Category: recovery / interruption
- Preconditions: ≥3 running sessions, ≥1 pending approval, ≥1 cron due soon, kanban ticket in progress if available.
- Steps:
  1. `pnpm cuttlefish restart` while work is live.
  2. On the dashboard, inventory every previously running session, approval, and ticket.
- Expected: no work silently continues as if nothing happened; interrupted sessions use the documented interrupted/failed conventions; pending approvals remain; no duplicate sessions spawned by recovery; operator can resume or abandon deliberately.

### SX-10 — WebSocket / live-tail reconnect flap
- Goal: flaky connectivity does not permanently desync the UI.
- Category: interruption / recovery
- Preconditions: a streaming session; browser devtools network throttle or offline toggle.
- Steps:
  1. Start a long stream; toggle offline for 5–10s; go online.
  2. Navigate away and back mid-stream.
  3. Confirm final transcript matches what `/activity` or export shows.
- Expected: UI reconnects or shows a clear disconnected state; no duplicated token spam after reconnect; completion state eventually converges with the server.

### SX-11 — Attachment and path boundary stress
- Goal: awkward files never escape policy or hang the gateway.
- Category: files / boundary
- Preconditions: test files — empty, 0-byte named `.png`, 40–50 MiB within policy if allowed, filename with spaces/unicode/`#`, symlink into a disallowed root (if safe to create inside the home), nested folder resource.
- Steps:
  1. Attach each via chat and via ticket resource fields where applicable.
  2. Attempt `/file` views on disallowed paths.
  3. For remote transfer (if remotes configured), attempt an oversize file (>50 MiB) and an off-allowlist destination.
- Expected: policy refusals are explicit; oversize remote transfer refused; symlinks do not punch through allowed roots; gateway memory stays reasonable (watch process RSS qualitatively).

### SX-12 — Export bundle of a heavy session
- Goal: run-bundle export works on a session with long history and several artifacts.
- Category: files / persistence
- Preconditions: a completed session with multi-turn history and ≥1 attachment/artifact.
- Steps:
  1. `POST /api/sessions/:id/bundle` or UI export.
  2. Inspect `run.json`, `summary.md`, `manifest.json`, `errors.json`, artifacts.
  3. Spot-check that secrets/tokens are absent.
- Expected: export completes; structure matches the documented layout; content matches the session; export of a still-running session fails or snapshots cleanly per design.

### SX-13 — Max tool calls and wall-clock budget enforcement
- Goal: execution budgets stop runaway agents.
- Category: boundary / recovery
- Preconditions: employee with low `execution.maxToolCalls` (e.g. 3) and/or a short `maxWallClock` / mid-pair deadline; task that would otherwise tool-loop.
- Steps:
  1. Dispatch a task likely to use many tools ("stat every file recursively and narrate").
  2. Watch for budget termination.
- Expected: session stops with a budget-related reason; does not continue tooling after the cap; parent mid-pair loop respects wall-clock when configured.

### SX-14 — Grok (or resume-id engine) stop then continue
- Goal: stopping a resume-id engine clears stale resume state so the next turn is clean.
- Category: interruption / recovery
- Preconditions: Grok engine signed in (or another engine with resume ids); otherwise Not executed — environment unavailable.
- Steps:
  1. Start a long Grok turn; stop/cancel mid-run.
  2. Immediately send a new message in the same session.
- Expected: next turn starts fresh (no restore of the terminated CLI session); no sticky error requiring a brand-new session unless documented.

### SX-15 — Feature-flag flip mid-flight (multi-role)
- Goal: disabling multi-role mid-run does not corrupt in-flight execution profiles.
- Category: settings / interruption
- Preconditions: multi-role enabled; a mid_pair run in progress; ability to set `features.multiRoleEmployeeExecution: false` and reload config/restart per product norms.
- Steps:
  1. Start mid_pair work.
  2. Disable the flag; restart or hot-reload as required.
  3. Observe the in-flight parent/children; start a *new* session on the same employee.
- Expected: in-flight work fails closed or finishes under the old in-memory plan without applying a hybrid protocol; new sessions run solo; no crash loops.

### SX-16 — Connector inbound flood (safe)
- Goal: a burst of inbound connector messages is queued or rate-limited without dropping the gateway.
- Category: concurrency / recovery
- Preconditions: test Slack/WhatsApp/SMS/IMAP sandbox; ability to send ~15 short messages quickly. No production workspaces.
- Steps:
  1. Flood the connected channel with numbered messages 1–15.
  2. Watch session creation, allowlist enforcement, and `/activity`.
- Expected: gateway stays up; allowlisted senders only; ordering is sensible or explicitly best-effort; secret-shaped text in replies is redacted; failures land in human-visible state.
- If no sandbox credentials: Not executed — environment unavailable.

### SX-17 — Knowledge outbox flush under load
- Goal: external knowledge export/flush remains optional and bounded.
- Category: persistence / concurrency
- Preconditions: knowledge sink configured to `jsonl` under the disposable home (not a production webhook).
- Steps:
  1. Generate several checkpoint decisions and completed sessions.
  2. Call outbox list + flush repeatedly.
  3. Break the sink path (rename directory) and flush again.
- Expected: flush is best-effort; core sessions still work when the sink fails; no unbounded retries wedging the event loop; bodies respect size limits.

### SX-18 — Orchestration hold thrash
- Goal: rapid hold/extend/cancel cycles leave leases consistent.
- Category: concurrency / interruption
- Preconditions: orchestration enabled; a live run long enough to hold; CLI or `/orchestration` hold controls.
- Steps:
  1. Start a run; create a hold; extend it; cancel it; create another.
  2. Concurrently attempt hold actions from a second operator tab if available.
- Expected: at most one coherent hold state; no leaked leases; run either remains held or resumes cleanly; unauthorized manager names fail per hold authorization rules.

### SX-19 — Pairing code brute-mistype (safe)
- Goal: wrong pairing codes fail closed without lockup.
- Category: invalid input / authorization
- Preconditions: auth enabled; valid pairing flow available.
- Steps:
  1. Generate a code; attempt 10 wrong codes from a second browser.
  2. Attempt the correct code once.
- Expected: wrong codes rejected quickly; no daemon CPU spin; valid code still works (or is invalidated with a clear "regenerate" message if rate-limited — either is acceptable if documented by behavior).

### SX-20 — Cross-screen consistency after chaos
- Goal: after the stress cards above, every major surface tells the same story.
- Category: navigation / recovery
- Preconditions: residual state from SX-01–SX-19 in the disposable home.
- Steps:
  1. Walk `/`, `/command`, `/talk`, `/kanban`, `/approvals`, `/activity`, `/orchestration`, `/cron`, `/limits`, `/org`, `/settings`, `/skills`, `/archive`.
  2. Pick three known entities (a session, a ticket, an approval) and verify each appears consistently wherever it is linked.
  3. Restart once more; spot-check the same three.
- Expected: no screen claims an entity another screen says is gone (unless intentional archive/delete); counts on `/command` are directionally right; no permanent spinners; console free of unhandled exceptions on navigation.

### SX-21 — Workspace profile injection under concurrent sessions
- Goal: workspace profiles isolate cwd/instructions when several profiles are used at once.
- Category: settings / concurrency
- Preconditions: ≥2 `workspaces.profiles` with distinct cwd + instructions inside allowed roots.
- Steps:
  1. Open two sessions on different profiles simultaneously; ask each "what is your working directory and first instruction line?"
  2. Confirm `transportMeta.workspaceProfile` (API) matches.
- Expected: no cross-profile instruction bleed; invalid profile id refused at create; explicit `cwd` override rules match docs when both are supplied.

### SX-22 — Home directory permission / disk-pressure degradation
- Goal: environmental pain produces named failures, not silent corruption.
- Category: recovery / error clarity
- Preconditions: ability to point `CUTTLEFISH_HOME` at a read-only directory or a tiny ramdisk (careful: keep this fully disposable).
- Steps:
  1. Start or run against a read-only home — attempt session create and settings save.
  2. If a small volume is available, fill it until writes fail; attempt a session message and a cron write.
- Expected: errors name the path or disk condition; no truncated YAML left as the only copy of an employee; recovering space + restart restores operations.
- Stop if the host system is at risk; mark partial execution honestly.

---

## Extended stress (SX-23–SX-32)

Additional load and recovery cards beyond the base stress set. Same safety
rails: disposable home, cheap engines when possible, no exploits.

### SX-23 — Hard kill of the gateway (`SIGKILL`) mid-work
- Goal: an unclean process death recovers to the same honest world as a graceful restart — or worse only in documented ways.
- Category: recovery / interruption
- Preconditions: ≥2 running sessions, ≥1 pending approval, a cron job due within a few minutes; shell access to the gateway PID.
- Steps:
  1. Note PIDs and in-flight entity ids.
  2. `kill -9` the gateway process (not child engines alone).
  3. Start the gateway again (`pnpm cuttlefish start` or service path).
  4. Inventory sessions, approvals, tickets, cron next-run times.
- Expected: start succeeds without manual home surgery; interrupted work is marked interrupted/failed (not still "running"); pending approvals remain decidable; no duplicate session ids; second start after a clean stop still works.
- Observe: difference vs graceful `stop`/`restart` (SX-09) — extra corruption here is High/Critical.

### SX-24 — Hundred-turn conversation bloat
- Goal: a single session with a very long history remains usable and exportable.
- Category: boundary / persistence
- Preconditions: cheap/local engine; ability to script ~100 short user/assistant turns (API loop preferred to avoid finger fatigue).
- Steps:
  1. Grow one session to ~100 turns with unique markers every 10 turns ("MARKER-n").
  2. Open it in the dashboard; scroll to top and bottom; send one more follow-up that references MARKER-1 and MARKER-50.
  3. Export a run bundle; restart; reopen.
- Expected: UI does not freeze indefinitely; history is complete or intentionally windowed with a clear cue; follow-up either uses history correctly or states limits honestly; export finishes without OOM; restart preserves the session.
- Variations: open the same fat session in two tabs while sending turn 101.

### SX-25 — Settings save thrash during active runs
- Goal: rapid settings writes do not tear config or kill in-flight engines.
- Category: concurrency / settings
- Preconditions: disposable home; several long-running sessions; `/settings` access.
- Steps:
  1. Start 3 long sessions.
  2. In `/settings`, flip harmless values (log level, a feature toggle you will revert, a non-port field) and save ~15 times as fast as the UI allows; interleave one invalid save (bad port) that must reject.
  3. Confirm sessions still stream or fail honestly; open `config.yaml` for torn writes; restart once.
- Expected: valid saves are atomic; invalid saves never leave a boot-breaking config; active sessions are not all cancelled unless a setting *requires* restart and the UI said so; post-restart config matches last good save.

### SX-26 — Skills install/update while agents are using skills
- Goal: skill tree mutations under load do not wedge the skills CLI or live sessions.
- Category: concurrency / files
- Preconditions: gateway running; at least one installed skill; a session whose prompt can invoke a skill; network if `skills add/update` needs it — otherwise update from a local package path.
- Steps:
  1. Start a session that depends on an installed skill.
  2. Concurrently run `cuttlefish skills update` (or add a second skill) from the CLI.
  3. List skills in UI and CLI; send a follow-up in the session.
- Expected: no corrupted skill manifest; CLI exits cleanly; session either keeps using the prior skill snapshot or reloads deliberately — not a half-extracted package; failed update is reversible with another update.

### SX-27 — Archive / delete parent while children still run
- Goal: destroying a parent session mid-delegation does not orphan children invisibly or crash the gateway.
- Category: delete-undo / concurrency
- Preconditions: manager fan-out in progress with ≥1 live child (see IA-01 / ORG-06 style setup).
- Steps:
  1. While children are running, archive the parent from the session list (and in a second trial, delete if the UI allows on non-terminal sessions).
  2. Watch children, `/activity`, and any ticket links.
  3. Restart; attempt to open parent from archive if archived.
- Expected: children are cancelled, completed-and-filed, or explicitly re-parented — and the UI says which; no forever-running orphans after restart; delete/archive of parent does not delete unrelated sessions.

### SX-28 — Dual-lane / worktree orchestration under dirty base
- Goal: orchestration apply/worktree guards hold when the base repo is dirty and workers race.
- Category: recovery / concurrency
- Preconditions: orchestration enabled; a matrix or dual-lane style run that uses git worktrees; a disposable git repo as cwd with an intentional uncommitted edit in the base.
- Steps:
  1. Dirty the base worktree (harmless file edit, uncommitted).
  2. Launch the smallest live orchestration that would apply or merge worker output.
  3. Observe refuse/apply behavior; attempt a second overlapping run.
- Expected: dirty-base apply is refused with a named reason (per dual-lane guards); no silent clobber of the operator's uncommitted work; overlapping runs do not corrupt worktrees; cleanup leaves no abandoned worktree pile beyond documented retention.

### SX-29 — Activity and limits pages under huge history
- Goal: operator flight-recorder surfaces stay responsive after a heavy stress pass.
- Category: navigation / boundary
- Preconditions: residual state from prior SX cards (dozens of sessions, failures, crons) or artificially generated activity.
- Steps:
  1. Open `/activity`; scroll/paginate to the oldest visible entries; filter/search if offered.
  2. Open `/limits`; switch any day/week/month windows; hard-refresh both routes.
  3. From `/command`, follow count links into kanban/org/cron and back.
- Expected: pages render within a few seconds on a normal dev machine; no browser tab crash; filters do not show other users' data (single-tenant home); empty providers still show empty states; navigation loops do not leak listeners (repeated visit stays stable).

### SX-30 — Board auto-dispatch vs. manual Run-now race
- Goal: manual-only and auto-dispatch paths cannot double-start the same ticket.
- Category: concurrency
- Preconditions: department board with background board-worker enabled for non-manual tickets; one ticket *without* `manualOnly`; one *with* `manualOnly: true`.
- Steps:
  1. On the auto ticket, spam "Run now" while the board worker might also pick it up.
  2. On the manual-only ticket, wait through a worker cycle (no auto start), then Run now once and double-click Run now.
- Expected: at most one session per ticket execution; manual-only never auto-starts; double Run now does not create twin sessions; ticket status matches the single linked session after refresh.

### SX-31 — Clock jump around cron and hold TTLs
- Goal: time warps do not schedule storms or permanent holds.
- Category: recovery / boundary
- Preconditions: disposable machine or VM where adjusting system clock is acceptable; a cron job; an orchestration hold with TTL if orchestration is on. Do not run on a host sharing critical timed jobs.
- Steps:
  1. Set a cron for ~5 minutes ahead; create a short TTL hold if available.
  2. Jump system clock forward 1 hour; observe cron fires and hold expiry.
  3. Jump clock backward 1 hour; observe next-fire and any duplicate runs.
  4. Restore correct time; restart gateway; confirm schedules re-normalize.
- Expected: at most a bounded catch-up (not thousands of catch-up runs); holds expire or remain consistent with TTL math; after restoring time, new schedules are sensible; failures are logged rather than wedging the scheduler.
- If clock changes are not allowed: Not executed — environment unavailable.

### SX-32 — Unicode and path-hostile identity storm in the org
- Goal: painful but legal names and paths do not break routing or storage.
- Category: boundary / files
- Preconditions: ability to create employees/departments/tickets with awkward strings in a disposable home.
- Steps:
  1. Create employees and departments using: combining characters, ZWJ emoji sequences, RTL names, names with `/\\:` , very long display names, and near-duplicate NFC/NFD spellings if the OS allows.
  2. Start sessions as two of them; assign kanban tickets; trigger one cross-request if services can be declared.
  3. Restart; reopen `/org` and each entity.
- Expected: either accept-and-round-trip or reject at create with a clear message — never create two files that collapse to one on disk; sessions route to the intended employee; dashboard does not blank; YAML on disk remains parseable.
- Avoid OS-illegal path characters if the platform rejects them; record platform-specific rejections as Pass when intentional.
