# 20 — Session Authority Collision and Arbitration

These cards stress what happens when multiple agents can influence the same
work but disagree about the next action. They extend file `19`'s handoff and
turn-scoped-authority coverage into concurrent supervisors, cross-session
callers, prioritized instructions, exact-once effects, and arbiter failure.

## Contract status and precedence under test

The current source implements prompt-bound COO/Program Manager authority,
direct-supervisor acknowledgement, direct-child result reads, COO message-only
recovery, model allowlisting, and atomic approval resolution. It does **not**
yet expose a general durable arbitration record or a source-grounded ordering
for multiple supervisors in one shared conversation. The All sidebar does group
distinct chats into one expandable agent row, but Rooms remain derived read-only
timelines rather than writable shared conversations. Therefore:

- SA-01, SA-07–SA-12, and SA-18 include regressions for implemented controls.
- A durable checkpoint produces `needs_attention`; a later durable assistant
  reply or notification produces a timestamp-aware `New agent message`
  indicator. SA-21 is a regression for that board-independent signal.
  SA-22–SA-25 specify stronger semantic urgency and multi-client convergence;
  missing distinctions are failures rather than implicit product choices.
- SA-26–SA-28 are regressions for the implemented agent-grouped sidebar. SA-29
  and SA-30 specify the not-yet-implemented shared-room mention/topic contract;
  plain transcript text is not currently an authorization-bearing `@mention`.
- The remaining cards are acceptance tests for this operator-specified target
  policy. Treat absent arbitration, silent last-write-wins behavior, or two
  executed outcomes as **Fail**, not as an undocumented product choice.

Target precedence:

1. A current direct human instruction overrides agent-originated instructions.
2. Among agents, the direct supervisor durably present in the affected
   session/room outranks an authorized agent acting from outside it.
3. If two in-session supervisors conflict, freeze the conflicting side effect
   and ask Cuttlefish (COO) to arbitrate.
4. If COO is a party to the conflict, Parliamentarian arbitrates instead.
5. If arbitration still cannot produce one valid decision, COO is the final
   tie-breaker. This final rule does not let COO expand the human's scope.

For every card, identify participants by durable session id, employee slug,
parent/room linkage, and server-owned role—not display name or model claims.
Use reversible actions on disposable approvals, checkpoints, boards, and files.
Capture the ordered message ids and target-resource state before and after the
collision. Never place a session token in the evidence report.

---

### SA-01 — Non-conflicting hierarchy preserves normal throughput
- Goal: the collision failsafe does not serialize ordinary supervisor/worker coordination.
- Category: happy path / concurrency
- Preconditions: one room with worker W and direct supervisor S; two independent reversible tasks with unique target ids.
- Steps:
  1. Have S direct W on target A while an authorized Program Manager advises a compatible action on target B.
  2. Deliver both instructions in both arrival orders.
  3. Observe execution, acknowledgements, and any conflict/arbitration records.
- Expected: both compatible actions proceed once; no arbitration is opened; attribution preserves each origin; swapping arrival order does not alter the result.
- Observe: latency added by authority checks and whether normal callbacks remain exactly once.

### SA-02 — In-session direct supervisor outranks an external authorized agent
- Goal: an agent with human-delegated authority cannot override the supervisor who is actively responsible inside the affected session.
- Category: authorization / concurrency
- Preconditions: W and direct supervisor S durably linked in room R; external Program Manager P has a valid current-turn `act` or `decide` grant; one reversible target T.
- Steps:
  1. From P's separate session, instruct action X on T.
  2. From S inside R, instruct mutually exclusive action Y on T before either side effect commits.
  3. Repeat with Y arriving first, and again with P's instruction arriving during execution.
- Expected: Y is authoritative; X is rejected, superseded, or held before mutation; W receives one unambiguous next action; no hybrid state is committed.
- Observe: evidence must identify why S counted as in-session and P as external, not merely compare rank labels.

### SA-03 — Two in-session supervisors freeze and page COO
- Goal: conflicting supervisors cannot produce last-write-wins behavior or two side effects.
- Category: concurrency / interruption
- Preconditions: two legitimate supervisors S1 and S2 durably present in the same room, both able to address W, COO available, reversible target T.
- Steps:
  1. Have S1 direct X and S2 direct incompatible Y within the same scheduling interval.
  2. Inspect W, T, pending checkpoints/approvals, and the COO session before responding.
  3. Let COO select X; then repeat in a fresh run selecting Y.
