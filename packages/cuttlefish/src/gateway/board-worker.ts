import { listSessions } from "../sessions/registry.js";
import { normalizeBoardWorkerConfig } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import { getEngineUsageStatus, type UsageStatus } from "../shared/usage-status.js";
import { readBoardArray, boardTicketComplexity, type BoardTicket, type BoardTicketComplexity } from "./board-service.js";
import type { ApiContext } from "./api/context.js";
import { dispatchTicket, findDepartmentManager } from "./ticket-dispatch.js";
import { scanOrg } from "./org.js";

/** Throttle the board-worker usage-skip signal so an exhausted-quota department
 *  logs its reason at most once per interval instead of every tick (audit H6). */
const USAGE_SKIP_LOG_INTERVAL_MS = 15 * 60 * 1000;
const lastUsageSkipLogAt = new Map<string, number>();
function logBoardWorkerUsageSkip(department: string, engine: string, now: number): void {
  const last = lastUsageSkipLogAt.get(department) ?? 0;
  if (now - last < USAGE_SKIP_LOG_INTERVAL_MS) return;
  lastUsageSkipLogAt.set(department, now);
  logger.warn(
    `[board-worker] ${department}: idle — reason=usage-exhausted engine=${engine}; TODO tickets are held until quota recovers`,
  );
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const PRIORITY_RANK: Record<string, number> = { low: 1, medium: 2, high: 3 };
const INTERACTIVE_SOURCES = new Set(["web", "talk"]);

export interface BoardWorkerDeps {
  context: ApiContext;
  orgDir: string;
  intervalMs?: number;
  now?: () => number;
}

export interface SessionLikeForIdle {
  source: string;
  lastActivity: string;
}

export interface TicketCandidate {
  department: string;
  ticket: BoardTicket;
  manager: { name: string; engine: string };
}

function parseLocalParts(now: number, timezone: string): { weekday: number; minutes: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date(now));
  const weekdayText = parts.find((part) => part.type === "weekday")?.value ?? "Mon";
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return { weekday: weekdayMap[weekdayText] ?? 1, minutes: (hour * 60) + minute };
}

function parseClockMinutes(clock: string): number {
  const [hour, minute] = clock.split(":").map((part) => Number(part));
  return (hour * 60) + minute;
}

export function isWithinBoardWorkerWindow(
  now: number,
  timezone: string,
  schedule: { weekday: { start: string; end: string }; weekend: { start: string; end: string } },
): boolean {
  const local = parseLocalParts(now, timezone);
  const window = local.weekday === 0 || local.weekday === 6 ? schedule.weekend : schedule.weekday;
  const start = parseClockMinutes(window.start);
  const end = parseClockMinutes(window.end);
  if (start === end) return true;
  if (start < end) return local.minutes >= start && local.minutes < end;
  return local.minutes >= start || local.minutes < end;
}

export function isChatIdle(
  sessions: SessionLikeForIdle[],
  idleMinutes: number,
  now: number,
): boolean {
  const thresholdMs = Math.max(0, idleMinutes) * 60_000;
  return !sessions.some((session) => {
    if (!INTERACTIVE_SOURCES.has(session.source)) return false;
    const last = Date.parse(session.lastActivity);
    return Number.isFinite(last) && now - last <= thresholdMs;
  });
}

export function usageModeForStatus(
  status: UsageStatus,
  minRemainingPercent: number,
): "skip" | "low-only" | "all" {
  if (status.state === "exhausted") return "skip";
  if (typeof status.remainingPercent === "number" && status.remainingPercent < minRemainingPercent) {
    return "skip";
  }
  if (status.state === "low") return "low-only";
  return "all";
}

function priorityRank(priority: string | undefined): number {
  return PRIORITY_RANK[priority ?? ""] ?? PRIORITY_RANK.medium;
}

