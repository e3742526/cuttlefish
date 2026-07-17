import type { ServerResponse } from "node:http";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { loadInstances } from "../../../cli/instances.js";
import { loadJobs } from "../../../cron/jobs.js";
import { ORG_DIR } from "../../../shared/paths.js";
import { getModelRegistry } from "../../../shared/models.js";
import { listSessions } from "../../../sessions/registry.js";
import { deriveWorkState, emptyWorkCounts } from "../../../shared/work-state.js";
import { getProcessHealth } from "../../../shared/process-health.js";
import { listApprovals } from "../../approvals.js";
import { summarizeWorkspaceProfiles } from "../../workspace-profiles.js";
import type { ApiContext } from "../context.js";
import { json } from "../responses.js";
import { isSessionLiveRunning } from "../serialize-session.js";
import type { Session } from "../../../shared/types.js";

type CommandCenterRangeKey = "day" | "week" | "month";
type HealthCheckStatus = "ok" | "degraded" | "error";

interface HealthCheck {
  name: string;
  status: HealthCheckStatus;
  detail?: string;
}

interface CommandCenterUsageBucket {
  range: CommandCenterRangeKey;
  sessionCount: number;
  totalCostUsd: number;
  totalTurns: number;
  totalTokens: number;
}

interface CommandCenterAgentUsage {
  employee: string;
  displayName: string;
  rank: string;
  department: string | null;
  engine: string;
  model: string;
  running: boolean;
  usage: Record<CommandCenterRangeKey, CommandCenterUsageBucket>;
}

interface CommandCenterManagerSummary {
  employee: string;
  displayName: string;
  department: string | null;
  rank: string;
  running: boolean;
}

const COMMAND_CENTER_RANGES: Array<{ key: CommandCenterRangeKey; ms: number }> = [
  { key: "day", ms: 24 * 60 * 60 * 1000 },
  { key: "week", ms: 7 * 24 * 60 * 60 * 1000 },
  { key: "month", ms: 30 * 24 * 60 * 60 * 1000 },
];

function readDepartmentTicketCounts(orgDir: string, departments: string[]): Record<string, number> {
  const counts: Record<string, number> = {
    backlog: 0,
    todo: 0,
    in_progress: 0,
    review: 0,
    done: 0,
    blocked: 0,
  };
  for (const department of departments) {
    const boardPath = path.join(orgDir, department, "board.json");
    if (!fs.existsSync(boardPath)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(boardPath, "utf-8")) as unknown;
      const tickets = Array.isArray(raw)
        ? raw
        : raw && typeof raw === "object" && Array.isArray((raw as { tickets?: unknown[] }).tickets)
          ? (raw as { tickets: unknown[] }).tickets
          : [];
      for (const ticket of tickets) {
        const status = typeof (ticket as { status?: unknown })?.status === "string"
          ? (ticket as { status: string }).status
          : null;
        if (status && status in counts) counts[status] += 1;
      }
    } catch {
      // Board corruption already surfaces on the board route; the command center
      // stays best-effort and simply omits unreadable departments.
    }
  }
  return counts;
}

function roundCurrency(value: number): number {
  return Number(value.toFixed(4));
}

