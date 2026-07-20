# 17 — Operations and Durable Data Lifecycle

These cards cover operator-facing boundaries that were previously spread across
smoke and stress passes: probe truth, custom-home isolation, migrations, board
reconciliation/retention, department moves, command-center aggregation, durable
resources, export integrity, remote transfer, Kiro continuity, and legacy skill
manifests. Use unique markers and the evidence rules in `README.md`; every file,
home, remote, and engine must be disposable.

---

### OD-01 — Liveness, readiness, and operator status tell different truths
- Goal: dependency failure degrades readiness without falsely declaring the HTTP process dead.
- Category: recovery / observability
- Preconditions: running gateway; one configured disposable email inbox or another readiness dependency that can be made unhealthy; authenticated operator client.
- Steps:
  1. Record status codes and bodies for `/api/healthz`, `/api/readyz`, and `/api/status` while healthy.
  2. Break only the test dependency and wait one bounded poll interval; query all three again.
  3. Restore the dependency and poll until recovery or the card timeout.
- Expected: liveness remains `200`; readiness becomes `503` with a named failed check; operator status reports the same degraded dependency with credentials redacted; readiness returns to `200` after recovery.
- Observe: the dashboard may remain usable while not-ready, but must not display the failed dependency as healthy.

### OD-02 — Active-home isolation across lifecycle and registry commands
- Goal: `CUTTLEFISH_HOME` selects one coherent instance without state leaking from another home.
- Category: persistence / boundary
- Preconditions: two fresh disposable homes A and B, distinct configured ports, gateway stopped.
- Steps:
  1. Set up A, start it, create uniquely marked session A, run `status` and `list`, then stop it.
  2. Set up B on its distinct port, start it, create uniquely marked session B, run `status` and `list`.
  3. Query B for A's session id, then stop B and restart A; query A for both ids.
- Expected: lifecycle/list use the active home's port and path; B cannot see A's session and A cannot see B's; switching homes does not rewrite either config or database.
- Observe: because the CLI exposes one canonical instance at a time, `list` should follow the active home rather than accumulate misleading simultaneous entries.

### OD-03 — Migration check is inert; apply verifies the version stamp
- Goal: operators can inspect and apply a pending template migration without silent partial success.
- Category: files / recovery / CLI
- Preconditions: disposable copy of a legitimately older test home with a known pending migration; current CLI built; before-snapshot of config and managed files.
- Steps:
  1. Run `cuttlefish migrate --check`; record exit code and pending versions; compare the home to the before-snapshot.
  2. Run the supported deterministic `--auto` path when the pending migration contains auto-add files; otherwise run the documented interactive migration and complete it normally.
  3. Re-run `--check`; inspect `cuttlefish.version`, staged migration cleanup, and user-owned file contents.
  4. Repeat from a fresh copy but terminate the migration before it stamps the version.
- Expected: check performs no writes; success advances exactly to the CLI version and preserves existing user content; interrupted/incomplete work is reported as failed and remains retryable rather than claiming completion.
- Observe: `start` against the older copy should warn about pending migration without auto-mutating it.

### OD-04 — Orphaned and completed kanban session reconciliation
- Goal: board reads repair stale running tickets while completed tickets do not advertise old idle sessions as live.
- Category: recovery / cross-screen consistency
- Preconditions: disposable board with ticket A linked to a session killed before ticket settlement, and completed ticket B linked to an old idle session.
- Steps:
  1. Restart the gateway; open the department board and record ticket/session states before and after the first read.
  2. Open A's detail panel and its linked session; then open B's detail panel.
  3. Refresh twice and query the ticket-to-session resolver for both tickets.
- Expected: A deterministically becomes `blocked` with failure-relevant session context; B stays completed and does not show its idle session as live; repeated reads are idempotent and do not keep changing timestamps.
- Observe: ticket, session list, detail panel, and activity must tell one story.

### OD-05 — Recycle-bin retention boundaries: 0, default, and 7 days
- Goal: ticket retention settings have precise deletion and restore semantics at every supported boundary.
- Category: delete-undo / boundary / persistence
- Preconditions: disposable board; ability to set retention to 0–7 days; controllable test clock or API fixture for expiry if changing host time is unsafe.
- Steps:
  1. At retention `0`, delete a ticket and prove it never appears in Recently deleted.
  2. Restore the default (3 days), delete/restore a ticket, restart, and verify all fields/linkage survive.
  3. At `7`, place one fixture just before expiry and one just after; trigger the normal purge/read path.
  4. Attempt to restore the expired id directly as well as through the UI.
- Expected: zero purges immediately; unexpired tickets are losslessly restorable across restart; expired tickets disappear once and cannot be resurrected by stale UI or replayed API calls.
- Observe: retention-setting changes must not retroactively corrupt active tickets.

### OD-06 — Department rename is atomic and collision-safe
- Goal: renaming a department moves employee ownership and UI state without overwriting another department.
- Category: settings / files / recovery
- Preconditions: departments Alpha and Existing; Alpha has employees, tickets, and an open chat; snapshot org YAML and board files.
- Steps:
  1. Rename Alpha to Beta from `/org`; inspect employee YAML, department directory, board tabs, and refresh events.
  2. Hard-refresh `/org`, `/kanban`, and the open chat; restart and re-check.
  3. From a restored snapshot, attempt Alpha → Existing and Alpha → an invalid/empty name.
- Expected: successful rename updates every matching employee and visible department reference; sessions remain attributed; target collision/invalid names reject before any partial file mutation; restart preserves the last valid state.
- Observe: an open browser must not retain a writable ghost tab for Alpha.

