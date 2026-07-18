import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrchestrationStore } from "../store.js";
import { SCHEMA_VERSION } from "../store-schema.js";
import type { Lease, SchedulerSnapshot } from "../types.js";

const fixedNow = new Date("2026-06-23T12:00:00.000Z");

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-orch-store-"));
  dbPath = path.join(tmpDir, "orchestration.db");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("OrchestrationStore", () => {
  it("initializes an empty WAL-backed database", () => {
    const store = OrchestrationStore.open(dbPath);

    expect(store.loadSnapshot()).toEqual({
      allocations: [],
      leases: [],
      queue: [],
      telemetry: [],
      nextSeq: 1,
    });
    const db = new Database(dbPath);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("synchronous", { simple: true })).toBe(1);
    db.close();
    store.close();
  });

  it("round-trips leases, allocations, queue, telemetry, and next sequence state", () => {
    const store = OrchestrationStore.open(dbPath);
    store.replaceSnapshot(exampleSnapshot());
    store.close();

    const reopened = OrchestrationStore.open(dbPath);
    const loaded = reopened.loadSnapshot();

    expect(loaded).toEqual(exampleSnapshot());
    reopened.close();
  });

  it("renames a corrupt database and recreates an empty store", () => {
    const warnSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    fs.writeFileSync(dbPath, "not a sqlite database");

    const store = OrchestrationStore.open(dbPath, { now: () => fixedNow });

    expect(store.loadSnapshot().leases).toEqual([]);
    expect(fs.readdirSync(tmpDir).some((name) => name.startsWith("orchestration.db.corrupt.2026-06-23T12-00-00-000Z"))).toBe(true);
    const recoveryDir = path.join(tmpDir, "orchestration-recovery");
    const manifestPath = path.join(recoveryDir, fs.readdirSync(recoveryDir)[0]);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    expect(manifest).toMatchObject({
      recoveredAt: fixedNow.toISOString(),
      originalDbPath: dbPath,
      message: expect.stringContaining("orchestration state could not be trusted"),
    });
    expect(store.loadSnapshot().telemetry[0].detail).toMatchObject({
      recoveryManifestPath: manifestPath,
    });
    store.close();
    warnSpy.mockRestore();
  });

  it("rolls back a failed snapshot replacement without leaving partial allocation state", () => {
    const store = OrchestrationStore.open(dbPath);
    const seed = exampleSnapshot();
    store.replaceSnapshot(seed);
    const invalid = {
      ...seed,
      leases: [seed.leases[0], seed.leases[0]],
    };

    expect(() => store.replaceSnapshot(invalid)).toThrow();
    expect(store.loadSnapshot()).toEqual(seed);
    store.close();
  });


  it("migrates queue diagnostic columns for existing orchestration databases", () => {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE leases (
        lease_id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, task_id TEXT NOT NULL, coordinator_id TEXT NOT NULL,
        role TEXT NOT NULL, state TEXT NOT NULL, started_at TEXT NOT NULL, lease_expires_at TEXT NOT NULL,
        lease_duration_ms INTEGER NOT NULL DEFAULT 3600000, heartbeat_at TEXT NOT NULL
      );
      CREATE TABLE allocations (
        allocation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, coordinator_id TEXT NOT NULL, state TEXT NOT NULL,
        optional_roles_skipped_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE allocation_leases (allocation_id TEXT NOT NULL, lease_id TEXT NOT NULL, PRIMARY KEY (allocation_id, lease_id));
      CREATE TABLE queue_items (
        task_id TEXT NOT NULL, coordinator_id TEXT NOT NULL, state TEXT NOT NULL, missing_roles_json TEXT NOT NULL,
        priority TEXT NOT NULL, blocked_since TEXT NOT NULL, resume_on_json TEXT NOT NULL, request_json TEXT NOT NULL,
        PRIMARY KEY (task_id, coordinator_id)
      );
      CREATE TABLE telemetry_events (
        event_id TEXT PRIMARY KEY, type TEXT NOT NULL, task_id TEXT, worker_id TEXT, provider TEXT, family TEXT,
        role TEXT, timestamp TEXT NOT NULL, detail_json TEXT
      );
    `);
    db.prepare(`
      INSERT INTO queue_items (task_id, coordinator_id, state, missing_roles_json, priority, blocked_since, resume_on_json, request_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "task-old",
      "coord-old",
      "blocked_resource",
      JSON.stringify(["seniorImplementer"]),
      "normal",
      fixedNow.toISOString(),
      JSON.stringify(["worker_released"]),
      JSON.stringify({
        taskId: "task-old",
        coordinatorId: "coord-old",
        requiredRoles: ["seniorImplementer"],
        optionalRoles: [],
        priority: "normal",
        leaseDurationMs: 60_000,
      }),
    );
    db.close();

    const store = OrchestrationStore.open(dbPath);
    expect(store.loadSnapshot().queue[0]).toMatchObject({
      taskId: "task-old",
      lastBlockedAt: fixedNow.toISOString(),
      blockedAttempts: 1,
    });
    store.close();
  });

  it("persists, claims, and updates live run continuations across reopen", () => {
    const store = OrchestrationStore.open(dbPath);
    store.upsertLiveContinuation({
      taskId: "task-live",
      coordinatorId: "coord-live",
      mode: "single_worker",
      state: "queued",
      task: {
        taskId: "task-live",
        coordinatorId: "coord-live",
        priority: "normal",
        leaseDurationMs: 60_000,
        prompt: "Resume me later",
      },
      enqueuedAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
      retryCount: 0,
    });
    store.close();

    const reopened = OrchestrationStore.open(dbPath);
    expect(reopened.listLiveContinuations()).toMatchObject([{ taskId: "task-live", state: "queued", retryCount: 0 }]);
    const claimed = reopened.claimQueuedLiveContinuation("task-live", "coord-live", {
      updatedAt: new Date("2026-06-23T12:01:00.000Z").toISOString(),
      allocationId: "alloc-live",
    });
    expect(claimed).toMatchObject({
      state: "dispatching",
      retryCount: 1,
      allocationId: "alloc-live",
    });
    reopened.markLiveContinuationState("task-live", "coord-live", "completed", {
      updatedAt: new Date("2026-06-23T12:02:00.000Z").toISOString(),
      allocationId: "alloc-live",
    });
    expect(reopened.getLiveContinuation("task-live", "coord-live")).toMatchObject({
      state: "completed",
      allocationId: "alloc-live",
    });
    reopened.close();
  });

  it("refuses to open a DB stamped with a schema_version newer than this binary's (TMP-CUT-015)", () => {
    const store = OrchestrationStore.open(dbPath);
    store.close();

    const db = new Database(dbPath);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 1));
    db.close();

    expect(() => OrchestrationStore.open(dbPath)).toThrow(/schema_version/i);
  });

  it("opens a DB stamped with an older schema_version without complaint (normal upgrade path)", () => {
    const store = OrchestrationStore.open(dbPath);
    store.close();

    const db = new Database(dbPath);
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION - 1));
    db.close();

    const reopened = OrchestrationStore.open(dbPath);
    expect(reopened.loadSnapshot()).toEqual({ allocations: [], leases: [], queue: [], telemetry: [], nextSeq: 1 });
    reopened.close();

    const finalDb = new Database(dbPath);
    expect(finalDb.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toMatchObject({
      value: String(SCHEMA_VERSION),
    });
    finalDb.close();
  });

  it("increments a durable boot generation counter on every open (TMP-CUT-013)", () => {
    const store = OrchestrationStore.open(dbPath);
    expect(store.getBootGeneration()).toBe(1);
    store.close();

    const reopened = OrchestrationStore.open(dbPath);
    expect(reopened.getBootGeneration()).toBe(2);
    reopened.close();

    const reopenedAgain = OrchestrationStore.open(dbPath);
    expect(reopenedAgain.getBootGeneration()).toBe(3);
    reopenedAgain.close();
  });

  it("stamps live continuations with the boot generation active when they were created", () => {
    const store = OrchestrationStore.open(dbPath);
    store.upsertLiveContinuation({
      taskId: "task-gen",
      coordinatorId: "coord-gen",
      mode: "single_worker",
      state: "queued",
      task: {
        taskId: "task-gen",
        coordinatorId: "coord-gen",
        priority: "normal",
        leaseDurationMs: 60_000,
        prompt: "Resume me later",
      },
      enqueuedAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
      retryCount: 0,
    });
    expect(store.listLiveContinuationsWithGeneration()).toMatchObject([{ taskId: "task-gen", bootGeneration: 1 }]);
    store.close();
  });

  it("blocks active continuation overwrite and fails queued work at the retry cap", () => {
    const store = OrchestrationStore.open(dbPath);
    const record = {
      taskId: "task-live",
      coordinatorId: "coord-live",
      mode: "single_worker" as const,
      state: "queued" as const,
      task: {
        taskId: "task-live",
        coordinatorId: "coord-live",
        priority: "normal" as const,
        leaseDurationMs: 60_000,
        prompt: "Resume me later",
      },
      enqueuedAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
      retryCount: 3,
    };

    store.upsertLiveContinuation(record);

    expect(() => store.upsertLiveContinuation({ ...record, updatedAt: new Date(fixedNow.getTime() + 1).toISOString() })).toThrow(/active/);
    expect(store.claimQueuedLiveContinuation("task-live", "coord-live", {
      updatedAt: new Date(fixedNow.getTime() + 2).toISOString(),
      allocationId: "alloc-capped",
    })).toBeUndefined();
    expect(store.getLiveContinuation("task-live", "coord-live")).toMatchObject({
      state: "failed",
      retryCount: 3,
      lastError: expect.stringContaining("retry limit reached"),
    });
    store.close();
  });

  it("expireHoldsInDb transitions active-but-overdue holds to expired state", () => {
    const store = OrchestrationStore.open(dbPath);
    const expiresAt = new Date(fixedNow.getTime() - 1).toISOString();
    store.upsertHold({
      holdId: "hold-expired",
      managerName: "manager",
      state: "active",
      roles: [],
      workerIds: ["worker-held"],
      taskId: null,
      coordinatorId: null,
      reason: null,
      createdAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
      expiresAt,
    });
    store.upsertHold({
      holdId: "hold-fresh",
      managerName: "manager",
      state: "active",
      roles: [],
      workerIds: ["worker-held-2"],
      taskId: null,
      coordinatorId: null,
      reason: null,
      createdAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
      expiresAt: new Date(fixedNow.getTime() + 60_000).toISOString(),
    });

    const expired = store.expireHolds(fixedNow.toISOString());

    expect(expired).toBe(1);
    expect(store.listHolds({ includeInactive: false })).toMatchObject([{ holdId: "hold-fresh", state: "active" }]);
    expect(store.listHolds({ includeInactive: true })).toHaveLength(2);
    expect(store.listHolds({ includeInactive: true }).find((h) => h.holdId === "hold-expired")).toMatchObject({ state: "expired" });
    store.close();
  });

  it("persists task pauses, holds, artifact metadata, and patch apply attempts", () => {
    const store = OrchestrationStore.open(dbPath);
    store.setTaskPause({
      taskId: "task-paused",
      coordinatorId: "coord-paused",
      pausedAt: fixedNow.toISOString(),
      pauseReason: "hold task",
      managerName: "manager",
    });
    store.upsertHold({
      holdId: "hold-1",
      managerName: "manager",
      state: "active",
      roles: ["seniorImplementer"],
      workerIds: ["worker-1"],
      taskId: "task-paused",
      coordinatorId: "coord-paused",
      reason: "reserve worker",
      createdAt: fixedNow.toISOString(),
      updatedAt: fixedNow.toISOString(),
      expiresAt: new Date(fixedNow.getTime() + 60_000).toISOString(),
    });
    store.addArtifactRecord({
      artifactId: "artifact-1",
      taskId: "task-paused",
      coordinatorId: "coord-paused",
      kind: "diff",
      lane: "openai",
      path: path.join(tmpDir, "diff.patch"),
      bytes: 12,
      createdAt: fixedNow.toISOString(),
      note: null,
    });
    store.addPatchApplyAttempt({
      attemptId: "apply-1",
      taskId: "task-paused",
      winnerLane: "openai",
      state: "failed",
      baseCwd: tmpDir,
      patchPath: null,
      error: "dirty base",
      createdAt: fixedNow.toISOString(),
    });
    store.close();

    const reopened = OrchestrationStore.open(dbPath);
    expect(reopened.listTaskPauses()).toMatchObject([{ taskId: "task-paused", managerName: "manager" }]);
    expect(reopened.listHolds({ includeInactive: true })).toMatchObject([{ holdId: "hold-1", workerIds: ["worker-1"] }]);
    expect(reopened.listArtifactRecords("task-paused", "diff")).toMatchObject([{ artifactId: "artifact-1", lane: "openai" }]);
    expect(reopened.listPatchApplyAttempts("task-paused")).toMatchObject([{ attemptId: "apply-1", state: "failed" }]);
    reopened.close();
  });
});

