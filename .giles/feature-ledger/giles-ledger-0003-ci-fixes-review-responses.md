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

## Validation Run

- Domain drift guard: CLEAN
- TypeScript: no new type errors in changed files
- Full CI validation required (Node.js 24, pnpm test)

## Remaining Open Items

- `run-mode.ts`: blocked run resume creates a new run instead of transitioning the saved blocked run (Codex P2) — deferred, requires careful orchestration logic
- `config.policy.dir`: config value accepted but all call sites hardcode `POLICY_DIR` (Codex P2) — deferred, low risk since POLICY_DIR already reads from env
- Documentation updates (ARCHITECTURE.md, TEST_LEDGER.md) — not yet written

## Provenance

CI-fix and review-response pass for PR #5, 2026-06-30. All changes verified against CI failure logs and reviewer comments.
