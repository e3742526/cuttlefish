# 13 — Inter-Agent Communication

Cuttlefish's differentiator is not a single chat — it is agents talking to
agents: manager delegation, `/talk` multi-party sessions, cross-department
service requests, mid-pair implementer↔reviewer loops, and the rules that
stop scoped agent tokens from rewriting the bus. File `03` covers org
CRUD and a core delegation happy path (`ORG-06`–`ORG-09`); this file
stresses the *communication* seams those cards only touch.
File `19` covers the deeper handoff lifecycle: direct-child result recovery,
two-contact supervisor acknowledgement, background drain, synthesis generations,
operator attention, and aggregate job completion.

Feature anchors: manager child-session delegation and `manager_delegation`
telemetry; `/talk` rehydration, dock dismiss tombstones, shared Talk
engine/model config protected from scoped tokens; `POST /api/org/cross-request`
and `provides:` services; mid-pair internal implementer/reviewer sessions
with depth guard; HR human-only exclusion from automated routing; session
tokens limited to own-session/delegation operations.

---

### IA-01 — Manager fan-out with explicit attribution chain
- Goal: a naturally splittable task produces child sessions the operator can follow without guesswork.
- Category: happy path / concurrency
- Preconditions: manager with ≥2 direct reports on working engines; multi-turn chat as the manager.
- Steps:
  1. Prompt the manager to assign distinct subtasks to two named reports and synthesize.
  2. Open each child live; note parent linkage, prompts, and completion.
  3. Read the parent's final synthesis and `/activity` for the fan-out.
- Expected: children are visibly parented; each report only receives its slice (no whole-task leakage); parent waits with an honest state; synthesis cites children rather than inventing their work.
- Observe: any `manager_delegation` style telemetry or UI counters for child counts before/after the engine run.

### IA-02 — Child reports back; parent does not re-fan-out on callback
- Goal: an untyped or summary callback from child to manager does not trigger an accidental second fan-out.
- Category: concurrency / recovery
- Preconditions: IA-01 style org; ability to send a follow-up into the parent after children complete (or observe automatic callbacks).
- Steps:
  1. Complete a two-child delegation.
  2. From a child session (or via whatever callback path exists), push a short status update toward the parent.
  3. Watch whether the parent spawns *new* children without a new human prompt.
- Expected: status aggregation does not silently re-delegate the original task; if re-delegation requires a new human turn, the UI makes that clear.
- Note: prior live playtests flagged untyped child-to-manager callbacks as a residual risk — treat unexpected re-fan-out as High.

### IA-03 — Delegation depth and recursion guards
- Goal: delegated children do not recursively explode the org.
- Category: boundary / concurrency
- Preconditions: three-level hierarchy (exec → manager → IC); multi-role depth guard relevant if mid_pair is also enabled on a mid-level manager.
- Steps:
  1. Ask the executive to delegate a research task that the manager might further split.
  2. If multi-role is on for a role session, confirm internal roles do not spawn additional execution profiles (`executionDepth` guard).
- Expected: depth is bounded by design; the operator sees a finite, inspectable tree; runaway session creation is blocked or capped with a visible reason.

### IA-04 — `/talk` turn-taking and attribution under reload
- Goal: multi-agent talk remains a coherent conversation when the human is impatient.
- Category: happy path / interruption
- Preconditions: ≥2 employees on working engines; `/talk` reachable.
- Steps:
  1. Start a talk on a concrete topic with two participants.
  2. After a few turns, hard-refresh; confirm rehydration and that dismissed docks (if any) stay dismissed.
  3. Open the same talk in a second browser window; send from one, watch the other.
- Expected: speaker attribution is unambiguous; reload reconnects; multi-window does not duplicate turns or scramble order.
- Variations: dismiss one participant mid-talk; confirm they leave the active dock set and do not keep generating turns.

