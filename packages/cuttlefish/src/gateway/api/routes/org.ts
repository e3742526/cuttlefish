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
import { resolveUserHeader } from "../../connector-reply.js";
import type { ApiContext } from "../context.js";
import { matchRoute } from "../match-route.js";
import { badRequest, json, notFound, serverError } from "../responses.js";
import { loadSessionMessagesForApi } from "../session-query-routes.js";
import { ORG_CHANGE_TYPES, type OrgChangeType } from "../../../shared/types.js";

const TICKET_SESSION_TAIL_LIMIT = 8;

const VALID_CHANGE_TYPES = new Set<OrgChangeType>(ORG_CHANGE_TYPES);
const MANAGER_MUTABLE_EMPLOYEE_FIELDS = new Set([
  "engine",
  "model",
  "effortLevel",
  "fallbackEngine",
  "fallbackModel",
] as const);

type ParsedChangeInput =
  | { ok: true; value: { changeType: OrgChangeType; employeeName: string; proposed: Record<string, unknown> } }
  | { ok: false; error: string };

/** Validate the shared {changeType, employeeName, proposed} shape used by the
 *  /api/org/validate and /api/org/change-requests routes. */
function parseChangeInput(body: unknown): ParsedChangeInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.changeType !== "string" || !VALID_CHANGE_TYPES.has(b.changeType as OrgChangeType)) {
    return { ok: false, error: `invalid changeType (valid: ${[...VALID_CHANGE_TYPES].join(", ")})` };
  }
  const employeeName = typeof b.employeeName === "string" ? b.employeeName.trim() : "";
  if (!employeeName) return { ok: false, error: "employeeName must be a non-empty string" };
  if (!b.proposed || typeof b.proposed !== "object" || Array.isArray(b.proposed)) {
    return { ok: false, error: "proposed must be a JSON object" };
  }
  return {
    ok: true,
    value: { changeType: b.changeType as OrgChangeType, employeeName, proposed: b.proposed as Record<string, unknown> },
  };
}

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
      const disallowedFields = Object.keys(body).filter(
        (key) => key !== "managerName" && !MANAGER_MUTABLE_EMPLOYEE_FIELDS.has(key as "engine" | "model" | "effortLevel" | "fallbackEngine" | "fallbackModel"),
      );
      if (disallowedFields.length > 0) {
        json(
          res,
          {
            error: `manager-scoped employee updates may only modify ${[...MANAGER_MUTABLE_EMPLOYEE_FIELDS].join(", ")} (received: ${disallowedFields.join(", ")})`,
          },
          403,
        );
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

  // --- Org change requests (HR / Org Steward) ---------------------------------
  // Phase 1 is draft-only: validate + create/list/get change requests. The
  // critique pipeline (pending_critique → pending_approval) and approve→apply
  // routes are layered on in later phases without changing these surfaces.

  if (method === "POST" && pathname === "/api/org/validate") {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const input = parseChangeInput(parsed.body);
    if (!input.ok) {
      badRequest(res, input.error);
      return true;
    }
    const { validateOrgChange } = await import("../../org.js");
    const result = validateOrgChange(context.getConfig(), input.value);
    json(res, { ok: result.ok, error: result.error ?? null });
    return true;
  }

  if (method === "POST" && pathname === "/api/org/change-requests") {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const input = parseChangeInput(parsed.body);
    if (!input.ok) {
      badRequest(res, input.error);
      return true;
    }
    const body = parsed.body as Record<string, unknown>;
    const { validateOrgChange } = await import("../../org.js");
    const validation = validateOrgChange(context.getConfig(), input.value);
    if (!validation.ok) {
      badRequest(res, validation.error || "invalid org change");
      return true;
    }
    // Run the full HR pipeline: hard guards → classify → persist pending_critique
    // → background HR critique → approval gate (or auto-apply for low-risk).
    const { submitOrgChange } = await import("../../hr-steward.js");
    const result = await submitOrgChange(
      {
        changeType: input.value.changeType,
        employeeName: input.value.employeeName,
        proposed: input.value.proposed,
        rationale: typeof body.rationale === "string" ? body.rationale : "",
        evidenceRefs: Array.isArray(body.evidenceRefs)
          ? body.evidenceRefs.filter((x): x is string => typeof x === "string")
          : [],
        proposedBy: typeof body.proposedBy === "string" && body.proposedBy.trim() ? body.proposedBy.trim() : "user",
      },
      context,
    );
    if (result.blocked) {
      json(res, { status: "blocked", error: result.reason, changeRequest: result.request }, 409);
      return true;
    }
    json(res, { status: "ok", changeRequest: result.request }, 202);
    return true;
  }

  if (method === "GET" && pathname === "/api/org/retired") {
    const { listRetiredEmployees } = await import("../../org.js");
    const employees = listRetiredEmployees().map(({ persona, ...rest }) => rest);
    json(res, { employees });
    return true;
  }

  if (method === "GET" && pathname === "/api/org/change-requests") {
    const { listChangeRequests } = await import("../../org-changes.js");
    const query = new URL(req.url ?? "/", "http://localhost").searchParams;
    const statusParam = query.get("status");
    const statuses = statusParam
      ? statusParam.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    const requests = listChangeRequests(statuses ? { status: statuses as never } : undefined);
    json(res, { changeRequests: requests });
    return true;
  }

  params = matchRoute("/api/org/change-requests/:id", pathname);
  if (method === "GET" && params) {
    const { getChangeRequest } = await import("../../org-changes.js");
    const request = getChangeRequest(params.id);
    if (!request) {
      notFound(res);
      return true;
    }
    json(res, request);
    return true;
  }

  params = matchRoute("/api/org/change-requests/:id/approve", pathname);
  if (method === "POST" && params) {
    const { getChangeRequest, updateChangeRequestStatus } = await import("../../org-changes.js");
    const { applyOrgChange } = await import("../../hr-steward.js");
    const { resolveApproval } = await import("../../approvals.js");
    const request = getChangeRequest(params.id);
    if (!request) {
      notFound(res);
      return true;
    }
    if (request.status !== "pending_approval" && request.status !== "approved") {
      json(res, { error: `change is ${request.status}, not awaiting approval` }, 409);
      return true;
    }
    const actor = resolveUserHeader(req.headers, context.getConfig().gateway.userHeader);
    if (request.approvalId) {
      try {
        resolveApproval(request.approvalId, "approved", actor);
      } catch {
        /* already resolved — proceed to apply idempotently */
      }
    }
    updateChangeRequestStatus(params.id, "approved");
    const applied = await applyOrgChange(request, context);
    if (!applied.ok) {
      json(res, { status: "error", error: applied.error, changeRequest: getChangeRequest(params.id) }, 400);
      return true;
    }
    json(res, { status: "ok", changeRequest: getChangeRequest(params.id) });
    return true;
  }

  params = matchRoute("/api/org/change-requests/:id/reject", pathname);
  if (method === "POST" && params) {
    const { getChangeRequest, updateChangeRequestStatus } = await import("../../org-changes.js");
    const { resolveApproval } = await import("../../approvals.js");
    const request = getChangeRequest(params.id);
    if (!request) {
      notFound(res);
      return true;
    }
    const actor = resolveUserHeader(req.headers, context.getConfig().gateway.userHeader);
    if (request.approvalId) {
      try {
        resolveApproval(request.approvalId, "rejected", actor);
      } catch {
        /* already resolved */
      }
    }
    const updated = updateChangeRequestStatus(params.id, "rejected");
    context.emit("org-change:updated", { id: params.id, status: "rejected" });
    json(res, { status: "ok", changeRequest: updated });
    return true;
  }

  params = matchRoute("/api/org/change-requests/:id/apply", pathname);
  if (method === "POST" && params) {
    const { getChangeRequest } = await import("../../org-changes.js");
    const { applyOrgChange } = await import("../../hr-steward.js");
    const request = getChangeRequest(params.id);
    if (!request) {
      notFound(res);
      return true;
    }
    const applied = await applyOrgChange(request, context);
    if (!applied.ok) {
      json(res, { status: "error", error: applied.error, changeRequest: getChangeRequest(params.id) }, 400);
      return true;
    }
    json(res, { status: "ok", changeRequest: getChangeRequest(params.id) });
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
