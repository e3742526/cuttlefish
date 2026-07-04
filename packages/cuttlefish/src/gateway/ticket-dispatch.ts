import { createSession, getSession, getSessionBySessionKey, updateSession } from "../sessions/registry.js";
import type { Employee, JsonObject, Session } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { toLeaseTransportMeta } from "../orchestration/lease-meta.js";
import { resolveLiveLeaseDurationMs, type OrchestrationRuntime } from "../orchestration/runtime.js";
import type { AllocationRequest, Lease, TaskPriority, Worker } from "../orchestration/types.js";
import {
  appendOrchestrationTelemetry,
  type OrchestrationRunTelemetryRecord,
} from "../orchestration/telemetry.js";
import { dispatchEmployeeSessionRun } from "./mid-pair-orchestrator.js";
import { findEmployee, isActiveEmployee, scanOrg } from "./org.js";
import { readBoardArray, writeBoardTickets, type BoardTicket } from "./board-service.js";
import type { ApiContext } from "./api/context.js";
import { orgWorkerIdForName, orgWorkerRoleForName } from "./org-worker-bridge.js";
import {
  buildResolvedRunAttachments,
  resolveIncomingRunAttachments,
  setRunAttachmentsOnTransportMeta,
} from "./run-attachments.js";

export type DispatchTicketFailureReason =
  | "no-assignee"
  | "not-found"
  | "unknown-employee"
  | "foreign-department-assignee"
  | "employee-not-active"
  | "no-manager"
  | "already-running"
  | "manual-only"
  | "invalid-resource"
  | "orchestration-unavailable"
  | "orchestration-worker-unmapped"
  | "orchestration-busy";

export type DispatchTicketResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: DispatchTicketFailureReason };

export interface DispatchTicketDeps {
  context: ApiContext;
  orgDir: string;
  now?: () => number;
}

export interface DispatchTicketOptions {
  source: string;
  routeToManager: boolean;
}

interface BoardDispatchLeaseGuard {
  lease: Lease;
  worker: Worker;
  transportMeta: JsonObject;
  release: () => void;
}

interface CapturedCompletion {
  cost?: number;
  durationMs?: number;
  error?: unknown;
}

function boardDispatchMeta(session: Session): Record<string, unknown> {
  const meta = session.transportMeta;
  return meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {};
}

function isRecoverableBoardDispatchSession(session: Session): boolean {
  // Don't reuse sessions that already failed: they carry stale error transcripts
  // that pollute fresh dispatches with confusing context.
  if (session.status === "error" || session.status === "interrupted") return false;
  const state = boardDispatchMeta(session).boardDispatchState;
  return state === "session_created" || state === "board_linked";
}

function matchesBoardDispatchSession(
  session: Session,
  sessionKey: string,
  source: DispatchTicketOptions["source"],
  department: string,
  ticketId: string,
): boolean {
  const meta = boardDispatchMeta(session);
  return (
    session.sessionKey === sessionKey &&
    meta.dispatchSource === source &&
    meta.boardDepartment === department &&
    meta.boardTicketId === ticketId
  );
}

function ticketPrompt(ticket: BoardTicket): string {
  const title = String(ticket.title || "").trim();
  const description = String(ticket.description || "").trim();
  return description ? `${title}\n\n${description}` : title;
}

async function resolveTicketResources(ticket: BoardTicket, context: ApiContext) {
  const specs: Array<Record<string, string>> = [];
  if (typeof ticket.resourcePath === "string" && ticket.resourcePath.trim()) {
    specs.push({
      path: ticket.resourcePath.trim(),
      intendedUse: "Ticket-linked directory context",
    });
  }
  if (typeof ticket.resourceUrl === "string" && ticket.resourceUrl.trim()) {
    specs.push({
      url: ticket.resourceUrl.trim(),
      intendedUse: "Ticket-linked URL context",
    });
  }
  if (specs.length === 0) return { attachments: [], promptBlock: null, engineAttachments: [] };
  const attachments = await resolveIncomingRunAttachments(specs, context);
  return buildResolvedRunAttachments(attachments);
}

function priorityForTicket(ticket: BoardTicket): TaskPriority {
  if (ticket.priority === "high") return "high";
  if (ticket.priority === "low") return "low";
  return "normal";
}

export function findDepartmentManager(department: string, registry: Map<string, Employee>): Employee | undefined {
  return [...registry.values()]
    .filter((employee) => employee.department === department && employee.rank === "manager")
    .sort((a, b) => a.name.localeCompare(b.name))[0];
}

