import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrchestrationRuntime } from "../runtime.js";
import type { LiveRunContinuationRecord } from "../live-run.js";
import type { OrchestrationConfig } from "../types.js";
import type { CuttlefishConfig } from "../../shared/types.js";
import { logger } from "../../shared/logger.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-orch-runtime-"));
  dbPath = path.join(tmpDir, "orchestration.db");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("OrchestrationRuntime continuation dispatch", () => {
  it("tryAllocationNow persists successful leases without changing normal allocation behavior", () => {
    const runtime1 = new OrchestrationRuntime({ config: config(), dbPath, startReaper: false });
    const immediate = runtime1.tryAllocationNow(request("board-ticket-1", "ticket-dispatch:manual"));

    expect(immediate.ok).toBe(true);
    if (!immediate.ok) return;
    expect(runtime1.listQueue()).toEqual([]);
    runtime1.close();

    const runtime2 = new OrchestrationRuntime({ config: config(), dbPath, startReaper: false });
    expect(runtime2.listLeases()).toEqual([
      expect.objectContaining({
        leaseId: immediate.allocation.leases[0].leaseId,
        taskId: "board-ticket-1",
        coordinatorId: "ticket-dispatch:manual",
        state: "running",
      }),
    ]);
    runtime2.close();
  });

  it("tryAllocationNow reports no capacity without creating queue items", () => {
    const runtime = new OrchestrationRuntime({ config: config(), dbPath, startReaper: false });
    const first = runtime.tryAllocationNow(request("board-ticket-1", "ticket-dispatch:manual"));
    expect(first.ok).toBe(true);

    const busy = runtime.tryAllocationNow(request("board-ticket-2", "ticket-dispatch:manual"));

    expect(busy.ok).toBe(false);
    expect(runtime.listQueue()).toEqual([]);
    runtime.close();
  });

  it("resumes a persisted blocked live continuation after restart", async () => {
    const runtime1 = new OrchestrationRuntime({ config: config(), dbPath, startReaper: false });
    const first = runtime1.requestAllocation(request("task-1", "coord-1"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const blocked = runtime1.requestAllocation(request("task-2", "coord-2"));
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    runtime1.queueLiveContinuation(continuation("task-2", "coord-2"));
    runtime1.close();

    const resumed: Array<{ taskId: string; allocationId: string }> = [];
    const runtime2 = new OrchestrationRuntime({ config: config(), dbPath, startReaper: false });
    runtime2.setResumeQueuedRunHandler(async ({ continuation, allocation }) => {
      resumed.push({ taskId: continuation.taskId, allocationId: allocation.allocationId });
    });

    runtime2.releaseLease(first.allocation.leases[0].leaseId, "coord-1");

    await waitFor(() => resumed.length === 1);
    expect(resumed[0]).toMatchObject({ taskId: "task-2" });
    await waitFor(() => runtime2.listLiveContinuations().find((entry) => entry.taskId === "task-2")?.state === "completed");
    runtime2.close();
  });

  it("released immediate leases wake normal queued orchestration work", async () => {
    const runtime = new OrchestrationRuntime({ config: config(), dbPath, startReaper: false });
    const immediate = runtime.tryAllocationNow(request("board-ticket-1", "ticket-dispatch:manual"));
    expect(immediate.ok).toBe(true);
    if (!immediate.ok) return;
    const blocked = runtime.requestAllocation(request("task-2", "coord-2"));
    expect(blocked.ok).toBe(false);
    runtime.queueLiveContinuation(continuation("task-2", "coord-2"));
    const resumed: Array<{ taskId: string; allocationId: string }> = [];
    runtime.setResumeQueuedRunHandler(async ({ continuation, allocation }) => {
      resumed.push({ taskId: continuation.taskId, allocationId: allocation.allocationId });
    });

    runtime.releaseLease(immediate.allocation.leases[0].leaseId, "ticket-dispatch:manual");

    await waitFor(() => resumed.length === 1);
    expect(resumed[0]).toMatchObject({ taskId: "task-2" });
    runtime.close();
  });

  it("persists global queue pause and suppresses queued dispatch after lease release", async () => {
    const runtime1 = new OrchestrationRuntime({ config: config(), dbPath, startReaper: false });
    const first = runtime1.requestAllocation(request("task-paused-1", "coord-paused-1"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const blocked = runtime1.requestAllocation(request("task-paused-2", "coord-paused-2"));
    expect(blocked.ok).toBe(false);
    runtime1.queueLiveContinuation(continuation("task-paused-2", "coord-paused-2"));
    expect(runtime1.pauseQueue("operator hold")).toMatchObject({
      queuePaused: true,
      pauseReason: "operator hold",
    });
    runtime1.close();

    const runtime2 = new OrchestrationRuntime({ config: config(), dbPath, startReaper: false });
    expect(runtime2.getControlState()).toMatchObject({ queuePaused: true, pauseReason: "operator hold" });
    const resumed: Array<{ taskId: string; allocationId: string }> = [];
    runtime2.setResumeQueuedRunHandler(async ({ continuation, allocation }) => {
      resumed.push({ taskId: continuation.taskId, allocationId: allocation.allocationId });
    });

    runtime2.releaseLease(first.allocation.leases[0].leaseId, "coord-paused-1");
    await sleep(50);

    expect(resumed).toEqual([]);
    expect(runtime2.listLiveContinuations()).toMatchObject([{ taskId: "task-paused-2", state: "queued" }]);
    expect(runtime2.listQueue()).toMatchObject([{ taskId: "task-paused-2" }]);
    runtime2.close();
  });

  it("queue resume retries with live headroom before leasing", async () => {
    let headroomCalls = 0;
    const runtime = new OrchestrationRuntime({
      config: config(),
      dbPath,
      startReaper: false,
      cuttlefishConfig: cuttlefishConfig(dbPath),
      headroomFilter: async (workers) => {
        headroomCalls++;
        return {
          allowed: [],
          rejected: workers.map((worker) => ({
            worker,
            headroom: { ok: false, provider: worker.provider, reason: "usage_exhausted" },
          })),
        };
      },
    });
    const first = runtime.requestAllocation(request("task-resume-1", "coord-resume-1"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const blocked = runtime.requestAllocation(request("task-resume-2", "coord-resume-2"));
    expect(blocked.ok).toBe(false);
    runtime.queueLiveContinuation(continuation("task-resume-2", "coord-resume-2"));
    runtime.pauseQueue("wait for quota");
    runtime.releaseLease(first.allocation.leases[0].leaseId, "coord-resume-1");

    const result = await runtime.resumeQueue();

    expect(result.controlState.queuePaused).toBe(false);
    expect(result.retryResults).toEqual([]);
    expect(headroomCalls).toBeGreaterThan(0);
    expect(runtime.listQueue()).toMatchObject([{ taskId: "task-resume-2" }]);
    expect(runtime.listLeases().filter((lease) => lease.state === "running")).toEqual([]);
    runtime.close();
  });

  it("per-task pause suppresses only the matching queued task until resumed", async () => {
    const runtime = new OrchestrationRuntime({ config: config(), dbPath, startReaper: false });
    const first = runtime.requestAllocation(request("task-active", "coord-active"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(runtime.requestAllocation(request("task-paused", "coord-paused")).ok).toBe(false);
    expect(runtime.requestAllocation(request("task-open", "coord-open")).ok).toBe(false);
    runtime.queueLiveContinuation(continuation("task-paused", "coord-paused"));
    runtime.queueLiveContinuation(continuation("task-open", "coord-open"));
    runtime.pauseTask("task-paused", "coord-paused", { reason: "operator task hold" });
    const resumed: string[] = [];
    runtime.setResumeQueuedRunHandler(async ({ continuation }) => {
      resumed.push(continuation.taskId);
    });

    runtime.releaseLease(first.allocation.leases[0].leaseId, "coord-active");

    await waitFor(() => resumed.includes("task-open"));
    expect(resumed).not.toContain("task-paused");
    expect(runtime.listLiveContinuations()).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: "task-paused", state: "queued" }),
      expect.objectContaining({ taskId: "task-open", state: "completed" }),
    ]));
    const openLease = runtime.listLeases().find((lease) => lease.taskId === "task-open" && lease.state === "running");
    expect(openLease).toBeDefined();
    if (!openLease) return;
    runtime.releaseLease(openLease.leaseId, openLease.coordinatorId);

    await runtime.resumeTask("task-paused", "coord-paused");
    await waitFor(() => resumed.includes("task-paused"));
    runtime.close();
  });

  it("active holds block held worker allocation until expiry", async () => {
    const runtime = new OrchestrationRuntime({
      config: twoWorkerConfig(),
      dbPath,
      startReaper: false,
    });
    runtime.createHold({
      managerName: "exec",
      workerIds: ["alphaImplementer"],
      roles: [],
      ttlMs: 60_000,
      reason: "reserve alpha",
    });

    const result = await runtime.requestAllocationWithLiveHeadroom(request("held-task", "held-coord"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.allocation.leases[0].workerId).toBe("betaImplementer");
    runtime.close();
  });

  it("releases resumed allocations that have no live continuation to dispatch", async () => {
    const runtime = new OrchestrationRuntime({ config: config(), dbPath, startReaper: false });
    const first = runtime.requestAllocation(request("task-1", "coord-1"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const blocked = runtime.requestAllocation(request("task-2", "coord-2"));
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;

    runtime.releaseLease(first.allocation.leases[0].leaseId, "coord-1");

    await waitFor(() => runtime.listLeases().every((lease) => lease.state !== "running"));
    expect(runtime.listLiveContinuations()).toEqual([]);
    runtime.close();
  });

  it("retries a failed live continuation by reallocating and dispatching it", async () => {
    const runtime = new OrchestrationRuntime({ config: config(), dbPath, startReaper: false });
    runtime.queueLiveContinuation(continuation("task-3", "coord-3", {
      state: "failed",
      lastError: "forced engine failure",
      allocationId: "alloc-old",
    }));
    const resumed: Array<{ taskId: string; allocationId: string }> = [];
    runtime.setResumeQueuedRunHandler(async ({ continuation, allocation }) => {
      resumed.push({ taskId: continuation.taskId, allocationId: allocation.allocationId });
    });

    const result = await runtime.retryFailedLiveContinuation("task-3", "coord-3");

    expect(result).toMatchObject({ ok: true, state: "dispatching" });
    await waitFor(() => resumed.length === 1);
    expect(resumed[0]).toMatchObject({ taskId: "task-3" });
    runtime.close();
  });

  it("does not dispatch manual failed-continuation retry while globally paused", async () => {
    const runtime = new OrchestrationRuntime({ config: config(), dbPath, startReaper: false });
    runtime.queueLiveContinuation(continuation("task-paused-retry", "coord-paused-retry", {
      state: "failed",
      lastError: "forced engine failure",
    }));
    runtime.pauseQueue("operator hold");
    const resumed: Array<{ taskId: string; allocationId: string }> = [];
    runtime.setResumeQueuedRunHandler(async ({ continuation, allocation }) => {
      resumed.push({ taskId: continuation.taskId, allocationId: allocation.allocationId });
    });

    const result = await runtime.retryFailedLiveContinuation("task-paused-retry", "coord-paused-retry");

    expect(result).toMatchObject({ ok: true, state: "paused" });
    expect(runtime.listLeases()).toEqual([]);
    expect(runtime.listLiveContinuations()).toMatchObject([{ taskId: "task-paused-retry", state: "queued" }]);
    expect(resumed).toEqual([]);
    runtime.close();
  });

  it("applies live headroom before retrying a failed continuation", async () => {
    const runtime = new OrchestrationRuntime({
      config: config(),
      dbPath,
      startReaper: false,
      cuttlefishConfig: cuttlefishConfig(dbPath),
      headroomFilter: async (workers) => ({
        allowed: [],
        rejected: workers.map((worker) => ({
          worker,
          headroom: { ok: false, provider: worker.provider, reason: "usage_exhausted" },
        })),
      }),
    });
    runtime.queueLiveContinuation(continuation("task-headroom-retry", "coord-headroom-retry", {
      state: "failed",
      lastError: "forced engine failure",
    }));
    const resumed: Array<{ taskId: string; allocationId: string }> = [];
    runtime.setResumeQueuedRunHandler(async ({ continuation, allocation }) => {
      resumed.push({ taskId: continuation.taskId, allocationId: allocation.allocationId });
    });

    const result = await runtime.retryFailedLiveContinuation("task-headroom-retry", "coord-headroom-retry");

    expect(result).toMatchObject({ ok: true, state: "blocked_resource" });
    expect(runtime.listLeases()).toEqual([]);
    expect(resumed).toEqual([]);
    runtime.close();
  });

  it("headroomFilter exception closes the headroom gate and blocks allocation", async () => {
    const runtime = new OrchestrationRuntime({
      config: config(),
      dbPath,
      startReaper: false,
      cuttlefishConfig: cuttlefishConfig(dbPath),
      headroomFilter: async () => {
        throw new Error("headroom service unavailable");
      },
    });
    const result = await runtime.requestAllocationWithLiveHeadroom(request("headroom-fail-task", "headroom-fail-coord"));

    // fail-closed: exception → empty allowedWorkerIds → no allocation
    expect(result.ok).toBe(false);
    expect(runtime.listLeases()).toHaveLength(0);
    runtime.close();
  });

  it("hold TTL expiry un-blocks held workers for subsequent allocations", async () => {
    const runtime = new OrchestrationRuntime({
      config: twoWorkerConfig(),
      dbPath,
      startReaper: false,
    });
    const hold = runtime.createHold({
      managerName: "exec",
      workerIds: ["alphaImplementer"],
      roles: [],
      ttlMs: 1, // expires almost immediately
      reason: "reserve alpha",
    });
    expect(hold.state).toBe("active");

    // Wait just a bit for the hold to expire, then allocate with headroom resolution
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Use live headroom path which calls expireHolds first
    const result = await runtime.requestAllocationWithLiveHeadroom(request("hold-expired-task", "hold-expired-coord"));
    // With no cuttlefishConfig (no live filter), expireHolds runs and alphaImplementer becomes available again
    expect(result.ok).toBe(true);
    runtime.close();
  });

  it("loads empirical routing scores while skipping corrupt telemetry lines", async () => {
    const prevHome = process.env.CUTTLEFISH_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-orch-runtime-telemetry-"));
    process.env.CUTTLEFISH_HOME = home;
    vi.resetModules();
    try {
      fs.mkdirSync(path.join(home, "logs"), { recursive: true });
      fs.writeFileSync(path.join(home, "logs", "orchestration-telemetry.jsonl"), [
        "{corrupt",
        JSON.stringify({
          task_id: "historical-task",
          coordinator_id: "historical-coord",
          session_id: "historical-session",
          lease_id: "historical-lease",
          worker_id: "betaImplementer",
          provider: "mock",
          family: "local",
          model: "mock",
          role: "seniorImplementer",
          mode: "single_worker",
          source: "orchestration",
          cost: null,
          latency_ms: null,
          tokens: null,
          files_changed: null,
          tests_added: null,
          tests_passed: null,
          review_blockers: null,
          human_edits: null,
          regressions: null,
          disposition: "selected",
          timestamp: "2026-06-24T10:00:00.000Z",
        }),
      ].join("\n"));
      const runtimeModule = await import("../runtime.js");
      const runtime = runtimeModule.createOrchestrationRuntimeFromConfig(cuttlefishConfig(path.join(home, "orchestration.db")), {
        config: twoWorkerConfig(),
        startReaper: false,
      });
      expect(runtime).toBeDefined();
      if (!runtime) return;
      const result = runtime.requestAllocation(request("empirical-task", "coord"));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.allocation.leases[0].workerId).toBe("betaImplementer");
      runtime.close();
    } finally {
      if (prevHome === undefined) delete process.env.CUTTLEFISH_HOME;
      else process.env.CUTTLEFISH_HOME = prevHome;
      fs.rmSync(home, { recursive: true, force: true });
      vi.resetModules();
    }
  });

  it("recovers stale dispatching continuations on boot and releases their leases", () => {
    const runtime1 = new OrchestrationRuntime({ config: config(), dbPath, startReaper: false });
    const allocation = runtime1.requestAllocation(request("stale-task", "stale-coord"));
    expect(allocation.ok).toBe(true);
    if (!allocation.ok) return;
    runtime1.queueLiveContinuation(continuation("stale-task", "stale-coord", {
      state: "dispatching",
      allocationId: allocation.allocation.allocationId,
      updatedAt: "1970-01-01T00:00:00.000Z",
    }));
    runtime1.close();

    const runtime2 = new OrchestrationRuntime({
      config: config(),
      dbPath,
      startReaper: false,
      staleDispatchingContinuationMs: 0,
    });

    expect(runtime2.listLiveContinuations()).toMatchObject([{
      taskId: "stale-task",
      state: "failed",
      lastError: expect.stringContaining("Recovered stale dispatching continuation"),
    }]);
    expect(runtime2.listLeases()).toMatchObject([{ state: "released" }]);
    runtime2.close();
  });

  it("recovers dispatching continuations left by an older boot generation even when updated_at is recent (TMP-CUT-013)", () => {
    const runtime1 = new OrchestrationRuntime({ config: config(), dbPath, startReaper: false });
    const allocation = runtime1.requestAllocation(request("gen-stale-task", "gen-stale-coord"));
    expect(allocation.ok).toBe(true);
    if (!allocation.ok) return;
    runtime1.queueLiveContinuation(continuation("gen-stale-task", "gen-stale-coord", {
      state: "dispatching",
      allocationId: allocation.allocation.allocationId,
      // Recent by wall clock (default staleDispatchingContinuationMs is
      // minutes), so the clock check alone would NOT flag this as stale.
      // Only the monotonic boot-generation cross-check should catch it.
      updatedAt: new Date().toISOString(),
    }));
    runtime1.close();

    const runtime2 = new OrchestrationRuntime({
      config: config(),
      dbPath,
      startReaper: false,
    });

    expect(runtime2.listLiveContinuations()).toMatchObject([{
      taskId: "gen-stale-task",
      state: "failed",
      lastError: expect.stringContaining("Recovered stale dispatching continuation"),
    }]);
    expect(runtime2.listLeases()).toMatchObject([{ state: "released" }]);
    runtime2.close();
  });

  it("prepareForShutdown fails dispatching continuations and releases running leases", async () => {
    const runtime = new OrchestrationRuntime({ config: config(), dbPath, startReaper: false });
    const allocation = runtime.requestAllocation(request("shutdown-task", "shutdown-coord"));
    expect(allocation.ok).toBe(true);
    if (!allocation.ok) return;
    runtime.queueLiveContinuation(continuation("shutdown-task", "shutdown-coord", {
      state: "dispatching",
      allocationId: allocation.allocation.allocationId,
    }));

    await runtime.prepareForShutdown("test shutdown", 1);

    expect(runtime.listLiveContinuations()).toMatchObject([{ taskId: "shutdown-task", state: "failed", lastError: "test shutdown" }]);
    expect(runtime.listLeases()).toMatchObject([{ state: "released" }]);
    runtime.close();
  });

  it("invokes the expired lease handler and retains diagnostic status", () => {
    const runtime = new OrchestrationRuntime({ config: config(), dbPath, startReaper: false });
    const allocation = runtime.requestAllocation(request("expiry-task", "expiry-coord", { leaseDurationMs: 1 }));
    expect(allocation.ok).toBe(true);
    if (!allocation.ok) return;
    const lease = allocation.allocation.leases[0];
    const handled: string[] = [];
    runtime.setExpiredLeaseHandler((leases) => leases.map((entry) => {
      handled.push(entry.leaseId);
      return {
        leaseId: entry.leaseId,
        sessionId: "session-expired",
        status: "interrupted",
        interruptible: true,
      };
    }));

    runtime.expireLeases(new Date(Date.parse(lease.leaseExpiresAt) + 1));

    expect(handled).toEqual([lease.leaseId]);
    expect(runtime.listLeases().find((entry) => entry.leaseId === lease.leaseId)).toMatchObject({ state: "expired" });
    expect(runtime.listExpiredLeaseHandling()).toEqual([{
      leaseId: lease.leaseId,
      sessionId: "session-expired",
      status: "interrupted",
      interruptible: true,
    }]);
    runtime.close();
  });

  it("warns when the target repo's HEAD moved between enqueue and dispatch", async () => {
    const repoDir = initGitRepo();
    try {
      const shaAtEnqueue = headSha(repoDir);
      const runtime = new OrchestrationRuntime({ config: config(), dbPath, startReaper: false });
      const first = runtime.requestAllocation(request("task-1", "coord-1"));
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const blocked = runtime.requestAllocation(request("task-2", "coord-2"));
      expect(blocked.ok).toBe(false);

      runtime.queueLiveContinuation(continuation("task-2", "coord-2", { taskCwd: repoDir }));
      // The enqueue-time HEAD SHA is captured once, up front, and never touched again.
      expect(runtime.getLiveContinuation("task-2", "coord-2")?.task.enqueueHeadSha).toBe(shaAtEnqueue);

      // Simulate the repo moving forward (a push/rebase elsewhere) while task-2 sits blocked.
      commitFile(repoDir, "second-commit");
      const shaAtDispatch = headSha(repoDir);
      expect(shaAtDispatch).not.toBe(shaAtEnqueue);

      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      const resumed: string[] = [];
      runtime.setResumeQueuedRunHandler(async ({ continuation }) => {
        resumed.push(continuation.taskId);
      });

      runtime.releaseLease(first.allocation.leases[0].leaseId, "coord-1");

      await waitFor(() => resumed.length === 1);
      // Dispatch proceeds exactly as before -- the warning does not block it.
      expect(resumed).toEqual(["task-2"]);
      expect(runtime.listLiveContinuations()).toMatchObject([{ taskId: "task-2", state: "completed" }]);
      expect(warnSpy.mock.calls.some(([msg]) =>
        typeof msg === "string"
        && msg.includes("task-2/coord-2")
        && msg.includes(shaAtEnqueue)
        && msg.includes(shaAtDispatch)
      )).toBe(true);
      warnSpy.mockRestore();
      runtime.close();
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("does not warn when the target repo's HEAD is unchanged between enqueue and dispatch", async () => {
    const repoDir = initGitRepo();
    try {
      const runtime = new OrchestrationRuntime({ config: config(), dbPath, startReaper: false });
      const first = runtime.requestAllocation(request("task-1", "coord-1"));
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const blocked = runtime.requestAllocation(request("task-2", "coord-2"));
      expect(blocked.ok).toBe(false);

      runtime.queueLiveContinuation(continuation("task-2", "coord-2", { taskCwd: repoDir }));

      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      const resumed: string[] = [];
      runtime.setResumeQueuedRunHandler(async ({ continuation }) => {
        resumed.push(continuation.taskId);
      });

      runtime.releaseLease(first.allocation.leases[0].leaseId, "coord-1");

      await waitFor(() => resumed.length === 1);
      expect(resumed).toEqual(["task-2"]);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
      runtime.close();
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("applies live headroom before allocating a worker", async () => {
    const runtime = new OrchestrationRuntime({
      config: twoWorkerConfig(),
      dbPath,
      startReaper: false,
      cuttlefishConfig: cuttlefishConfig(dbPath),
      headroomFilter: async (workers) => ({
        allowed: workers.filter((worker) => worker.id === "betaImplementer"),
        rejected: workers
          .filter((worker) => worker.id !== "betaImplementer")
          .map((worker) => ({
            worker,
            headroom: { ok: false, provider: worker.provider, reason: "usage_exhausted" },
          })),
      }),
    });

    const result = await runtime.requestAllocationWithLiveHeadroom(request("headroom-task", "headroom-coord"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.allocation.leases[0].workerId).toBe("betaImplementer");
    runtime.close();
  });
});

function continuation(
  taskId: string,
  coordinatorId: string,
  overrides: Partial<LiveRunContinuationRecord> & { taskCwd?: string } = {},
): LiveRunContinuationRecord {
  return {
    taskId,
    coordinatorId,
    mode: "single_worker",
    state: overrides.state ?? "queued",
    task: {
      taskId,
      coordinatorId,
      requiredRoles: ["seniorImplementer"],
      priority: "normal",
      leaseDurationMs: 60_000,
      prompt: `Resume ${taskId}`,
      cwd: overrides.taskCwd,
    },
    enqueuedAt: "2026-06-24T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-06-24T10:00:00.000Z",
    retryCount: 0,
    lastDispatchedAt: overrides.lastDispatchedAt,
    allocationId: overrides.allocationId,
    lastError: overrides.lastError,
  };
}

function initGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-orch-runtime-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Cuttlefish Test"], { cwd: dir });
  commitFile(dir, "initial-commit");
  return dir;
}

function commitFile(dir: string, message: string): void {
  fs.writeFileSync(path.join(dir, `${message}.txt`), message);
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: dir });
}

function headSha(dir: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" }).trim();
}

function request(taskId: string, coordinatorId: string, overrides: { leaseDurationMs?: number } = {}) {
  return {
    taskId,
    coordinatorId,
    requiredRoles: ["seniorImplementer"],
    optionalRoles: [],
    priority: "normal" as const,
    leaseDurationMs: overrides.leaseDurationMs ?? 60_000,
  };
}

function config(): OrchestrationConfig {
  return {
    workers: [{
      id: "mockImplementer",
      provider: "mock",
      family: "local",
      tier: "frontier",
      capabilities: ["repo_edit", "coding"],
      tools: ["git", "filesystem"],
      maxConcurrentTasks: 1,
      costClass: "low",
      workspacePolicy: "shared",
    }],
    roles: [{
      id: "seniorImplementer",
      requiredCapabilities: ["repo_edit", "coding"],
      requiredTools: ["git", "filesystem"],
    }],
    coordinatorTemplates: [],
    quotas: { providers: {}, families: {} },
  };
}

function twoWorkerConfig(): OrchestrationConfig {
  const cfg = config();
  return {
    ...cfg,
    workers: [
      { ...cfg.workers[0], id: "alphaImplementer" },
      { ...cfg.workers[0], id: "betaImplementer" },
    ],
  };
}

function cuttlefishConfig(dbPath: string): CuttlefishConfig {
  return {
    gateway: { port: 8888, host: "127.0.0.1" },
    engines: {
      default: "codex",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt" },
    },
    connectors: {},
    logging: { file: false, stdout: false, level: "error" },
    orchestration: { enabled: true, empiricalRouting: true, dbPath },
  } as CuttlefishConfig;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
