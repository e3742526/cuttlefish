# 14 — Authorization, Pairing, and Approval Gates

File `08` covers the core checkpoint gate, reject path, persistence, and
orchestration hold/recovery (`AP-01`–`AP-08`). File `09` covers a basic
pairing round-trip (`ST-07`). This file covers the *authorization* layer
around those gates: who may approve, what scoped agents may not do,
remote-access pairing under `authRequired`, security-hook checkpoints,
org-change proposal binding, decision vocabulary beyond approve/reject,
and session-token hygiene.

Safety: use a disposable home and test pairing codes only. Never paste
real operator credentials or live session tokens into prompts, tickets, or
scenario notes.

---

### AZ-01 — Org-change proposal binds to originating chat and needs operator approval
- Goal: a chat-originated org change appears in both the chat review card and `/approvals`, and only an authenticated operator can resolve it.
- Category: happy path / authorization
- Preconditions: gateway running; a human chat session that can propose an org change (hire/edit/delete path your build exposes).
- Steps:
  1. From chat, propose a small reversible org change (e.g. add a disposable test employee).
  2. Confirm a pending item appears in the chat UI and in `/approvals` for the same decision.
  3. Attempt to resolve it by pasting "approved" prose back into the *agent* chat (or any scoped agent token path).
  4. As operator, approve from `/approvals` (or the authenticated review control).
- Expected: agent prose and scoped tokens cannot resolve the change; operator approval applies it once; the originating session's card updates; no double-apply.
- Observe: approver identity and timestamp are recorded on the decision.

### AZ-02 — Operator rejection and revise/defer vocabulary
- Goal: checkpoint decisions are not a boolean — `deferred` and `revised` are real outcomes.
- Category: happy path / delete-undo
- Preconditions: a flow that opens a human checkpoint with multiple allowed options (security PreToolUse gate, email screening checkpoint, or generic `POST /api/checkpoints` test harness).
- Steps:
  1. Trigger a checkpoint; choose **deferred**; confirm the run stays paused and the item remains findable.
  2. Trigger or reuse a checkpoint; choose **revised** with notes; confirm notes persist and the resulting action matches design.
  3. Approve a separate item with decision notes; reject another.
- Expected: each decision badge (`approved` / `rejected` / `deferred` / `revised`) renders distinctly on `/approvals`; notes and resulting actions survive restart; deferred work does not silently expire without saying so.

### AZ-03 — Security PreToolUse / risky Bash becomes a durable checkpoint
- Goal: review-gated engine commands pause for a human instead of executing.
- Category: interruption / authorization
- Preconditions: Claude interactive path with PreToolUse hooks enabled; an employee/session whose `approvalPolicy` / `reviewTriggers` gate a known risky command category; disposable workspace.
- Steps:
  1. Prompt the agent to run a review-gated shell command (use a *harmless* gated pattern your config treats as risky — e.g. a matched prefix that only echoes).
  2. Confirm the command did not execute; a checkpoint appears with command text and trigger categories.
  3. Approve; confirm the intended resulting action (resume / run / skip) matches the checkpoint contract.
  4. Repeat and reject.
- Expected: deny-at-hook, durable checkpoint, senior-security-officer (or configured `securityReviewer`) context when designed; rejection leaves no partial side effect from the blocked command.
- Variations: employee `approvalPolicy: notify` (looser) — risky action may continue with a session notification instead of a hard gate; confirm that mode is explicit and still audited.

### AZ-04 — Inbound untrusted content opens human review, not auto-dispatch
- Goal: email/connector content that fails screening becomes a checkpoint rather than an engine prompt.
- Category: recovery / files
- Preconditions: a test IMAP or connector path; ability to inject a message that fails untrusted-content screening (or an attachment that is unsupported/oversized). Use throwaway inboxes only.
- Steps:
  1. Deliver the failing message/attachment.
  2. Watch `/approvals` and any connector session list — engine must not have already answered.
  3. As operator, approve or reject the review item.
