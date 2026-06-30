import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requeueRecoveredContinuation } from "../recovery-requeue.js";
import { OrchestrationStore } from "../store.js";
import { pruneRecoveryNotices, writeRecoveryManifest } from "../store-recovery.js";

const fixedNow = new Date("2026-06-23T12:00:00.000Z");

let tmpDir: string;
let dbPath: string;
let quarantineDir: string;
let recoveryDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-recovery-requeue-"));
  dbPath = path.join(tmpDir, "orchestration.db");
  quarantineDir = path.join(tmpDir, "quarantine");
  recoveryDir = path.join(tmpDir, "orchestration-recovery");
  fs.mkdirSync(quarantineDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Build a minimal quarantined DB that looks like a real corrupt-recovered DB */
function buildQuarantinedDb(corruptDbPath: string, taskId: string, coordinatorId: string): void {
  const db = new Database(corruptDbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_run_continuations (
      task_id TEXT NOT NULL,
      coordinator_id TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'single_worker',
      state TEXT NOT NULL,
      task_json TEXT NOT NULL,
      enqueued_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_dispatched_at TEXT,
      allocation_id TEXT,
      last_error TEXT,
      PRIMARY KEY (task_id, coordinator_id)
    );
    CREATE TABLE IF NOT EXISTS orchestration_holds (
      hold_id TEXT PRIMARY KEY,
      manager_name TEXT NOT NULL,
      state TEXT NOT NULL,
      roles_json TEXT NOT NULL DEFAULT '[]',
      worker_ids_json TEXT NOT NULL DEFAULT '[]',
      task_id TEXT,
      coordinator_id TEXT,
      reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
  const task = {
    taskId,
    coordinatorId,
    priority: "normal",
    leaseDurationMs: 60_000,
    prompt: `Continue ${taskId}`,
  };
  db.prepare(`
    INSERT INTO live_run_continuations
      (task_id, coordinator_id, mode, state, task_json, enqueued_at, updated_at, retry_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(taskId, coordinatorId, "single_worker", "queued", JSON.stringify(task), fixedNow.toISOString(), fixedNow.toISOString(), 2);
  db.close();
}

function buildManifestPath(corruptDbPath: string): string {
  const manifest = {
    recoveredAt: fixedNow.toISOString(),
    originalDbPath: dbPath,
    corruptDbPath,
    message: "orchestration state could not be trusted",
    operatorGuidance: "Review the quarantined DB before re-queueing",
  };
  return writeRecoveryManifest(recoveryDir, manifest);
}

describe("requeueRecoveredContinuation", () => {
  it("imports continuation from quarantined DB, sets task pause, and marks ok", () => {
    const corruptDbPath = path.join(quarantineDir, "orchestration.db.corrupt.2026-06-23T12-00-00-000Z");
    buildQuarantinedDb(corruptDbPath, "task-recovered", "coord-recovered");
    const manifestPath = buildManifestPath(corruptDbPath);
    const store = OrchestrationStore.open(dbPath, { now: () => fixedNow });

    const result = requeueRecoveredContinuation({
      manifestPath,
      taskId: "task-recovered",
      coordinatorId: "coord-recovered",
      managerName: "operator",
      store,
      now: () => fixedNow,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.taskId).toBe("task-recovered");
    expect(result.coordinatorId).toBe("coord-recovered");
    expect(result.paused).toBe(true);
    // continuation upserted in live state as queued
    const stored = store.getLiveContinuation("task-recovered", "coord-recovered");
    // retryCount is PRESERVED across recovery (inserted as 2), not reset to 0 —
    // resetting let a broken continuation bypass the retry cap across recovery cycles.
    expect(stored).toMatchObject({ taskId: "task-recovered", state: "queued", retryCount: 2 });
    // task pause set
    expect(store.listTaskPauses()).toMatchObject([{
      taskId: "task-recovered",
      coordinatorId: "coord-recovered",
      managerName: "operator",
    }]);
    store.close();
  });

  it("resets retry count and clears allocationId on import regardless of original state", () => {
    const corruptDbPath = path.join(quarantineDir, "orchestration.db.corrupt.2026-06-23T12-00-00-000Z");
    // Build with dispatching state (mid-execution when corruption happened)
    const db = new Database(corruptDbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS live_run_continuations (
        task_id TEXT NOT NULL, coordinator_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'single_worker',
        state TEXT NOT NULL, task_json TEXT NOT NULL, enqueued_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0,
        last_dispatched_at TEXT, allocation_id TEXT, last_error TEXT,
        PRIMARY KEY (task_id, coordinator_id)
      );
    `);
    const task = { taskId: "task-mid", coordinatorId: "coord-mid", priority: "normal", leaseDurationMs: 60_000, prompt: "Resume" };
    db.prepare(`
      INSERT INTO live_run_continuations
        (task_id, coordinator_id, mode, state, task_json, enqueued_at, updated_at, retry_count, allocation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("task-mid", "coord-mid", "single_worker", "dispatching", JSON.stringify(task), fixedNow.toISOString(), fixedNow.toISOString(), 5, "old-alloc");
    db.close();
    const manifestPath = buildManifestPath(corruptDbPath);
    const store = OrchestrationStore.open(dbPath, { now: () => fixedNow });

    const result = requeueRecoveredContinuation({
      manifestPath,
      taskId: "task-mid",
      coordinatorId: "coord-mid",
      managerName: "operator",
      store,
      now: () => fixedNow,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // retryCount PRESERVED (inserted as 5) so the retry cap survives recovery;
    // allocationId cleared and state reset to queued.
    expect(result.continuation.retryCount).toBe(5);
    expect(result.continuation.allocationId).toBeUndefined();
    expect(result.continuation.state).toBe("queued");
    store.close();
  });

  it("imports non-expired holds alongside the continuation", () => {
    const corruptDbPath = path.join(quarantineDir, "orchestration.db.corrupt.2026-06-23T12-00-00-000Z");
    buildQuarantinedDb(corruptDbPath, "task-with-holds", "coord-with-holds");
    // add a hold for this task into quarantine DB
    const db = new Database(corruptDbPath);
    const futureExpiry = new Date(fixedNow.getTime() + 120_000).toISOString();
    db.prepare(`
      INSERT INTO orchestration_holds (hold_id, manager_name, state, roles_json, worker_ids_json,
        task_id, coordinator_id, reason, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("hold-abc", "manager", "active", "[]", JSON.stringify(["worker-1"]),
      "task-with-holds", "coord-with-holds", "reserve worker", fixedNow.toISOString(), fixedNow.toISOString(), futureExpiry);
    db.close();
    const manifestPath = buildManifestPath(corruptDbPath);
    const store = OrchestrationStore.open(dbPath, { now: () => fixedNow });

    const result = requeueRecoveredContinuation({
      manifestPath,
      taskId: "task-with-holds",
      coordinatorId: "coord-with-holds",
      managerName: "operator",
      store,
      now: () => fixedNow,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.holdsImported).toBe(1);
    expect(store.listHolds({ includeInactive: false })).toMatchObject([{
      holdId: "hold-abc",
      workerIds: ["worker-1"],
      state: "active",
    }]);
    store.close();
  });

  it("skips expired holds during import", () => {
    const corruptDbPath = path.join(quarantineDir, "orchestration.db.corrupt.2026-06-23T12-00-00-000Z");
    buildQuarantinedDb(corruptDbPath, "task-exp-holds", "coord-exp-holds");
    const db = new Database(corruptDbPath);
    const pastExpiry = new Date(fixedNow.getTime() - 1_000).toISOString();
    db.prepare(`
      INSERT INTO orchestration_holds (hold_id, manager_name, state, roles_json, worker_ids_json,
        task_id, coordinator_id, reason, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("hold-expired", "manager", "active", "[]", JSON.stringify(["worker-2"]),
      "task-exp-holds", "coord-exp-holds", null, fixedNow.toISOString(), fixedNow.toISOString(), pastExpiry);
    db.close();
    const manifestPath = buildManifestPath(corruptDbPath);
    const store = OrchestrationStore.open(dbPath, { now: () => fixedNow });

    const result = requeueRecoveredContinuation({
      manifestPath,
      taskId: "task-exp-holds",
      coordinatorId: "coord-exp-holds",
      managerName: "operator",
      store,
      now: () => fixedNow,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.holdsImported).toBe(0);
    expect(store.listHolds({ includeInactive: false })).toHaveLength(0);
    store.close();
  });

  it("returns manifest_not_found when manifest path does not exist", () => {
    const store = OrchestrationStore.open(dbPath, { now: () => fixedNow });
    const result = requeueRecoveredContinuation({
      manifestPath: path.join(tmpDir, "nonexistent.json"),
      taskId: "task-x",
      coordinatorId: "coord-x",
      managerName: "operator",
      store,
      now: () => fixedNow,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("manifest_not_found");
    store.close();
  });

  it("returns invalid_manifest when manifest is missing required fields", () => {
    const badManifestPath = path.join(recoveryDir, "bad.json");
    fs.mkdirSync(recoveryDir, { recursive: true });
    fs.writeFileSync(badManifestPath, JSON.stringify({ recoveredAt: "2026-06-23T12:00:00.000Z" }));
    const store = OrchestrationStore.open(dbPath, { now: () => fixedNow });
    const result = requeueRecoveredContinuation({
      manifestPath: badManifestPath,
      taskId: "task-x",
      coordinatorId: "coord-x",
      managerName: "operator",
      store,
      now: () => fixedNow,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_manifest");
    store.close();
  });

  it("returns continuation_not_found when taskId has no matching row in quarantined DB", () => {
    const corruptDbPath = path.join(quarantineDir, "orchestration.db.corrupt.2026-06-23T12-00-00-000Z");
    buildQuarantinedDb(corruptDbPath, "task-found", "coord-found");
    const manifestPath = buildManifestPath(corruptDbPath);
    const store = OrchestrationStore.open(dbPath, { now: () => fixedNow });

    const result = requeueRecoveredContinuation({
      manifestPath,
      taskId: "task-unknown",
      coordinatorId: "coord-found",
      managerName: "operator",
      store,
      now: () => fixedNow,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("continuation_not_found");
    store.close();
  });

  it("returns invalid_manifest when corruptDbPath in manifest does not exist on disk", () => {
    const corruptDbPath = path.join(quarantineDir, "does-not-exist.db");
    // write manifest pointing to nonexistent path
    const manifest = {
      recoveredAt: fixedNow.toISOString(),
      originalDbPath: dbPath,
      corruptDbPath,
      message: "orchestration state could not be trusted",
      operatorGuidance: "Review the quarantined DB before re-queueing",
    };
    const manifestPath = writeRecoveryManifest(recoveryDir, manifest);
    const store = OrchestrationStore.open(dbPath, { now: () => fixedNow });

    const result = requeueRecoveredContinuation({
      manifestPath,
      taskId: "task-x",
      coordinatorId: "coord-x",
      managerName: "operator",
      store,
      now: () => fixedNow,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_manifest");
    store.close();
  });

  it("rejects recovery manifests outside the expected recovery directory", () => {
    const outsideDir = path.join(tmpDir, "outside");
    const corruptDbPath = path.join(quarantineDir, "orchestration.db.corrupt.2026-06-23T12-00-00-000Z");
    buildQuarantinedDb(corruptDbPath, "task-outside", "coord-outside");
    const manifestPath = writeRecoveryManifest(outsideDir, {
      recoveredAt: fixedNow.toISOString(),
      originalDbPath: dbPath,
      corruptDbPath,
      message: "orchestration state could not be trusted",
      operatorGuidance: "Review the quarantined DB before re-queueing",
    });
    const store = OrchestrationStore.open(dbPath, { now: () => fixedNow });

    const result = requeueRecoveredContinuation({
      manifestPath,
      taskId: "task-outside",
      coordinatorId: "coord-outside",
      managerName: "operator",
      store,
      recoveryDir,
      now: () => fixedNow,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_manifest");
    store.close();
  });

  it("prunes old recovery notices and their quarantined database files", () => {
    const oldCorruptDbPath = path.join(quarantineDir, "orchestration.db.corrupt.old");
    const newCorruptDbPath = path.join(quarantineDir, "orchestration.db.corrupt.new");
    fs.writeFileSync(oldCorruptDbPath, "old");
    fs.writeFileSync(newCorruptDbPath, "new");
    const oldManifestPath = writeRecoveryManifest(recoveryDir, {
      recoveredAt: "2026-05-01T00:00:00.000Z",
      originalDbPath: dbPath,
      corruptDbPath: oldCorruptDbPath,
      message: "old recovery",
      operatorGuidance: "old guidance",
    });
    const newManifestPath = writeRecoveryManifest(recoveryDir, {
      recoveredAt: "2026-06-23T00:00:00.000Z",
      originalDbPath: dbPath,
      corruptDbPath: newCorruptDbPath,
      message: "new recovery",
      operatorGuidance: "new guidance",
    });

    const result = pruneRecoveryNotices(recoveryDir, {
      now: new Date("2026-06-24T00:00:00.000Z"),
      maxAgeMs: 30 * 24 * 60 * 60 * 1_000,
      maxNotices: 100,
    });

    expect(result).toEqual({ kept: 1, removed: 1 });
    expect(fs.existsSync(oldManifestPath)).toBe(false);
    expect(fs.existsSync(oldCorruptDbPath)).toBe(false);
    expect(fs.existsSync(newManifestPath)).toBe(true);
    expect(fs.existsSync(newCorruptDbPath)).toBe(true);
  });

  it("prunes recovery notices by newest-count limit and treats missing dirs as no-op", () => {
    const firstDb = path.join(quarantineDir, "orchestration.db.corrupt.first");
    const secondDb = path.join(quarantineDir, "orchestration.db.corrupt.second");
    fs.writeFileSync(firstDb, "first");
    fs.writeFileSync(secondDb, "second");
    const firstManifestPath = writeRecoveryManifest(recoveryDir, {
      recoveredAt: "2026-06-22T00:00:00.000Z",
      originalDbPath: dbPath,
      corruptDbPath: firstDb,
      message: "first recovery",
      operatorGuidance: "first guidance",
    });
    const secondManifestPath = writeRecoveryManifest(recoveryDir, {
      recoveredAt: "2026-06-23T00:00:00.000Z",
      originalDbPath: dbPath,
      corruptDbPath: secondDb,
      message: "second recovery",
      operatorGuidance: "second guidance",
    });

    expect(pruneRecoveryNotices(recoveryDir, {
      now: new Date("2026-06-24T00:00:00.000Z"),
      maxAgeMs: 365 * 24 * 60 * 60 * 1_000,
      maxNotices: 1,
    })).toEqual({ kept: 1, removed: 1 });
    expect(fs.existsSync(firstManifestPath)).toBe(false);
    expect(fs.existsSync(secondManifestPath)).toBe(true);
    expect(pruneRecoveryNotices(path.join(tmpDir, "missing-recovery"))).toEqual({ kept: 0, removed: 0 });
  });

  it("rolls back live-store writes when recovered holds are malformed", () => {
    const corruptDbPath = path.join(quarantineDir, "orchestration.db.corrupt.2026-06-23T12-00-00-000Z");
    buildQuarantinedDb(corruptDbPath, "task-bad-hold", "coord-bad-hold");
    const db = new Database(corruptDbPath);
    const futureExpiry = new Date(fixedNow.getTime() + 120_000).toISOString();
    db.prepare(`
      INSERT INTO orchestration_holds (hold_id, manager_name, state, roles_json, worker_ids_json,
        task_id, coordinator_id, reason, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("hold-bad", "manager", "active", "{not-json", JSON.stringify(["worker-1"]),
      "task-bad-hold", "coord-bad-hold", "bad hold", fixedNow.toISOString(), fixedNow.toISOString(), futureExpiry);
    db.close();
    const manifestPath = buildManifestPath(corruptDbPath);
    const store = OrchestrationStore.open(dbPath, { now: () => fixedNow });

    const result = requeueRecoveredContinuation({
      manifestPath,
      taskId: "task-bad-hold",
      coordinatorId: "coord-bad-hold",
      managerName: "operator",
      store,
      now: () => fixedNow,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_record");
    expect(store.getLiveContinuation("task-bad-hold", "coord-bad-hold")).toBeUndefined();
    expect(store.listTaskPauses()).toEqual([]);
    store.close();
  });

  it("returns invalid_record when continuation state is not recoverable (completed)", () => {
    const corruptDbPath = path.join(quarantineDir, "orchestration.db.corrupt.2026-06-23T12-00-00-000Z");
    const db = new Database(corruptDbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS live_run_continuations (
        task_id TEXT NOT NULL, coordinator_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'single_worker',
        state TEXT NOT NULL, task_json TEXT NOT NULL, enqueued_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0,
        last_dispatched_at TEXT, allocation_id TEXT, last_error TEXT,
        PRIMARY KEY (task_id, coordinator_id)
      );
    `);
    const task = { taskId: "task-done", coordinatorId: "coord-done", priority: "normal", leaseDurationMs: 60_000, prompt: "done" };
    db.prepare(`
      INSERT INTO live_run_continuations
        (task_id, coordinator_id, mode, state, task_json, enqueued_at, updated_at, retry_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("task-done", "coord-done", "single_worker", "completed", JSON.stringify(task), fixedNow.toISOString(), fixedNow.toISOString(), 1);
    db.close();
    const manifestPath = buildManifestPath(corruptDbPath);
    const store = OrchestrationStore.open(dbPath, { now: () => fixedNow });

    const result = requeueRecoveredContinuation({
      manifestPath,
      taskId: "task-done",
      coordinatorId: "coord-done",
      managerName: "operator",
      store,
      now: () => fixedNow,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_record");
    store.close();
  });
});