- Expected: T freezes before either conflicting mutation; one durable conflict identifies both instructions and origins; COO is asked once; only COO's selected branch executes once.
- Variations: exact timestamp tie, different timestamps, same rank, and different managerial ranks.

### SA-04 — Parliamentarian arbitrates when COO is a conflict party
- Goal: COO cannot silently judge its own contested instruction.
- Category: authorization / boundary
- Preconditions: COO and another legitimate in-session supervisor issue incompatible actions for T; Parliamentarian available as a distinct server-owned employee session.
- Steps:
  1. Submit the non-COO instruction and COO instruction in both arrival orders.
  2. Verify the conflict routes to Parliamentarian rather than back to COO for the first decision.
  3. Have Parliamentarian select one branch with a short rationale.
- Expected: side effects remain frozen until Parliamentarian decides; Parliamentarian sees bounded conflict evidence, not unrelated transcripts; the selected branch runs once and the losing instruction is durably closed.
- Observe: a session merely claiming “I am Parliamentarian” must not qualify.

### SA-05 — Unresolved Parliamentarian arbitration ends with COO as final tie-breaker
- Goal: the fallback ladder terminates deterministically when the first arbiter cannot decide.
- Category: recovery / interruption
- Preconditions: SA-04 conflict; Parliamentarian returns `deferred`, malformed, contradictory, or times out after its documented contact budget.
- Steps:
  1. Exercise each unresolved result in separate runs.
  2. Observe whether the conflict returns to COO exactly once as final tie-breaker.
  3. Have COO select a branch, then replay the late Parliamentarian response.
- Expected: COO's final valid choice commits once; late or replayed arbiter output cannot reverse it; no COO↔Parliamentarian loop forms; unresolved state remains visibly blocked until the final choice.
- Variations: Parliamentarian unavailable at dispatch, engine failure, and model fallback exhaustion.

### SA-06 — Direct human instruction interrupts and closes agent arbitration
- Goal: the user retains ultimate control while agents are debating authority.
- Category: interruption / authorization
- Preconditions: pending SA-03 or SA-04 conflict with no side effect committed.
- Steps:
  1. While arbitration is pending, send a direct human instruction selecting X, selecting Y, and canceling both in three fresh runs.
  2. Deliver a late COO or Parliamentarian decision afterward.
- Expected: the direct human choice closes the conflict and is applied once; late agent decisions are rejected as stale; cancel leaves T unchanged; the audit trail distinguishes human override from agent arbitration.
- Observe: quoted human text relayed by an agent is not a direct human instruction.

### SA-07 — Out-of-session or stale delegated capability cannot win a collision
- Goal: authority is bound to the exact current human prompt and live session, not possession of an old token.
- Category: authorization / boundary
- Preconditions: a completed delegated COO/Program Manager turn, its expired token in a controlled harness, and a fresh in-session supervisor action on T.
- Steps:
  1. Replay the old delegated decision against T while S submits a current instruction.
  2. Create a new grant with the same scopes but a different prompt and retry the old token during the new active window.
  3. Try the token from another session id.
- Expected: every stale, prompt-mismatched, or session-mismatched request returns `403`; S's valid action proceeds once; no old actor appears as resolver.
- Observe: verify both signed prompt binding and live grant state, not expiry time alone.

### SA-08 — Consultation and callbacks do not transfer authority
- Goal: asking Program Manager or COO for advice cannot turn the recipient, sender, or callback into a human delegate.
- Category: authorization / cross-session
- Preconditions: manager M consults Program Manager P and COO C using child sessions; no direct human delegation directive; reversible approval/checkpoint T.
- Steps:
  1. Have P and C recommend opposite outcomes and return callbacks to M.
  2. Attempt to resolve T from P, C, M, and a quoted callback body.
  3. Repeat with a real explicit grant to P as the control.
- Expected: consultation-only attempts fail closed; advice remains attributed data for M; only the separately prompt-bound direct-human grant can authorize the matching scope.
- Observe: no callback text can mint `/delegate-authority` indirectly.

