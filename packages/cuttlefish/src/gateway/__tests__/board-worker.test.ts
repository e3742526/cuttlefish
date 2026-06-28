import { describe, expect, it } from "vitest";
import {
  isChatIdle,
  isWithinBoardWorkerWindow,
  rankBoardWorkerCandidates,
  selectBoardWorkerCandidate,
  usageModeForStatus,
  type TicketCandidate,
} from "../board-worker.js";
import type { BoardTicket } from "../board-service.js";
import type { UsageStatus } from "../../shared/usage-status.js";

function candidate(id: string, opts: Partial<BoardTicket> = {}): TicketCandidate {
  return {
    department: "software-delivery",
    manager: { name: "lead", engine: "claude" },
    ticket: {
      id,
      title: id,
      description: "",
      status: "todo",
      priority: "medium",
      complexity: "medium",
      assignee: "worker",
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
      ...opts,
    },
  };
}

function status(state: UsageStatus["state"], remainingPercent?: number): UsageStatus {
  return { engine: "claude", state, remainingPercent, source: "live" };
}

describe("board worker scheduling", () => {
  it("handles weekday/weekend windows and midnight wrap", () => {
    expect(
      isWithinBoardWorkerWindow(
        Date.parse("2026-06-22T23:30:00.000Z"),
        "UTC",
        {
          weekday: { start: "22:00", end: "04:00" },
          weekend: { start: "20:00", end: "02:00" },
        },
      ),
    ).toBe(true);

    expect(
      isWithinBoardWorkerWindow(
        Date.parse("2026-06-21T03:30:00.000Z"),
        "UTC",
        {
          weekday: { start: "22:00", end: "04:00" },
          weekend: { start: "22:00", end: "04:00" },
        },
      ),
    ).toBe(true);

    expect(
      isWithinBoardWorkerWindow(
        Date.parse("2026-06-21T12:00:00.000Z"),
        "UTC",
        {
          weekday: { start: "22:00", end: "04:00" },
          weekend: { start: "22:00", end: "04:00" },
        },
      ),
    ).toBe(false);
  });
});

describe("board worker idle gate", () => {
  it("counts only web/talk sources and honors 0 and 60 minute thresholds", () => {
    const now = Date.parse("2026-06-22T12:00:00.000Z");
    expect(
      isChatIdle(
        [
          { source: "cron", lastActivity: "2026-06-22T11:59:00.000Z" },
          { source: "discord", lastActivity: "2026-06-22T11:59:00.000Z" },
        ],
        0,
        now,
      ),
    ).toBe(true);

    expect(
      isChatIdle(
        [{ source: "web", lastActivity: "2026-06-22T11:59:30.000Z" }],
        60,
        now,
      ),
    ).toBe(false);

    expect(
      isChatIdle(
        [{ source: "talk", lastActivity: "2026-06-22T10:58:59.000Z" }],
        60,
        now,
      ),
    ).toBe(true);
  });
});

describe("board worker usage gating", () => {
  it("skips exhausted engines and engines under the configured remaining threshold", () => {
    expect(usageModeForStatus(status("exhausted", 0), 15)).toBe("skip");
    expect(usageModeForStatus(status("ok", 10), 15)).toBe("skip");
  });

  it("restricts low status to low-complexity only and allows ok status", () => {
    expect(usageModeForStatus(status("low", 15), 15)).toBe("low-only");
    expect(usageModeForStatus(status("ok", 80), 15)).toBe("all");
  });
});

describe("board worker selection ordering", () => {
  it("prefers low complexity, then priority, then oldest", () => {
    const selected = selectBoardWorkerCandidate([
      candidate("high-priority-medium", { priority: "high", complexity: "medium", createdAt: "2026-06-19T00:00:00.000Z" }),
      candidate("older-low", { priority: "medium", complexity: "low", createdAt: "2026-06-18T00:00:00.000Z" }),
      candidate("newer-low-high", { priority: "high", complexity: "low", createdAt: "2026-06-20T00:00:00.000Z" }),
    ]);
    expect(selected?.ticket.id).toBe("newer-low-high");
  });


  it("returns dispatch candidates in fallback order after a busy first pick", () => {
    const ranked = rankBoardWorkerCandidates([
      candidate("newer-low", { priority: "high", complexity: "low", createdAt: "2026-06-20T00:00:00.000Z" }),
      candidate("older-low", { priority: "medium", complexity: "low", createdAt: "2026-06-18T00:00:00.000Z" }),
      candidate("medium-high", { priority: "high", complexity: "medium", createdAt: "2026-06-17T00:00:00.000Z" }),
    ]);

    expect(ranked.map((entry) => entry.ticket.id)).toEqual(["newer-low", "older-low"]);
  });

  it("does not rank manual-only tickets for automatic dispatch", () => {
    const ranked = rankBoardWorkerCandidates([
      candidate("manual-only", { manualOnly: true, complexity: "low", priority: "high" }),
      candidate("normal", { complexity: "low", priority: "medium" }),
    ].filter((entry) => entry.ticket.manualOnly !== true));

    expect(ranked.map((entry) => entry.ticket.id)).toEqual(["normal"]);
  });

  it("falls through to highest priority available when no low-complexity tickets exist", () => {
    const selected = selectBoardWorkerCandidate([
      candidate("medium-old", { priority: "medium", complexity: "medium", createdAt: "2026-06-18T00:00:00.000Z" }),
      candidate("high-new", { priority: "high", complexity: "high", createdAt: "2026-06-20T00:00:00.000Z" }),
      candidate("high-old", { priority: "high", complexity: "medium", createdAt: "2026-06-17T00:00:00.000Z" }),
    ]);
    expect(selected?.ticket.id).toBe("high-old");
  });
});
