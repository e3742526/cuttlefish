import { describe, it, expect, beforeEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { Session } from "../../shared/types.js";
import { classifyOrphanedBoardTicket, reconcileDepartmentOrphanedTickets, reconcileOrphanedTickets, sweepOrphanedBoardTickets } from "../orphaned-ticket-reconciler.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-board-orphans-"));
const orgDir = path.join(tmp, "org");
const NOW = new Date("2026-06-21T12:00:00.000Z").getTime();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function writeBoard(dept: string, value: unknown) {
  const dir = path.join(orgDir, dept);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "board.json"), JSON.stringify(value, null, 2));
}

function readBoard(dept: string): any[] {
  return JSON.parse(fs.readFileSync(path.join(orgDir, dept, "board.json"), "utf-8"));
}

function session(overrides: Partial<Session>): Session {
  return {
    id: "s-1",
    engine: "claude",
    engineSessionId: null,
    source: "web",
    sourceRef: "web:s-1",
    connector: "web",
    sessionKey: "web:s-1",
    replyContext: null,
    messageId: null,
    transportMeta: null,
    employee: "code-implementer",
    model: null,
    title: "Patch the thing",
    parentSessionId: null,
    userId: null,
    status: "running",
    effortLevel: null,
    totalCost: 0,
    totalTurns: 0,
    lastContextTokens: null,
    createdAt: iso(5_000),
    lastActivity: iso(120_000),
    lastError: null,
    ...overrides,
  };
}

beforeEach(() => {
  fs.rmSync(orgDir, { recursive: true, force: true });
});

