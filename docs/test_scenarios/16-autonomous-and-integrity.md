# 16 — Autonomous Operation and Integrity Boundaries

These cards cover high-risk seams that files 01–15 do not exercise directly:
autonomous authorization, context-history selection, crash-safe email ingest,
artifact-registry drift, knowledge-webhook failures, and the local voice stack.
They are trust tests, not demonstrations. A passing run must show that Cuttlefish
stays inside the operator's configured scope and becomes visibly degraded when a
dependency or durable handoff fails.

Use a disposable `CUTTLEFISH_HOME`, disposable project directories, test inboxes,
and local fixture servers only. Autonomous authorization deliberately removes a
human click when enabled; never point these cards at a real project or production
org. The live dual-model cards require signed-in Claude and Codex CLIs. If either
is unavailable, execute the fail-closed branch and mark the consensus branch
**Not executed — environment unavailable** rather than substituting a model.

---

### AI-01 — Autonomous mode needs both switches, one project, and a visible banner
- Goal: autonomous authorization cannot activate accidentally or invisibly.
- Category: settings / authorization / recovery
- Preconditions: disposable home; two disposable directories allowed by `workspaces.roots`; browser and shell access.
- Steps:
  1. Add one workspace profile with a valid `cwd` and `autonomousMode.enabled: true`, but leave `features.autonomousMode: false`; restart and inspect the dashboard plus `GET /api/status`.
  2. Enable the global feature switch; restart; visit several dashboard routes and inspect status again.
  3. Disable either switch and restart.
  4. Separately try an enabled profile with no `cwd`, then two enabled profiles. Restore the last valid config after each start attempt.
- Expected: both switches are required; the active state names the opted-in project in a global banner and `autonomousMode.active`; disabling either switch removes the banner and restores ordinary human gates. Missing `cwd` and multiple enabled profiles are rejected as configuration errors rather than widening scope or starting partially.
- Observe: `authorizationsToday` is a dashboard convenience counter that resets on process restart; the durable approval history, not that counter, must remain the audit source.

### AI-02 — Two-model tool authorization: consensus once, every other outcome fails closed
- Goal: a gated tool action auto-resolves only when the fixed Claude Fable 5 and Codex gpt-5.6-sol judges both approve it.
- Category: authorization / interruption / recovery
- Preconditions: AI-01 active for the exact test-project `cwd`; `toolReview: true`; a disposable employee whose security policy gates a harmless Bash pattern; both judge engines signed in for the consensus trial.
- Steps:
  1. Ask the employee to run a harmless command that matches the configured review trigger, such as an `echo` through a deliberately gated shell prefix.
  2. Watch the checkpoint, the two judge sessions, the requesting transcript, `/approvals`, and the banner counter settle.
  3. Make exactly one judge unavailable in config and trigger a fresh harmless checkpoint.
  4. Confirm it remains pending, then resolve it as a human operator. If practical, repeat with an ambiguous command that causes one judge to decline; do not use a destructive command merely to force disagreement.
- Expected: only two `approved` verdicts auto-resolve; the approval is stamped `resolvedByKind: "autonomous_dual_model"`, attributed to both named judges, badged as autonomous in `/approvals`, applied once, and counted once. Missing engine, decline, error, timeout, or unparseable output never auto-approves or auto-rejects: the checkpoint stays pending for a human and the session says consensus was not reached.
- Observe: the autonomous resume message must say AI reviewers approved reconsideration; it must never claim that a human approved the command.

### AI-03 — Exact-project boundary and judge recursion guard
- Goal: exact working-directory scope and judge-only isolation prevent autonomous authority from bleeding into sibling paths, subdirectories, worktrees, or the verdict sessions themselves.
- Category: authorization / files / boundary
- Preconditions: AI-02 setup; allowed roots containing the opted-in directory, one sibling directory, and one nested subdirectory or worktree.
- Steps:
  1. Trigger the harmless gated command from a session whose resolved `cwd` is exactly the autonomous project's directory; record whether the two judge sessions start.
  2. Trigger the same command from the sibling directory and then from the nested directory/worktree.
  3. Inspect each judge session's API/activity metadata, parentage, employee binding, and child-session tree.
  4. While a verdict is running, watch for any security checkpoint raised by a judge's own attempted tool use.
- Expected: only the exact realpath match is eligible. Sibling and nested paths use the ordinary human checkpoint even though they are inside an allowed workspace root. Verdict sessions have `autonomousVerdictSession: true`, no org employee identity, judge-only/read-only engine restrictions, and exactly one parent link; they never spawn another autonomous verdict chain or auto-authorize their own tool request.
- Observe: two judge sessions per decision are expected; grandchildren, mutable judge tooling, or a subtree match are High findings.

