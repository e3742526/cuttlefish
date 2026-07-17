import fs from "node:fs";
import path from "node:path";
import type { CronJob, CronRunEntry } from "../shared/types.js";
import { CRON_JOBS, CRON_RUNS } from "../shared/paths.js";
import { safeWriteFile } from "../shared/safe-write.js";
import { logger } from "../shared/logger.js";
import { parseStoredCronJob, sanitizeCronLogId } from "./validation.js";

/** Backs up the current jobs.json contents next to the original, best-effort. */
function backupJobsFile(suffix: string): string {
  const backupPath = `${CRON_JOBS}.${suffix}-${Date.now()}`;
  try {
    fs.copyFileSync(CRON_JOBS, backupPath);
  } catch {
    // best effort — the original file is still on disk
  }
  return backupPath;
}

export function loadJobs(): CronJob[] {
  let raw: string;
  try {
    raw = fs.readFileSync(CRON_JOBS, "utf-8");
  } catch (err) {
    // Missing file is normal (no cron jobs configured yet); anything else is not.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error(
        `Failed to read cron jobs file ${CRON_JOBS}: ${err instanceof Error ? err.message : err}`,
      );
    }
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Corrupt JSON: preserve the broken file for the operator, then run with no jobs.
    const backupPath = backupJobsFile("corrupt");
    logger.error(
      `Failed to parse cron jobs file ${CRON_JOBS}: ${err instanceof Error ? err.message : err}. ` +
      `Corrupt copy saved to ${backupPath}; running with zero cron jobs.`,
    );
    return [];
  }
  if (!Array.isArray(parsed)) {
    const backupPath = backupJobsFile("corrupt");
    logger.error(
      `Cron jobs file ${CRON_JOBS} did not contain a JSON array. ` +
      `Corrupt copy saved to ${backupPath}; running with zero cron jobs.`,
    );
    return [];
  }

  // Runtime shape validation (DAT-BUS-005): JSON.parse only guarantees valid JSON
  // syntax, not a valid CronJob shape. A hand-edited or version-skewed jobs.json
  // can contain entries with missing/wrong-typed fields (e.g. a non-string id),
  // which would otherwise be scheduled as-is. Validate each entry's shape (not
  // its schedule validity — an invalid schedule is intentionally surfaced via the
  // API rather than hidden, see `parseStoredCronJob`'s doc comment), drop
  // structurally invalid entries (following the same backup-and-continue pattern
  // used above for corrupt JSON), and keep running with the valid subset.
  const validJobs: CronJob[] = [];
  let invalidCount = 0;
  for (const entry of parsed) {
    try {
      validJobs.push(parseStoredCronJob(entry));
    } catch (err) {
      invalidCount += 1;
      logger.warn(
        `Dropping invalid cron job entry in ${CRON_JOBS}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  if (invalidCount > 0) {
    const backupPath = backupJobsFile("invalid");
    logger.warn(
      `${invalidCount} invalid cron job entr${invalidCount === 1 ? "y" : "ies"} dropped from ${CRON_JOBS}. ` +
      `Original copy saved to ${backupPath}; running with ${validJobs.length} valid job(s).`,
    );
  }
  return validJobs;
}

export function saveJobs(jobs: CronJob[]): void {
  // Atomic + fsync-durable + audited (canonical, low-churn state).
  safeWriteFile(CRON_JOBS, JSON.stringify(jobs, null, 2) + "\n", {
    audit: { actor: "gateway", op: "cron.save" },
  });
}

export const DEFAULT_MAX_RUN_LOG_ENTRIES = 1000;

function pruneRunLog(logPath: string, maxEntries: number): void {
  if (maxEntries <= 0) return;
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, "utf-8");
  } catch {
    return;
  }
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length <= maxEntries) return;
  const kept = lines.slice(-maxEntries).join("\n") + "\n";
  safeWriteFile(logPath, kept);
}

export function appendRunLog(jobId: string, entry: CronRunEntry, opts: { maxEntries?: number } = {}): void {
  fs.mkdirSync(CRON_RUNS, { recursive: true });
  // jobId is attacker/user-controlled via the cron API body (SEC-CFDB-005); sanitize
  // it before it becomes part of the run-log path so control chars/newlines cannot
  // forge fake log entries and path separators cannot escape CRON_RUNS.
  const logPath = path.join(CRON_RUNS, `${sanitizeCronLogId(jobId)}.jsonl`);
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf-8");
  pruneRunLog(logPath, opts.maxEntries ?? DEFAULT_MAX_RUN_LOG_ENTRIES);
}
