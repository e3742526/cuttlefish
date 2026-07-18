import fs from "node:fs";
import path from "node:path";
import { safeWriteFile } from "../shared/safe-write.js";
import { KeyedMutex } from "../shared/async-lock.js";
import { scanOrg } from "./org.js";

export type BoardTicketStatus = "backlog" | "todo" | "in_progress" | "review" | "done" | "blocked";
export type BoardTicketPriority = "low" | "medium" | "high";
export type BoardTicketComplexity = "low" | "medium" | "high";
export const DEFAULT_RECYCLE_BIN_RETENTION_DAYS = 3;
export const MIN_RECYCLE_BIN_RETENTION_DAYS = 0;
export const MAX_RECYCLE_BIN_RETENTION_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
const VALID_STATUSES = new Set<BoardTicketStatus>(["backlog", "todo", "in_progress", "review", "done", "blocked"]);
const VALID_PRIORITIES = new Set<BoardTicketPriority>(["low", "medium", "high"]);
const VALID_COMPLEXITIES = new Set<BoardTicketComplexity>(["low", "medium", "high"]);

export interface BoardTicket {
  id: string;
  title: string;
  description: string;
  status: BoardTicketStatus;
  priority: BoardTicketPriority;
  complexity?: BoardTicketComplexity;
  assignee: string;
  resourcePath?: string;
  resourceUrl?: string;
  manualOnly?: boolean;
  source?: string;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
  baseUpdatedAt?: string;
  [k: string]: unknown;
}

export interface DeletedBoardTicket extends BoardTicket {
  deletedAt: string;
}

export interface BoardState {
  tickets: BoardTicket[];
  deletedTickets: DeletedBoardTicket[];
  retentionDays: number;
}

export class BoardConflictError extends Error {
  constructor(
    message: string,
    public readonly ticketIds: string[],
  ) {
    super(message);
    this.name = "BoardConflictError";
  }
}

export interface BoardMergeOptions {
  activeSessionIds?: ReadonlySet<string>;
}

export function boardTicketComplexity(ticket: Pick<BoardTicket, "complexity">): BoardTicketComplexity {
  return typeof ticket.complexity === "string" && VALID_COMPLEXITIES.has(ticket.complexity as BoardTicketComplexity)
    ? ticket.complexity as BoardTicketComplexity
    : "medium";
}

export function clampRecycleBinRetentionDays(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_RECYCLE_BIN_RETENTION_DAYS;
  return Math.max(MIN_RECYCLE_BIN_RETENTION_DAYS, Math.min(MAX_RECYCLE_BIN_RETENTION_DAYS, Math.round(n)));
}

export function boardPath(orgDir: string, department: string): string {
  return path.join(orgDir, department, "board.json");
}

// CON-002 / board-JSON RMW race: every write function below is internally
// synchronous (no `await`), so two direct calls can never interleave their
// own read-modify-write — but a caller that holds an *async* gap open across
// its own read (e.g. ticket-dispatch.ts's dispatchTicket, which awaits a
// lease allocation between reading the board and writing it back) can be
// raced by any other write landing in that gap and silently clobbered by the
// stale in-memory snapshot's eventual write. `boardLock` lives here — inside
// board-service.ts, keyed by board file path — so every write to a given
// board file is guarded in one place rather than ad hoc at each call site.
// It's a synchronous guard (throw `BoardConflictError` if locked), not an
// async acquire, so these functions keep their existing synchronous
// signatures; `writeBoardTicketsWithinLock` lets a caller that already holds
// the lock (ticket-dispatch.ts) write without tripping its own guard.
export const boardLock = new KeyedMutex();

function assertBoardNotLocked(file: string): void {
  if (boardLock.isLocked(file)) {
    throw new BoardConflictError(
      "Board is being updated by another in-flight operation — retry shortly",
      [],
    );
  }
}

export function defaultBoardState(retentionDays = DEFAULT_RECYCLE_BIN_RETENTION_DAYS): BoardState {
  return {
    tickets: [],
    deletedTickets: [],
    retentionDays: clampRecycleBinRetentionDays(retentionDays),
  };
}