### AI-04 — Autonomous org-change override stays auditable and cannot bypass hard invariants
- Goal: the explicitly gateway-wide org-change override can resolve a reversible change, while self-modification and cyclic hierarchy changes remain impossible.
- Category: authorization / persistence / boundary
- Preconditions: AI-01 active with `orgChangeOverride: true`; both judges available; disposable employees and an originating human chat.
- Steps:
  1. From a human chat, propose one reversible org change that normally requires approval, such as hiring a disposable employee or changing its reporting line.
  2. Follow the HR critique, approval, two verdict sessions, `/approvals`, originating transcript, and resulting YAML.
  3. Repeat from a session not using the autonomous workspace profile to verify the documented gateway-wide HR behavior is visible rather than mistaken for project-local behavior.
  4. As an agent actor, propose that HR modify/retire itself; separately propose a `reportsTo` cycle. Inspect the change records and org files.
- Expected: two approving judge verdicts may apply the reversible change exactly once and record autonomous attribution instead of human wording; a non-consensus result stays pending. Because HR is a singleton lane, the override is gateway-wide once enabled. Agent-driven HR self-modification and cyclic/self-referential hierarchy changes are rejected before autonomous review and remain rejected if replayed; no YAML mutation occurs.
- Observe: the dashboard should make the gateway-wide consequence legible. If the UI only says “one project” while HR override reaches all chats, record that ambiguity.

### AI-05 — Continuous dispatch is project-scoped, capped, cooled down, and quota-aware
- Goal: autonomous continuous work cannot turn into an unbounded or cross-project ticket loop.
- Category: concurrency / boundary / recovery
- Preconditions: AI-01 active with `continuousDispatch: true` and `maxAutoDispatchesPerHour: 2`; board worker enabled; cheap engine; six small `todo` tickets in one department: four non-manual tickets with `resourcePath` exactly equal to the autonomous project, one sibling-project ticket, and one exact-project `manualOnly` ticket.
- Steps:
  1. Manually run the first exact-project ticket and let it complete; time how quickly the second ticket starts compared with the normal board-worker interval.
  2. Let that first automatic dispatch finish so the third ticket starts automatically; when the third finishes, leave the fourth eligible and inspect logs/activity.
  3. Restart, raise the hourly cap for this sub-trial, and auto-dispatch one ticket. Move that ticket back to `todo` within two minutes, complete another seed ticket in the same department, and verify the cooled-down ticket is not immediately selected again. If the board does not allow this state transition, record the cooldown branch as Not applicable rather than editing board storage.
  4. Temporarily drive the assigned engine below the board worker's configured usage threshold, then restore it. Finally disable the global autonomous switch.
- Expected: completion can immediately dispatch the next exact-project, non-manual ticket; sibling and `manualOnly` tickets never join that chain. The rolling-hour cap stops the third immediate dispatch with a visible throttle signal, same-ticket cooldown prevents instant redispatch loops, and the existing usage gate still wins. Disabling the feature ends continuous dispatch without cancelling unrelated work.
- Observe: hourly-cap and cooldown counters reset on daemon restart by design; a restart must not create duplicate runs from already-dispatched tickets.

### AI-06 — Context manager changes only synthetic history, and only in `on`
- Goal: long histories are reduced predictably for Ollama/Kilo/Aider without silently rewriting native Claude/Codex/Grok resume state.
- Category: boundary / persistence / settings
- Preconditions: debug logging visible in `/activity` or gateway logs; one synthetic-history engine (Ollama, Kilo, or Aider) and one native-resume engine; a disposable session history containing unique early markers, repeated low-value assistant/tool output, a partial message if the harness can create one, and a very large old tool result.
- Steps:
  1. Run a marked follow-up with `context.managerMode: off`; capture behavior and engine input evidence available from the test harness.
  2. Repeat equivalent sessions in `shadow` and `on`, keeping model and history constant; inspect `context_manager` metadata (`strategy`, before/after estimates, slots, dropped, summarized).
  3. Run the same `on` trial through the native-resume engine.
  4. Set `CUTTLEFISH_CONTEXT_MANAGER=shadow` while config says `on`, restart, and repeat one short turn; then remove the override.
- Expected: `off` preserves existing behavior; `shadow` reports what would change but passes no selected history; `on` applies selected history only to synthetic-history engines, retaining the newest user/assistant turns while dropping partial/duplicate over-budget content and marking extractive/truncated summaries. Native-resume engines report `native_resume_unmodified` with unchanged input. The environment override wins while present and an invalid override fails back to `off`.
- Observe: full session history remains durable and exportable regardless of prompt selection; compaction must not delete registry messages.

### AI-07 — Email ingest crash boundary favors at-most-once and honest readiness
- Goal: a crash after the durable `dispatching` claim never re-runs untrusted email invisibly.
- Category: interruption / persistence / recovery
- Preconditions: disposable IMAP inbox with `autoIngest: true`, a non-empty `allowFrom`, a sender whose aligned SPF/DKIM/DMARC result passes the ingest trust gate, and a deliberately slow COO engine; access to inbox message/status APIs and gateway PID. Do not use a real mailbox.
- Steps:
  1. Send a uniquely marked allowed message and force an immediate inbox check.
  2. As soon as the message reports `dispatching`, hard-kill the gateway before the engine settles; restart and poll the same inbox/message again.
  3. Compare session rows and turns for the unique marker; inspect inbox health, `GET /api/healthz`, `GET /api/readyz`, and `GET /api/status`.
  4. Send a second unique message and let it ingest normally as a control. Separately send a message above the configured `maxMessageBytes` limit.
