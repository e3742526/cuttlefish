import { describe, it, expect, beforeEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { syncBoardForEvent, type BoardSyncDeps } from "../board-sync.js";
import { resolveBestSessionForTicket, shouldExposeSessionForTicket } from "../ticket-session-resolver.js";
import type { Session } from "../../shared/types.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-boardsync-"));
const orgDir = path.join(tmp, "org");

function makeSession(p: Partial<Session>): Session {
  return { id: "s1", employee: "code-implementer", title: "Patch the thing", status: "running", ...(p as any) } as Session;
}

function writeBoard(dept: string, value: unknown) {
  const d = path.join(orgDir, dept);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "board.json"), JSON.stringify(value, null, 2));
}
function readBoard(dept: string): any {
  return JSON.parse(fs.readFileSync(path.join(orgDir, dept, "board.json"), "utf-8"));
}

const NOW = new Date("2026-06-21T12:00:00.000Z").getTime();

function deps(over: Partial<BoardSyncDeps> = {}): BoardSyncDeps {
  return {
    getSession: (id) => (id === "s1" ? makeSession({ id }) : undefined),
    resolveDepartment: (emp) => (emp === "code-implementer" ? "software-delivery" : undefined),
    orgDir,
    now: () => NOW,
    ...over,
  };
}

beforeEach(() => {
  fs.rmSync(orgDir, { recursive: true, force: true });
});

