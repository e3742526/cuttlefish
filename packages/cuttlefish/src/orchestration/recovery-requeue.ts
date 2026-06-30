import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { appendOrchestrationAudit } from "./audit.js";
import type { LiveRunContinuationRecord } from "./live-run.js";
import type { OrchestrationStore } from "./store.js";
import { parseDbJson } from "./store-utils.js";
import type { HoldRecord } from "./store-controls.js";
import type { OrchestrationRecoveryManifest } from "./store-recovery.js";

export type RecoveryRequeueResult =
  | { ok: false; reason: "manifest_not_found" | "invalid_manifest" | "continuation_not_found" | "invalid_record"; message: string }
  | { ok: true; taskId: string; coordinatorId: string; continuation: LiveRunContinuationRecord; holdsImported: number; paused: true };

interface LiveRunContinuationRow {
  task_id: string;
  coordinator_id: string;
  mode: LiveRunContinuationRecord["mode"];
  state: string;
  task_json: string;
  enqueued_at: string;
  updated_at: string;
  retry_count: number;
  last_dispatched_at: string | null;
  allocation_id: string | null;
  last_error: string | null;
}

interface HoldRow {
  hold_id: string;
  manager_name: string;
  state: HoldRecord["state"];
  roles_json: string;
  worker_ids_json: string;
  task_id: string | null;
  coordinator_id: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export function requeueRecoveredContinuation(opts: {
  manifestPath: string;
  taskId: string;
  coordinatorId: string;
  managerName: string;
  store: OrchestrationStore;
  recoveryDir?: string;
  now?: () => Date;
}): RecoveryRequeueResult {
  const manifest = readRecoveryManifest(opts.manifestPath, opts.recoveryDir);
  if (!manifest.ok) return manifest;
  const corruptDbPath = resolveContainedCorruptDbPath(manifest.manifest.corruptDbPath, manifest.recoveryDir);
  if (!corruptDbPath.ok) return corruptDbPath;
  if (!fs.existsSync(corruptDbPath.path)) {
    return { ok: false, reason: "invalid_manifest", message: `corruptDbPath does not exist: ${manifest.manifest.corruptDbPath}` };
  }
  const db = new Database(corruptDbPath.path, { readonly: true, fileMustExist: true });
  try {
    if (!hasTable(db, "live_run_continuations")) {
      return { ok: false, reason: "invalid_manifest", message: "quarantined DB has no live_run_continuations table" };
    }
    const rows = db.prepare("SELECT * FROM live_run_continuations WHERE task_id = ? AND coordinator_id = ?").all(opts.taskId, opts.coordinatorId) as LiveRunContinuationRow[];
    if (rows.length === 0) return { ok: false, reason: "continuation_not_found", message: `no recovered continuation for ${opts.taskId}` };
    const nowIso = (opts.now?.() ?? new Date()).toISOString();
    const continuation = rowToContinuation(rows[0], nowIso);
    const holds = stageRecoveredHolds(db, continuation.taskId, continuation.coordinatorId, nowIso);
    opts.store.transaction(() => {
      opts.store.upsertLiveContinuation(continuation);
      opts.store.setTaskPause({
        taskId: continuation.taskId,
        coordinatorId: continuation.coordinatorId,
        pausedAt: nowIso,
        pauseReason: "Recovered from quarantined orchestration DB; explicit resume required",
        managerName: opts.managerName,
      });
      for (const hold of holds) opts.store.upsertHold(hold);
    });
    appendOrchestrationAudit("orchestration.recovery.requeue", {
      manifestPath: opts.manifestPath,
      taskId: continuation.taskId,
      coordinatorId: continuation.coordinatorId,
      managerName: opts.managerName,
      holdsImported: holds.length,
    }, manifest.manifest.originalDbPath);
    return {
      ok: true,
      taskId: continuation.taskId,
      coordinatorId: continuation.coordinatorId,
      continuation,
      holdsImported: holds.length,
      paused: true,
    };
  } catch (err) {
    return { ok: false, reason: "invalid_record", message: err instanceof Error ? err.message : String(err) };
  } finally {
    db.close();
  }
}

function stageRecoveredHolds(
  db: Database.Database,
  taskId: string,
  coordinatorId: string,
  nowIso: string,
): HoldRecord[] {
  if (!hasTable(db, "orchestration_holds")) return [];
  const rows = db.prepare(`
    SELECT * FROM orchestration_holds
    WHERE state = 'active' AND (task_id = ? OR (task_id IS NULL AND coordinator_id = ?))
  `).all(taskId, coordinatorId) as HoldRow[];
  const holds: HoldRecord[] = [];
  for (const row of rows) {
    const expiresAt = Date.parse(row.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.parse(nowIso)) continue;
    holds.push({
      holdId: row.hold_id,
      managerName: row.manager_name,
      state: "active",
      roles: parseDbJson<string[]>(row.roles_json, "recovered hold roles"),
      workerIds: parseDbJson<string[]>(row.worker_ids_json, "recovered hold workers"),
      taskId: row.task_id,
      coordinatorId: row.coordinator_id,
      reason: row.reason,
      createdAt: row.created_at,
      updatedAt: nowIso,
      expiresAt: row.expires_at,
    });
  }
  return holds;
}

function rowToContinuation(row: LiveRunContinuationRow, nowIso: string): LiveRunContinuationRecord {
  if (row.state !== "queued" && row.state !== "dispatching" && row.state !== "failed") {
    throw new Error(`recovered continuation ${row.task_id}/${row.coordinator_id} has unsupported state ${row.state}`);
  }
  const task = parseDbJson<LiveRunContinuationRecord["task"]>(row.task_json, "recovered live run task");
  if (!task || typeof task !== "object" || task.taskId !== row.task_id || task.coordinatorId !== row.coordinator_id) {
    throw new Error(`recovered continuation task payload does not match ${row.task_id}/${row.coordinator_id}`);
  }
  return {
    taskId: row.task_id,
    coordinatorId: row.coordinator_id,
    mode: row.mode,
    state: "queued",
    task,
    enqueuedAt: row.enqueued_at || nowIso,
    updatedAt: nowIso,
    // Preserve the accumulated retry count across recovery cycles. Resetting to 0
    // let a fundamentally-broken continuation (dead worker, invalid payload) fail →
    // be recovered → fail → be recovered forever, because the retry cap
    // (claimNextLiveRunContinuation: retry_count >= maxRetryCount) only ever saw a
    // freshly-zeroed count and never tripped.
    retryCount: row.retry_count,
    lastDispatchedAt: undefined,
    allocationId: undefined,
    lastError: undefined,
  };
}

function readRecoveryManifest(manifestPath: string, expectedRecoveryDir?: string):
  | { ok: true; manifest: OrchestrationRecoveryManifest; recoveryDir: string }
  | { ok: false; reason: "manifest_not_found" | "invalid_manifest"; message: string } {
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, reason: "manifest_not_found", message: `recovery manifest not found: ${manifestPath}` };
  }
  try {
    const resolved = path.resolve(manifestPath);
    const recoveryDir = path.resolve(expectedRecoveryDir ?? path.dirname(resolved));
    if (!isPathWithin(resolved, recoveryDir)) {
      return { ok: false, reason: "invalid_manifest", message: "recovery manifest path is outside the recovery directory" };
    }
    const parsed = JSON.parse(fs.readFileSync(resolved, "utf-8")) as Partial<OrchestrationRecoveryManifest>;
    if (
      typeof parsed.recoveredAt !== "string"
      || typeof parsed.originalDbPath !== "string"
      || typeof parsed.corruptDbPath !== "string"
      || typeof parsed.message !== "string"
      || typeof parsed.operatorGuidance !== "string"
    ) {
      return { ok: false, reason: "invalid_manifest", message: "recovery manifest is missing required fields" };
    }
    return { ok: true, manifest: parsed as OrchestrationRecoveryManifest, recoveryDir };
  } catch (err) {
    return { ok: false, reason: "invalid_manifest", message: err instanceof Error ? err.message : String(err) };
  }
}

function resolveContainedCorruptDbPath(corruptDbPath: string, recoveryDir: string):
  | { ok: true; path: string }
  | { ok: false; reason: "invalid_manifest"; message: string } {
  const resolved = path.resolve(corruptDbPath);
  const recoveryRoot = path.dirname(recoveryDir);
  if (!isPathWithin(resolved, recoveryRoot)) {
    return { ok: false, reason: "invalid_manifest", message: "corruptDbPath is outside the recovery root" };
  }
  if (!path.basename(resolved).includes(".corrupt.")) {
    return { ok: false, reason: "invalid_manifest", message: "corruptDbPath does not look like a quarantined orchestration database" };
  }
  return { ok: true, path: resolved };
}

function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function hasTable(db: Database.Database, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as { name: string } | undefined;
  return Boolean(row);
}