- Expected: the claimed message is not dispatched a second time after restart or provider replay; it remains visibly stuck/degraded for operator attention rather than being called healthy. Liveness stays `200` while readiness is `503 not_ready` with an email check until dependencies recover. The control message runs once and reaches `ingested`; oversized mail is bounded and does not start an engine turn.
- Observe: at-most-once intentionally trades automatic recovery for duplicate prevention. Do not “repair” the row by editing SQLite during the card; report the available operator recovery path or its absence.

### AI-08 — Artifact registry survives restart and tells the truth when bytes disappear
- Goal: registered artifact lineage remains queryable while on-disk loss and policy violations are surfaced explicitly.
- Category: files / persistence / boundary
- Preconditions: disposable allowed root; one small generated file with known SHA-256; a second path outside `gateway.fileReadRoots`; a completed session id if available.
- Steps:
  1. `POST /api/artifacts/register` with kind, producing run id, source metadata, tags, and notes; compare the returned SHA-256 with a local hash.
  2. Find it through `GET /api/artifacts` using `runId`, `kind`, `tag`, and `q`; patch only mutable metadata and attach the artifact to a session.
  3. Restart; fetch the artifact and validate it by both id and path.
  4. Move the underlying file aside, then repeat `GET` and `POST /api/artifacts/validate`; restore it afterward. Attempt to register the out-of-root file and an id containing `../`.
- Expected: identity, creation hash, lineage, tags, and attachment survive restart; filters return the same record. Missing bytes leave the record intact but set `existsOnDisk: false` and make validation `ok: false`; consumers fail legibly rather than fabricating content. Out-of-root paths and path-like ids are rejected, and metadata patches never move or rewrite the file.
- Observe: `/validate` checks registry presence and current disk existence; it does not promise to re-hash bytes. Treat a stored creation hash as lineage metadata, not a live integrity scan.

### AI-09 — Knowledge webhook outage and oversized response cannot become a gateway outage
- Goal: optional external knowledge export/read failures stay bounded, retryable where appropriate, and non-authoritative.
- Category: recovery / boundary / persistence
- Preconditions: a local fixture HTTP server allowlisted only for this disposable run; configurable modes for success, `429`, `500`, delayed response beyond timeout, and a streamed body over 2 MiB; webhook sink and read provider pointed at it.
- Steps:
  1. Complete a session and decide a checkpoint to create outbox envelopes; flush against a normal acknowledgement and verify delivered state once.
  2. Create more envelopes; exercise `429`, `500`, timeout, and oversized success/error bodies, inspecting outbox status, attempt count, retry timing, and logs after each flush.
  3. Exercise `/api/knowledge/search` and `/api/knowledge/context` against normal, timed-out, and oversized fixture responses.
  4. While the fixture is broken, create and complete an ordinary chat; then set sink/read providers back to `noop`/`none` and restart.
- Expected: successful items are delivered once; retryable failures return claims to a durable pending/retry state with bounded backoff, body reads, and request time. Read failures end as bounded request errors, not process hangs or memory growth. Core chat and local SQLite state continue to work throughout; disabled providers return their documented empty/default behavior.
- Observe: fixture tokens, envelope bodies, and session content must not spill into generic activity logs. This deepens SX-17, which covers JSONL/load rather than webhook protocol failure.

### AI-10 — Local voice first-use, interrupted acquisition, cache corruption, and fallback
- Goal: `/talk` remains usable when its local Whisper/Kokoro assets or browser audio capabilities are missing, interrupted, or corrupt.
- Category: files / interruption / recovery
- Preconditions: fresh disposable home with no speech models; a browser with microphone support; enough disk for the selected Whisper model; network only for the acquisition trial; typed Talk available as the control path.
- Steps:
  1. Open `/talk`, tap the mic, verify the local-model disclosure, cancel, and confirm no model/session turn was created. Reopen and accept; from a second tab click download again while progress is active.
  2. Stop the gateway mid-download, restart, and retry. Confirm the abandoned uniquely named partial is inert and only a fully verified final model becomes available.
  3. Complete one voice turn; compare spoken words, transcript, session history, and response. Test mute during streamed audio and confirm only one voice path is audible.
  4. In the disposable cache only, corrupt a completed model without changing its size; restart and trigger verification/re-acquisition. Then deny microphone permission and make Kokoro unavailable while leaving browser speech synthesis enabled; use typed Talk for a final turn.
- Expected: acquisition is single-flight with visible progress; interrupted or hash/size-invalid assets never activate and can be replaced cleanly. Transcription runs locally and lands once in the Talk session. Mic denial or missing `ffmpeg`/`whisper-cli` produces an actionable retry/error state while typed Talk remains usable. Kokoro loss is labeled as browser fallback, never double-speaks with the fallback, and mute silences queued/streamed audio without losing the text reply.
- Observe: if no model/network is available, execute cancel, permission, typed-mode, and fallback branches; mark acquisition-specific steps **Not executed — environment unavailable**.
