import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { ORG_DIR } from "../../../shared/paths.js";
import { logger } from "../../../shared/logger.js";
import { listSessions } from "../../../sessions/registry.js";
import { readJsonBody } from "../../http-helpers.js";
import { authorizeManagerScope } from "../../manager-auth.js";
import { BoardConflictError, defaultBoardState, readBoardArray, readBoardState, writeMergedBoard } from "../../board-service.js";
import { resolveBestSessionForTicket, resolveTicketSessionFallbackState, resolveTicketSessionFailureReason, resolveTicketSessionStalled } from "../../ticket-session-resolver.js";
import { dispatchTicket } from "../../ticket-dispatch.js";
import { scanOrg } from "../../org.js";
import type { ApiContext } from "../context.js";
import { matchRoute } from "../match-route.js";
import { badRequest, json, notFound, serverError } from "../responses.js";
import { loadSessionMessagesForApi } from "../session-query-routes.js";

const TICKET_SESSION_TAIL_LIMIT = 8;

function validateBoardAssigneesForDepartment(department: string, payload: unknown): string | null {
  const tickets = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && !Array.isArray(payload) && Array.isArray((payload as { tickets?: unknown }).tickets)
      ? (payload as { tickets: unknown[] }).tickets
      : null;
  if (!tickets) return null;

  const org = scanOrg();
  for (const [index, ticket] of tickets.entries()) {
    if (!ticket || typeof ticket !== "object" || Array.isArray(ticket)) continue;
    const assignee = (ticket as { assignee?: unknown }).assignee;
    if (typeof assignee !== "string" || !assignee.trim()) continue;
    const employee = org.get(assignee);
    if (!employee) continue;
    if (employee.department !== department) {
      const id = typeof (ticket as { id?: unknown }).id === "string" ? (ticket as { id: string }).id : `#${index}`;
      return `ticket "${id}" is assigned to "${assignee}", who belongs to department "${employee.department}", not "${department}"`;
    }
  }
  return null;
}

