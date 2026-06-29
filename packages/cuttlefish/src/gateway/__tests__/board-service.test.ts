import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BoardConflictError,
  DEFAULT_RECYCLE_BIN_RETENTION_DAYS,
  boardTicketComplexity,
  indexBoardTicketsById,
  mergeBoardTickets,
  parseBoardWritePayload,
  readBoardState,
  writeMergedBoard,
  type BoardTicket,
} from "../board-service.js";

function ticket(id: string, source?: string): BoardTicket {
  return {
    id,
    title: id,
    description: "",
    status: "todo",
    priority: "medium",
    assignee: "a",
    source,
    sessionId: source === "session" ? id : undefined,
    createdAt: "2026-06-22T00:00:00.000Z",
    updatedAt: "2026-06-22T00:00:00.000Z",
  };
}

describe("board-service mergeBoardTickets", () => {
  it("preserves omitted session tickets during manual board writes", () => {
    const current = [ticket("manual-old"), ticket("session-s1", "session")];
    const incoming = [ticket("manual-new")];
    expect(mergeBoardTickets(current, incoming).map((t) => t.id)).toEqual(["manual-new", "session-s1"]);
  });

  it("allows explicit deletion of a session ticket", () => {
    const current = [ticket("session-s1", "session")];
    expect(mergeBoardTickets(
      current,
      [],
      new Set(["session-s1"]),
      new Map([["session-s1", current[0].updatedAt]]),
    )).toEqual([]);
  });

  it("rejects stale updates before they can erase active session state", () => {
    const current = [{
      ...ticket("session-s1", "session"),
      status: "in_progress" as const,
      updatedAt: "2026-06-22T01:00:00.000Z",
    }];
    const staleIncoming = [{
      ...ticket("session-s1"),
      status: "todo" as const,
      baseUpdatedAt: "2026-06-22T00:00:00.000Z",
      updatedAt: "2026-06-22T00:00:00.000Z",
    }];

    expect(() => mergeBoardTickets(current, staleIncoming)).toThrow(BoardConflictError);
  });

  it("rejects deleting an active session ticket without a delete version", () => {
    const current = [{
      ...ticket("session-s1", "session"),
      status: "in_progress" as const,
    }];

    expect(() => mergeBoardTickets(current, [], new Set(["session-s1"]))).toThrow(BoardConflictError);
  });

  it("allows deleting a session ticket when the referenced session is no longer present", () => {
    const current = [{
      ...ticket("session-s1", "session"),
      status: "in_progress" as const,
    }];

    expect(mergeBoardTickets(
      current,
      [],
      new Set(["session-s1"]),
      new Map(),
      { activeSessionIds: new Set() },
    )).toEqual([]);
  });

  it("still rejects deleting an in-progress ticket when its session is active", () => {
    const current = [{
      ...ticket("session-s1", "session"),
      status: "in_progress" as const,
    }];

    expect(() => mergeBoardTickets(
      current,
      [],
      new Set(["session-s1"]),
      new Map(),
      { activeSessionIds: new Set(["session-s1"]) },
    )).toThrow(BoardConflictError);
  });

  it("allows a fresh update that omits active session metadata and preserves server state", () => {
    const current = [{
      ...ticket("session-s1", "session"),
      status: "in_progress" as const,
      updatedAt: "2026-06-22T01:00:00.000Z",
    }];
    const incoming = [{
      ...ticket("session-s1"),
      status: "in_progress" as const,
      title: "renamed",
      baseUpdatedAt: current[0].updatedAt,
      updatedAt: "2026-06-22T01:05:00.000Z",
    }];

    const { baseUpdatedAt: _baseUpdatedAt, ...stored } = incoming[0];
    expect(mergeBoardTickets(current, incoming)).toEqual([{
      ...stored,
      sessionId: current[0].sessionId,
      source: current[0].source,
    }]);
  });

  it("clears stale terminal session metadata when a completed ticket is sent back to an actionable column", () => {
    const current = [{
      ...ticket("session-s1", "session"),
      status: "done" as const,
      updatedAt: "2026-06-22T01:00:00.000Z",
    }];
    const incoming = [{
      ...ticket("session-s1", "session"),
      status: "todo" as const,
      baseUpdatedAt: current[0].updatedAt,
      updatedAt: "2026-06-22T01:05:00.000Z",
    }];

    expect(mergeBoardTickets(current, incoming)).toEqual([{
      id: "session-s1",
      title: "session-s1",
      description: "",
      status: "todo",
      priority: "medium",
      assignee: "a",
      createdAt: "2026-06-22T00:00:00.000Z",
      updatedAt: "2026-06-22T01:05:00.000Z",
    }]);
  });

  it("accepts array payloads and object payloads with deletedIds", () => {
    expect(parseBoardWritePayload([ticket("a")]).tickets).toHaveLength(1);
    const parsed = parseBoardWritePayload({ tickets: [ticket("a")], deletedIds: ["session-s1"] });
    expect(parsed.deletedIds.has("session-s1")).toBe(true);
    expect(parsed.retentionDays).toBeNull();
  });

  it("defaults missing complexity to medium", () => {
    expect(boardTicketComplexity(ticket("a"))).toBe("medium");
    expect(boardTicketComplexity({ ...ticket("b"), complexity: "low" })).toBe("low");
  });

  it("indexes tickets by id for O(1) lookup while preserving first-match behavior", () => {
    const first = { ...ticket("duplicate"), title: "first" };
    const second = { ...ticket("duplicate"), title: "second" };
    const tickets = [ticket("a"), first, second, ticket("b")];

    const index = indexBoardTicketsById(tickets);

    expect(index.get("a")).toBe(tickets[0]);
    expect(index.get("b")).toBe(tickets[3]);
    expect(index.get("duplicate")).toBe(first);
  });

  it("moves deleted tickets into deletedTickets and preserves retention", () => {
    const orgDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-board-service-"));
    const deptDir = path.join(orgDir, "software-delivery");
    fs.mkdirSync(deptDir, { recursive: true });
    fs.writeFileSync(path.join(deptDir, "board.json"), JSON.stringify([ticket("keep"), ticket("drop")], null, 2));

    writeMergedBoard(orgDir, "software-delivery", {
      tickets: [ticket("keep")],
      deletedIds: ["drop"],
      retentionDays: 5,
    });

    const board = readBoardState(orgDir, "software-delivery");
    expect(board).toBeTruthy();
    expect(board?.retentionDays).toBe(5);
    expect(board?.tickets.map((entry) => entry.id)).toEqual(["keep"]);
    expect(board?.deletedTickets.map((entry) => entry.id)).toEqual(["drop"]);
    expect(board?.deletedTickets[0]?.deletedAt).toBeTruthy();
  });

  it("restores a ticket when it reappears in active tickets", () => {
    const orgDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-board-service-"));
    const deptDir = path.join(orgDir, "software-delivery");
    fs.mkdirSync(deptDir, { recursive: true });

    writeMergedBoard(orgDir, "software-delivery", {
      tickets: [ticket("restored")],
      retentionDays: DEFAULT_RECYCLE_BIN_RETENTION_DAYS,
    });
    writeMergedBoard(orgDir, "software-delivery", {
      tickets: [],
      deletedIds: ["restored"],
      deletedVersions: { restored: ticket("restored").updatedAt },
      retentionDays: DEFAULT_RECYCLE_BIN_RETENTION_DAYS,
    });
    writeMergedBoard(orgDir, "software-delivery", {
      tickets: [ticket("restored")],
      retentionDays: DEFAULT_RECYCLE_BIN_RETENTION_DAYS,
    });

    const board = readBoardState(orgDir, "software-delivery");
    expect(board?.tickets.map((entry) => entry.id)).toEqual(["restored"]);
    expect(board?.deletedTickets).toEqual([]);
  });

  it("rejects malformed ticket status instead of accepting contract drift", () => {
    const orgDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-board-service-"));
    const deptDir = path.join(orgDir, "software-delivery");
    fs.mkdirSync(deptDir, { recursive: true });

    expect(() => writeMergedBoard(orgDir, "software-delivery", {
      tickets: [{ ...ticket("bad"), status: "mystery" }],
    })).toThrow(/status must be one of/);
  });

  it("accepts a manual-only ticket with either a directory path or a URL, but not both", () => {
    expect(parseBoardWritePayload([
      { ...ticket("dir"), manualOnly: true, resourcePath: "/tmp/project" },
    ]).tickets[0]).toMatchObject({ manualOnly: true, resourcePath: "/tmp/project" });

    const orgDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-board-service-"));
    const deptDir = path.join(orgDir, "software-delivery");
    fs.mkdirSync(deptDir, { recursive: true });

    expect(() => writeMergedBoard(orgDir, "software-delivery", {
      tickets: [{ ...ticket("bad-resource"), resourcePath: "/tmp/project", resourceUrl: "https://example.com" }],
    })).toThrow(/resourcePath or resourceUrl/);
  });

});