describe("OrchestrationStore.open — file permissions (SEC-CFDB-001)", () => {
  it("creates the orchestration DB file with owner-only (0600) permissions", () => {
    const store = OrchestrationStore.open(dbPath);
    try {
      const mode = fs.statSync(dbPath).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      store.close();
    }
  });

  it("tightens a pre-existing world-readable DB file back to 0600 on open", () => {
    const first = OrchestrationStore.open(dbPath);
    first.close();
    fs.chmodSync(dbPath, 0o644); // simulate a pre-hardening world-readable install

    const reopened = OrchestrationStore.open(dbPath);
    try {
      const mode = fs.statSync(dbPath).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      reopened.close();
    }
  });
});

function exampleSnapshot(): SchedulerSnapshot {
  const lease = exampleLease();
  return {
    allocations: [
      {
        allocationId: "alloc_task_1_2",
        taskId: "task-1",
        coordinatorId: "coord-1",
        state: "allocated",
        leases: [lease],
        optionalRolesSkipped: ["optionalReviewer"],
        createdAt: fixedNow.toISOString(),
        updatedAt: fixedNow.toISOString(),
      },
    ],
    leases: [lease],
    queue: [
      {
        taskId: "task-2",
        coordinatorId: "coord-2",
        state: "blocked_resource",
        missingRoles: ["seniorImplementer"],
        priority: "high",
        blockedSince: fixedNow.toISOString(),
        lastBlockedAt: new Date(fixedNow.getTime() + 30_000).toISOString(),
        blockedAttempts: 3,
        resumeOn: ["worker_released", "quota_available", "lease_expired"],
        request: {
          taskId: "task-2",
          coordinatorId: "coord-2",
          requiredRoles: ["seniorImplementer"],
          optionalRoles: [],
          priority: "high",
          leaseDurationMs: 60_000,
        },
      },
    ],
    telemetry: [
      {
        eventId: "evt_3",
        type: "allocation_created",
        taskId: "task-1",
        timestamp: fixedNow.toISOString(),
        detail: { coordinatorId: "coord-1", roles: ["seniorImplementer"] },
      },
    ],
    nextSeq: 4,
  };
}

function exampleLease(): Lease {
  return {
    leaseId: "lease_task_1_seniorImplementer_codexSenior_1",
    workerId: "codexSenior",
    taskId: "task-1",
    coordinatorId: "coord-1",
    role: "seniorImplementer",
    state: "running",
    startedAt: fixedNow.toISOString(),
    leaseExpiresAt: new Date(fixedNow.getTime() + 60_000).toISOString(),
    leaseDurationMs: 60_000,
    heartbeatAt: fixedNow.toISOString(),
  };
}