function parseBoardState(payload: unknown): BoardState | null {
  if (Array.isArray(payload)) {
    return { ...defaultBoardState(), tickets: payload as BoardTicket[] };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const parsed = payload as { tickets?: unknown; deletedTickets?: unknown; retentionDays?: unknown };
  if (!Array.isArray(parsed.tickets)) return null;
  return {
    tickets: parsed.tickets as BoardTicket[],
    deletedTickets: Array.isArray(parsed.deletedTickets) ? parsed.deletedTickets as DeletedBoardTicket[] : [],
    retentionDays: clampRecycleBinRetentionDays(parsed.retentionDays),
  };
}

function pruneDeletedTickets(
  deletedTickets: DeletedBoardTicket[],
  retentionDays: number,
  now = Date.now(),
): DeletedBoardTicket[] {
  if (retentionDays <= 0) return [];
  const cutoff = now - (retentionDays * DAY_MS);
  return deletedTickets.filter((ticket) => {
    const deletedAt = Date.parse(ticket.deletedAt);
    return Number.isFinite(deletedAt) && deletedAt >= cutoff;
  });
}

function serializeBoardState(state: BoardState): string {
  const normalized: BoardState = {
    tickets: state.tickets,
    deletedTickets: state.deletedTickets,
    retentionDays: clampRecycleBinRetentionDays(state.retentionDays),
  };
  const payload: BoardState | BoardTicket[] =
    normalized.deletedTickets.length === 0 && normalized.retentionDays === DEFAULT_RECYCLE_BIN_RETENTION_DAYS
      ? normalized.tickets
      : normalized;
  return JSON.stringify(payload, null, 2);
}

export function readBoardState(orgDir: string, department: string): BoardState | null {
  const file = boardPath(orgDir, department);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf-8");
  const parsed = parseBoardState(JSON.parse(raw));
  if (!parsed) throw new Error("board.json must be an array or { tickets, deletedTickets, retentionDays }");
  const normalized: BoardState = {
    tickets: parsed.tickets,
    deletedTickets: pruneDeletedTickets(parsed.deletedTickets, parsed.retentionDays),
    retentionDays: clampRecycleBinRetentionDays(parsed.retentionDays),
  };
  const serialized = serializeBoardState(normalized);
  if (serialized !== raw) safeWriteFile(file, serialized);
  return normalized;
}

export function readBoardArray(orgDir: string, department: string): BoardTicket[] | null {
  return readBoardState(orgDir, department)?.tickets ?? null;
}

export function parseBoardWritePayload(
  payload: unknown,
): { tickets: BoardTicket[]; deletedIds: Set<string>; deletedVersions: Map<string, string>; retentionDays: number | null } {
  if (Array.isArray(payload)) {
    return { tickets: payload as BoardTicket[], deletedIds: new Set(), deletedVersions: new Map(), retentionDays: null };
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const p = payload as { tickets?: unknown; deletedIds?: unknown; deletedVersions?: unknown; retentionDays?: unknown };
    if (!Array.isArray(p.tickets)) throw new Error("tickets must be an array");
    const deletedIds = new Set<string>();
    if (Array.isArray(p.deletedIds)) {
      for (const id of p.deletedIds) {
        if (typeof id === "string" && id.trim()) deletedIds.add(id);
      }
    }
    const deletedVersions = new Map<string, string>();
    if (p.deletedVersions && typeof p.deletedVersions === "object" && !Array.isArray(p.deletedVersions)) {
      for (const [id, updatedAt] of Object.entries(p.deletedVersions as Record<string, unknown>)) {
        if (deletedIds.has(id) && typeof updatedAt === "string" && updatedAt.trim()) {
          deletedVersions.set(id, updatedAt);
        }
      }
    }
    return {
      tickets: p.tickets as BoardTicket[],
      deletedIds,
      deletedVersions,
      retentionDays: p.retentionDays == null ? null : clampRecycleBinRetentionDays(p.retentionDays),
    };
  }
  throw new Error("Board payload must be an array or { tickets, deletedIds, retentionDays }");
}

function assertValidBoardTicket(ticket: unknown, index: number): asserts ticket is BoardTicket {
  if (!ticket || typeof ticket !== "object" || Array.isArray(ticket)) {
    throw new Error(`tickets[${index}] must be an object`);
  }
  const t = ticket as Partial<BoardTicket>;
  if (typeof t.id !== "string" || !t.id.trim()) throw new Error(`tickets[${index}].id must be a non-empty string`);
  if (typeof t.title !== "string" || !t.title.trim()) throw new Error(`tickets[${index}].title must be a non-empty string`);
  if (typeof t.status !== "string" || !VALID_STATUSES.has(t.status as BoardTicketStatus)) {
    throw new Error(`tickets[${index}].status must be one of ${[...VALID_STATUSES].join(", ")}`);
  }
  if (t.priority !== undefined && (typeof t.priority !== "string" || !VALID_PRIORITIES.has(t.priority as BoardTicketPriority))) {
    throw new Error(`tickets[${index}].priority must be one of ${[...VALID_PRIORITIES].join(", ")}`);
  }
  if (t.complexity !== undefined && (typeof t.complexity !== "string" || !VALID_COMPLEXITIES.has(t.complexity as BoardTicketComplexity))) {
    throw new Error(`tickets[${index}].complexity must be one of ${[...VALID_COMPLEXITIES].join(", ")}`);
  }
  if (t.resourcePath !== undefined && (typeof t.resourcePath !== "string" || !t.resourcePath.trim())) {
    throw new Error(`tickets[${index}].resourcePath must be a non-empty string when provided`);
  }
  if (t.resourceUrl !== undefined) {
    if (typeof t.resourceUrl !== "string" || !t.resourceUrl.trim()) {
      throw new Error(`tickets[${index}].resourceUrl must be a non-empty string when provided`);
    }
    try {
      const parsed = new URL(t.resourceUrl);
      if (!/^https?:$/.test(parsed.protocol)) {
        throw new Error(`tickets[${index}].resourceUrl must use http or https`);
      }
    } catch (err) {
      throw err instanceof Error && err.message.includes(`tickets[${index}]`)
        ? err
        : new Error(`tickets[${index}].resourceUrl must be a valid http(s) URL`);
    }
  }
  if (t.resourcePath && t.resourceUrl) {
    throw new Error(`tickets[${index}] may specify resourcePath or resourceUrl, but not both`);
  }
  if (t.manualOnly !== undefined && typeof t.manualOnly !== "boolean") {
    throw new Error(`tickets[${index}].manualOnly must be a boolean when provided`);
  }
}

function assertValidBoardTickets(tickets: unknown[]): asserts tickets is BoardTicket[] {
  tickets.forEach(assertValidBoardTicket);
}

export interface RejectedBoardTicket {
  index: number;
  id: string | null;
  title: string | null;
  error: string;
}

export function partitionBoardTickets(tickets: unknown[]): {
  valid: BoardTicket[];
  rejected: RejectedBoardTicket[];
} {
  const valid: BoardTicket[] = [];
  const rejected: RejectedBoardTicket[] = [];
  for (let i = 0; i < tickets.length; i++) {
    try {
      assertValidBoardTicket(tickets[i], i);
      valid.push(tickets[i] as BoardTicket);
    } catch (err) {
      const t = tickets[i] && typeof tickets[i] === "object" ? tickets[i] as Record<string, unknown> : {};
      rejected.push({
        index: i,
        id: typeof t["id"] === "string" ? t["id"] : null,
        title: typeof t["title"] === "string" ? t["title"] : null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { valid, rejected };
}

function ticketTime(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function assertFreshBoardTicket(current: BoardTicket | undefined, baseUpdatedAt: unknown, action: "update" | "delete"): void {
  if (!current) return;
  const currentTime = ticketTime(current.updatedAt);
  const baseTime = ticketTime(baseUpdatedAt);
  if (currentTime == null || baseTime == null || currentTime <= baseTime) return;
  throw new BoardConflictError(
    `board conflict: ticket "${current.id}" changed since this board was loaded; refresh before ${action}`,
    [current.id],
  );
}

/** Whether an incoming board-save payload for `id` represents a real change
 *  against the currently-stored ticket. A bundled-but-unmodified card (no
 *  `baseUpdatedAt` and every field matching) must not be treated as a change —
 *  see `validateBoardAssigneesForDepartment`, whose stale-card guard depends
 *  on this returning false for untouched cards. */
export function hasChangedBoardTicket(
  incoming: Record<string, unknown>,
  current: BoardTicket | undefined,
): boolean {
  if (!current) return true;
  if (incoming.baseUpdatedAt != null) return true;
  return (
    incoming.title !== current.title ||
    (incoming.description ?? "") !== current.description ||
    incoming.status !== current.status ||
    (incoming.priority ?? "medium") !== current.priority ||
    (incoming.complexity ?? "medium") !== current.complexity ||
    (incoming.assignee ?? "") !== current.assignee ||
    (incoming.resourcePath ?? "") !== (current.resourcePath ?? "") ||
    (incoming.resourceUrl ?? "") !== (current.resourceUrl ?? "") ||
    (incoming.manualOnly === true) !== (current.manualOnly === true) ||
    (incoming.source ?? "") !== (current.source ?? "") ||
    (incoming.sessionId ?? "") !== (current.sessionId ?? "") ||
    incoming.createdAt !== current.createdAt ||
    incoming.updatedAt !== current.updatedAt
  );
}

/** Validate that every changed/new ticket in a department board-save payload
 *  is assigned to a known employee who belongs to that department. Unchanged
 *  (stale-bundled) tickets are skipped so a save touching one card doesn't
 *  fail because an unrelated card's assignee has since left the roster.
 *  Returns an error message, or null when the payload is valid (or not a
 *  ticket-array/`{tickets}` shape, which other validation handles). */
export function validateBoardAssigneesForDepartment(
  department: string,
  payload: unknown,
  currentTickets: BoardTicket[],
): string | null {
  const tickets = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && !Array.isArray(payload) && Array.isArray((payload as { tickets?: unknown }).tickets)
      ? (payload as { tickets: unknown[] }).tickets
      : null;
  if (!tickets) return null;

  const org = scanOrg();
  const currentById = new Map(currentTickets.map((ticket) => [ticket.id, ticket]));
  for (const [index, ticket] of tickets.entries()) {
    if (!ticket || typeof ticket !== "object" || Array.isArray(ticket)) continue;
    const incoming = ticket as Record<string, unknown>;
    const assignee = incoming.assignee;
    if (typeof assignee !== "string" || !assignee.trim()) continue;
    const id = typeof incoming.id === "string" ? incoming.id : `#${index}`;
    // Board saves carry the whole department. A stale card bundled without a
    // base version was not changed by the caller, so it must not prevent a
    // separate ticket from being deleted. New or changed tickets are still
    // checked against the current employee roster below.
    if (!hasChangedBoardTicket(incoming, currentById.get(id))) continue;
    const employee = org.get(assignee);
    if (!employee) {
      return `ticket "${id}" is assigned to "${assignee}", who is not a known employee`;
    }
    if (employee.department !== department) {
      return `ticket "${id}" is assigned to "${assignee}", who belongs to department "${employee.department}", not "${department}"`;
    }
  }
  return null;
}

function isActiveSessionTicket(ticket: BoardTicket, activeSessionIds?: ReadonlySet<string>): boolean {
  return (
    typeof ticket.sessionId === "string" &&
    ticket.sessionId.trim().length > 0 &&
    (!activeSessionIds || activeSessionIds.has(ticket.sessionId)) &&
    ticket.status !== "done" &&
    ticket.status !== "blocked"
  );
}

function shouldClearTerminalSessionLink(current: BoardTicket | undefined, incoming: BoardTicket, activeSessionIds?: ReadonlySet<string>): boolean {
  if (!current || isActiveSessionTicket(current, activeSessionIds)) return false;
  if (typeof current.sessionId !== "string" || !current.sessionId.trim()) return false;
  return incoming.status !== "done" && incoming.status !== "blocked";
}

function assertDoesNotReplaceActiveSession(
  current: BoardTicket | undefined,
  incoming: BoardTicket,
  activeSessionIds?: ReadonlySet<string>,
): void {
  if (!current || !isActiveSessionTicket(current, activeSessionIds)) return;
  const replacesSession = (
    typeof incoming.sessionId === "string" &&
    incoming.sessionId.trim().length > 0 &&
    incoming.sessionId !== current.sessionId
  );
  const replacesSource = incoming.source != null && incoming.source !== current.source;
  if (!replacesSession && !replacesSource) return;
  throw new BoardConflictError(
    `board conflict: ticket "${current.id}" has active session state; refresh before saving`,
    [current.id],
  );
}

export function mergeBoardTickets(
  current: BoardTicket[],
  incoming: BoardTicket[],
  deletedIds = new Set<string>(),
  deletedVersions = new Map<string, string>(),
  options: BoardMergeOptions = {},
): BoardTicket[] {
  const currentById = new Map(current.map((ticket) => [ticket.id, ticket]));
  const validIncoming = incoming.filter((ticket) => ticket && ticket.id && !deletedIds.has(ticket.id));
  for (const ticket of validIncoming) {
    const currentTicket = currentById.get(ticket.id);
    // Only enforce optimistic-concurrency freshness when the client explicitly
    // claims a base version. An omitted `baseUpdatedAt` means the client is not
    // asserting freshness for this ticket (it bundled it only because a save
    // sends the whole department board), so a concurrent write to it must not
    // reject the unrelated edit/delete the client actually intends. Do NOT fall
    // back to `updatedAt` here — that would make every untouched ticket conflict.
    if (ticket.baseUpdatedAt != null) {
      assertFreshBoardTicket(currentTicket, ticket.baseUpdatedAt, "update");
    }
    assertDoesNotReplaceActiveSession(currentTicket, ticket, options.activeSessionIds);
  }
  const filteredIncoming = validIncoming.map((ticket) => {
    const currentTicket = currentById.get(ticket.id);
    // A ticket sent without `baseUpdatedAt` isn't being edited by the client —
    // it was bundled only because saves carry the whole department board. Don't
    // let its stale snapshot clobber a concurrent agent write: if the server's
    // copy is strictly newer, keep the server's version verbatim.
    if (ticket.baseUpdatedAt == null && currentTicket) {
      const currentTime = ticketTime(currentTicket.updatedAt);
      const incomingTime = ticketTime(ticket.updatedAt);
      if (currentTime != null && (incomingTime == null || currentTime > incomingTime)) {
        return currentTicket;
      }
    }
    const { baseUpdatedAt: _baseUpdatedAt, ...stored } = ticket;
    if (currentTicket && isActiveSessionTicket(currentTicket, options.activeSessionIds)) {
      stored.sessionId = currentTicket.sessionId;
      if (currentTicket.source != null) stored.source = currentTicket.source;
    } else if (shouldClearTerminalSessionLink(currentTicket, stored as BoardTicket, options.activeSessionIds)) {
      delete stored.sessionId;
      delete stored.source;
    }
    return stored as BoardTicket;
  });
  for (const deletedId of deletedIds) {
    const currentTicket = currentById.get(deletedId);
    if (!currentTicket || !isActiveSessionTicket(currentTicket, options.activeSessionIds)) continue;
    if (!deletedVersions.has(deletedId)) {
      throw new BoardConflictError(
        `board conflict: ticket "${deletedId}" has active session state; refresh before deleting`,
        [deletedId],
      );
    }
    assertFreshBoardTicket(currentTicket, deletedVersions.get(deletedId), "delete");
  }
  const incomingIds = new Set(filteredIncoming.map((ticket) => ticket.id).filter(Boolean));
  const merged = [...filteredIncoming];
  for (const ticket of current) {
    if (ticket?.source !== "session") continue;
    if (incomingIds.has(ticket.id) || deletedIds.has(ticket.id)) continue;
    merged.push(ticket);
  }
  return merged;
}

function mergeDeletedTickets(
  current: BoardState,
  activeTickets: BoardTicket[],
  deletedIds: Set<string>,
  deletedAt: string,
): DeletedBoardTicket[] {
  const activeIds = new Set(activeTickets.map((ticket) => ticket.id).filter(Boolean));
  const currentTicketsById = indexBoardTicketsById(current.tickets);
  const deleted = new Map(current.deletedTickets.map((ticket) => [ticket.id, ticket]));
  for (const deletedId of deletedIds) {
    if (deleted.has(deletedId)) continue;
    const existing = currentTicketsById.get(deletedId);
    if (!existing) continue;
    deleted.set(deletedId, { ...existing, deletedAt });
  }
  return [...deleted.values()].filter((ticket) => !activeIds.has(ticket.id));
}

export function indexBoardTicketsById(tickets: BoardTicket[]): Map<string, BoardTicket> {
  const ticketsById = new Map<string, BoardTicket>();
  for (const ticket of tickets) {
    if (!ticket?.id || ticketsById.has(ticket.id)) continue;
    ticketsById.set(ticket.id, ticket);
  }
  return ticketsById;
}

export function writeMergedBoard(
  orgDir: string,
  department: string,
  payload: unknown,
  options: BoardMergeOptions = {},
): BoardTicket[] {
  const file = boardPath(orgDir, department);
  assertBoardNotLocked(file);
  const current = readBoardState(orgDir, department) ?? defaultBoardState();
  const { tickets, deletedIds, deletedVersions, retentionDays } = parseBoardWritePayload(payload);
  assertValidBoardTickets(tickets);
  const nextRetentionDays = retentionDays ?? current.retentionDays;
  const mergedTickets = mergeBoardTickets(current.tickets, tickets, deletedIds, deletedVersions, options);
  const mergedDeletedTickets = pruneDeletedTickets(
    mergeDeletedTickets(current, mergedTickets, deletedIds, new Date().toISOString()),
    nextRetentionDays,
  );
  safeWriteFile(file, serializeBoardState({
    tickets: mergedTickets,
    deletedTickets: mergedDeletedTickets,
    retentionDays: nextRetentionDays,
  }));
  verifyBoardWrite(file, mergedTickets);
  return mergedTickets;
}

export interface WriteMergedBoardPartialResult {
  written: BoardTicket[];
  rejected: RejectedBoardTicket[];
}

export interface BoardTicketArchiveResult {
  boardsUpdated: number;
  ticketsArchived: number;
  departments: string[];
}

export function writeMergedBoardPartial(
  orgDir: string,
  department: string,
  payload: unknown,
  options: BoardMergeOptions = {},
): WriteMergedBoardPartialResult {
  const file = boardPath(orgDir, department);
  assertBoardNotLocked(file);
  const current = readBoardState(orgDir, department) ?? defaultBoardState();
  const { tickets: rawTickets, deletedIds, deletedVersions, retentionDays } = parseBoardWritePayload(payload);
  const { valid, rejected } = partitionBoardTickets(rawTickets);
  const nextRetentionDays = retentionDays ?? current.retentionDays;
  const mergedTickets = mergeBoardTickets(current.tickets, valid, deletedIds, deletedVersions, options);
  const mergedDeletedTickets = pruneDeletedTickets(
    mergeDeletedTickets(current, mergedTickets, deletedIds, new Date().toISOString()),
    nextRetentionDays,
  );
  safeWriteFile(file, serializeBoardState({
    tickets: mergedTickets,
    deletedTickets: mergedDeletedTickets,
    retentionDays: nextRetentionDays,
  }));
  verifyBoardWrite(file, mergedTickets);
  return { written: mergedTickets, rejected };
}

/**
 * Move matching tickets to each board's recycle bin without revalidating the
 * unrelated tickets that share that board. Lifecycle cleanup uses this after a
 * session or employee has already been removed, so it can repair an old
 * dangling reference even when that reference would fail a normal board save.
 */
function archiveBoardTickets(
  orgDir: string,
  matches: (ticket: BoardTicket) => boolean,
): BoardTicketArchiveResult {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(orgDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { boardsUpdated: 0, ticketsArchived: 0, departments: [] };
    }
    throw err;
  }

  let boardsUpdated = 0;
  let ticketsArchived = 0;
  const departments: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const department = entry.name;
    const file = boardPath(orgDir, department);
    if (!fs.existsSync(file)) continue;
    assertBoardNotLocked(file);
    const current = readBoardState(orgDir, department);
    if (!current) continue;
    const deletedIds = new Set(current.tickets.filter(matches).map((ticket) => ticket.id));
    if (deletedIds.size === 0) continue;

    const tickets = current.tickets.filter((ticket) => !deletedIds.has(ticket.id));
    const deletedTickets = pruneDeletedTickets(
      mergeDeletedTickets(current, tickets, deletedIds, new Date().toISOString()),
      current.retentionDays,
    );
    safeWriteFile(file, serializeBoardState({
      tickets,
      deletedTickets,
      retentionDays: current.retentionDays,
    }));
    verifyBoardWrite(file, tickets);
    boardsUpdated++;
    ticketsArchived += deletedIds.size;
    departments.push(department);
  }
  return { boardsUpdated, ticketsArchived, departments };
}

/** Archive session-created tickets when their backing gateway sessions are deleted. */
export function archiveSessionBoardTickets(
  orgDir: string,
  sessionIds: Iterable<string>,
): BoardTicketArchiveResult {
  const ids = new Set([...sessionIds].filter((id) => id.trim()));
  if (ids.size === 0) return { boardsUpdated: 0, ticketsArchived: 0, departments: [] };
  return archiveBoardTickets(orgDir, (ticket) => {
    if (ticket.source !== "session") return false;
    const sessionId = typeof ticket.sessionId === "string" ? ticket.sessionId.trim() : "";
    if (sessionId && ids.has(sessionId)) return true;
    return ticket.id.startsWith("session-") && ids.has(ticket.id.slice("session-".length));
  });
}

/** Archive tickets assigned to an employee when that employee is removed. */
export function archiveEmployeeBoardTickets(
  orgDir: string,
  employeeName: string,
): BoardTicketArchiveResult {
  const name = employeeName.trim();
  if (!name) return { boardsUpdated: 0, ticketsArchived: 0, departments: [] };
  return archiveBoardTickets(orgDir, (ticket) => ticket.assignee === name);
}

export function writeBoardTickets(orgDir: string, department: string, tickets: BoardTicket[]): void {
  assertBoardNotLocked(boardPath(orgDir, department));
  performWriteBoardTickets(orgDir, department, tickets);
}

/**
 * Same as `writeBoardTickets`, but skips the lock guard — for a caller
 * (ticket-dispatch.ts's `dispatchTicket`) that already holds `boardLock` for
 * this board file and is writing from inside its own critical section.
 */
export function writeBoardTicketsWithinLock(orgDir: string, department: string, tickets: BoardTicket[]): void {
  performWriteBoardTickets(orgDir, department, tickets);
}

function performWriteBoardTickets(orgDir: string, department: string, tickets: BoardTicket[]): void {
  const current = readBoardState(orgDir, department) ?? defaultBoardState();
  const file = boardPath(orgDir, department);
  safeWriteFile(file, serializeBoardState({
    tickets,
    deletedTickets: pruneDeletedTickets(current.deletedTickets, current.retentionDays),
    retentionDays: current.retentionDays,
  }));
  verifyBoardWrite(file, tickets);
}

/**
 * Read the board back immediately after a write and throw if any expected
 * ticket id is missing. Catches silent truncation, wrong-path writes, and
 * any post-write filesystem anomaly before the caller returns success.
 */
function verifyBoardWrite(file: string, expected: BoardTicket[]): void {
  let onDisk: BoardTicket[];
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = parseBoardState(JSON.parse(raw));
    onDisk = parsed?.tickets ?? [];
  } catch (err) {
    throw new Error(
      `board write-verify: could not re-read ${file} after write — ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const onDiskIds = new Set(onDisk.map((t) => t.id));
  const missing = expected.map((t) => t.id).filter((id) => id && !onDiskIds.has(id));
  if (missing.length > 0) {
    throw new Error(
      `board write-verify: ${missing.length} ticket(s) missing from ${file} after write: ${missing.join(", ")}`
    );
  }
}

/** Counts tickets in a board by status — used for startup/reload summaries. */
function countByStatus(tickets: BoardTicket[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of tickets) {
    const s = t.status ?? "unknown";
    counts[s] = (counts[s] ?? 0) + 1;
  }
  return counts;
}

/**
 * Log a one-line summary per department board to `log`.
 * Call on startup and after config reload so board state is always visible in
 * the daemon log — makes "tickets added but not showing" detectable immediately.
 */
export function logBoardSummary(orgDir: string, log: (msg: string) => void): void {
  if (!fs.existsSync(orgDir)) return;
  let totalDepts = 0;
  let totalTickets = 0;
  for (const dept of fs.readdirSync(orgDir)) {
    const file = boardPath(orgDir, dept);
    if (!fs.existsSync(file)) continue;
    try {
      const state = readBoardState(orgDir, dept);
      if (!state) continue;
      const counts = countByStatus(state.tickets);
      const summary = Object.entries(counts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([s, n]) => `${n} ${s}`)
        .join(", ");
      log(`[board] ${dept}: ${state.tickets.length} ticket(s) — ${summary || "empty"}`);
      totalDepts++;
      totalTickets += state.tickets.length;
    } catch (err) {
      log(`[board] ${dept}: ERROR reading board.json — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (totalDepts > 0) {
    log(`[board] summary: ${totalDepts} dept(s), ${totalTickets} total ticket(s)`);
  }
}