### OD-07 — Command Center counts, windows, and deep links reconcile
- Goal: `/command` aggregates persisted state using the same semantics as detail screens.
- Category: navigation / cross-screen consistency
- Preconditions: known counts of agents, running agents, tickets by status, cron jobs, and sessions with cost/turn/token metadata in two time windows.
- Steps:
  1. Record source counts from `/org`, `/kanban`, `/cron`, and session APIs.
  2. Open `/command`; compare every count and agent-usage row for day/week/month windows.
  3. Follow each count and manager direct-chat link; verify destination and employee preselection.
  4. Add one new entity, complete one session, and confirm bounded live refresh without hard reload.
- Expected: counts and windows match their documented persisted fields; links land on the correct route/entity; manager chat uses `/?employee=<slug>` and does not silently override the selected employee's engine.
- Observe: summed `lastContextTokens` is a volume proxy, not mislabeled as exact billed usage.

### OD-08 — Run resources attach without a prompt and persist into later turns
- Goal: files, folders, URLs, and prior artifacts share one durable resource contract.
- Category: files / persistence
- Preconditions: existing session; allowed local file and folder, local fixture URL, registered artifact; authenticated API client.
- Steps:
  1. Attach each resource with `POST /api/sessions/:id/resources` without sending a message; include access mode, intended use, and producing-run metadata where supported.
  2. List `/api/sessions/:id/resources`; record normalized ids, hashes, and paths/URLs.
  3. Send a later prompt requiring the file and artifact markers; restart and list again.
  4. Try a disallowed path, malformed URL, and unknown artifact id.
- Expected: attachment alone creates no engine turn; valid metadata persists and is reused on the later dispatch; invalid resources reject atomically without removing earlier resources; local read-only resources are never represented as writable.
- Observe: folder references remain metadata; do not expect recursive copying unless another surface explicitly promises it.

### OD-09 — Run-bundle manifest proves copied bytes and log isolation
- Goal: a completed run exports a self-consistent bundle without unrelated files or logs.
- Category: files / integrity
- Preconditions: completed marked session with one input attachment, one produced artifact, one checkpoint, and unrelated concurrent session/log marker.
- Steps:
  1. Export with `POST /api/sessions/:id/bundle`; require terminal success and locate `manifest.json` last.
  2. Hash every inventoried payload and compare size/hash to the manifest; inspect `run.json`, `summary.md`, `errors.json`, and copied artifacts.
  3. Search the bundle for the unrelated marker and secret-shaped fixture token.
  4. Attempt export while an equivalent session is still running.
- Expected: every copied payload matches its manifest entry; only concrete attached/produced files are copied; folder resources remain references; correlated logs exclude unrelated activity and redact secrets; running export fails or snapshots only if explicitly reported as such.
- Observe: user-controlled titles/source refs must not broaden log selection.

### OD-10 — Remote file transfer success and every bounded refusal
- Goal: transfer sends exactly one allowed managed file and fails safely at destination, size, and response boundaries.
- Category: files / recovery / boundary
- Preconditions: local fixture remote on the configured allowlist; managed small file with known hash; fixture modes for success, delayed response, and oversized success/error bodies.
- Steps:
  1. Transfer the small file and compare received bytes/hash plus one request count.
  2. Try an unlisted destination, out-of-root source, directory, and file over 50 MiB.
  3. Exercise delayed response beyond two minutes only in an isolated timed harness; exercise bounded oversized response modes.
  4. Retry the successful request deliberately and record whether the API promises or does not promise idempotency.
- Expected: allowed transfer preserves bytes; policy/size/type failures occur before outbound delivery; timeout and response-body limits end with named errors without gateway memory growth or crash.
- Observe: no remote credentials, headers, or file contents appear in generic activity logs.

### OD-11 — Kiro continuity, answer cleanup, and estimated-credit accounting
- Goal: Kiro resume state and local credit estimates remain honest across turns and real exhaustion.
- Category: persistence / recovery / settings
- Preconditions: signed-in Kiro CLI with a cheap test model; configured credit budget and billing anchor; otherwise Not executed — environment unavailable.
- Steps:
  1. Send two marked turns in one session; verify the second uses stored resume id and retains context.
  2. Inspect the displayed answer and raw activity for ANSI/footer handling; compare `kiro-credits.json` before/after.
  3. Restart and send a third turn; inspect `/limits` estimate and reset date.
  4. If real credit exhaustion occurs, record session and limits behavior without manufacturing provider state.
- Expected: continuity survives restart when the CLI reports a resume id; ANSI and `Credits … Time …` footer do not pollute assistant content; credits accumulate once per turn; UI labels the gauge as an estimate, while a real exhaustion blocks regardless of stale estimate.
- Observe: absence of a stable provider quota endpoint is not a failure if the estimate is clearly labeled.

### OD-12 — Legacy and current skills manifests load without rewriting user data
- Goal: upgrades accept both seeded object-shaped and legacy flat-array `skills.json` formats.
- Category: migration / files / compatibility
- Preconditions: two disposable homes with equivalent installed-skill entries, one in each supported manifest shape; backup both files.
- Steps:
  1. Run `cuttlefish skills list` and open `/skills` against each home; compare logical entries.
  2. Run a no-op `skills update` where network/package fixtures permit; inspect manifest shape and local skill files.
  3. Add a malformed entry to a copy and repeat list/update.
- Expected: both supported shapes list equivalent skills; no-op reads do not rewrite or drop metadata; update either preserves the supported shape or performs an explicit lossless migration; malformed data yields a named error or skips only the bad entry without erasing valid skills.
- Observe: user-edited skill markdown must follow the overwrite/warning contract already tested by SK-04.