describe("syncBoardForEvent", () => {
  it("creates an in_progress ticket on session:started", () => {
    writeBoard("software-delivery", []);
    const ok = syncBoardForEvent("session:started", { sessionId: "s1" }, deps());
    expect(ok).toBe(true);
    const b = readBoard("software-delivery");
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ id: "session-s1", status: "in_progress", assignee: "code-implementer", source: "session", title: "Patch the thing" });
  });

  it("flips the SAME ticket to done on session:completed (idempotent, no duplicate)", () => {
    writeBoard("software-delivery", []);
    syncBoardForEvent("session:started", { sessionId: "s1" }, deps());
    syncBoardForEvent("session:completed", { sessionId: "s1" }, deps());
    const b = readBoard("software-delivery");
    expect(b).toHaveLength(1);
    expect(b[0].status).toBe("done");
  });

  it("F2: session:fallback-required blocks the ticket (waiting on human)", () => {
    writeBoard("software-delivery", []);
    syncBoardForEvent("session:started", { sessionId: "s1" }, deps());
    const ok = syncBoardForEvent("session:fallback-required", { sessionId: "s1" }, deps());
    expect(ok).toBe(true);
    const b = readBoard("software-delivery");
    expect(b).toHaveLength(1);
    expect(b[0].status).toBe("blocked");
    expect(b[0].description).toMatch(/waiting on human/);
  });

  it("F2: approval:resolved approved → in_progress; rejected → done", () => {
    writeBoard("software-delivery", []);
    syncBoardForEvent("session:fallback-required", { sessionId: "s1" }, deps());
    syncBoardForEvent("approval:resolved", { sessionId: "s1", state: "approved" }, deps());
    expect(readBoard("software-delivery")[0].status).toBe("in_progress");
    syncBoardForEvent("approval:resolved", { sessionId: "s1", state: "rejected" }, deps());
    expect(readBoard("software-delivery")[0].status).toBe("done");
  });

  it("does not regress a terminal session back to in_progress when approval resolves late", () => {
    writeBoard("software-delivery", []);
    syncBoardForEvent("session:completed", { sessionId: "s1" }, deps({
      getSession: () => makeSession({ status: "idle" }),
    }));
    syncBoardForEvent("approval:resolved", { sessionId: "s1", state: "approved" }, deps({
      getSession: () => makeSession({ status: "idle" }),
    }));
    expect(readBoard("software-delivery")[0]).toMatchObject({
      status: "done",
      description: "completed",
    });
  });

  it("ignores unrelated events", () => {
    writeBoard("software-delivery", []);
    expect(syncBoardForEvent("session:delta", { sessionId: "s1" }, deps())).toBe(false);
  });

  it("marks failures blocked without copying error text to the board", () => {
    writeBoard("software-delivery", []);
    syncBoardForEvent("session:started", { sessionId: "s1" }, deps());
    syncBoardForEvent("session:completed", { sessionId: "s1", error: "secret-laden boom" },
      deps({ getSession: () => makeSession({ status: "error" }) }));
    const t = readBoard("software-delivery")[0];
    expect(t.status).toBe("blocked");
    expect(t.description).toBe("failed - see session");
    expect(JSON.stringify(t)).not.toContain("boom"); // no error text anywhere on the ticket

    syncBoardForEvent("session:completed", { sessionId: "s1", stalled: true }, deps());
    expect(readBoard("software-delivery")[0].status).toBe("blocked");
  });

  it("preserves hand-authored tickets and appends alongside them", () => {
    writeBoard("software-delivery", [{ id: "policy-1", title: "POLICY", status: "todo", priority: "high", assignee: "x" }]);
    syncBoardForEvent("session:started", { sessionId: "s1" }, deps());
    const b = readBoard("software-delivery");
    expect(b).toHaveLength(2);
    expect(b.find((t: any) => t.id === "policy-1")).toBeTruthy();
  });

  it("updates a ticket-driven board ticket in place instead of creating a session-* duplicate", () => {
    writeBoard("software-delivery", [{
      id: "ticket-1",
      title: "Manual board task",
      description: "Keep this description",
      status: "todo",
      priority: "high",
      complexity: "low",
      assignee: "code-reviewer",
      sessionId: "s1",
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    }]);
    const ok = syncBoardForEvent("session:completed", { sessionId: "s1" }, deps({
      getSession: () =>
        makeSession({
          employee: "code-implementer",
          transportMeta: { boardTicketId: "ticket-1", boardDepartment: "software-delivery" } as any,
        }),
    }));
    expect(ok).toBe(true);
    const b = readBoard("software-delivery");
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({
      id: "ticket-1",
      status: "done",
      description: "Keep this description",
      sessionId: "s1",
    });
  });

  it("uses the ticket boardDepartment for failure updates even when the worker belongs to another department", () => {
    writeBoard("product", [{
      id: "ticket-x",
      title: "Cross-team task",
      description: "Keep this description",
      status: "in_progress",
      priority: "high",
      complexity: "low",
      assignee: "code-reviewer",
      sessionId: "s1",
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    }]);
    const ok = syncBoardForEvent("session:completed", { sessionId: "s1", error: "boom" }, deps({
      getSession: () =>
        makeSession({
          status: "error",
          transportMeta: { boardTicketId: "ticket-x", boardDepartment: "product" } as any,
        }),
    }));
    expect(ok).toBe(true);
    expect(readBoard("product")).toEqual([
      expect.objectContaining({
        id: "ticket-x",
        status: "blocked",
        description: "Keep this description",
        sessionId: "s1",
      }),
    ]);
    expect(fs.existsSync(path.join(orgDir, "software-delivery", "board.json"))).toBe(false);
  });

  it("ignores sessions with no employee", () => {
    writeBoard("software-delivery", []);
    const ok = syncBoardForEvent("session:started", { sessionId: "s1" }, deps({
      getSession: () => makeSession({ employee: null }),
    }));
    expect(ok).toBe(false);
    expect(readBoard("software-delivery")).toHaveLength(0);
  });

  it("skips departments without a board.json (opt-in only)", () => {
    // no board written for 'research'
    const ok = syncBoardForEvent("session:started", { sessionId: "s1" }, deps({
      resolveDepartment: () => "research",
    }));
    expect(ok).toBe(false);
    expect(fs.existsSync(path.join(orgDir, "research", "board.json"))).toBe(false);
  });

  it("never corrupts a non-array (object-shaped) board", () => {
    writeBoard("software-delivery", { todo: [], in_progress: [], done: [] });
    const ok = syncBoardForEvent("session:started", { sessionId: "s1" }, deps());
    expect(ok).toBe(false);
    expect(Array.isArray(readBoard("software-delivery"))).toBe(false); // untouched
  });

  it("creates a terminal ticket even if the started event was missed", () => {
    writeBoard("software-delivery", []);
    const ok = syncBoardForEvent("session:completed", { sessionId: "s1" }, deps());
    expect(ok).toBe(true);
    expect(readBoard("software-delivery")[0]).toMatchObject({ id: "session-s1", status: "done" });
  });

  it("caps auto terminal tickets and drops the oldest", () => {
    // 41 prior done session-tickets + 1 hand-authored; cap is 40.
    const seed: any[] = [{ id: "keep-me", title: "manual", status: "todo", priority: "high", assignee: "x" }];
    for (let i = 0; i < 41; i++) {
      seed.push({ id: `session-old${i}`, title: `t${i}`, status: "done", priority: "medium", assignee: "e", source: "session",
        sessionId: `old${i}`, createdAt: new Date(NOW - (100 - i) * 1000).toISOString(), updatedAt: new Date(NOW - (100 - i) * 1000).toISOString() });
    }
    writeBoard("software-delivery", seed);
    syncBoardForEvent("session:completed", { sessionId: "s1" }, deps());
    const b = readBoard("software-delivery");
    const terminal = b.filter((t: any) => t.source === "session" && (t.status === "done" || t.status === "blocked"));
    expect(terminal).toHaveLength(40);            // capped
    expect(b.find((t: any) => t.id === "keep-me")).toBeTruthy(); // manual ticket preserved
    expect(b.find((t: any) => t.id === "session-old0")).toBeUndefined(); // oldest dropped
    expect(b.find((t: any) => t.id === "session-s1")).toBeTruthy();       // newest kept
  });
});

