# 12 — Failover and Fallback

Cuttlefish is a bus across engines; failover is how it stays useful when a
rung is exhausted, unsigned-in, or rate-limited. File `02` already has a
opportunistic rate-limit card (`CH-08`) and a crash card (`CH-07`); this
file covers *configured* fallback: same-engine employee fallback models,
multi-role role failover chains, reviewer loss policies, orchestration
headroom filtering, and default Fable→Opus style policy visibility.

Feature anchors: employee optional same-engine fallback model; multi-role
`fallbackChain` (≤5, engine+model or external `{ employee }`); reviewer
loss policies (`block`, `replace_then_block`, `replace_then_degrade`,
`degrade`); `executionRunState.fallbackActive` / `degraded` /
`degradedReason`; orchestration usage-aware headroom before leases;
default model-fallback chain continuing on Claude Opus when Fable cannot
continue (employee-owned policy still wins).

Enable `features.multiRoleEmployeeExecution: true` for the multi-role
cards; restore the prior value after the pass.

---

### FO-01 — Employee same-engine fallback model activates on primary loss
- Goal: when the primary model cannot serve a turn, the configured same-engine fallback is used and disclosed.
- Category: recovery / happy path
- Preconditions: an employee whose primary model can be forced unavailable (uninstall/unauth, or pick a deliberately invalid primary model string if the UI allows saving it) and whose `fallback` / same-engine fallback model is a working model on the same engine.
- Steps:
  1. Confirm the employee YAML (or `/org` detail) shows primary + fallback.
  2. Start a session as that employee; send a short prompt that would normally succeed on the fallback.
  3. Watch session state, UI chrome, and `/activity` for fallback signals.
- Expected: the run either succeeds on the fallback or fails with an explicit "primary unavailable, fallback also failed" story — never a silent swap with the primary still labeled as active.
- Observe: is `fallbackActive` (or equivalent UI copy) visible to a non-API operator?

### FO-02 — Role failover chain walks in configured order
- Goal: multi-role reviewer/implementer failover resolves rungs in order, skipping unavailable ones.
- Category: recovery / concurrency
- Preconditions: multi-role flag on; an employee with `execution.tier: mid_pair` and a reviewer `fallbackChain` of at least two rungs where rung 1 is unavailable (bad engine, unsigned-in) and rung 2 is healthy; `replace_then_degrade` or `replace_then_block` loss policy.
- Steps:
  1. Dispatch a short implementer+reviewer task to that employee.
  2. Watch child/internal sessions and parent `executionRunState` (API or any UI surface that exposes it).
  3. Confirm which reviewer target actually ran.
- Expected: rung 1 is skipped (or fails fast); rung 2 serves the review; parent remains `running` until the loop settles; no attempt to use a self-referential or unknown employee target.
- Variations: reverse the chain so the healthy rung is first — failover must not walk past a working rung.

### FO-03 — Failover chain entry defers to an external org employee
- Goal: a chain entry `{ employee: name }` resolves that employee's engine/model/effort at dispatch time.
- Category: recovery / settings
- Preconditions: multi-role on; employee A with a reviewer chain entry pointing at employee B; B on a distinct working engine/model.
- Steps:
  1. Run a mid-pair task on A that requires a reviewer.
  2. Force A's primary reviewer allocation to fail (or put an unavailable primary rung ahead of the external entry).
  3. Inspect the reviewer session attribution.
- Expected: the external agent resolves to B's live engine/model/effort; the parent records which employee actually reviewed; B is not mutated into an internal role org member.

### FO-04 — Reviewer loss policies: block vs. degrade
- Goal: each configured loss policy produces a distinct, honest terminal outcome when no reviewer can be allocated.
- Category: recovery / boundary
- Preconditions: multi-role on; ability to make *all* reviewer rungs unavailable (no signed-in engines for those targets).
- Steps:
  1. Configure policy `block`; run a mid-pair task; record terminal parent state and any `degradedReason`.
  2. Reconfigure to `degrade` (or `replace_then_degrade` with an empty/unusable chain); run again.
  3. Optionally exercise `replace_then_block` with a chain that exhausts.
- Expected:
  - `block` / exhausted `replace_then_block`: parent does not silently claim a successful reviewed result; failure/blocked is explicit.
  - `degrade` / exhausted `replace_then_degrade`: parent may complete as solo/degraded with `degraded` + reason populated — never presented as a clean reviewed pass.
