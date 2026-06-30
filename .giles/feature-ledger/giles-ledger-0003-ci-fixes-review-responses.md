# Feature Ledger: ci-fixes-review-responses

**feature id:** `ci-fixes-review-responses`

## CI Fixes and Review Comment Responses

**action summary:** Fix 4 CI failures from PR #5 and address all critical/high/medium review comments from Gemini Code Assist and Codex automated reviews.

**status:** complete (pending CI validation)

## CI Failure Fixes

### Fix 1: hasCycle direction bug (artifact-lineage/store.ts)

The DFS in `hasCycle` traversed edges BACKWARDS (following incoming edges instead of outgoing edges), so it could never detect forward cycles. Both cycle tests failed.

**touched files:**
- `packages/cuttlefish/src/artifact-lineage/store.ts` — changed `SELECT from_artifact_id WHERE to_artifact_id = ?` to `SELECT to_artifact_id WHERE from_artifact_id = ?` and push `row.to_artifact_id`

### Fix 2: run bundle export gate (gateway/run-bundles.ts, policy/export-gate.ts)

The `builtin-deny-run-bundle` rule blocked all run bundle exports, causing the existing bundle test to get 500 instead of 201. Also, `mkdirSync` was called before the gate check, leaving orphaned directories on denied exports.

**touched files:**
- `packages/cuttlefish/src/policy/export-gate.ts` — changed `builtin-deny-run-bundle` to `builtin-allow-run-bundle` (allow: true); run bundles are allowed by default, user policy can restrict
- `packages/cuttlefish/src/gateway/run-bundles.ts` — moved gate check before `mkdirSync`

### Fix 3: checkpoint test mock (gateway/__tests__/checkpoints.test.ts)

Pre-existing test bug: mock comment said "do not execute the job" but the code called `job()`, which ran `runWebSession`, which checked `engineAvailable("claude")` → false (binary not in CI PATH) → set session to 'error'. Fixed by actually not running the job.

**touched files:**
- `packages/cuttlefish/src/gateway/__tests__/checkpoints.test.ts` — changed mock to truly skip job execution

## Review Comment Responses

### recoverOrphanedRunsAtStartup: skip orchestration runs (Gemini HIGH)

At server boot, orchestration runs are swept by the orchestration runtime's own boot-time sweep after it initialises. The shared startup sweep incorrectly targeted orchestration runs with empty `liveAllocationIds`.

**touched files:**
- `packages/cuttlefish/src/shared/run-recovery.ts` — removed `liveAllocationIds` param; added `if (run.engine === "orchestration") continue;`
- `packages/cuttlefish/src/gateway/server.ts` — updated call site: `recoverOrphanedRunsAtStartup(liveSessionIds)` (no second arg)

### sweepOrphanedOrchestrationRuns: blocked runs not handled (Gemini CRITICAL, Codex P2)

Blocked (queued) runs use `${taskId}:${coordinatorId}` as `sourceRef`, not `allocationId`. The sweep only checked `liveAllocationIds`, so all queued blocked runs were incorrectly dead-lettered at restart.

**touched files:**
- `packages/cuttlefish/src/orchestration/run-ledger-integration.ts` — added `liveContinuationKeys: Set<string>` parameter; check both allocationId and continuationKey in loop
- `packages/cuttlefish/src/orchestration/runtime.ts` — build `liveContinuationKeys` from `store.listLiveContinuations(["queued"])` and pass to sweep

### Policy loader: invalid action silently dropped (Gemini HIGH, security)

Unknown `action` values silently dropped the constraint, turning the rule into a catch-all. Now `parseRule` returns `null` for rules with invalid action values (fail-safe: reject the whole rule).

**touched files:**
- `packages/cuttlefish/src/policy/loader.ts` — return null from `parseRule` when `raw.action` is defined but not a valid action

### Policy loader: corrupt JSON silently returns empty profile (Gemini HIGH, fail-closed)

Corrupt/invalid JSON was caught and returned `buildDefaultProfile()`, violating fail-closed. Now `parseProfileFile` throws on parse error; callers see the error.

**touched files:**
- `packages/cuttlefish/src/policy/loader.ts` — removed try/catch in `parseProfileFile`; JSON errors propagate

### Policy loader: policyDir not checked for directory (Gemini MEDIUM)

`readdirSync` would throw `ENOTDIR` if `policyDir` existed but was a file.

**touched files:**
- `packages/cuttlefish/src/policy/loader.ts` — added `|| !fs.statSync(policyDir).isDirectory()` to early return guard

### RegExp cache for matchesGlob (Gemini MEDIUM)

`matchesGlob` created a new RegExp on every call. Added a module-level `Map<string, RegExp>` cache.

**touched files:**
- `packages/cuttlefish/src/policy/evaluator.ts` — added `_globRegexpCache` Map

### CLI ledger renameSync error handling (Gemini MEDIUM)

`fs.renameSync` can throw if the DB file is locked (gateway running). Wrapped in try/catch with a helpful error message.