describe("resolveBestSessionForTicket", () => {
  it("resolves via transportMeta.boardTicketId", () => {
    const ticket = { id: "ticket-1", sessionId: undefined } as any;
    const session = makeSession({
      id: "s-board",
      lastActivity: "2026-06-21T12:00:10.000Z",
      transportMeta: { boardTicketId: "ticket-1" } as any,
    });
    expect(resolveBestSessionForTicket(ticket, [session])?.id).toBe("s-board");
  });

  it("resolves via the persisted ticket.sessionId", () => {
    const ticket = { id: "ticket-2", sessionId: "s-direct" } as any;
    const session = makeSession({ id: "s-direct", lastActivity: "2026-06-21T12:00:10.000Z" });
    expect(resolveBestSessionForTicket(ticket, [session])?.id).toBe("s-direct");
  });

  it("resolves via a channel/source key containing the ticket id", () => {
    const ticket = { id: "ticket-chan", sessionId: undefined } as any;
    const session = makeSession({
      id: "s-chan",
      lastActivity: "2026-06-21T12:00:10.000Z",
      replyContext: { channel: "kanban:software-delivery:ticket-chan" } as any,
    });
    expect(resolveBestSessionForTicket(ticket, [session])?.id).toBe("s-chan");
  });

  it("picks the most recently active match when several sessions qualify", () => {
    const ticket = { id: "ticket-3", sessionId: undefined } as any;
    const older = makeSession({
      id: "s-old",
      lastActivity: "2026-06-21T12:00:05.000Z",
      transportMeta: { boardTicketId: "ticket-3" } as any,
    });
    const newer = makeSession({
      id: "s-new",
      lastActivity: "2026-06-21T12:00:09.000Z",
      replyContext: { channel: "manual:ticket-3" } as any,
    });
    expect(resolveBestSessionForTicket(ticket, [older, newer])?.id).toBe("s-new");
  });

  it("returns undefined when nothing matches", () => {
    const ticket = { id: "ticket-miss", sessionId: undefined } as any;
    expect(resolveBestSessionForTicket(ticket, [makeSession({ id: "s-other" })])).toBeUndefined();
  });
});

describe("shouldExposeSessionForTicket", () => {
  it("hides idle history for completed tickets", () => {
    expect(shouldExposeSessionForTicket(
      { status: "done" } as any,
      makeSession({ status: "idle", lastError: null, transportMeta: null }),
    )).toBe(false);
  });

  it("keeps blocked failure sessions inspectable", () => {
    expect(shouldExposeSessionForTicket(
      { status: "blocked" } as any,
      makeSession({ status: "interrupted", lastError: "Stalled: watchdog timeout", transportMeta: null }),
    )).toBe(true);
  });

  it("keeps active in-progress sessions visible", () => {
    expect(shouldExposeSessionForTicket(
      { status: "in_progress" } as any,
      makeSession({ status: "running", lastError: null, transportMeta: null }),
    )).toBe(true);
  });
});