export function resolveDispatchEmployee(
  department: string,
  ticket: BoardTicket,
  registry: Map<string, Employee>,
  routeToManager: boolean,
): { employee?: Employee; reason?: Exclude<DispatchTicketFailureReason, "not-found" | "already-running"> } {
  if (routeToManager) {
    const manager = findDepartmentManager(department, registry);
    if (!manager) return { reason: "no-manager" };
    if (!isActiveEmployee(manager)) return { reason: "employee-not-active" };
    return { employee: manager };
  }
  const assignee = typeof ticket.assignee === "string" ? ticket.assignee.trim() : "";
  if (!assignee) return { reason: "no-assignee" };
  const employee = findEmployee(assignee, registry);
  if (!employee) return { reason: "unknown-employee" };
  if (employee.department !== department) return { reason: "foreign-department-assignee" };
  // Draft/disabled/retired employees must not receive work — availability is a
  // first-class dispatch gate, not an advisory badge.
  if (!isActiveEmployee(employee)) return { reason: "employee-not-active" };
  return { employee };
}

function getTicket(board: BoardTicket[], ticketId: string): BoardTicket | undefined {
  return board.find((ticket) => ticket && ticket.id === ticketId);
}

function ticketIsAlreadyClaimed(ticket: BoardTicket, reusableSession: Session | undefined): boolean {
  if (ticket.status !== "in_progress") return false;
  if (!reusableSession) return true;
  return ticket.sessionId !== reusableSession.id;
}

function refreshDispatchTicket(
  orgDir: string,
  department: string,
  ticketId: string,
  reusableSession: Session | undefined,
):
  | { tickets: BoardTicket[]; ticket: BoardTicket }
  | { reason: Extract<DispatchTicketFailureReason, "not-found" | "already-running"> } {
  const latestTickets = readBoardArray(orgDir, department);
  if (!latestTickets) return { reason: "not-found" };
  const latestTicket = getTicket(latestTickets, ticketId);
  if (!latestTicket) return { reason: "not-found" };
  if (ticketIsAlreadyClaimed(latestTicket, reusableSession)) return { reason: "already-running" };
  return { tickets: latestTickets, ticket: latestTicket };
}

