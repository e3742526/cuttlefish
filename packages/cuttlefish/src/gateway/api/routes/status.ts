import type { ServerResponse } from "node:http";
import http from "node:http";
import { loadInstances } from "../../../cli/instances.js";
import { getModelRegistry } from "../../../shared/models.js";
import { listSessions } from "../../../sessions/registry.js";
import { deriveWorkState, emptyWorkCounts } from "../../../shared/work-state.js";
import { listApprovals } from "../../approvals.js";
import type { ApiContext } from "../context.js";
import { json } from "../responses.js";
import { isSessionLiveRunning } from "../serialize-session.js";

function checkInstanceHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({ hostname: "localhost", port, path: "/api/status", timeout: 2000 }, (res) => {
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
    const connectorErrors = Object.values(connectors).filter((health) => health.status === "error");
    checks.push({
      name: "connectors",
      status: connectorErrors.length > 0 ? "degraded" : "ok",
      ...(connectorErrors.length > 0 ? { detail: `${connectorErrors.length} connector(s) reporting error` } : {}),
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

  return false;
}