### IA-05 — Scoped agent cannot change shared Talk engine/model
- Goal: Talk's shared configuration is operator-owned.
- Category: settings / authorization
- Preconditions: an in-flight talk session; a session-scoped agent token or an agent-driven path that attempts config changes (use documented API with `CUTTLEFISH_SESSION_TOKEN` from a child session if exposed to the test shell — never log the raw token).
- Steps:
  1. As operator, note Talk engine/model.
  2. Attempt to change shared Talk engine/model via a scoped agent credential or agent tool path.
  3. Re-check Talk config as operator.
- Expected: scoped attempt is denied; operator config unchanged; denial is explicit in logs/API without leaking the token into model context.
- If no scoped-token harness is available, mark Not executed — environment unavailable and note the gap.

### IA-06 — Cross-department service request happy path
- Goal: department A can request a named service from department B with a full trace.
- Category: happy path / navigation
- Preconditions: employee in dept A; employee in dept B with `provides: [{ name, description }]` for a test service (e.g. `copy-edit`); both on working engines.
- Steps:
  1. From an A-owned session (or the documented `POST /api/org/cross-request` path), request the service with a short prompt.
  2. Open the provider-owned session; confirm the cross-service brief and engine/model.
  3. Follow to completion; inspect `transportMeta.crossRequest` style linkage (API or UI).
- Expected: provider session is created and dispatched; managers/route metadata are present; both sides can find the work; no silent drop.
- Variations: request a service no one provides — expect `422` / `no_service_provider` with an available-service inventory, not a hang.

### IA-07 — Mid-pair implementer ↔ reviewer communication
- Goal: internal roles exchange enough context for a real review without becoming org members.
- Category: happy path / concurrency
- Preconditions: multi-role flag on; employee with `mid_pair` profile; disposable workspace cwd with a tiny change the implementer can make.
- Steps:
  1. Assign a small edit+review task.
  2. Watch implementer session produce a change; watcher reviewer receive diff or summary-only context.
  3. If the reviewer requests revision, confirm a bounded revision pass (not infinite).
- Expected: internal roles appear as runtime sessions only; reviewer stays read-only by default; parent `executionRunState` shows review context mode (`diff` vs `summary_only`) and any degradation reason; invalid reviewer JSON triggers at most one repair retry before loss policy.
- Observe: known UI gap for live review progress — API truth still required.

### IA-08 — Agent-to-agent path cannot page HR
- Goal: HR / Org Steward remains human-only even when agents try to route through it.
- Category: authorization / recovery
- Preconditions: `hr-manager` present; a manager or automated path that might choose HR (cross-service discovery, board dispatch, or child session with `employee=hr-manager`).
- Steps:
  1. From an agent/parented session, attempt to open or delegate work to `hr-manager`.
  2. Attempt to discover HR via cross-service routing if HR accidentally lists a service.
- Expected: `403` / `hr_human_only` (or exclusion from discovery); no HR child session; leader-ack timeouts that would have paged HR fall back to executive or manual human review instead.
- Variations: direct human top-level session *can* use HR (control case).

### IA-09 — Concurrent multi-manager mesh
- Goal: two managers delegating at once do not cross-wire children.
- Category: concurrency
- Preconditions: two disjoint manager trees (M1→R1,R2 and M2→R3,R4) on working engines.
- Steps:
  1. In two browser tabs (or API clients), start comparable fan-out tasks on M1 and M2 simultaneously.
  2. Label each task uniquely ("only mention codeword ALPHA" vs "BRAVO").
  3. Inspect every child prompt and final parent synthesis.
- Expected: no child of M1 receives BRAVO work or vice versa; session graphs remain disjoint; gateway stays healthy under the parallel load.

### IA-10 — Inter-agent handoff of attachments / run resources
- Goal: resources attached on a parent are available to delegated children per design, without leaking secrets.
- Category: files / concurrency
- Preconditions: parent session with a small attached `.txt` resource; manager capable of delegation.
- Steps:
  1. Attach a file whose content includes a unique token string.
  2. Ask the manager to have a report summarize the attachment.
  3. Verify the child actually saw the content (summary contains the token) or that the product explicitly says attachments are not inherited — either way must be consistent and documented by behavior.
- Expected: no crash; if inheritance is supported, the child sees screened content; secret-shaped strings follow redaction rules on any connector-visible path.
