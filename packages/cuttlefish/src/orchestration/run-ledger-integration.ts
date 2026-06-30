import { v4 as uuidv4 } from "uuid";
import { getRunLedger } from "../run-ledger/index.js";
import { logger } from "../shared/logger.js";
import type { LiveRunContinuationRecord } from "./live-run.js";
import type { Allocation } from "./types.js";

/**
 * Creates a canonical run-ledger entry for an orchestration allocation and
 * immediately transitions it to `running`. Returns the new runId. Call this
 * at the top of `runAllocatedOrchestrationTask` / `runAllocatedDualLaneTask`,
 * after leases are confirmed, mirroring `beginSessionRun`.
 */
export function beginOrchestrationRun(
  allocation: Allocation,
  mode: string,
  taskTitle?: string,
  now?: string,
): string {
  const runId = uuidv4();
  const createdAt = now ?? new Date().toISOString();
  const ledger = getRunLedger();
  ledger.createRun({
    runId,
    sessionId: null,
    source: "orchestration",
    sourceRef: allocation.allocationId,
    engine: "orchestration",
    title: taskTitle ?? `${allocation.taskId}/${allocation.coordinatorId}`,
    promptExcerpt: `mode:${mode}`,
    createdAt,
  });
  ledger.transitionRun({ runId, nextState: "running", at: createdAt });
  return runId;
}

/**
 * Creates a canonical run-ledger entry for a blocked orchestration request
 * (continuation queued, waiting for resources). Returns the new runId.
 * The runId must be stamped on the continuation row so it survives restarts.
 */
export function createBlockedOrchestrationRun(
  taskId: string,
  coordinatorId: string,
  mode: string,
  taskTitle?: string,
  now?: string,
): string {
  const runId = uuidv4();
  const createdAt = now ?? new Date().toISOString();
  const ledger = getRunLedger();
  ledger.createRun({
    runId,
    sessionId: null,
    source: "orchestration",
    sourceRef: `${taskId}:${coordinatorId}`,
    engine: "orchestration",
    title: taskTitle ?? `${taskId}/${coordinatorId}`,
    promptExcerpt: `mode:${mode} blocked`,
    createdAt,
  });
  ledger.transitionRun({ runId, nextState: "blocked", at: createdAt });
  return runId;
}

/**
 * Transitions an orchestration allocation run to `completed`.
 * No-op if the runId is not found (allocation may not have been wired).
 */
export function finalizeOrchestrationRunCompleted(runId: string | undefined, at?: string): void {
  if (!runId) return;
  try {
    getRunLedger().transitionRun({ runId, nextState: "completed", at: at ?? new Date().toISOString() });
  } catch (err) {
    logger.warn(`run-ledger: could not finalize orchestration run ${runId} as completed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Transitions an orchestration allocation run to `failed`.
 * No-op if the runId is not found.
 */
export function finalizeOrchestrationRunFailed(runId: string | undefined, errorMessage: string, at?: string): void {
  if (!runId) return;
  try {
    getRunLedger().transitionRun({ runId, nextState: "failed", errorMessage, at: at ?? new Date().toISOString() });
  } catch (err) {
    logger.warn(`run-ledger: could not finalize orchestration run ${runId} as failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Transitions an orchestration allocation run to `interrupted` or `dead_lettered`
 * based on the retry count, mirroring the recovery logic for sessions.
 */
export function recoverOrchestrationRun(
  continuation: Pick<LiveRunContinuationRecord, "runId" | "retryCount">,
  maxRetries: number,
  errorMessage: string,
  at?: string,
): void {
  const runId = continuation.runId;
  if (!runId) return;
  const nextState = continuation.retryCount >= maxRetries ? "dead_lettered" : "interrupted";
  try {
    getRunLedger().transitionRun({ runId, nextState, errorMessage, at: at ?? new Date().toISOString() });
  } catch (err) {
    logger.warn(`run-ledger: could not recover orchestration run ${runId} to ${nextState}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Transitions an orchestration run to `interrupted` during graceful shutdown.
 * No-op if runId is not set.
 */
export function interruptOrchestrationRun(runId: string | undefined, reason: string, at?: string): void {
  if (!runId) return;
  try {
    getRunLedger().transitionRun({ runId, nextState: "interrupted", errorMessage: reason, at: at ?? new Date().toISOString() });
  } catch (err) {
    logger.warn(`run-ledger: could not interrupt orchestration run ${runId}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Boot-time sweep: finds orchestration runs in non-terminal states with no
 * matching live continuation and transitions them to `dead_lettered`. Called
 * after `recoverStaleDispatchingContinuations()`. Returns the count of runs swept.
 *
 * Running runs use allocationId as sourceRef and are matched by liveAllocationIds.
 * Blocked (queued) runs are matched by their specific runId (from liveBlockedRunIds),
 * not by taskId:coordinatorId key — that key is non-unique and would incorrectly
 * protect stray duplicate blocked runs sharing the same task/coordinator pair.
 */
export function sweepOrphanedOrchestrationRuns(
  liveAllocationIds: Set<string>,
  liveBlockedRunIds: Set<string>,
): number {
  const ledger = getRunLedger();
  const nonTerminal = ledger.listRuns({ states: ["created", "running", "blocked"], engine: "orchestration" });
  let swept = 0;
  const at = new Date().toISOString();
  for (const run of nonTerminal) {
    if (run.sourceRef && liveAllocationIds.has(run.sourceRef)) continue;
    if (liveBlockedRunIds.has(run.runId)) continue;
    try {
      ledger.transitionRun({
        runId: run.runId,
        nextState: "dead_lettered",
        errorMessage: "Run owner not found at boot-time orphan sweep",
        at,
      });
      swept += 1;
    } catch (err) {
      logger.warn(`run-ledger: boot-time sweep could not dead-letter orphaned run ${run.runId}: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (swept > 0) {
    logger.info(`run-ledger: boot-time orphan sweep dead-lettered ${swept} orchestration run(s)`);
  }
  return swept;
}