function createLeaseGuard(runtime: OrchestrationRuntime, lease: Lease, worker: Worker): BoardDispatchLeaseGuard {
  let released = false;
  const transportMeta = toLeaseTransportMeta({
    leaseId: lease.leaseId,
    taskId: lease.taskId,
    coordinatorId: lease.coordinatorId,
    workerId: lease.workerId,
    role: lease.role,
    mode: "single_worker",
  });
  return {
    lease,
    worker,
    transportMeta,
    release: () => {
      if (released) return;
      released = true;
      try {
        runtime.releaseLease(lease.leaseId, lease.coordinatorId);
      } catch (err) {
        logger.warn(`[ticket-dispatch] orchestration release failed for lease ${lease.leaseId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

async function allocateBoardDispatchLease(
  department: string,
  ticket: BoardTicket,
  employee: Employee,
  opts: DispatchTicketOptions,
  deps: DispatchTicketDeps,
  sessionKey: string,
): Promise<BoardDispatchLeaseGuard | { reason: Extract<DispatchTicketFailureReason, "orchestration-unavailable" | "orchestration-worker-unmapped" | "orchestration-busy"> } | undefined> {
  if (deps.context.getConfig().orchestration?.enabled !== true) return undefined;
  const runtime = deps.context.orchestration?.runtime;
  if (!runtime) return { reason: "orchestration-unavailable" };

  const workerId = orgWorkerIdForName(employee.name);
  const roleId = orgWorkerRoleForName(employee.name);
  const worker = runtime.listWorkers().find((candidate) => candidate.id === workerId);
  const hasRole = runtime.config.roles.some((role) => role.id === roleId);
  if (!worker || !hasRole) return { reason: "orchestration-worker-unmapped" };

  const request: AllocationRequest = {
    taskId: sessionKey,
    coordinatorId: `ticket-dispatch:${opts.source}`,
    requiredRoles: [roleId],
    optionalRoles: [],
    priority: priorityForTicket(ticket),
    leaseDurationMs: resolveLiveLeaseDurationMs(deps.context.getConfig()),
  };
  let result;
  try {
    result = await runtime.tryAllocationNowWithLiveHeadroom(request);
  } catch (err) {
    logger.warn(
      `[ticket-dispatch] orchestration allocation failed for ${department}/${ticket.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { reason: "orchestration-unavailable" };
  }
  if (!result.ok) return { reason: "orchestration-busy" };
  const lease = result.allocation.leases.find((candidate) => candidate.workerId === workerId && candidate.role === roleId);
  if (!lease) {
    for (const allocated of result.allocation.leases) {
      try {
        runtime.releaseLease(allocated.leaseId, allocated.coordinatorId);
      } catch {
        // best-effort cleanup before reporting the invariant as unmapped
      }
    }
    return { reason: "orchestration-worker-unmapped" };
  }
  return createLeaseGuard(runtime, lease, worker);
}

export async function dispatchTicket(
  department: string,
  ticketId: string,
  opts: DispatchTicketOptions,
  deps: DispatchTicketDeps,
): Promise<DispatchTicketResult> {
  let tickets: BoardTicket[] | null;
  try {
    tickets = readBoardArray(deps.orgDir, department);
  } catch (err) {
    logger.warn(`[ticket-dispatch] failed to parse ${department}/board.json: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, reason: "not-found" };
  }
  if (!tickets) return { ok: false, reason: "not-found" };

  const ticket = getTicket(tickets, ticketId);
  if (!ticket) return { ok: false, reason: "not-found" };

  const sessionKey = `${opts.source}:${department}:${ticketId}`;
  let reusableSession: Session | undefined;
  if (ticket.sessionId) {
    const existing = getSession(ticket.sessionId);
    if (existing?.status === "running") return { ok: false, reason: "already-running" };
    if (
      existing &&
      ticket.status === "in_progress" &&
      isRecoverableBoardDispatchSession(existing) &&
      matchesBoardDispatchSession(existing, sessionKey, opts.source, department, ticketId)
    ) {
      reusableSession = existing;
    }
  } else {
    const existing = getSessionBySessionKey(sessionKey);
    if (
      existing &&
      isRecoverableBoardDispatchSession(existing) &&
      matchesBoardDispatchSession(existing, sessionKey, opts.source, department, ticketId)
    ) {
      reusableSession = existing;
    }
  }

  const registry = scanOrg();
  const resolved = resolveDispatchEmployee(department, ticket, registry, opts.routeToManager);
  if (!resolved.employee || resolved.reason) {
    return { ok: false, reason: resolved.reason ?? "unknown-employee" };
  }

  const employee = resolved.employee;
  if (ticket.manualOnly && opts.source !== "manual") {
    return { ok: false, reason: "manual-only" };
  }
  const engine = deps.context.sessionManager.getEngine(employee.engine);
  if (!engine) {
    throw new Error(`Engine "${employee.engine}" not available for ${employee.name}`);
  }
  const leaseGuard = await allocateBoardDispatchLease(department, ticket, employee, opts, deps, sessionKey);
  if (leaseGuard && "reason" in leaseGuard) {
    logger.info(`[ticket-dispatch] skipped ${department}/${ticketId}: ${leaseGuard.reason}`);
    return { ok: false, reason: leaseGuard.reason };
  }

  let refreshed: ReturnType<typeof refreshDispatchTicket>;
  try {
    refreshed = refreshDispatchTicket(deps.orgDir, department, ticketId, reusableSession);
  } catch (err) {
    leaseGuard?.release();
    logger.warn(`[ticket-dispatch] failed to refresh ${department}/board.json: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, reason: "not-found" };
  }
  if ("reason" in refreshed) {
    leaseGuard?.release();
    return { ok: false, reason: refreshed.reason };
  }

  tickets = refreshed.tickets;
  const dispatchTicket = refreshed.ticket;
  const now = deps.now?.() ?? Date.now();
  const iso = new Date(now).toISOString();
  const prompt = ticketPrompt(dispatchTicket);
  let resolvedResources;
  try {
    resolvedResources = await resolveTicketResources(dispatchTicket, deps.context);
  } catch (err) {
    logger.info(`[ticket-dispatch] skipped ${department}/${ticketId}: invalid-resource`);
    return { ok: false, reason: "invalid-resource" };
  }
  const dispatchTransportMeta = {
    ...(resolvedResources.attachments.length > 0
      ? setRunAttachmentsOnTransportMeta(reusableSession?.transportMeta ?? null, resolvedResources.attachments)
      : (reusableSession?.transportMeta ?? {})),
    ...(leaseGuard?.transportMeta ?? {}),
    boardDepartment: department,
    boardTicketId: ticketId,
    boardDispatchState: "session_created",
    dispatchSource: opts.source,
    routedToManager: opts.routeToManager,
  };
  let session: Session;
  try {
    session = reusableSession ?? createSession({
      engine: employee.engine,
      source: opts.source,
      sourceRef: `${opts.source}:${department}:${ticketId}:${now}`,
      connector: opts.source,
      sessionKey,
      replyContext: { source: opts.source, department, ticketId },
      transportMeta: dispatchTransportMeta,
      employee: employee.name,
      model: employee.model,
      title: dispatchTicket.title,
      effortLevel: employee.effortLevel ?? undefined,
      prompt,
      promptExcerpt: dispatchTicket.title,
    });

    dispatchTicket.status = "in_progress";
    dispatchTicket.sessionId = session.id;
    dispatchTicket.assignee = employee.name;
    dispatchTicket.updatedAt = iso;
    writeBoardTickets(deps.orgDir, department, tickets);

    const runningSession = updateSession(session.id, {
      status: "running",
      lastActivity: iso,
      lastError: null,
      transportMeta: {
        ...dispatchTransportMeta,
        boardDispatchState: "board_linked",
      } as JsonObject,
    }) ?? {
      ...session,
      status: "running" as const,
      lastActivity: iso,
      lastError: null,
      transportMeta: {
        ...dispatchTransportMeta,
        boardDispatchState: "board_linked",
      } as JsonObject,
    };

    deps.context.emit("board:updated", { department });
    deps.context.emit("ticket:dispatched", {
      department,
      ticketId,
      sessionId: session.id,
      employee: employee.name,
      source: opts.source,
      routeToManager: opts.routeToManager,
    });

    let completion: CapturedCompletion | undefined;
    let runError: unknown;
    const telemetryContext = leaseGuard
      ? contextWithCompletionCapture(deps.context, runningSession.id, (payload) => {
        completion = payload;
      })
      : deps.context;
    const run = dispatchEmployeeSessionRun(
      runningSession,
      prompt,
      engine,
      deps.context.getConfig(),
      telemetryContext,
      employee,
      {
        attachments: resolvedResources.engineAttachments,
        resourceContext: resolvedResources.promptBlock,
      },
    );
    if (leaseGuard) {
      void run.then(
        () => {
          appendBoardDispatchTelemetrySafely(buildBoardDispatchTelemetry(leaseGuard, runningSession.id, employee.model, opts.source, completion, null));
          leaseGuard.release();
        },
        (err) => {
          runError = err;
          appendBoardDispatchTelemetrySafely(buildBoardDispatchTelemetry(leaseGuard, runningSession.id, employee.model, opts.source, completion, runError));
          leaseGuard.release();
        },
      );
    }
  } catch (err) {
    leaseGuard?.release();
    throw err;
  }

  return { ok: true, sessionId: session.id };
}

function contextWithCompletionCapture(
  context: ApiContext,
  sessionId: string,
  capture: (payload: CapturedCompletion) => void,
): ApiContext {
  return {
    ...context,
    emit: (event: string, payload: unknown) => {
      if (event === "session:completed" && payload && typeof payload === "object" && !Array.isArray(payload)) {
        const record = payload as Record<string, unknown>;
        if (record.sessionId === sessionId) {
          capture({
            cost: typeof record.cost === "number" ? record.cost : undefined,
            durationMs: typeof record.durationMs === "number" ? record.durationMs : undefined,
            error: record.error,
          });
        }
      }
      context.emit(event, payload);
    },
  };
}

function buildBoardDispatchTelemetry(
  guard: BoardDispatchLeaseGuard,
  sessionId: string,
  model: string | undefined,
  source: string,
  completion: CapturedCompletion | undefined,
  runError: unknown,
): OrchestrationRunTelemetryRecord {
  const session = getSession(sessionId);
  return {
    task_id: guard.lease.taskId,
    coordinator_id: guard.lease.coordinatorId,
    session_id: sessionId,
    lease_id: guard.lease.leaseId,
    worker_id: guard.worker.id,
    provider: guard.worker.provider,
    family: guard.worker.family,
    model: session?.model ?? model ?? null,
    role: guard.lease.role,
    mode: "single_worker",
    source,
    cost: finiteNumber(completion?.cost),
    latency_ms: finiteNumber(completion?.durationMs),
    tokens: session?.lastContextTokens ?? null,
    files_changed: null,
    tests_added: null,
    tests_passed: null,
    review_blockers: null,
    human_edits: null,
    regressions: null,
    disposition: session?.status === "error" || session?.lastError || completion?.error || runError ? "failed" : "completed",
    timestamp: new Date().toISOString(),
  };
}

function appendBoardDispatchTelemetrySafely(record: OrchestrationRunTelemetryRecord): void {
  try {
    appendOrchestrationTelemetry(record, { fsync: false });
  } catch (err) {
    logger.warn(`[ticket-dispatch] orchestration telemetry append failed for ${record.task_id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
