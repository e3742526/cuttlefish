import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import fs from "node:fs";
import path from "node:path";
import type { BoardTicket } from "../board-service.js";
import type { OrchestrationRuntime } from "../../orchestration/runtime.js";

let tmpHome: string;
const testHome = withTempCuttlefishHome("cuttlefish-ticket-dispatch-orch-");
const runtimes: OrchestrationRuntime[] = [];

/** dispatchTicket() fires its dispatch fire-and-forget through
 *  dispatchEmployeeSessionRun, which now resolves dispatchWebSessionRun via a
 *  dynamic import (to avoid a static import cycle with session-dispatch.ts) —
 *  an extra microtask hop beyond dispatchTicket()'s own resolution. Poll
 *  instead of asserting immediately. */
async function waitForCall(fn: { mock: { calls: unknown[] } }, times = 1, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn.mock.calls.length >= times) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (fn.mock.calls.length < times) throw new Error(`waitForCall: expected ${times} call(s), got ${fn.mock.calls.length}`);
}

function orgDir() {
  return path.join(tmpHome, "org");
}

function departmentDir() {
  return path.join(orgDir(), "software-delivery");
}

function boardPath() {
  return path.join(departmentDir(), "board.json");
}

function readBoard(): BoardTicket[] {
  const payload = JSON.parse(fs.readFileSync(boardPath(), "utf-8"));
  return Array.isArray(payload) ? payload as BoardTicket[] : payload.tickets as BoardTicket[];
}

