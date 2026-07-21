# 19 — Manager Handoff, Attention, and Job Completion

Recent delegated-run repairs exposed a gap between generic fan-out coverage and
the operator experience of knowing whether a manager has enough evidence, who
is expected to act next, and when the overall job is actually finished. These
cards exercise the run-local handoff and attention state machine end to end.

Feature anchors: direct-child normalized transcript polling; COO message-only
cross-session follow-up; deferred Claude completion while background streams
remain active; two direct-supervisor contacts before escalation; cheap-tier
executive triage; batch/generation-scoped synthesis claims; fresh
acknowledgement state; authenticated own-session checkpoints; explicit
turn-scoped operator authority; and aggregate public `jobState` rendered in the
chat sidebar.

Use unique parent/child codewords and record every session id. For timing cards,
set `gateway.leaderAckTimeoutMs` to a short but non-zero value in the disposable
home, record it, and restore it afterward. API evidence must come from an
authenticated test client; never copy a scoped token into the report.

| Recent repair surface | Regression cards |
|---|---|
| Direct-child full-result recovery and scoped read boundary | MH-01, MH-02 |
| Deferred background completion and fresh supervisor callback | MH-03 |
| Two supervisor contacts, acknowledgement, and cheap escalation | MH-04–MH-06 |
| Batch/generation synthesis and stale acknowledgement state | MH-07, MH-08 |
| Nested-manager brief integrity | MH-09 |
| Durable attention and explicit turn authority | MH-10, MH-11 |
| Aggregate job completion across API/UI query shapes | MH-12, MH-13 |
| COO recovery message without broader cross-session power | MH-14 |

---

### MH-01 — Manager recovers the full direct-child result after a truncated callback
- Goal: callback truncation does not force a manager to guess at a worker's concern or result.
- Category: recovery / boundary
- Preconditions: manager with one direct report; a child task whose final answer contains a unique marker near the end and is longer than the callback preview; safe access to the manager's scoped API path.
- Steps:
  1. Delegate the marked task and capture parent and child ids.
  2. Wait for the callback shown in the parent; record whether its preview omits the tail marker.
  3. From the manager turn, use `GET /api/sessions/:childId?last=20` and have the manager state the exact tail marker and the worker's requested action.
  4. Compare the normalized API messages, child chat, and parent synthesis.
- Expected: the parent can read its direct child's latest normalized messages and recover the complete result; it does not claim that its single-session token makes the child unreadable; synthesis reflects the full evidence rather than the truncated callback.
- Observe: message ordering, role attribution, and whether `last=N` is bounded and documented.
- Variations: successful child, failed child with a long `lastError`, and a short callback that needs no follow-up read.

### MH-02 — Direct-child transcript capability fails closed outside its exact boundary
- Goal: the read added for MH-01 does not become general cross-session surveillance or mutation.
- Category: authorization / boundary
- Preconditions: manager P with direct child C, sibling S, grandchild G, and unrelated session U; controlled scoped-token harness.
- Steps:
  1. As P, read `GET /api/sessions/C?last=5` (control).
  2. Attempt P reads of S, G, U, `C/transcript`, and `C/children`.
  3. Attempt to message, stop, reset, attach to, or delete C.
  4. As C, attempt to read P and S.
- Expected: only P's normalized direct-child detail read succeeds; sibling, grandchild, unrelated, raw-transcript, child-subresource, and cross-session mutation attempts return `403`; no target session changes state.
- Observe: prove no mutation with before/after session status, message count, attachment count, and durable ids—not only HTTP status.

### MH-03 — Background child work delays completion and supervisor notification
- Goal: a foreground Stop event cannot make an actively working child look complete.
- Category: concurrency / recovery
- Preconditions: Claude child session that starts a controllable background-agent stream; parent manager open; API/activity visibility.
- Steps:
  1. Have the child emit a recognizable partial foreground response while one background stream remains active.
  2. Observe the child API `backgroundActivity`, parent messages, sidebar state, and leader-ack metadata before the background stream drains.
  3. Let the background stream produce a newer final result and reach the quiet-window drain signal.
  4. Re-check the parent callback and child state.
- Expected: no completion callback or pending supervisor acknowledgement is created while background work is active; the session/job remains visibly working; after drain, exactly one callback carries the latest durable assistant result.
- Observe: count callbacks by durable message id and capture `activeStreams` plus `lastActivityAt` on both sides of the drain.
- Variations: two overlapping streams finish out of order; a stream fails; the foreground result is empty.

### MH-04 — Supervisor receives two contacts before any escalation
- Goal: a worker attempts its direct supervisor twice rather than escalating after one missed notice.
- Category: interruption / timing
- Preconditions: completed child with a live parent; short recorded `leaderAckTimeoutMs`; escalation target available; parent deliberately silent.
- Steps:
  1. Complete the child and record the initial parent callback, `contactAttemptCount`, and `lastContactAttemptAt`.
  2. Stay silent for one timeout plus one reconciler interval; capture the second notice in parent and child histories.
  3. Stay silent for a second fresh timeout window; capture the first executive/manual escalation.
