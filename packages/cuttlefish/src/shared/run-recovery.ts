import { logger } from "./logger.js";
import { getRunLedger } from "../run-ledger/index.js";

/**
 * Boot-time scan for orphaned session-engine run-ledger entries in non-terminal
 * states. Any session-engine run with no corresponding live session is transitioned
 * to `interrupted`. Orchestration-engine runs are intentionally skipped here;
 * they are handled by the orchestration runtime's own boot-time sweep after it
 * initialises.
 *
 * Recovery NEVER maps to `completed`; fail-closed rule.
 *
 * @param liveSessionIds Set of session IDs that are actively running (post-recovery).
 * @returns Count of runs swept.
 */
export function recoverOrphanedRunsAtStartup(
  liveSessionIds: Set<string>,
): number {
  const ledger = getRunLedger();
  const nonTerminal = ledger.listRuns({ states: ["created", "running", "blocked"] });
  let swept = 0;
  const at = new Date().toISOString();
  for (const run of nonTerminal) {
    // Orchestration runs are handled by the runtime's own boot-time sweep.
    if (run.engine === "orchestration") continue;
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