beforeEach(() => {
  tmpHome = testHome.home();
  vi.resetModules();
});

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.close();
  vi.doUnmock("../api/session-dispatch.js");
  vi.doUnmock("../board-service.js");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("ticket dispatch orchestration bridge", () => {
  it("manual dispatch creates a board-linked session with lease metadata and releases after run settles", async () => {
    seedOrg([ticket("ticket-1", "worker")]);
    const deferred = promiseGate();
    const dispatchWebSessionRun = vi.fn(() => deferred.promise);
    vi.doMock("../api/session-dispatch.js", () => ({ dispatchWebSessionRun }));
    const { dispatchTicket } = await import("../ticket-dispatch.js");
    const registry = await import("../../sessions/registry.js");
    const telemetry = await import("../../orchestration/telemetry.js");
    const { context, runtime } = await makeContext();

    const result = await dispatchTicket(
      "software-delivery",
      "ticket-1",
      { source: "manual", routeToManager: false },
      { context, orgDir: orgDir(), now: () => Date.parse("2026-06-24T10:00:00.000Z") },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    const session = registry.getSession(result.sessionId);
    expect(session?.transportMeta).toMatchObject({
      boardDepartment: "software-delivery",
      boardTicketId: "ticket-1",
      boardDispatchState: "board_linked",
      orchestrationLease: {
        taskId: "manual:software-delivery:ticket-1",
        coordinatorId: "ticket-dispatch:manual",
        workerId: expect.stringContaining("worker"),
      },
    });
    expect(runtime.listLeases()).toEqual([expect.objectContaining({ state: "running" })]);
    await waitForCall(dispatchWebSessionRun);
    expect(dispatchWebSessionRun).toHaveBeenCalledTimes(1);

    deferred.resolve();
    await settle();

    expect(runtime.listLeases()).toEqual([expect.objectContaining({ state: "released" })]);
    const records = telemetry.readOrchestrationTelemetry(telemetry.ORCHESTRATION_TELEMETRY_LOG).records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      task_id: "manual:software-delivery:ticket-1",
      coordinator_id: "ticket-dispatch:manual",
      session_id: result.sessionId,
      provider: "mock",
      family: "local",
      mode: "single_worker",
      source: "manual",
      disposition: "completed",
    });
  });

  it("releases the lease when board write fails after allocation and remains retryable", async () => {
    seedOrg([ticket("ticket-1", "worker")]);
    let failNextBoardWrite = true;
    const dispatchWebSessionRun = vi.fn(() => Promise.resolve());
    vi.doMock("../api/session-dispatch.js", () => ({ dispatchWebSessionRun }));
    vi.doMock("../board-service.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../board-service.js")>();
      const failableWrite = (dir: string, department: string, tickets: BoardTicket[]) => {
        if (failNextBoardWrite) {
          failNextBoardWrite = false;
          throw new Error("injected board write failure");
        }
        return actual.writeBoardTicketsWithinLock(dir, department, tickets);
      };
      return {
        ...actual,
        writeBoardTickets: vi.fn(failableWrite),
        writeBoardTicketsWithinLock: vi.fn(failableWrite),
      };
    });
    const { dispatchTicket } = await import("../ticket-dispatch.js");
    const registry = await import("../../sessions/registry.js");
    const { context, runtime } = await makeContext();

    await expect(dispatchTicket(
      "software-delivery",
      "ticket-1",
      { source: "manual", routeToManager: false },
      { context, orgDir: orgDir(), now: () => Date.parse("2026-06-24T10:00:00.000Z") },
    )).rejects.toThrow("injected board write failure");

    expect(runtime.listLeases()).toEqual([expect.objectContaining({ state: "released" })]);
    expect(readBoard()[0].status).toBe("todo");
    expect(dispatchWebSessionRun).not.toHaveBeenCalled();
    const failedSession = registry.listSessions()[0];

    const retry = await dispatchTicket(
      "software-delivery",
      "ticket-1",
      { source: "manual", routeToManager: false },
      { context, orgDir: orgDir(), now: () => Date.parse("2026-06-24T10:01:00.000Z") },
    );

    expect(retry).toEqual({ ok: true, sessionId: failedSession.id });
    expect(registry.listSessions()).toHaveLength(1);
    expect(registry.getSession(failedSession.id)?.transportMeta).toMatchObject({
      boardDispatchState: "board_linked",
      orchestrationLease: {
        coordinatorId: "ticket-dispatch:manual",
      },
    });
    expect(readBoard()[0]).toMatchObject({ status: "in_progress", sessionId: failedSession.id });
    await waitForCall(dispatchWebSessionRun);
    await settle();
    expect(runtime.listLeases().filter((lease) => lease.state === "running")).toHaveLength(0);
  });

  it("leaves a second ticket todo when the exact assigned worker is busy", async () => {
    seedOrg([ticket("ticket-1", "worker"), ticket("ticket-2", "worker")]);
    const deferred = promiseGate();
    vi.doMock("../api/session-dispatch.js", () => ({ dispatchWebSessionRun: vi.fn(() => deferred.promise) }));
    const { dispatchTicket } = await import("../ticket-dispatch.js");
    const { context } = await makeContext();

    const first = await dispatchTicket(
      "software-delivery",
      "ticket-1",
      { source: "board-worker", routeToManager: true },
      { context, orgDir: orgDir(), now: () => Date.parse("2026-06-24T10:00:00.000Z") },
    );
    const second = await dispatchTicket(
      "software-delivery",
      "ticket-2",
      { source: "board-worker", routeToManager: true },
      { context, orgDir: orgDir(), now: () => Date.parse("2026-06-24T10:00:01.000Z") },
    );

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: "orchestration-busy" });
    expect(readBoard().find((entry) => entry.id === "ticket-2")).toMatchObject({ status: "todo" });

    deferred.resolve();
    await settle();
  });

  it("releases an allocated lease when the ticket is claimed before board linking", async () => {
    seedOrg([ticket("ticket-1", "worker")]);
    const dispatchWebSessionRun = vi.fn();
    vi.doMock("../api/session-dispatch.js", () => ({ dispatchWebSessionRun }));
    const { dispatchTicket } = await import("../ticket-dispatch.js");
    const { context, runtime } = await makeContext({
      headroomFilter: async (workers) => {
        const claimed = readBoard();
        claimed[0].status = "in_progress";
        claimed[0].sessionId = "external-session";
        fs.writeFileSync(boardPath(), JSON.stringify(claimed, null, 2));
        return { allowed: workers, rejected: [] };
      },
    });

    const result = await dispatchTicket(
      "software-delivery",
      "ticket-1",
      { source: "manual", routeToManager: false },
      { context, orgDir: orgDir(), now: () => Date.parse("2026-06-24T10:00:00.000Z") },
    );

    expect(result).toEqual({ ok: false, reason: "already-running" });
    expect(runtime.listLeases()).toEqual([expect.objectContaining({ state: "released" })]);
    expect(dispatchWebSessionRun).not.toHaveBeenCalled();
    expect(readBoard()[0]).toMatchObject({ status: "in_progress", sessionId: "external-session" });
  });

  it("fails visible instead of using legacy dispatch when orchestration runtime is unavailable", async () => {
    seedOrg([ticket("ticket-1", "worker")]);
    const dispatchWebSessionRun = vi.fn();
    vi.doMock("../api/session-dispatch.js", () => ({ dispatchWebSessionRun }));
    const { dispatchTicket } = await import("../ticket-dispatch.js");
    const context = makeBareContext({ orchestration: { enabled: true } });

    const result = await dispatchTicket(
      "software-delivery",
      "ticket-1",
      { source: "board-worker", routeToManager: true },
      { context, orgDir: orgDir(), now: () => Date.parse("2026-06-24T10:00:00.000Z") },
    );

    expect(result).toEqual({ ok: false, reason: "orchestration-unavailable" });
    expect(dispatchWebSessionRun).not.toHaveBeenCalled();
    expect(readBoard()[0].status).toBe("todo");
  });

  it("does not create a manual-dispatch lease when the exact worker lacks live headroom", async () => {
    seedOrg([ticket("ticket-1", "worker")]);
    const dispatchWebSessionRun = vi.fn();
    vi.doMock("../api/session-dispatch.js", () => ({ dispatchWebSessionRun }));
    const { dispatchTicket } = await import("../ticket-dispatch.js");
    const { context, runtime } = await makeContext({
      headroomFilter: async (workers) => ({
        allowed: [],
        rejected: workers.map((worker) => ({
          worker,
          headroom: { ok: false, provider: worker.provider, reason: "usage_exhausted" },
        })),
      }),
    });

    const result = await dispatchTicket(
      "software-delivery",
      "ticket-1",
      { source: "manual", routeToManager: false },
      { context, orgDir: orgDir(), now: () => Date.parse("2026-06-24T10:00:00.000Z") },
    );

    expect(result).toEqual({ ok: false, reason: "orchestration-busy" });
    expect(runtime.listLeases()).toEqual([]);
    expect(dispatchWebSessionRun).not.toHaveBeenCalled();
    expect(readBoard()[0].status).toBe("todo");
  });
});