### SA-09 — Forged hierarchy, room membership, and role claims fail closed
- Goal: precedence derives from server-owned topology rather than body fields or natural-language claims.
- Category: authorization / invalid input
- Preconditions: ordinary worker session A, unrelated target room R, and controlled API client.
- Steps:
  1. Attempt to claim `managerName`, `parentSessionId`, room id, employee slug, COO, and Parliamentarian identity in bodies or prompts.
  2. Attempt the same using a renamed display title that matches a real supervisor.
  3. Compare R and T before/after.
- Expected: forged callers gain no read, message, decision, or arbitration power; mismatches return `403` or validation errors; no durable topology or target state changes.
- Variations: Unicode/confusable role names, case changes, deleted employee, and stale parent linkage.

### SA-10 — Priority beats arrival order without discarding lower-priority history
- Goal: network timing cannot decide authority, while all instructions remain auditable.
- Category: concurrency / ordering
- Preconditions: a lower-priority external instruction L and higher-priority in-session supervisor instruction H for the same target and generation; controllable delivery delays.
- Steps:
  1. Deliver L then H; repeat H then L; repeat with identical wall-clock timestamps.
  2. Restart between receipt and resolution in one run.
  3. Read normalized message order and the resolved action.
- Expected: H wins in every ordering; L is retained as superseded/conflicting rather than deleted; durable sequence/generation identity—not client clock—breaks ordering ties.
- Observe: UI order, API order, and executed action must agree after refresh.

### SA-11 — Duplicate and replayed priority messages are idempotent
- Goal: retries cannot multiply supervisor contacts, conflicts, arbitration sessions, or side effects.
- Category: recovery / concurrency
- Preconditions: one prioritized instruction with a durable message/idempotency id; ability to replay before and after acknowledgement.
- Steps:
  1. Send the same instruction concurrently from two clients and retry it after a timeout.
  2. Replay it after the target action completes and after daemon restart.
- Expected: one durable instruction, one acknowledgement, at most one conflict/arbitration record, and one side effect exist; replays return the existing result or an explicit duplicate response.
- Observe: prove absence from database/API counts and target state, not toast text alone.

### SA-12 — Two authorized decision-makers race on one approval
- Goal: valid authority on both requests still yields a single terminal outcome.
- Category: concurrency / authorization
- Preconditions: pending reversible approval T; eligible COO and Program Manager turns each explicitly granted `decide`; barrier-synchronized clients.
- Steps:
  1. Submit approve and reject simultaneously.
  2. Repeat with approve/approve and reject/reject.
  3. Inspect approval row, actor, resulting action, queue, and target after restart.
- Expected: an atomic state transition chooses one result and actor; the loser receives already-decided/conflict feedback; resulting work dispatches or stops once; no blended actor or double resume occurs.
- Variations: one token expires at the barrier and one session changes to a disallowed model.

### SA-13 — Deconfliction is scoped per target and objective generation
- Goal: a collision on one resource does not freeze unrelated work or contaminate a later turn.
- Category: concurrency / boundary
- Preconditions: targets A and B; two objective generations G1 and G2; conflicting instructions only for A/G1.
- Steps:
  1. Submit compatible work for B/G1 and B/G2 while A/G1 enters arbitration.
  2. Submit a later unambiguous A/G2 instruction.
  3. Resolve A/G1 and compare all outcomes.
- Expected: only A/G1 freezes; B work and valid A/G2 proceed according to dependency rules; resolution markers name target and generation so A/G1 cannot suppress or overwrite A/G2.
- Observe: broad “session is waiting” state must not silently deadlock independent queued work.

### SA-14 — Membership and supervisor changes cannot race an open conflict
- Goal: changing reporting lines or room presence mid-arbitration cannot manufacture a winner.
- Category: concurrency / persistence
- Preconditions: open S1/S2 conflict; reversible org membership/reporting change available through normal approval flow.
- Steps:
  1. Remove S1 from the room, reassign W, or rename a supervisor while arbitration is pending.
  2. Add a new supervisor S3 and submit a competing instruction.
  3. Resolve or cancel the original conflict, then start a fresh objective.
- Expected: the open conflict uses a durable membership/topology snapshot or explicitly restarts evaluation; it never silently rewrites origins; S3 affects only a clearly new generation; org changes do not bypass approval rules.
- Observe: deleted employees remain identifiable in historical attribution.