describe("orphaned ticket reconciler", () => {
  it("leaves non-orphan tickets untouched", () => {
    const tickets = [
      { id: "todo-1", status: "todo", sessionId: "s-1" },
      { id: "noop-1", status: "in_progress", sessionId: "" },
    ] as any[];
    expect(sweepOrphanedBoardTickets(tickets, [], { engines: new Map() }, NOW)).toBe(0);
    expect(tickets[0].status).toBe("todo");
    expect(tickets[1].status).toBe("in_progress");
  });

  it("classifies a missing session as a restart orphan during startup sweep", () => {
    const decision = classifyOrphanedBoardTicket(
      { status: "in_progress", sessionId: "missing-session" } as any,
      [],
      { engines: new Map() },
      NOW,
      undefined,
      "startup",
    );
    expect(decision).toEqual({ shouldUpdate: true, blockedReason: "interrupted - gateway restarted" });
  });

  it("classifies a stale running session with no live turn as worker died", () => {
    const engine = { name: "claude", run: async () => ({ sessionId: "", result: "" }), isTurnRunning: () => false } as any;
    const decision = classifyOrphanedBoardTicket(
      { status: "in_progress", sessionId: "s-1" } as any,
      [session({ status: "running" })],
      { engines: new Map([["claude", engine]]) },
      NOW,
    );
    expect(decision).toEqual({ shouldUpdate: true, blockedReason: "interrupted - worker died" });
  });

  it("resolves a ticket via the existing board-ticket mapping rules", () => {
    const decision = classifyOrphanedBoardTicket(
      { id: "ticket-chan", status: "in_progress", sessionId: "not-the-session" } as any,
      [
        session({
          id: "s-chan",
          status: "interrupted",
          replyContext: { channel: "kanban:software-delivery:ticket-chan" } as any,
          sessionKey: "kanban:software-delivery:ticket-chan",
        }),
      ],
      { engines: new Map() },
      NOW,
    );
    expect(decision).toEqual({ shouldUpdate: true, blockedReason: "interrupted - gateway restarted" });
  });

  it("preserves a live running session when the engine still reports a turn", () => {
    const engine = { name: "claude", run: async () => ({ sessionId: "", result: "" }), isTurnRunning: () => true } as any;
    const decision = classifyOrphanedBoardTicket(
      { status: "in_progress", sessionId: "s-1" } as any,
      [session({ status: "running" })],
      { engines: new Map([["claude", engine]]) },
      NOW,
    );
    expect(decision).toEqual({ shouldUpdate: false });
  });

  it("preserves a freshly resumed running session during startup sweep", () => {
    const decision = classifyOrphanedBoardTicket(
      { status: "in_progress", sessionId: "s-1" } as any,
      [session({ status: "running", lastActivity: iso(1_000) })],
      { engines: new Map() },
      NOW,
      undefined,
      "startup",
    );
    expect(decision).toEqual({ shouldUpdate: false });
  });

  it("sweeps a board and emits once per affected department on startup", () => {
    writeBoard("software-delivery", [
      { id: "keep", status: "todo", title: "keep", description: "keep", sessionId: "x", priority: "high", assignee: "a" },
      { id: "orphan", status: "in_progress", title: "orphan", description: "running", sessionId: "s-1", priority: "medium", assignee: "code-implementer", createdAt: iso(20_000), updatedAt: iso(20_000) },
    ]);
    const events: any[] = [];
    const updated = reconcileOrphanedTickets({
      engines: new Map(),
      orgDir,
      getSession: () => undefined,
      listSessions: () => [session({ status: "interrupted" })],
      emit: (event, payload) => events.push({ event, payload }),
      now: () => NOW,
      cause: "startup",
    });
    expect(updated).toEqual({ boardsUpdated: 1, ticketsUpdated: 1 });
    expect(events).toEqual([{ event: "board:updated", payload: { department: "software-delivery" } }]);
    const board = readBoard("software-delivery");
    expect(board[0].status).toBe("todo");
    expect(board[1]).toMatchObject({
      status: "blocked",
      description: "running",
      blockedReason: "interrupted - gateway restarted",
      sessionId: "s-1",
    });
  });

  it("uses the periodic reason on the status-reconciler backstop", () => {
    writeBoard("software-delivery", [
      { id: "orphan", status: "in_progress", title: "orphan", description: "running", sessionId: "s-1", priority: "medium", assignee: "code-implementer", createdAt: iso(20_000), updatedAt: iso(20_000) },
    ]);
    reconcileOrphanedTickets({
      engines: new Map(),
      orgDir,
      getSession: () => undefined,
      listSessions: () => [session({ status: "idle", lastActivity: iso(120_000) })],
      emit: () => {},
      now: () => NOW,
      cause: "periodic",
    });
    expect(readBoard("software-delivery")[0]).toMatchObject({
      status: "blocked",
      description: "running",
      blockedReason: "interrupted - worker died",
    });
  });

  it("can deterministically reconcile one department on board read", () => {
    writeBoard("software-delivery", [
      { id: "orphan", status: "in_progress", title: "orphan", description: "running", sessionId: "s-1", priority: "medium", assignee: "code-implementer", createdAt: iso(20_000), updatedAt: iso(20_000) },
    ]);
    writeBoard("research", [
      { id: "keep", status: "in_progress", title: "keep", description: "running", sessionId: "other", priority: "medium", assignee: "researcher", createdAt: iso(20_000), updatedAt: iso(20_000) },
    ]);

    const result = reconcileDepartmentOrphanedTickets("software-delivery", {
      engines: new Map(),
      orgDir,
      getSession: () => undefined,
      listSessions: () => [session({ status: "idle", lastActivity: iso(120_000) })],
      emit: () => {},
      now: () => NOW,
      cause: "periodic",
    });

    expect(result).toEqual({ boardsUpdated: 1, ticketsUpdated: 1 });
    expect(readBoard("software-delivery")[0]).toMatchObject({
      status: "blocked",
      blockedReason: "interrupted - worker died",
    });
    expect(readBoard("research")[0].status).toBe("in_progress");
  });

  it("heals a stale fallback-approved auto ticket to done when the backing session is gone", () => {
    writeBoard("software-delivery", [
      {
        id: "session-s-1",
        source: "session",
        status: "blocked",
        title: "fallback artifact",
        description: "running (fallback approved)",
        sessionId: "s-1",
        priority: "medium",
        assignee: "code-implementer",
        createdAt: iso(20_000),
        updatedAt: iso(20_000),
      },
    ]);

    const result = reconcileDepartmentOrphanedTickets("software-delivery", {
      engines: new Map(),
      orgDir,
      getSession: () => undefined,
      listSessions: () => [],
      emit: () => {},
      now: () => NOW,
      cause: "periodic",
    });

    expect(result).toEqual({ boardsUpdated: 1, ticketsUpdated: 1 });
    expect(readBoard("software-delivery")[0]).toMatchObject({
      status: "done",
      description: "completed",
    });
  });
});
