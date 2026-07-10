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

type CommandCenterRangeKey = "day" | "week" | "month";

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

// Exact-match visibility routes only. These paths do not overlap any param
// routes, so hoisting them behind one handler preserves precedence.
export async function handleStatusRoutes(
  method: string,
  pathname: string,
  res: ServerResponse,
  context: ApiContext,
): Promise<boolean> {
  if (method === "GET" && pathname === "/api/healthz") {
    json(res, { status: "ok", uptime: process.uptime() });
    return true;
  }
  if (method === "GET" && pathname === "/api/workspace-profiles") {
    json(res, { profiles: summarizeWorkspaceProfiles(context.getConfig()) });
    return true;
  }
  if (method === "GET" && pathname === "/api/status") {
    const config = context.getConfig();
    const checks: Array<{ name: string; status: "ok" | "degraded" | "error"; detail?: string }> = [];
    let sessions = [] as ReturnType<typeof listSessions>;
    let running = 0;
    try {
      sessions = listSessions();
      running = sessions.filter((session) => isSessionLiveRunning(session, context)).length;
      checks.push({ name: "sessions_db", status: "ok" });
    } catch (err) {
      checks.push({ name: "sessions_db", status: "error", detail: err instanceof Error ? err.message : String(err) });
    }
    const connectors = Object.fromEntries(
      Array.from(context.connectors.values()).map((connector) => [connector.name, connector.getHealth()]),
    );
    const emailInboxes = context.emailService?.listInboxes() ?? [];
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
    // Audit H1: the health surface previously never observed the orchestration
    // runtime, so `/api/status` stayed green while every orchestration-backed
    // dispatch failed with a 409. Probe it when orchestration is enabled.
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

    // Audit E1/H1: after an uncaught exception Node's state is undefined, so the
    // daemon (kept alive by design) must not report a clean healthy status.
    // Dropped operator notifications (E7) also surface here as degraded.
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

    const overall: "ok" | "degraded" | "error" = checks.some((check) => check.status === "error")
      ? "error"
      : checks.some((check) => check.status === "degraded")
        ? "degraded"
        : "ok";
    json(res, {
      status: overall,
      checks,
      uptime: Math.floor((Date.now() - context.startTime) / 1000),
      port: config.gateway.port || 8888,
      engines: {
        default: config.engines.default,
        ...Object.fromEntries(
          Object.entries(registry).map(([name, entry]) => [
            name,
            { model: entry.defaultModel, available: entry.available },
          ]),
        ),
      },
      sessions: { total: sessions.length, running, active: running },
      connectors,
      email: {
        enabled: config.email?.enabled === true,
        inboxes: emailInboxes.map((inbox) => ({
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
      const transportState = queue.getTransportState(session.sessionKey || session.sourceRef, session.status);
      const workState = deriveWorkState({
        status: session.status,
        transportState,
        approvalRequired: pendingApprovalSessionIds.has(session.id),
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
        session.status,
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