### SA-15 — Crash and restart preserve one conflict and one winner
- Goal: arbitration survives daemon/process failure without losing the freeze or applying both branches.
- Category: recovery / persistence
- Preconditions: open conflict with COO or Parliamentarian decision in flight; disposable daemon and target.
- Steps:
  1. Restart after conflict creation, after arbiter dispatch, and immediately after decision persistence in separate runs.
  2. Reconnect UI/API and allow queued callbacks to drain.
- Expected: one conflict id rehydrates with its participants and state; pending work stays frozen; committed work is not repeated; late callbacks reconcile to the persisted winner.
- Variations: hard kill, graceful restart, and unavailable arbiter engine during recovery.

### SA-16 — Non-responsive arbiter follows bounded contact and fallback rules
- Goal: collision handling cannot wait forever or jump immediately to the most expensive executive path.
- Category: interruption / fallback
- Preconditions: conflict requiring COO or Parliamentarian; shortened recorded timeouts; cheap-tier triage configured; arbiter intentionally silent.
- Steps:
  1. Record the initial arbiter contact and remain silent through its first timeout.
  2. Confirm a second contact to the same arbiter and a fresh timeout window.
  3. Let that expire and inspect fallback/tie-break behavior and selected model.
- Expected: two contacts precede fallback; routine triage uses the first available cheap-tier model; escalation is capped and visible; no conflicting side effect runs merely because the arbiter is absent.
- Observe: ordinary COO/Parliamentarian model defaults remain unchanged.

### SA-17 — Arbitration recursion and ping-pong are bounded
- Goal: COO and Parliamentarian cannot delegate the same conflict back and forth indefinitely.
- Category: concurrency / recovery
- Preconditions: conflict payload that causes each arbiter to request the other's opinion; session and cost counters visible.
- Steps:
  1. Let COO consult Parliamentarian and Parliamentarian attempt to consult COO on the same conflict id.
  2. Repeat callbacks, retries, and one model fallback.
  3. Wait through the documented terminal timeout.
- Expected: the conflict id/depth guard prevents recursive arbitration sessions; a finite cap ends in a COO final choice or visible human checkpoint; costs and session counts remain bounded.
- Observe: no generic manager fan-out enforcement should treat an arbitration callback as a new task.

### SA-18 — Model fallback invalidates delegated human authority
- Goal: an eligible delegate cannot retain operator power after falling to an unapproved model.
- Category: fallback / authorization
- Preconditions: active delegated COO or Program Manager turn on GPT-5.5, GPT-5.6-sol, Opus 4.8, or Fable; reversible decision T; forced fallback to a model outside that list.
- Steps:
  1. Trigger fallback before the delegate resolves T.
  2. Attempt the resolution with the original token and from the resumed fallback turn.
  3. Return to an allowed model without a new human grant and retry.
- Expected: every post-fallback attempt fails `403`; returning to an allowed model does not resurrect the expired/mismatched grant; a fresh direct-human grant is required.
- Observe: fallback handoff text and copied context cannot mint a new grant.

### SA-19 — Priority storm does not starve ordinary work or operator input
- Goal: a flood of low-priority cross-agent messages cannot hide supervisor, arbiter, or human instructions.
- Category: stress / concurrency
- Preconditions: session tree at configured concurrency cap; 100 uniquely numbered advisory/status messages; one supervisor instruction, one arbiter response, and one direct human cancel.
- Steps:
  1. Flood advisories while delivering the three higher-priority messages at known offsets.
  2. Track queue positions, processing latency, drops/coalescing, and final target state.
  3. Refresh and restart while the queue drains.
- Expected: direct human and authoritative control messages are handled within a bounded priority SLA; ordinary messages either process or are explicitly coalesced/backpressured; no silent loss, starvation, or cross-session attribution occurs.
- Variations: queue full, one engine rate-limited, and repeated child completion callbacks.

### SA-20 — Conflict audit is complete, bounded, and explainable
- Goal: an operator can reconstruct why an instruction won without reading private raw transcripts.
- Category: persistence / navigation
- Preconditions: completed SA-03, SA-04, SA-06, SA-12, and one unresolved conflict; access to session detail, Approvals/checkpoints, activity, and run-bundle export.
- Steps:
  1. For each conflict, correlate conflict id, target/generation, instruction ids, server-owned actors, precedence reason, arbiter contacts, winner, loser disposition, timestamps, and resulting action.
  2. Export the run bundle; restart and repeat the read.
  3. Verify secrets and unrelated transcript content are absent.