async function makeContext(
  opts: Pick<ConstructorParameters<typeof OrchestrationRuntime>[0], "headroomFilter"> = {},
) {
  const { scanOrg } = await import("../org.js");
  const { OrchestrationRuntime } = await import("../../orchestration/runtime.js");
  const { augmentOrchestrationConfigWithOrgWorkers } = await import("../org-worker-bridge.js");
  const augmented = augmentOrchestrationConfigWithOrgWorkers(baseConfig(), scanOrg());
  const config = {
    gateway: {},
    engines: { default: "mock", mock: { bin: "mock", model: "mock" } },
    orchestration: { enabled: true, dbPath: path.join(tmpHome, "orchestration.db"), leaseDurationMs: 60_000 },
  };
  const runtime = new OrchestrationRuntime({
    config: augmented.config,
    dbPath: path.join(tmpHome, "orchestration.db"),
    startReaper: false,
    cuttlefishConfig: config as any,
    ...opts,
  });
  runtimes.push(runtime);
  return { runtime, context: makeBareContext(config, runtime) };
}

function makeBareContext(config: Record<string, unknown>, runtime?: OrchestrationRuntime) {
  return {
    config,
    getConfig: () => config,
    connectors: new Map(),
    startTime: Date.now(),
    emit: vi.fn(),
    orchestration: runtime ? { runtime } : undefined,
    sessionManager: {
      getEngine: (name: string) => ({ name, run: vi.fn() }),
      getQueue: () => ({
        enqueue: vi.fn(),
        getPendingCount: () => 0,
        getTransportState: (_key: string, status: string) => status,
      }),
    },
  } as any;
}

function seedOrg(tickets: BoardTicket[]): void {
  fs.mkdirSync(departmentDir(), { recursive: true });
  fs.writeFileSync(path.join(departmentDir(), "manager.yaml"), [
    "name: worker",
    "displayName: Worker",
    "department: software-delivery",
    "rank: manager",
    "engine: mock",
    "model: mock",
    "persona: worker",
  ].join("\n"));
  fs.writeFileSync(boardPath(), JSON.stringify(tickets, null, 2));
}

function ticket(id: string, assignee: string): BoardTicket {
  return {
    id,
    title: id,
    description: "Run this ticket",
    status: "todo",
    priority: "high",
    complexity: "low",
    assignee,
    createdAt: "2026-06-24T00:00:00.000Z",
    updatedAt: "2026-06-24T00:00:00.000Z",
  };
}

function baseConfig() {
  return {
    workers: [],
    roles: [],
    coordinatorTemplates: [],
    quotas: { providers: {}, families: {} },
  };
}

function promiseGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