async function buildCommandCenterPayload(context: ApiContext) {
  const sessions = listSessions();
  const now = Date.now();
  const { withPortalExecutive } = await import("../../org-hierarchy.js");
  const { scanOrg } = await import("../../org.js");
  const registry = withPortalExecutive(scanOrg(), context.getConfig().portal?.portalName);
  const employees = Array.from(registry.values());
  const runningEmployees = new Set(
    sessions
      .filter((session) => session.employee && isSessionLiveRunning(session, context))
      .map((session) => session.employee as string),
  );
  const departments = Array.from(new Set(employees.map((employee) => employee.department).filter((dept): dept is string => !!dept)));
  const ticketCounts = readDepartmentTicketCounts(ORG_DIR, departments);
  const cronJobs = loadJobs();

  const usageByEmployee = new Map<string, CommandCenterAgentUsage>();
  for (const employee of employees) {
    usageByEmployee.set(employee.name, {
      employee: employee.name,
      displayName: employee.displayName,
      rank: employee.rank,
      department: employee.department || null,
      engine: employee.engine,
      model: employee.model,
      running: runningEmployees.has(employee.name),
      usage: Object.fromEntries(
        COMMAND_CENTER_RANGES.map(({ key }) => [
          key,
          {
            range: key,
            sessionCount: 0,
            totalCostUsd: 0,
            totalTurns: 0,
            totalTokens: 0,
          },
        ]),
      ) as Record<CommandCenterRangeKey, CommandCenterUsageBucket>,
    });
  }

  for (const session of sessions) {
    if (!session.employee) continue;
    const target = usageByEmployee.get(session.employee);
    if (!target) continue;
    const createdAtMs = Date.parse(session.createdAt);
    if (!Number.isFinite(createdAtMs)) continue;
    const ageMs = now - createdAtMs;
    for (const { key, ms } of COMMAND_CENTER_RANGES) {
      if (ageMs > ms) continue;
      const bucket = target.usage[key];
      bucket.sessionCount += 1;
      bucket.totalCostUsd = roundCurrency(bucket.totalCostUsd + (session.totalCost ?? 0));
      bucket.totalTurns += session.totalTurns ?? 0;
      bucket.totalTokens += session.lastContextTokens ?? 0;
    }
  }

  const managers: CommandCenterManagerSummary[] = employees
    .filter((employee) => employee.rank === "manager" || employee.rank === "executive")
    .map((employee) => ({
      employee: employee.name,
      displayName: employee.displayName,
      department: employee.department || null,
      rank: employee.rank,
      running: runningEmployees.has(employee.name),
    }))
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank === "executive" ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });

  const availableAgents = Array.from(usageByEmployee.values()).sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });

  const ticketsTotal = Object.values(ticketCounts).reduce((sum, count) => sum + count, 0);
  return {
    generatedAt: new Date(now).toISOString(),
    summary: {
      agents: employees.length,
      agentsRunning: runningEmployees.size,
      cronJobs: cronJobs.length,
      // "Open" excludes terminal (done) tickets so the metric matches its label;
      // ticketsTotal is retained for callers that want the whole-board count.
      ticketsOpen: ticketsTotal - ticketCounts.done,
      ticketsTotal,
    },
    ticketCounts,
    managers,
    availableAgents,
  };
}

// Named so the /api/status "connectors" check surfaces which connector(s)
// are failing instead of a bare count (a bare count made two different
// root causes on two different polls indistinguishable to a health monitor).
export function summarizeConnectorErrors(
  connectors: Record<string, { status: string } | null | undefined>,
): { count: number; names: string[] } {
  const errors = Object.entries(connectors).filter(([, health]) => health?.status === "error");
  return { count: errors.length, names: errors.map(([name]) => name) };
}

export function summarizeEmailReadiness(
  enabled: boolean,
  serviceAvailable: boolean,
  inboxes: Array<{ id: string; health?: { status: "idle" | "ok" | "degraded" | "error"; detail?: string | null } }>,
): { status: HealthCheckStatus; detail?: string } {
  if (!enabled) return { status: "ok" };
  if (!serviceAvailable) return { status: "error", detail: "email is enabled but its service is unavailable" };
  if (inboxes.length === 0) return { status: "error", detail: "email is enabled but no inboxes are configured" };
  const errors = inboxes.filter((inbox) => inbox.health?.status === "error");
  if (errors.length > 0) return { status: "error", detail: `email inbox error: ${errors.map((inbox) => inbox.id).join(", ")}` };
  const pending = inboxes.filter((inbox) => !inbox.health || inbox.health.status === "idle" || inbox.health.status === "degraded");
  if (pending.length > 0) return { status: "degraded", detail: `email inbox not healthy: ${pending.map((inbox) => inbox.id).join(", ")}` };
  return { status: "ok" };
}

function overallCheckStatus(checks: HealthCheck[]): HealthCheckStatus {
  if (checks.some((check) => check.status === "error")) return "error";
  if (checks.some((check) => check.status === "degraded")) return "degraded";
  return "ok";
}