**touched files:**
- `packages/cuttlefish/src/cli/ledger.ts` — wrapped renameSync calls in try/catch

### UNIQUE constraint on run_artifact_xref (Gemini MEDIUM)

Added `UNIQUE(run_id, artifact_id, relation)` constraint to `run_artifact_xref` table. The existing `INSERT OR IGNORE` already handles duplicates; the constraint makes the intent explicit in the schema.

**touched files:**
- `packages/cuttlefish/src/artifact-lineage/store.ts` — added UNIQUE constraint to CREATE TABLE

### Codex P1: invalid policy action is fail-open (Codex P1)

`parseRule` returned `null` for unknown `action` values, silently dropping the rule. A typo (e.g. "exprot" instead of "export") would cause a deny rule to vanish, leaving the gate open. Now `parseRule` throws so `parseProfileFile` propagates the error — the whole policy file is rejected on invalid action (fail-closed).

**touched files:**
- `packages/cuttlefish/src/policy/loader.ts` — changed `return null` to `throw new Error(...)` in parseRule for invalid action

### Codex P2: UNIQUE constraint on existing xref tables (Codex P2, already fixed)

Codex reviewed commit `9ba9dc1` and correctly noted that `CREATE TABLE IF NOT EXISTS` skips existing tables. This was already addressed in commit `f230234` which added `CREATE UNIQUE INDEX IF NOT EXISTS idx_lineage_xref_unique ON run_artifact_xref (run_id, artifact_id, relation)` as a standalone statement that runs on every `open()` call — applying the constraint to existing databases.

## Validation Run

- CI all green (build, giles, unit-tests, typecheck) on commit f230234
- Domain drift guard: CLEAN
- TypeScript: no new type errors in changed files

## Remaining Open Items

- `run-mode.ts`: blocked run resume creates a new run instead of transitioning the saved blocked run (Codex P2) — deferred, requires careful orchestration logic
- `config.policy.dir`: config value accepted but all call sites hardcode `POLICY_DIR` (Codex P2) — deferred, low risk since POLICY_DIR already reads from env
- Documentation updates (ARCHITECTURE.md, TEST_LEDGER.md) — not yet written

### Codex P2: dedup xrefs before unique index (Codex P2)

`CREATE UNIQUE INDEX` on an existing table fails if duplicate rows already exist. Added a DELETE dedup statement in CREATE_SCHEMA, before the `CREATE UNIQUE INDEX` — keeps the row with `MIN(xref_id)` per `(run_id, artifact_id, relation)` group. No-op on new or already-clean databases.

**touched files:**
- `packages/cuttlefish/src/artifact-lineage/store.ts` — added DELETE dedup before CREATE UNIQUE INDEX

### Codex P2: recover orchestration runs when runtime is disabled (Codex P2)

When `config.orchestration.enabled` is not true, `createGatewayOrchestrationRuntime` returns `undefined` and the runtime sweep never runs. Orchestration-engine runs were skipped unconditionally by `recoverOrphanedRunsAtStartup`, leaving them non-terminal forever. Added `orchestrationEnabled` parameter (default true); when false, orchestration runs are recovered as `interrupted` by the startup sweep.

**touched files:**
- `packages/cuttlefish/src/shared/run-recovery.ts` — added `orchestrationEnabled` parameter
- `packages/cuttlefish/src/gateway/server.ts` — pass `currentConfig.orchestration?.enabled === true`

## Validation Run

- CI all green (build, giles, unit-tests, typecheck) on commit 82f04db
- Domain drift guard: CLEAN
- TypeScript: no new type errors in changed files

## Remaining Open Items

- `run-mode.ts`: blocked run resume creates a new run instead of transitioning the saved blocked run (Codex P2) — deferred, requires careful orchestration logic
- `config.policy.dir`: config value accepted but all call sites hardcode `POLICY_DIR` (Codex P2) — deferred, low risk since POLICY_DIR already reads from env
- Documentation updates (ARCHITECTURE.md, TEST_LEDGER.md) — not yet written

### Codex P2: sweep orphaned runs by runId not taskId:coordinatorId key (Codex P2)

`sweepOrphanedOrchestrationRuns` used `liveContinuationKeys` (a set of `${taskId}:${coordinatorId}` strings) to protect blocked runs from dead-lettering. This key is non-unique: if two blocked runs share the same task/coordinator pair, both are protected even though only one has a matching live continuation. Changed to match by the specific `runId` stored on each live continuation — only the exact run referenced by a live queued continuation is protected.

**touched files:**
- `packages/cuttlefish/src/orchestration/run-ledger-integration.ts` — renamed param `liveContinuationKeys` → `liveBlockedRunIds`; check `liveBlockedRunIds.has(run.runId)` instead of key-based sourceRef match
- `packages/cuttlefish/src/orchestration/runtime.ts` — build `liveBlockedRunIds` from `listLiveContinuations(["queued"]).map(c => c.runId).filter(Boolean)`

## Provenance

CI-fix and review-response pass for PR #5 and PR #6, 2026-06-30. All changes verified against CI failure logs and reviewer comments.
