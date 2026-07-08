import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import fs from "node:fs";
import path from "node:path";
import type { BoardTicket } from "../board-service.js";

let tmpHome: string;
const testHome = withTempCuttlefishHome("cuttlefish-ticket-dispatch-idempotency-");

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

function seedOrg() {
  fs.mkdirSync(departmentDir(), { recursive: true });
  fs.writeFileSync(path.join(departmentDir(), "worker.yaml"), [
    "name: worker",
    "displayName: Worker",
    "department: software-delivery",
    "rank: employee",
    "engine: claude",
    "model: opus",
    "persona: worker",
  ].join("\n"));
  fs.writeFileSync(boardPath(), JSON.stringify([
    {
      id: "ticket-1",
      title: "Repair dispatch",
      description: "Ensure retry is idempotent",
      status: "todo",
      priority: "high",
      complexity: "medium",
      assignee: "worker",
      createdAt: "2026-06-23T00:00:00.000Z",
      updatedAt: "2026-06-23T00:00:00.000Z",
    },
  ], null, 2));
}

beforeEach(() => {
  tmpHome = testHome.home();
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("../api/session-dispatch.js");
  vi.doUnmock("../board-service.js");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("ticket dispatch idempotency", () => {
  it("reuses a pre-created session after board write failure instead of duplicating it", async () => {
    seedOrg();

    let failNextBoardWrite = true;
    const dispatchWebSessionRun = vi.fn();

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
    const context = {
      getConfig: () => ({ gateway: {}, engines: { default: "claude", claude: { bin: "claude", model: "opus" } } }),
      connectors: new Map(),
      startTime: Date.now(),
      emit: vi.fn(),
      sessionManager: {
        getEngine: () => ({ run: vi.fn() }),
        getQueue: () => ({ enqueue: vi.fn(), getPendingCount: () => 0, getTransportState: (_key: string, status: string) => status }),
      },
    } as any;

    await expect(dispatchTicket(
      "software-delivery",
      "ticket-1",
      { source: "board", routeToManager: false },
      { context, orgDir: orgDir(), now: () => Date.parse("2026-06-23T10:00:00.000Z") },
    )).rejects.toThrow("injected board write failure");

    const sessionsAfterFailure = registry.listSessions();
    expect(sessionsAfterFailure).toHaveLength(1);
    expect(sessionsAfterFailure[0].status).toBe("idle");
    expect(sessionsAfterFailure[0].sessionKey).toBe("board:software-delivery:ticket-1");
    expect(sessionsAfterFailure[0].transportMeta).toMatchObject({
      boardDepartment: "software-delivery",
      boardTicketId: "ticket-1",
      boardDispatchState: "session_created",
    });
    expect(readBoard()[0].status).toBe("todo");
    expect(readBoard()[0].sessionId).toBeUndefined();
    expect(dispatchWebSessionRun).not.toHaveBeenCalled();

    const retry = await dispatchTicket(
      "software-delivery",
      "ticket-1",
      { source: "board", routeToManager: false },
      { context, orgDir: orgDir(), now: () => Date.parse("2026-06-23T10:01:00.000Z") },
    );

    expect(retry).toEqual({ ok: true, sessionId: sessionsAfterFailure[0].id });

    const sessionsAfterRetry = registry.listSessions();
    expect(sessionsAfterRetry).toHaveLength(1);
    expect(sessionsAfterRetry[0]).toMatchObject({
      id: sessionsAfterFailure[0].id,
      status: "running",
      sessionKey: "board:software-delivery:ticket-1",
    });
    expect(sessionsAfterRetry[0].transportMeta).toMatchObject({
      boardDepartment: "software-delivery",
      boardTicketId: "ticket-1",
      boardDispatchState: "board_linked",
    });
    expect(readBoard()[0]).toMatchObject({
      status: "in_progress",
      sessionId: sessionsAfterFailure[0].id,
      assignee: "worker",
      updatedAt: "2026-06-23T10:01:00.000Z",
    });
    await waitForCall(dispatchWebSessionRun);
    expect(dispatchWebSessionRun).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("serializes two concurrent dispatches of the same ticket — exactly one wins, no lost board update (CON-002)", async () => {
    seedOrg();

    const dispatchWebSessionRun = vi.fn(() => Promise.resolve());
    vi.doMock("../api/session-dispatch.js", () => ({ dispatchWebSessionRun }));

    const { dispatchTicket } = await import("../ticket-dispatch.js");
    const registry = await import("../../sessions/registry.js");
    const context = {
      getConfig: () => ({ gateway: {}, engines: { default: "claude", claude: { bin: "claude", model: "opus" } } }),
      connectors: new Map(),
      startTime: Date.now(),
      emit: vi.fn(),
      sessionManager: {
        getEngine: () => ({ run: vi.fn() }),
        getQueue: () => ({ enqueue: vi.fn(), getPendingCount: () => 0, getTransportState: (_key: string, status: string) => status }),
      },
    } as any;

    const deps = { context, orgDir: orgDir(), now: () => Date.parse("2026-06-23T10:00:00.000Z") };
    const [first, second] = await Promise.all([
      dispatchTicket("software-delivery", "ticket-1", { source: "board", routeToManager: false }, deps),
      dispatchTicket("software-delivery", "ticket-1", { source: "board", routeToManager: false }, deps),
    ]);

    const results = [first, second];
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as { reason: string }).reason).toBe("already-running");

    // The board must record exactly the winner's session — no torn/lost write.
    const board = readBoard();
    expect(board).toHaveLength(1);
    expect(board[0].status).toBe("in_progress");
    expect(board[0].sessionId).toBe((winners[0] as { sessionId: string }).sessionId);

    // Only one session was ever created for this ticket.
    const sessions = registry.listSessions();
    expect(sessions).toHaveLength(1);
    await waitForCall(dispatchWebSessionRun);
    expect(dispatchWebSessionRun).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("redispatches a todo ticket that still points at a stopped prior session", async () => {
    seedOrg();

    const dispatchWebSessionRun = vi.fn(() => Promise.resolve());
    vi.doMock("../api/session-dispatch.js", () => ({ dispatchWebSessionRun }));

    const { createSession, updateSession, getSession } = await import("../../sessions/registry.js");
    const staleSession = createSession({
      engine: "claude",
      source: "board",
      sourceRef: "board:software-delivery:ticket-1:stale",
      connector: "board",
      sessionKey: "board:software-delivery:ticket-1",
      replyContext: { source: "board", department: "software-delivery", ticketId: "ticket-1" },
      transportMeta: {
        boardDepartment: "software-delivery",
        boardTicketId: "ticket-1",
        boardDispatchState: "board_linked",
        dispatchSource: "board",
      },
      employee: "worker",
      model: "opus",
      title: "Repair dispatch",
      prompt: "Ensure retry is idempotent",
      promptExcerpt: "Repair dispatch",
    });
    updateSession(staleSession.id, {
      status: "idle",
      lastActivity: "2026-06-23T09:59:00.000Z",
    });

    fs.writeFileSync(boardPath(), JSON.stringify([
      {
        ...readBoard()[0],
        status: "todo",
        sessionId: staleSession.id,
        source: "board",
      },
    ], null, 2));

    const { dispatchTicket } = await import("../ticket-dispatch.js");
    const context = {
      getConfig: () => ({ gateway: {}, engines: { default: "claude", claude: { bin: "claude", model: "opus" } } }),
      connectors: new Map(),
      startTime: Date.now(),
      emit: vi.fn(),
      sessionManager: {
        getEngine: () => ({ run: vi.fn() }),
        getQueue: () => ({ enqueue: vi.fn(), getPendingCount: () => 0, getTransportState: (_key: string, status: string) => status }),
      },
    } as any;

    const result = await dispatchTicket(
      "software-delivery",
      "ticket-1",
      { source: "board", routeToManager: false },
      { context, orgDir: orgDir(), now: () => Date.parse("2026-06-23T10:00:00.000Z") },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.sessionId).not.toBe(staleSession.id);
    expect(getSession(staleSession.id)?.status).toBe("idle");
    expect(readBoard()[0]).toMatchObject({
      status: "in_progress",
      sessionId: result.sessionId,
      assignee: "worker",
      updatedAt: "2026-06-23T10:00:00.000Z",
    });
    await waitForCall(dispatchWebSessionRun);
    expect(dispatchWebSessionRun).toHaveBeenCalledTimes(1);
  }, 15_000);
});