function buildHealthSnapshot(context: ApiContext) {
  const config = context.getConfig();
  const checks: HealthCheck[] = [];
  let sessions = [] as ReturnType<typeof listSessions>;
  let running = 0;
  try {
    sessions = listSessions();
    running = sessions.filter((session) => isSessionLiveRunning(session, context)).length;
    checks.push({ name: "sessions_db", status: "ok" });
  } catch (err) {
    checks.push({ name: "sessions_db", status: "error", detail: err instanceof Error ? err.message : String(err) });
  }

  const connectors: Record<string, { status: string; detail?: string } | null> = {};
  for (const connector of context.connectors.values()) {
    try {
      connectors[connector.name] = connector.getHealth();
    } catch (err) {
      connectors[connector.name] = { status: "error", detail: err instanceof Error ? err.message : String(err) };
    }
  }
  const connectorErrors = summarizeConnectorErrors(connectors);
  checks.push({
    name: "connectors",
    status: connectorErrors.count > 0 ? "degraded" : "ok",
    ...(connectorErrors.count > 0
      ? { detail: `${connectorErrors.count} connector(s) reporting error: ${connectorErrors.names.join(", ")}` }
      : {}),
  });

  const registry = getModelRegistry(config);
  const availableEngines = Object.values(registry).filter((entry) => entry.available);
  const defaultEngine = registry[config.engines.default];
  checks.push({
    name: "engines",
    status: availableEngines.length === 0 ? "error" : defaultEngine?.available === false ? "degraded" : "ok",
    ...(availableEngines.length === 0
      ? { detail: "No engines are available" }
      : defaultEngine?.available === false
        ? { detail: `Default engine ${config.engines.default} is unavailable` }
        : {}),
  });

  if (config.orchestration?.enabled === true) {
    const runtime = context.orchestration?.runtime;
    if (!runtime) {
      checks.push({ name: "orchestration", status: "error", detail: "orchestration is enabled but its runtime is unavailable" });
    } else {
      try {
        runtime.hasActiveWork();
        checks.push({ name: "orchestration", status: "ok" });
      } catch (err) {
        checks.push({ name: "orchestration", status: "error", detail: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  let emailInboxes = [] as ReturnType<NonNullable<ApiContext["emailService"]>["listInboxes"]>;
  let emailServiceAvailable = Boolean(context.emailService);
  try {
    emailInboxes = context.emailService?.listInboxes() ?? [];
  } catch (err) {
    emailServiceAvailable = false;
    if (config.email?.enabled === true) {
      checks.push({ name: "email", status: "error", detail: err instanceof Error ? err.message : String(err) });
    }
  }
  if (config.email?.enabled === true && !checks.some((check) => check.name === "email")) {
    const email = summarizeEmailReadiness(true, emailServiceAvailable, emailInboxes);
    checks.push({ name: "email", ...email });
  }

  const health = getProcessHealth();
  if (health.uncaughtExceptions > 0) {
    checks.push({
      name: "process_stability",
      status: "degraded",
      detail: `${health.uncaughtExceptions} uncaught exception(s) since start; last: ${health.lastUncaughtMessage ?? "unknown"}`,
    });
  } else if (health.droppedNotifications > 0) {
    checks.push({
      name: "process_stability",
      status: "degraded",
      detail: `${health.droppedNotifications} operator notification(s) dropped; last reason: ${health.lastDroppedNotificationReason ?? "unknown"}`,
    });
  }

  return {
    config,
    checks,
    sessions,
    running,
    connectors,
    emailInboxes,
    registry,
    overall: overallCheckStatus(checks),
  };
}

function checkInstanceHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({ hostname: "localhost", port, path: "/api/healthz", timeout: 2000 }, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

// STT-CF-003: a DB-recorded "running" status can briefly disagree with the
// actual live-engine state during the window between an engine crash and the
// session row being updated to reflect it. Downgrade to "error" (the status a
// crash handler eventually settles the row to — see sessions/manager.ts) using
// the same isSessionLiveRunning predicate that buildCommandCenterPayload,
// buildHealthSnapshot, and serializeSession already use, so /api/work and
// /api/activity agree with the rest of the API surface instead of trusting
// session.status/queue bookkeeping alone.
function liveAwareStatus(session: Session, context: ApiContext): Session["status"] {
  return session.status === "running" && !isSessionLiveRunning(session, context) ? "error" : session.status;
}

// Exact-match visibility routes only. These paths do not overlap any param
// routes, so hoisting them behind one handler preserves precedence.
export async function handleStatusRoutes(
  method: string,
  pathname: string,
  res: ServerResponse,
  context: ApiContext,
): Promise<boolean> {
  if (method === "GET" && pathname === "/api/healthz") {
    json(res, { status: "ok", kind: "liveness", uptime: process.uptime() });
    return true;
  }
  if (method === "GET" && pathname === "/api/readyz") {
    const snapshot = buildHealthSnapshot(context);
    const ready = snapshot.overall === "ok";
    json(res, {
      status: ready ? "ready" : "not_ready",
      checks: snapshot.checks,
      uptime: Math.floor((Date.now() - context.startTime) / 1000),
    }, ready ? 200 : 503);
    return true;
  }
  if (method === "GET" && pathname === "/api/workspace-profiles") {
    json(res, { profiles: summarizeWorkspaceProfiles(context.getConfig()) });
    return true;
  }
  if (method === "GET" && pathname === "/api/status") {
    const snapshot = buildHealthSnapshot(context);
    json(res, {
      status: snapshot.overall,
      checks: snapshot.checks,
      uptime: Math.floor((Date.now() - context.startTime) / 1000),
      port: snapshot.config.gateway.port || 8888,
      engines: {
        default: snapshot.config.engines.default,
        ...Object.fromEntries(
          Object.entries(snapshot.registry).map(([name, entry]) => [
            name,
            { model: entry.defaultModel, available: entry.available },
          ]),
        ),
      },
      sessions: { total: snapshot.sessions.length, running: snapshot.running, active: snapshot.running },
      connectors: snapshot.connectors,
      email: {
        enabled: snapshot.config.email?.enabled === true,
        inboxes: snapshot.emailInboxes.map((inbox) => ({
          id: inbox.id,
          label: inbox.label ?? null,
          status: inbox.health?.status ?? "idle",
          detail: inbox.health?.detail ?? null,
          lastCheckedAt: inbox.health?.lastCheckedAt ?? null,
          cachedCount: inbox.health?.cachedCount ?? 0,
        })),
      },
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/instances") {
    const instances = loadInstances();
    const currentPort = context.getConfig().gateway.port || 8888;
    const results = await Promise.all(
      instances.map(async (inst) => ({
        name: inst.name,
        port: inst.port,
        running: inst.port === currentPort ? true : await checkInstanceHealth(inst.port),
        current: inst.port === currentPort,
      })),
    );
    json(res, results);
    return true;
  }

  if (method === "GET" && pathname === "/api/work") {
    const queue = context.sessionManager.getQueue();
    const pendingApprovalSessionIds = new Set(listApprovals({ state: "pending" }).map((approval) => approval.sessionId));
    let deptByEmployee: Map<string, string | undefined> | null = null;
    try {
      const { scanOrg } = await import("../../org.js");
      const registry = scanOrg();
      deptByEmployee = new Map(Array.from(registry.values()).map((employee) => [employee.name, employee.department]));
    } catch {
      // Org scan is optional for this read-only view.
    }

    const counts = emptyWorkCounts();
    const items = listSessions().map((session) => {
      const effectiveStatus = liveAwareStatus(session, context);
      const transportState = queue.getTransportState(session.sessionKey || session.sourceRef, effectiveStatus);
      const workState = deriveWorkState({
        status: effectiveStatus,
        transportState,
        approvalRequired: pendingApprovalSessionIds.has(session.id),
        hasRun: typeof session.transportMeta?.latestRunId === "string",
        cron: session.source === "cron",
      });
      counts[workState]++;
      return {
        sessionId: session.id,
        employee: session.employee ?? null,
        dept: (session.employee && deptByEmployee?.get(session.employee)) ?? null,
        workState,
        title: session.title ?? null,
      };
    });
    json(res, { counts, items });
    return true;
  }

  if (method === "GET" && pathname === "/api/activity") {
    const sessions = listSessions();
    const events: Array<{ event: string; payload: unknown; ts: number }> = [];
    for (const session of sessions) {
      if (session.parentSessionId) {
        events.push({
          event: "session:delegated",
          payload: {
            sessionId: session.id,
            parentSessionId: session.parentSessionId,
            employee: session.employee,
            engine: session.engine,
            connector: session.connector,
            title: session.title ?? null,
          },
          ts: new Date(session.createdAt).getTime(),
        });
      }
      const ts = new Date(session.lastActivity || session.createdAt).getTime();
      const transportState = context.sessionManager.getQueue().getTransportState(
        session.sessionKey || session.sourceRef,
        liveAwareStatus(session, context),
      );
      if (transportState === "running") {
        events.push({ event: "session:started", payload: { sessionId: session.id, employee: session.employee, engine: session.engine, connector: session.connector }, ts });
      } else if (transportState === "queued") {
        events.push({ event: "session:queued", payload: { sessionId: session.id, employee: session.employee, engine: session.engine, connector: session.connector }, ts });
      } else if (transportState === "idle") {
        events.push({ event: "session:completed", payload: { sessionId: session.id, employee: session.employee, engine: session.engine, connector: session.connector }, ts });
      } else if (transportState === "error") {
        events.push({ event: "session:error", payload: { sessionId: session.id, employee: session.employee, error: session.lastError, connector: session.connector }, ts });
      }
    }
    events.sort((a, b) => b.ts - a.ts);
    json(res, events.slice(0, 30));
    return true;
  }

  if (method === "GET" && pathname === "/api/command-center") {
    json(res, await buildCommandCenterPayload(context));
    return true;
  }

  return false;
}