- Expected: human-review checkpoint opens; no automatic agent turn on unscreened content; supported text, when eventually released, is wrapped as untrusted data rather than raw trust.
- If no connector credentials exist, Not executed — environment unavailable.

### AZ-05 — Pairing codes under authentication enabled vs. disabled
- Goal: the remote-access panel's pairing controls match `authRequired`.
- Category: settings / authorization
- Preconditions: ability to toggle gateway authentication in the disposable home's config and restart.
- Steps:
  1. With authentication **disabled**, open the remote-access / pairing panel — "Create pairing code" should be hidden with an explanatory note.
  2. Enable authentication; restart; from the **local** dashboard create a pairing code; pair a second browser.
  3. From a non-local / unpaired context (if simulable), confirm create is disabled with a "use local Mac dashboard" style hint when `canBootstrapLocal` is false.
  4. Unpair; confirm access is revoked on next request per design.
- Expected: controls never imply pairing works when auth is off; codes expire/reject when stale; paired list is accurate after refresh and restart.

### AZ-06 — Session-scoped token cannot reach operator collections
- Goal: scoped agent credentials stay inside the documented own-session/delegation envelope.
- Category: authorization / boundary
- Preconditions: a running agent session that exposes `CUTTLEFISH_SESSION_TOKEN` only to its engine subprocess (retrieve via a controlled test harness or gateway debug path if one exists for playtests — do not scrape logs for secrets in shared environments).
- Steps:
  1. With the scoped token, attempt operator-wide reads: email collection, knowledge outbox, orchestration holds, skills removal, session archive of *another* session, filesystem discovery outside own attachments.
  2. Attempt allowed own-session operations (status, own attachments, documented delegation).
- Expected: operator-wide routes deny; own-session routes succeed; raw token never appears in model-visible context or UI transcripts.
- If the token cannot be obtained safely, Not executed — environment unavailable; still verify from the human UI that archive/skills-remove controls are operator-facing only.

### AZ-07 — Manager identity binding on employee PATCH
- Goal: a session-scoped caller cannot claim a foreign manager identity.
- Category: authorization
- Preconditions: two managers M1 and M2; a scoped session bound to M1 (or API caller simulating that bind).
- Steps:
  1. As M1-scoped caller, `PATCH` an employee with `managerName: M1` for a legitimate report change (control).
  2. As M1-scoped caller, attempt `managerName: M2` (or another foreign manager).
- Expected: foreign manager claim returns `403`; legitimate self-manager path behaves per product rules; org YAML is not half-written.

### AZ-08 — Concurrent double-decision race on one approval
- Goal: two operators (or two tabs) deciding the same item produce one coherent outcome.
- Category: concurrency / recovery
- Preconditions: a single pending approval; two authenticated browser sessions.
- Steps:
  1. Open the same `/approvals` item in two tabs.
  2. Approve in tab A and reject in tab B as close to simultaneously as possible.
- Expected: exactly one decision wins; the other receives a clear already-decided error; the underlying work is not both resumed and cancelled; queue shows a single terminal state.

### AZ-09 — Approval applies only once; replay is safe
- Goal: replaying an approve request is idempotent enough not to duplicate side effects.
- Category: boundary / recovery
- Preconditions: AZ-01 style org-change or a checkpoint that resumes a session.
- Steps:
  1. Approve the item.
  2. Immediately re-submit the same approve (second click, replayed `POST`, or browser refresh+confirm).
- Expected: no second employee created, no second resume storm; UI shows already-decided; logs may note the replay but work runs once.

### AZ-10 — Disabled orchestration / auth surfaces stay honest under authorization stress
- Goal: turning features off does not leave authorized-looking dead controls.
- Category: settings / empty state
- Preconditions: ability to set `orchestration.enabled: false` and (separately) review `/approvals` with zero pending items.
- Steps:
  1. Disable orchestration; visit `/orchestration` and attempt hold/create actions.
  2. With an empty approvals queue, confirm empty state (not a spinner forever).
  3. Re-enable; confirm authorized operator controls return.
- Expected: disabled = explained; empty = intentional empty state; re-enable restores function without a daemon reinstall.