function createdAtMs(ticket: BoardTicket): number {
  const parsed = Date.parse(ticket.createdAt);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

export function rankBoardWorkerCandidates(candidates: TicketCandidate[]): TicketCandidate[] {
  if (candidates.length === 0) return [];
  const low = candidates.filter((candidate) => boardTicketComplexity(candidate.ticket) === "low");
  const pool = low.length > 0 ? low : candidates;
  return [...pool].sort((a, b) => {
    const priorityDelta = priorityRank(b.ticket.priority) - priorityRank(a.ticket.priority);
    if (priorityDelta !== 0) return priorityDelta;
    return createdAtMs(a.ticket) - createdAtMs(b.ticket);
  });
}

export function selectBoardWorkerCandidate(candidates: TicketCandidate[]): TicketCandidate | undefined {
  return rankBoardWorkerCandidates(candidates)[0];
}

async function buildCandidates(
  now: number,
  deps: BoardWorkerDeps,
): Promise<TicketCandidate[]> {
  const registry = scanOrg();
  const boardWorkerConfig = normalizeBoardWorkerConfig(deps.context.getConfig().boardWorker);
  const departments = new Set([...registry.values()].map((employee) => employee.department));
  const candidates: TicketCandidate[] = [];

  for (const department of departments) {
    const manager = findDepartmentManager(department, registry);
    if (!manager) {
      logger.info(`[board-worker] ${department}: no-manager`);
      continue;
    }

    let tickets: BoardTicket[] | null;
    try {
      tickets = readBoardArray(deps.orgDir, department);
    } catch (err) {
      logger.warn(`[board-worker] ${department}/board.json malformed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!tickets) continue;

    const status = await getEngineUsageStatus(manager.engine, deps.context.getConfig(), { now });
    const usageMode = usageModeForStatus(status, boardWorkerConfig.usage.minRemainingPercent);
    if (usageMode === "skip") {
      // Audit H6: a usage-exhausted skip previously wrote nothing, so TODO tickets
      // simply sat and the pause looked like a bug/stall. Emit a throttled, structured
      // signal so an operator can tell quota (not a defect) is why work isn't moving.
      logBoardWorkerUsageSkip(department, manager.engine, now);
      continue;
    }

    const todoTickets = tickets.filter((ticket) => ticket.status === "todo" && ticket.manualOnly !== true);
    const filtered = usageMode === "low-only"
      ? todoTickets.filter((ticket) => boardTicketComplexity(ticket) === "low")
      : todoTickets;
    for (const ticket of filtered) {
      candidates.push({
        department,
        ticket,
        manager: { name: manager.name, engine: manager.engine },
      });
    }
  }

  return candidates;
}

export function startBoardWorker(deps: BoardWorkerDeps): () => void {
  let isDispatching = false;

  const tick = async () => {
    if (isDispatching) return;
    isDispatching = true;
    try {
      const now = deps.now?.() ?? Date.now();
      const config = normalizeBoardWorkerConfig(deps.context.getConfig().boardWorker);
      if (!config.enabled) return;
      if (!isWithinBoardWorkerWindow(now, config.timezone, config.schedule)) return;

      const idle = isChatIdle(
        listSessions().map((session) => ({ source: session.source, lastActivity: session.lastActivity })),
        config.idleMinutes,
        now,
      );
      if (!idle) return;

      const candidates = rankBoardWorkerCandidates(await buildCandidates(now, deps));
      for (const selected of candidates) {
        const result = await dispatchTicket(
          selected.department,
          selected.ticket.id,
          { source: "board-worker", routeToManager: true },
          { context: deps.context, orgDir: deps.orgDir, now: () => now },
        );
        if (result.ok) {
          logger.info(
            `[board-worker] auto-dispatched ${selected.department}/${selected.ticket.id} ` +
            `-> ${selected.manager.name} at ${new Date(now).toISOString()}`,
          );
          return;
        }
        logger.info(
          `[board-worker] skipped ${selected.department}/${selected.ticket.id}: ${result.reason}`,
        );
      }
    } catch (err) {
      logger.warn(`[board-worker] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      isDispatching = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
