import fs from "node:fs";
import path from "node:path";
import type { Session } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { readBoardArray, writeBoardTickets, type BoardTicket } from "./board-service.js";
import { findBoardTicketForSession } from "./ticket-session-resolver.js";

/**
 * Auto-reflect running jobs on the department Kanban.
 *
 * The Kanban (`org/<dept>/board.json`) is otherwise a manual artifact — nothing in
 * the session runtime touches it, so a running delegated job never shows up. This
 * module subscribes to `session:started` / `session:completed` and upserts ONE
 * ticket per employee-bound session on that employee's department board:
 *   started   → in_progress
 *   completed → done/blocked (failure is visible without leaking error text)
 *
 * The board answers "what's being worked on / what's pending"; error detail stays
 * in the session/threads view and never lands on the board.
 *
 * Conservative by design:
 *  - only sessions BOUND TO AN EMPLOYEE that resolves to a department are ticketed
 *    (top-level COO / connector chats with no employee are ignored);
 *  - only departments that already HAVE a board.json are written (no new boards are
 *    created — a department opts in by having a board);
 *  - a non-array board.json is left untouched (never corrupt a hand-authored board).
 *
 * Pure + dependency-injected so it is unit-testable without the DB or org scan.
 */

const TICKET_PREFIX = "session-";
/** Cap auto-managed terminal tickets per board so it can't grow without bound. */
const MAX_SESSION_TERMINAL_TICKETS = 40;

export interface BoardSyncDeps {
  /** Look up the live session row (for employee/title/status). */
  getSession: (id: string) => Session | undefined;
  /** Map an employee name → its department name (undefined if unknown). */
  resolveDepartment: (employee: string) => string | undefined;
  /** Root org directory (contains <dept>/board.json). */
  orgDir: string;
  /** Optional: notify listeners so the web Kanban refreshes. */
  emit?: (event: string, payload: unknown) => void;
  /** Test override. */
  now?: () => number;
}

function shorten(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

/** Drop the oldest auto (source:"session") terminal tickets beyond the cap. */
function pruneSessionTickets(tickets: BoardTicket[]): void {
  const terminal = tickets.filter((t) => t?.source === "session" && (t.status === "done" || t.status === "blocked"));
  if (terminal.length <= MAX_SESSION_TERMINAL_TICKETS) return;
  terminal.sort((a, b) => Date.parse(a.updatedAt || "") - Date.parse(b.updatedAt || "")); // oldest first
  const drop = new Set(terminal.slice(0, terminal.length - MAX_SESSION_TERMINAL_TICKETS));
  for (let i = tickets.length - 1; i >= 0; i--) {
    if (drop.has(tickets[i])) tickets.splice(i, 1);
  }
}

function terminalBoardStateForSession(session: Session | undefined): {
  status: BoardTicket["status"];
  note: string;
} | null {
  if (!session) return null;
  if (session.status === "error" || session.status === "interrupted") {
    return { status: "blocked", note: "failed - see session" };
  }
  if (session.status === "idle") {
    return { status: "done", note: "completed" };
  }
  return null;
}

/**
 * Upsert a board ticket for a session lifecycle event. Returns true if a board was
 * written. Exported for tests; wired into the gateway emitter in server.ts.
 */
export function syncBoardForEvent(event: string, payload: unknown, deps: BoardSyncDeps): boolean {
  const HANDLED = ["session:started", "session:completed", "session:fallback-required", "approval:resolved"];
  if (!HANDLED.includes(event)) return false;
  const now = deps.now?.() ?? Date.now();
  const p = (payload ?? {}) as {
    sessionId?: string; employee?: string | null; title?: string | null; state?: string;
  };
  const sessionId = p.sessionId;
  if (!sessionId) return false;

  const session = deps.getSession(sessionId);
  const employee = session?.employee ?? p.employee ?? null;
  if (!employee) return false; // not an employee/worker job — don't ticket it

  const dept = deps.resolveDepartment(employee);
  if (!dept) return false;

  const boardPath = path.join(deps.orgDir, dept, "board.json");
  if (!fs.existsSync(boardPath)) return false; // department hasn't opted into a board

  let tickets: BoardTicket[] | null;
  try {
    tickets = readBoardArray(deps.orgDir, dept);
  } catch (err) {
    logger.warn(`[board-sync] ${dept}/board.json is not valid JSON — skipping: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  if (!tickets) return false; // never corrupt a non-array (hand-authored) board

  const ticketId = `${TICKET_PREFIX}${sessionId}`;
  const iso = new Date(now).toISOString();
  // Error detail never lands on the board, but failed/stalled work is visible.
  // Feature 2: reflect the approval lifecycle so a session stalled on a human
  // decision shows as "blocked" (not invisibly idle), and clears when resolved.
  let status: BoardTicket["status"];
  let note: string;
  if (event === "session:started") {
    status = "in_progress";
    note = "running";
  } else if (event === "session:fallback-required") {
    status = "blocked";
    note = "waiting on human (model-fallback approval)";
  } else if (event === "approval:resolved") {
    const terminal = terminalBoardStateForSession(session);
    if (terminal) {
      status = terminal.status;
      note = terminal.note;
    } else if (p.state === "approved") {
      status = "in_progress";
      note = "running (fallback approved)";
    } else {
      status = "done";
      note = "stopped (fallback rejected)";
    }
  } else {
    const failed = Boolean((payload as { error?: unknown; stalled?: unknown })?.error || (payload as { stalled?: unknown })?.stalled || session?.status === "error");
    status = failed ? "blocked" : "done";
    note = failed ? "failed - see session" : "completed";
  }

  const existing = session ? findBoardTicketForSession(tickets, session, ticketId) : tickets.find((t) => t?.id === ticketId);
  if (existing) {
    existing.status = status;
    existing.assignee = employee;
    existing.sessionId = sessionId;
    existing.updatedAt = iso;
    if (existing.source === "session") {
      existing.description = note;
    }
  } else {
    const title = shorten(String(session?.title || p.title || `${employee} task`), 140);
    tickets.push({
      id: ticketId,
      title,
      description: note,
      status,
      priority: "medium",
      complexity: "medium",
      assignee: employee,
      source: "session",
      sessionId,
      createdAt: iso,
      updatedAt: iso,
    });
  }

  pruneSessionTickets(tickets);

  try {
    // Atomic + fsync (born-safe for F1/F2). No audit: board sync is high-churn
    // and would flood the ledger; the board itself is derived, not canonical.
    writeBoardTickets(deps.orgDir, dept, tickets);
  } catch (err) {
    logger.warn(`[board-sync] failed to write ${dept}/board.json: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  deps.emit?.("board:updated", { department: dept });
  return true;
}
