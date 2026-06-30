import { logger } from "./logger.js";
import { getRunLedger } from "../run-ledger/index.js";

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