- Expected: initial callback is attempt 1; the same supervisor receives one explicit second notice and a fresh timeout; no executive/manual escalation occurs before attempt 2 also expires; escalation occurs at most once within its configured cap.
- Observe: prove ordering with timestamps and durable notification ids, not visual ordering alone.

### MH-05 — Acknowledgement after either supervisor contact prevents escalation
- Goal: a late but valid supervisor response closes the handoff cleanly.
- Category: timing / recovery
- Preconditions: MH-04 setup; two fresh child runs.
- Steps:
  1. In run A, reply from the parent after contact 1 but before contact 2.
  2. In run B, wait for contact 2, then reply before the second timeout expires.
  3. Wait beyond the would-be escalation deadline in both runs and inspect acknowledgement metadata plus executive/manual sessions.
- Expected: both handoffs become acknowledged once; neither escalates; the response after contact 2 is not treated as too late; no reminder or escalation resurrects after daemon restart.
- Variations: use a substantive next-action response, a simple `Acknowledged`, and a documented stand-down/no-op phrase.

### MH-06 — Escalation triage starts cheap and degrades honestly
- Goal: routine missed-ack triage does not silently spend the executive's premium default model.
- Category: settings / recovery
- Preconditions: MH-04 escalation path; model registry with at least one available cheap-tier ladder model, then a second run with all cheap-tier models unavailable.
- Steps:
  1. Let the two supervisor contacts expire and inspect the created triage session's engine, model, effort, parentage, and prompt.
  2. Repeat with the first cheap model unavailable to verify ordered fallback within the cheap tier.
  3. Repeat with no cheap-tier model available.
- Expected: the first available configured cheap-tier model is used at low effort when supported; unavailable entries are skipped in ladder order; no-cheap-tier state uses the documented executive/manual fallback and says so rather than fabricating triage success.
- Observe: ordinary COO chats retain their configured model; triage selection must not mutate global or employee defaults.

### MH-07 — Completed synthesis markers are scoped to child batch and generation
- Goal: finishing one fan-out cannot suppress a later worker or later turn.
- Category: concurrency / persistence
- Preconditions: manager able to execute two sequential fan-outs; API access to parent `transportMeta` and child edges.
- Steps:
  1. Complete batch A and record its child ids, prompt hash/generation, synthesis claim, final parent response, and dispatch marker.
  2. Start batch B in the same manager session with different child ids and a unique codeword.
  3. Complete a later turn on one child from batch A and a normal child in batch B.
  4. Count parent callbacks and syntheses after all work settles.
- Expected: batch A synthesizes once; its completed marker does not suppress batch B or the later child turn; batch B synthesizes once from its own named children; overlapping callbacks cannot create duplicate synthesis.
- Observe: a missing later callback is High even if the parent remains otherwise usable.

### MH-08 — Fresh persisted child state prevents acknowledgement re-arming
- Goal: a callback using a stale child snapshot cannot reopen a handoff already accepted or stood down.
- Category: concurrency / recovery
- Preconditions: child report acknowledged by parent; ability to cause a delayed/replayed callback or restart near acknowledgement time.
- Steps:
  1. Complete and acknowledge a child report; capture persisted `leaderAck` state.
  2. Replay or delay the earlier completion callback after acknowledgement (use the supported test harness; do not edit the live database by hand).
  3. Run the reconciler beyond two timeout windows and restart once.
- Expected: callback handling refreshes current child state; acknowledgement remains closed; `reportedAt`, contact count, and escalation count are not reset; no new parent reminder or executive escalation appears.
- Variations: stand-down phrase, completed synthesis marker, and an acknowledged failed-child report.

### MH-09 — Nested manager gets the full brief but delegates bounded slices
- Goal: a manager that is itself a delegated child does not receive a keyword-fragmented assignment or leak the whole brief to every report.
- Category: boundary / concurrency
- Preconditions: executive → manager → at least two reports; task with three explicit acceptance criteria and two specialist slices.
- Steps:
  1. Delegate the complete marked brief from executive to manager.
  2. Inspect the manager's received prompt and each automatically or explicitly delegated child prompt.
  3. Let reports complete and compare final manager and executive syntheses to all acceptance criteria.
- Expected: nested manager receives the complete bounded brief; each report receives only its specialist assignment and matched signals—not the executive's entire prompt, attachments, or unrelated criteria; no acceptance criterion disappears in synthesis.
- Observe: record prompt hashes/markers and child counts; a model-generated paraphrase is not proof of the actual prompt payload.