- Expected: every transition is attributable and survives restart; the UI states who is deciding and why work is frozen; export contains bounded evidence but no tokens; unresolved conflicts remain actionable rather than appearing finished.
- Observe: audit ordering must use durable ids/sequences and distinguish proposed, selected, committed, superseded, canceled, and stale states.

### SA-21 — Agent-to-human communication produces a visible durable indicator
- Goal: the user can tell from outside a chat that an agent has addressed them.
- Category: navigation / persistence
- Preconditions: agent session A not currently open; chat sidebar visible in another session; no board dependency.
- Steps:
  1. Have A send a uniquely marked agent-to-human notification while the user remains in another chat.
  2. Inspect All, Focused, Rooms, and any global attention/approval surface without opening A.
  3. Refresh and restart before opening A, then locate the marker and open it.
- Expected: A shows a durable, accessible indicator identifying new agent communication; the signal survives refresh/restart and clears only under the documented read/acknowledge rule; it does not require a Kanban ticket or board file.
- Observe: browser notification permission may enhance the signal but cannot be the only in-app indicator.

### SA-22 — FYI, reply requested, and approval required are distinguishable
- Goal: the user can prioritize agent messages without opening every unread session.
- Category: navigation / authorization
- Preconditions: three fresh sessions capable of emitting an FYI closure, a question requiring a reply, and a durable checkpoint/approval.
- Steps:
  1. Emit all three while viewing a fourth session.
  2. Compare sidebar text/icon/accessible labels and the Approvals surface.
  3. Open each in descending urgency and perform the required response where applicable.
- Expected: approval/checkpoint has highest attention; reply requested is visibly actionable but not mislabeled as approval; FYI is unread/informational and does not pulse forever; resolved items downgrade or clear without hiding unread content.
- Observe: color alone is insufficient; screen-reader labels and persistent text must carry the semantic distinction.

### SA-23 — Missing Kanban board falls back to attention, not chat-only memory
- Goal: failure to persist a backlog/board item cannot make the agent's human-facing follow-up invisible.
- Category: recovery / empty state
- Preconditions: department without `board.json`; agent discovers a real residual follow-up and a board write is unavailable or policy-blocked.
- Steps:
  1. Have the agent attempt the supported tracking path and encounter the missing-board condition.
  2. Leave its chat before the final report arrives.
  3. Inspect sidebar/attention/approval surfaces and restart.
- Expected: the app records a durable human-visible indicator containing owner, follow-up summary, and tracking failure; it does not claim the item is on a board; no board is required merely to notify the user.
- Variations: nonexistent department, read-only board, malformed board, and a healthy-board control where ticket plus indicator link to the same durable item.

### SA-24 — Notification retries coalesce without suppressing escalation
- Goal: repeated callbacks and supervisor reminders do not flood the user, but a material urgency change remains visible.
- Category: concurrency / recovery
- Preconditions: one FYI notification, two supervisor contacts, and a later checkpoint for the same target/generation.
- Steps:
  1. Deliver duplicate FYI/callback messages concurrently and count indicators.
  2. Deliver the second supervisor contact; then escalate to a checkpoint.
  3. Resolve the checkpoint and replay all earlier notifications.
- Expected: duplicates coalesce under one durable thread/item; the second contact updates urgency/history without creating sidebar spam; checkpoint upgrades to `needs_attention`; resolution prevents stale replays from re-alerting.
- Observe: the transcript may retain all source messages, but the operator-facing indicator count must remain coherent.

### SA-25 — Attention lifecycle works across focus, tabs, and devices
- Goal: reading or resolving an agent communication has predictable multi-client semantics.
- Category: persistence / concurrency
- Preconditions: same authenticated operator in two browser tabs or devices; one FYI, one reply-requested item, and one approval-required item.
- Steps:
  1. Open the FYI in tab A while tab B remains on another chat.
  2. Reply to the question in tab B; resolve the approval in tab A.
  3. Reconnect both clients, hard-refresh, and restart the daemon.
- Expected: read state, replied state, and resolved state converge without double acknowledgements; a focused/open chat does not auto-clear a message the user has not actually seen under the documented rule; no resolved item remains falsely urgent.
- Variations: offline tab reconnect, websocket event loss, browser-notification denial, and grouped-room versus flat-session view.

