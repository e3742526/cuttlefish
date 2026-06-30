import fs from "node:fs";
import { logger } from "./logger.js";
import { getRunLedger } from "../run-ledger/index.js";
import { OrchestrationStore } from "../orchestration/store.js";

/**
 * Reads the persisted orchestration store (if it exists) and returns the set
 * of run-ledger `sourceRef` values that correspond to live (non-terminal)
 * orchestration continuations.  Used at boot time to avoid false-positive
 * orphan sweeps of runs that belong to an orchestration runtime that has not
 * yet been instantiated.
 *
 * Two sourceRef shapes are used by the run-ledger integration layer:
 *   - dispatching continuations  →  `allocation.allocationId`  (UUID)
 *   - queued/blocked continuations  →  `${taskId}:${coordinatorId}`
 *
 * Returns an empty Set when the DB file does not exist or cannot be read,
 * so the caller degrades gracefully when orchestration has never been used.
 */
export function getLiveOrchestrationSourceRefs(orchDbPath: string): Set<string> {
  if (!fs.existsSync(orchDbPath)) return new Set();
  try {
    const store = OrchestrationStore.open(orchDbPath, { recoverCorrupt: false });
    try {
      const continuations = store.listLiveContinuations(["queued", "dispatching"]);
      const refs = new Set<string>();
      for (const c of continuations) {
        if (c.state === "dispatching" && c.allocationId) {
          refs.add(c.allocationId);
        } else if (c.state === "queued") {
          refs.add(`${c.task.taskId}:${c.coordinatorId}`);
        }
      }
      return refs;
    } finally {
      store.close();
    }
  } catch (err) {
    logger.warn(`run-recovery: could not read orchestration store for live source refs — orphan sweep will cover orchestration runs: ${err instanceof Error ? err.message : err}`);
    return new Set();
  }
}

/**
 * Boot-time scan for orphaned run-ledger entries in non-terminal states.
 * Any run with no corresponding live session is transitioned to `interrupted`.
 * When orchestration is enabled, orchestration-engine runs are intentionally
 * skipped here because the orchestration runtime's own boot-time sweep handles
 * them with finer-grained logic (blocked-run continuation keys, etc.).
 * When orchestration is disabled, the runtime sweep never runs, so this
 * function recovers orchestration-engine runs too.
 *
 * Recovery NEVER maps to `completed`; fail-closed rule.
 *
 * @param liveSessionIds Set of session IDs that are actively running.
 * @param orchestrationEnabled Whether the orchestration runtime will sweep its own runs.
 * @returns Count of runs swept.
 */
export function recoverOrphanedRunsAtStartup(
  liveSessionIds: Set<string>,
  orchestrationEnabled = true,
): number {
  const ledger = getRunLedger();
  const nonTerminal = ledger.listRuns({ states: ["created", "running", "blocked"] });
  let swept = 0;
  const at = new Date().toISOString();
  for (const run of nonTerminal) {
    // Orchestration runs are handled by the runtime's own boot-time sweep when enabled.
    if (run.engine === "orchestration" && orchestrationEnabled) continue;
    const isLiveSession = run.sessionId !== null && liveSessionIds.has(run.sessionId);
    if (isLiveSession) continue;
    try {
      ledger.transitionRun({
        runId: run.runId,
        nextState: "interrupted",
        errorMessage: "Run owner not found at startup recovery",
        at,
      });
      swept += 1;
    } catch (err) {
      logger.warn(`run-recovery: could not mark orphaned run ${run.runId} as interrupted: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (swept > 0) {
    logger.info(`run-recovery: startup scan marked ${swept} orphaned run(s) as interrupted`);
  }
  return swept;
}