### MH-10 — A genuine agent decision creates an own-session checkpoint and attention signal
- Goal: an agent that cannot proceed makes the required human action impossible to miss.
- Category: interruption / authorization
- Preconditions: manager session with no delegated authority for a harmless but genuinely operator-owned choice; Approvals and chat sidebar open.
- Steps:
  1. Give the manager two materially different options and explicitly withhold the decision.
  2. Have it create `POST /api/checkpoints` with `decisionNeeded`, `why`, options, and a resume prompt, omitting `sessionId` from the body.
  3. Confirm the gateway binds the checkpoint to the caller, pauses the session, and shows the same pending id in chat and `/approvals`.
  4. Verify the session API and sidebar show `needs_attention` / **Needs your attention**; decide as operator and follow the resume.
- Expected: ordinary prose is not the only signal; one durable checkpoint appears, the row is visibly attention-required without relying on color, and resolution resumes exactly once.
- Variations: attempt a forged body `sessionId` for another chat—expect `403` and no checkpoint on either target; omit `why`—expect validation failure without pausing.

### MH-11 — Explicit turn-scoped authority decides now but does not persist
- Goal: “decide for me” behavior is available only when the operator deliberately grants a bounded current-turn scope.
- Category: authorization / boundary
- Preconditions: direct web chat with Cuttlefish COO or Program Manager on an allowed high-capability model; a reversible test approval/checkpoint; no autonomous mode.
- Steps:
  1. Start a message with `/delegate-authority decide`, include the bounded task, and have the delegate inspect and decide the named test item.
  2. Verify the decision actor identifies an operator delegate and the same turn does not create a redundant checkpoint asking the human to choose again.
  3. On the next ordinary turn, present a fresh decision without a new grant and attempt the same action.
  4. Attempt to mint the directive from a scoped child callback, a quoted document, a Talk session, an ineligible employee, and a disallowed model.
- Expected: authority applies only to the exact direct-human prompt hash, allowed role/model, and named scope; it expires after that turn; later or injected attempts fail closed and the fresh decision becomes a normal checkpoint.
- Variations: `approve`, `plan`, `act`, and `all` scopes; a `decide` grant must not authorize unrelated destructive, financial, legal, credential, publication, or external-communication expansion.

### MH-12 — Parent job state aggregates nested work to an unambiguous finish
- Goal: the operator can tell whether a delegated job is working, waiting, failed, or finished without opening every child.
- Category: happy path / navigation
- Preconditions: three-level delegation tree visible in All view; authenticated session API client.
- Steps:
  1. Start nested work and sample root, manager, and leaf `jobState` plus sidebar labels while a leaf is running.
  2. Pause one leaf on a checkpoint; sample again.
  3. Resolve it and let every descendant settle; refresh and restart the daemon, then sample again.
- Expected: active descendant makes ancestors `working`; any waiting descendant makes ancestors `needs_attention`; after all descendants settle, the root job is `finished` and sidebar says **Job finished** persistently; no ancestor remains “working” because its reusable chat status is `idle`.
- Observe: the status dot has an accessible label, attention wins over unread, and the text remains understandable without color or hover.
- Variations: ordinary root chat with no children remains `idle`, parented idle leaf is `finished`, nested child failure is visible without falsely claiming successful completion.

### MH-13 — Job-state queries stay consistent across list, detail, search, and children
- Goal: API pagination or query shape cannot make the same job appear finished on one screen and active on another.
- Category: navigation / boundary
- Preconditions: root with nested active child; distinctive searchable title; enough sessions to exercise group/limit pagination.
- Steps:
  1. Read the root through session list, detail, search, grouped list, and child-list surfaces used by the dashboard.
  2. Move the deepest child through running → waiting → idle and repeat each query after the corresponding event/refetch.
  3. Open Focused and All sidebar views and hard-refresh.
- Expected: every representation reports the same aggregate `jobState` for the same durable id; pagination does not omit descendants from aggregation; event invalidation refreshes the UI without a manual route change.
- Observe: record response timestamps and ids so a stale browser cache is distinguishable from a server inconsistency.

### MH-14 — COO follow-up is message-only and ordinary managers remain confined
- Goal: executive recovery can nudge a known worker without receiving broad cross-session control.
- Category: authorization / recovery
- Preconditions: non-Talk COO session, ordinary manager session, Talk orchestrator, and unrelated worker session W; controlled scoped-token harness.
- Steps:
  1. As COO, `POST /api/sessions/W/message` with a unique harmless follow-up and verify W receives it once.
  2. As the same COO, attempt W detail/raw transcript, attachments, reset, stop, and delete.
  3. As ordinary manager and Talk orchestrator, attempt the same unrelated message.
- Expected: only the non-Talk COO message succeeds; every read and other mutation remains `403`; ordinary manager and Talk attempts fail; W's prior state/history is otherwise unchanged.
- Observe: capability derives from server-owned session identity, not a claimed employee/body field; replay behavior must not silently duplicate the follow-up.