export async function handleOrgRoutes(
  method: string,
  pathname: string,
  req: HttpRequest,
  res: ServerResponse,
  context: ApiContext,
): Promise<boolean> {
  let params = matchRoute("/api/org/employees/:name", pathname);

  if (method === "GET" && pathname === "/api/org") {
    if (!fs.existsSync(ORG_DIR)) {
      json(res, { departments: [], employees: [], hierarchy: { root: null, sorted: [], warnings: [] } });
      return true;
    }
    const entries = fs.readdirSync(ORG_DIR, { withFileTypes: true });
    const departments = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const { resolveOrgHierarchy } = await import("../../org-hierarchy.js");
    const orgRegistry = scanOrg();
    const hierarchy = resolveOrgHierarchy(orgRegistry);
    const employees = hierarchy.sorted.map((name) => {
      const node = hierarchy.nodes[name];
      const emp = node.employee;
      const { persona, ...rest } = emp;
      return {
        ...rest,
        parentName: node.parentName,
        directReports: node.directReports,
        depth: node.depth,
        chain: node.chain,
      };
    });
    json(res, {
      departments,
      employees,
      hierarchy: {
        root: hierarchy.root,
        sorted: hierarchy.sorted,
        warnings: hierarchy.warnings,
      },
    });
    return true;
  }

  if (method === "GET" && params) {
    const orgRegistry = scanOrg();
    const emp = orgRegistry.get(params.name);
    if (!emp) {
      notFound(res);
      return true;
    }
    const { resolveOrgHierarchy } = await import("../../org-hierarchy.js");
    const hierarchy = resolveOrgHierarchy(orgRegistry);
    const node = hierarchy.nodes[params.name];
    json(res, {
      ...emp,
      parentName: node?.parentName ?? null,
      directReports: node?.directReports ?? [],
      depth: node?.depth ?? 0,
      chain: node?.chain ?? [params.name],
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/org/employees") {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      badRequest(res, "employee body must be a JSON object");
      return true;
    }
    const { createEmployeeYaml, validateEmployeeCreate } = await import("../../org.js");
    const registry = scanOrg();
    const result = validateEmployeeCreate(context.getConfig(), body, registry.keys());
    if (!result.ok || !result.employee) {
      badRequest(res, result.error || "invalid employee");
      return true;
    }
    const wrote = createEmployeeYaml(result.employee);
    if (!wrote) {
      badRequest(res, `employee "${result.employee.name}" already exists`);
      return true;
    }
    context.reloadOrg?.();
    context.emit("org:updated", { employee: result.employee.name, action: "created" });
    const created = scanOrg().get(result.employee.name);
    json(res, { status: "ok", employee: created ?? null }, 201);
    return true;
  }

  params = matchRoute("/api/org/employees/:name", pathname);
  if (method === "PATCH" && params) {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      badRequest(res, "update body must be a JSON object");
      return true;
    }
    const { updateEmployeeYaml, validateEmployeeUpdate } = await import("../../org.js");
    const registry = scanOrg();
    const current = registry.get(params.name);
    if (!current) {
      notFound(res);
      return true;
    }
    const managerName = typeof body.managerName === "string" ? body.managerName.trim() : "";
    if (managerName) {
      const auth = authorizeManagerScope(registry, managerName, [params.name]);
      if (!auth.ok) {
        json(res, { error: auth.error }, 403);
        return true;
      }
    }
    const employeeUpdate = { ...body };
    delete employeeUpdate.managerName;

    const result = validateEmployeeUpdate(context.getConfig(), current, employeeUpdate);
    if (!result.ok) {
      badRequest(res, result.error || "invalid update");
      return true;
    }

    const wrote = updateEmployeeYaml(params.name, result.updates!);
    if (!wrote) {
      notFound(res);
      return true;
    }

    context.reloadOrg?.();
    context.emit("org:updated", { employee: params.name });
    const updated = scanOrg().get(params.name);
    json(res, { status: "ok", employee: updated ?? null });
    return true;
  }

  if (method === "DELETE" && params) {
    const { deleteEmployeeYaml } = await import("../../org.js");
    const { getAllParents } = await import("../../org-hierarchy.js");
    const name = params.name;
    const registry = scanOrg();
    const current = registry.get(name);
    if (!current) {
      notFound(res);
      return true;
    }
    // Refuse to orphan reports: block deletion while anyone still reports to
    // this employee (primary or secondary matrix links).
    const reports = [...registry.values()]
      .filter((emp) => getAllParents(emp.reportsTo).includes(name))
      .map((emp) => emp.name);
    if (reports.length > 0) {
      json(res, {
        error: `Cannot delete "${name}" while ${reports.length} employee${reports.length === 1 ? "" : "s"} still report${reports.length === 1 ? "s" : ""} to them. Reassign or remove them first.`,
        reports,
      }, 409);
      return true;
    }
    const deleted = deleteEmployeeYaml(name);
    if (!deleted) {
      notFound(res);
      return true;
    }
    context.reloadOrg?.();
    context.emit("org:updated", { employee: name, action: "deleted" });
    json(res, { status: "ok" });
    return true;
  }

  params = matchRoute("/api/org/departments/:name/board", pathname);
  if (method === "GET" && params) {
    const deptDir = path.join(ORG_DIR, params.name);
    if (!fs.existsSync(deptDir)) {
      notFound(res);
      return true;
    }
    const boardPath = path.join(deptDir, "board.json");
    if (!fs.existsSync(boardPath)) {
      notFound(res);
      return true;
    }
    try {
      const board = readBoardState(ORG_DIR, params.name) ?? defaultBoardState();
      json(res, board);
    } catch (err) {
      logger.warn(`GET /api/org/departments/${params.name}/board: corrupt board.json — ${err instanceof Error ? err.message : String(err)}`);
      serverError(res, "board.json is corrupt");
    }
    return true;
  }

  params = matchRoute("/api/org/departments/:name/tickets/:id/session", pathname);
  if (method === "GET" && params) {
    const routeParams = params;
    let board: import("../../board-service.js").BoardTicket[] | null;
    try {
      board = readBoardArray(ORG_DIR, routeParams.name);
    } catch (err) {
      logger.warn(`GET /api/org/departments/${routeParams.name}/tickets/${routeParams.id}/session: corrupt board.json — ${err instanceof Error ? err.message : String(err)}`);
      serverError(res, "board.json is corrupt");
      return true;
    }
    const ticket = board?.find((entry) => entry?.id === routeParams.id);
    if (!ticket) {
      json(res, { found: false });
      return true;
    }
    const session = resolveBestSessionForTicket(ticket, listSessions());
    if (!session) {
      json(res, { found: false });
      return true;
    }
    const detail = loadSessionMessagesForApi(session.id, context, String(TICKET_SESSION_TAIL_LIMIT));
    if (!detail) {
      json(res, { found: false });
      return true;
    }
    const lastActivityMs = Date.parse(detail.session.lastActivity || "");
    const lastActivityAgoMs = Number.isFinite(lastActivityMs) ? Math.max(0, Date.now() - lastActivityMs) : null;
    const stalled = resolveTicketSessionStalled(detail.session);
    const fallback = resolveTicketSessionFallbackState(detail.session);
    json(res, {
      found: true,
      sessionId: detail.session.id,
      status: detail.session.status,
      engine: detail.session.engine,
      model: detail.session.model,
      employee: detail.session.employee,
      totalCost: detail.session.totalCost,
      lastActivityIso: detail.session.lastActivity,
      lastActivityAgoMs,
      stalled,
      stalledForMs: stalled ? lastActivityAgoMs : null,
      failureReason: resolveTicketSessionFailureReason(detail.session),
      fallback,
      lastError: detail.session.lastError,
      messages: detail.messages.map((message) => ({
        role: message.role,
        text: message.content,
        ts: message.timestamp,
        kind: message.toolCall ? "tool_call" : message.partial ? "partial" : message.role === "notification" ? "notification" : "message",
        toolCall: message.toolCall,
      })),
    });
    return true;
  }

  params = matchRoute("/api/org/departments/:name/tickets/:id/dispatch", pathname);
  if (method === "POST" && params) {
    const result = await dispatchTicket(
      params.name,
      params.id,
      { source: "manual", routeToManager: false },
      { context, orgDir: ORG_DIR },
    );
    if (!result.ok) {
      if (result.reason === "no-assignee") {
        json(res, { reason: result.reason, error: "Assign someone first." }, 400);
        return true;
      }
      if (result.reason === "foreign-department-assignee") {
        json(res, { reason: result.reason, error: "Assignee does not belong to this department." }, 400);
        return true;
      }
      if (result.reason === "already-running") {
        json(res, { reason: result.reason, error: "Ticket already has a running session." }, 409);
        return true;
      }
      if (result.reason.startsWith("orchestration-")) {
        json(res, { reason: result.reason, error: result.reason }, 409);
        return true;
      }
      if (result.reason === "not-found") {
        notFound(res);
        return true;
      }
      json(res, { reason: result.reason, error: result.reason }, 404);
      return true;
    }
    json(res, { status: "ok", sessionId: result.sessionId });
    return true;
  }

  params = matchRoute("/api/org/departments/:name/board", pathname);
  if (method === "PUT" && params) {
    const deptDir = path.join(ORG_DIR, params.name);
    if (!fs.existsSync(deptDir)) {
      notFound(res);
      return true;
    }
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    try {
      const assigneeError = validateBoardAssigneesForDepartment(params.name, parsed.body);
      if (assigneeError) {
        badRequest(res, assigneeError);
        return true;
      }
      writeMergedBoard(ORG_DIR, params.name, parsed.body);
    } catch (err) {
      logger.warn(`PUT /api/org/departments/${params.name}/board failed: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof BoardConflictError) {
        json(res, {
          reason: "board-conflict",
          error: err.message,
          ticketIds: err.ticketIds,
        }, 409);
        return true;
      }
      badRequest(res, err instanceof Error ? err.message : "Invalid board payload");
      return true;
    }
    context.emit("board:updated", { department: params.name });
    json(res, { status: "ok" });
    return true;
  }

  return false;
}