### SA-26 — All view shows one expandable row per agent
- Goal: repeated child tasks do not create a wall of identical top-level agent rows.
- Category: navigation / regression
- Preconditions: one agent has at least four durable sessions spanning two parents and two days; another agent has one session; All view selected.
- Steps:
  1. Refresh the session list and count top-level rows for each agent.
  2. Select the repeated agent row, collapse it, and expand it again.
  3. Refresh and restart the gateway, then repeat the count.
- Expected: All shows exactly one top-level row per agent with the correct chat count; expanding reveals every loaded underlying session in activity order; collapse/expand state is stable under its documented persistence rule.
- Observe: direct Cuttlefish chats and pinned agents obey the same single-row rule; scheduled jobs remain in their separate section.

### SA-27 — Grouping never merges session or supervisor authority
- Goal: visual consolidation cannot broaden transcript access or confuse the active task.
- Category: authorization / navigation
- Preconditions: two sessions under the same worker agent but different parent supervisors, unique codewords, and distinct session-scoped tokens.
- Steps:
  1. Expand the worker row and open each child session in turn.
  2. Read and send with each child token; attempt to read the sibling with the other token.
  3. Collapse the row, select the latest child, and inspect the displayed title, parent, transcript, and outgoing target.
- Expected: both chats remain separately selectable and attributable; no transcript is concatenated; sibling-token access still fails; collapsed-row selection opens only the latest concrete session and sends only there.
- Observe: unread, working, and needs-attention state aggregate visibly without changing which session owns the state.

### SA-28 — Realtime refresh cannot duplicate an agent group
- Goal: websocket invalidation, pagination, and optimistic updates do not reintroduce repeated top-level rows.
- Category: concurrency / persistence
- Preconditions: All view open; one agent with one loaded session; controllable session-create and notification events.
- Steps:
  1. Create three more sessions for that agent while concurrently emitting duplicate invalidation events.
  2. Load more history, rename one child, pin the agent, and hard-refresh during the updates.
  3. Compare durable session ids, the top-level agent-row count, chat badge, expansion list, and keyboard navigation order.
- Expected: one top-level agent row remains; every unique session appears once when expanded; the count converges to server totals; pinning moves the group without cloning it; keyboard order contains no duplicate session id.
- Variations: delete one child, partial bulk-delete failure, and a late completion notification for an older child.

### SA-29 — Shared-room `@mentions` fan out only to durable members
- Goal: a future writable room can notify one or many intended participants without spawning chats or leaking to outsiders.
- Category: authorization / target contract
- Preconditions: writable room fixture with human H, supervisor S, workers W1/W2, outsider X, and server-owned membership records; notifications observable.
- Steps:
  1. Send messages containing `@W1`, `@W1 @W2`, `@all`, an unknown handle, a display-name collision, and escaped/code-form mentions.
  2. Have X forge `@S` text through a session outside the room and attempt to fetch room history.
  3. Remove W2 from membership, mention W2 again, refresh, and replay the original message id.
- Expected: one durable room message is created per send, not one new chat per recipient; only resolved active members receive deduplicated notifications; unknown/ambiguous mentions fail visibly; plain forged text grants no access or authority; replay is idempotent; removal follows the documented history/notification policy.
- Observe: recipient resolution uses server-owned slugs/ids, never model-authored identity claims, and mention priority cannot outrank human/supervisor authority.

### SA-30 — `#topics` organize room work without becoming authority
- Goal: topics make a shared timeline navigable while remaining metadata rather than a privilege or routing bypass.
- Category: navigation / authorization / target contract
- Preconditions: writable room fixture; two authorized members; topic index/search UI; messages with `#incident-a`, `#incident-b`, mixed case, punctuation, Unicode, and code blocks.
- Steps:
  1. Post and filter messages by one and multiple topics; edit or delete a tagged message if supported.
  2. Combine `@mentions` with topics and verify recipient notifications link back to the same room message and active topic filter.
  3. Attempt to use a reserved-looking topic such as `#approval`, `#coo`, or `#urgent` to gain priority or decision authority.
- Expected: normalized topics remain durably searchable across refresh/restart; false positives in URLs/code are handled by the documented parser; edits/deletes update the index coherently; hashtags never grant access, priority, approval, or delegated human authority.
- Observe: notification badges coalesce by durable message id even when a message carries several mentions and topics.