- Observe: does the web UI currently hide review status (known fidelity gap)? If so, confirm the API still tells the truth and note UI gap as Note, not as a new product regression unless it claims success falsely.

### FO-05 — Failover chain validation rejects bad configs at save time
- Goal: illegal chains never reach runtime.
- Category: invalid input / boundary
- Preconditions: `/org` employee editor with multi-role UI, or the employee create/update API.
- Steps / Variations (each a save attempt):
  1. Chain longer than 5 rungs.
  2. Self-referential external employee entry (points at the same employee).
  3. Unknown employee name in an external entry.
  4. Entry that sets both `employee` and `engine`+`model` (XOR violation).
  5. Duplicate engine+model rungs (if the UI allows typing them).
- Expected: structural validation rejects with a named error; nothing partial is written; previously valid profile remains intact.

### FO-06 — Primary engine process dies; configured fallback path is attempted
- Goal: a mid-run engine death interacts cleanly with fallback policy rather than wedging the session forever.
- Category: recovery / interruption
- Preconditions: FO-01 style employee with a working fallback; shell access to kill the engine child (not the gateway).
- Steps:
  1. Start a long-running task on the primary.
  2. `kill -9` the engine CLI child mid-stream.
  3. Watch session status and whether a fallback retry or a clean interrupted/failed terminal state appears.
- Expected: no infinite "running"; either a documented retry on the fallback or an interrupted/failed state with enough context to re-run; gateway stays healthy; concurrent sessions unaffected.
- Note: do not require a specific retry policy — require honesty and recoverability. Cross-check `CH-07` for crash-status conventions (`Interrupted:` prefix on Pi).

### FO-07 — Rate-limit / usage-limit recovery with fallback configured
- Goal: when a real usage limit hits, configured fallback or the limits surface tells an operator what to do next.
- Category: recovery / error clarity
- Preconditions: hardest to force — use the smallest-quota engine, a near-exhausted Kiro credit budget estimate, or record Not executed when no limit can be induced safely.
- Steps:
  1. Drive work until the engine reports a rate or credit limit.
  2. Check the session, `/limits`, and any fallback activation.
- Expected: limit is named (not a generic 500); `/limits` moves; if fallback is configured and applicable, handoff is visible; if not, the operator is not left with a zombie run.
- Observe: Kiro gauge remains labeled as an *estimate* even when a real exhaustion event arrives.

### FO-08 — Orchestration lease skips unavailable or exhausted engines
- Goal: live orchestration allocation filters engines with no headroom before creating leases.
- Category: recovery / concurrency
- Preconditions: orchestration enabled; a matrix/run that would prefer an engine you can mark unavailable or exhaust (unsigned-in, stopped binary, or artificially low headroom if exposed).
- Steps:
  1. Launch the smallest live orchestration run that allocates workers.
  2. With one candidate engine unavailable, confirm leases land only on healthy engines or the run fails with a clear allocation error.
  3. Compare against a dry-run (inert) of the same matrix — dry-run must not claim a live lease.
- Expected: no lease on an unavailable engine; failure modes are operator-readable on `/orchestration`; simulation/dry-run stays deterministic and side-effect free.

### FO-09 — Default Fable→Opus fallback policy is legible
- Goal: the product's default model-fallback chain (Fable 5 → Claude Opus at Max when Fable cannot continue) is either exercised or clearly documented in operator-visible surfaces when it fires.
- Category: recovery / settings
- Preconditions: environment where Fable is the configured default/primary and Opus is available; otherwise Not executed — environment unavailable (do not invent a fake Fable outage).
- Steps:
  1. Run a task on an employee/session that would use Fable under default policy.
  2. If a real Fable continuation failure occurs (or can be safely simulated per current docs), watch for Opus takeover.
- Expected: when the default chain fires, the operator can tell which model finished the work; employee-specific fallback policy still overrides defaults when set.
- Observe: COO / seed persona defaults match the documented Fable-to-Opus posture without surprising model thrash on every turn.

### FO-10 — Concurrent failures do not cascade across unrelated sessions
- Goal: one employee's failover storm does not poison the gateway or sibling sessions.
- Category: concurrency / recovery
- Preconditions: three sessions — A (broken primary with fallback), B (healthy), C (healthy other engine if available).
- Steps:
  1. Trigger repeated primary failures on A (invalid model, killed process, or forced limit).
  2. Keep B and C producing normal short replies throughout.
- Expected: B and C complete cleanly; gateway `status` stays healthy; A's failures remain scoped to A; no global restart or session-list corruption.
