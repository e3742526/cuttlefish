import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { ORG_DIR } from "../../../shared/paths.js";
import { logger } from "../../../shared/logger.js";
import { createSession, getSession, insertMessage, listSessions } from "../../../sessions/registry.js";
import { readJsonBody } from "../../http-helpers.js";
import { authorizeManagerScope, isManagerNameAuthorizedForPrincipal } from "../../manager-auth.js";
import type { GatewayPrincipal } from "../../auth.js";
import { archiveEmployeeBoardTickets, BoardConflictError, defaultBoardState, readBoardArray, readBoardState, writeMergedBoardPartial } from "../../board-service.js";
import { resolveBestSessionForTicket, resolveTicketSessionFallbackState, resolveTicketSessionFailureReason, resolveTicketSessionStalled, shouldExposeSessionForTicket } from "../../ticket-session-resolver.js";
import { dispatchTicket } from "../../ticket-dispatch.js";
import { RESERVED_ORG_DIRS, isActiveEmployee, scanOrg } from "../../org.js";
import { resolveUserHeader } from "../../connector-reply.js";
import type { ApiContext } from "../context.js";
import { matchRoute } from "../match-route.js";
import { badRequest, json, notFound, serverError } from "../responses.js";
import { loadSessionMessagesForApi } from "../session-query-routes.js";
import { EXECUTION_TIERS, ORG_CHANGE_TYPES, type Employee, type EmployeeExecutionConfig, type OrgChangeType, type OrgWarning } from "../../../shared/types.js";

const TICKET_SESSION_TAIL_LIMIT = 8;

/** Effective execution config — applies V1 defaults for absent fields. */
function effectiveExecution(emp: Employee): EmployeeExecutionConfig {
  return emp.execution ?? { tier: "solo" };
}

interface ExecutionProfileSummary {
  tier: "solo" | "mid_pair";
  label: string;
  reviewerLossPolicy?: string;
  reviewerToolProfile?: string;
  hasCustomRoleOverrides: boolean;
}

interface OrgServiceSummary {
  name: string;
  description: string;
  provider: {
    name: string;
    displayName: string;
    department: string;
    rank: Employee["rank"];
  };
}

const SERVICE_RANK_PRIORITY: Record<Employee["rank"], number> = {
  executive: 0,
  manager: 1,
  senior: 2,
  employee: 3,
};

function computeExecutionProfileSummary(emp: Employee): ExecutionProfileSummary {
  const exec = effectiveExecution(emp);
  const tier = (EXECUTION_TIERS as readonly string[]).includes(exec.tier) ? exec.tier : "solo";
  return {
    tier,
    label: tier === "mid_pair" ? "Built-in review" : "Solo",
    reviewerLossPolicy: exec.reviewerLossPolicy,
    reviewerToolProfile: exec.reviewerToolProfile,
    hasCustomRoleOverrides: !!(exec.roles?.implementer || exec.roles?.reviewer),
  };
}

function buildOrgServices(registry: Map<string, Employee>): OrgServiceSummary[] {
  const services = new Map<string, OrgServiceSummary>();
  for (const employee of registry.values()) {
    if (!isActiveEmployee(employee) || !Array.isArray(employee.provides)) continue;
    for (const service of employee.provides) {
      const key = service.name.trim().toLowerCase();
      if (!key) continue;
      const candidate: OrgServiceSummary = {
        name: service.name.trim(),
        description: service.description.trim(),
        provider: {
          name: employee.name,
          displayName: employee.displayName,
          department: employee.department,
          rank: employee.rank,
        },
      };
      const current = services.get(key);
      if (!current) {
        services.set(key, candidate);
        continue;
      }
      const candidatePriority = SERVICE_RANK_PRIORITY[candidate.provider.rank];
      const currentPriority = SERVICE_RANK_PRIORITY[current.provider.rank];
      if (
        candidatePriority < currentPriority ||
        (candidatePriority === currentPriority && candidate.provider.name.localeCompare(current.provider.name) < 0)
      ) {
        services.set(key, candidate);
      }
    }
  }
  return [...services.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function findServiceProvider(registry: Map<string, Employee>, serviceName: string): { employee: Employee; service: { name: string; description: string } } | null {
  const key = serviceName.trim().toLowerCase();
  if (!key) return null;
  let best: { employee: Employee; service: { name: string; description: string } } | null = null;
  for (const employee of registry.values()) {
    if (!isActiveEmployee(employee) || !Array.isArray(employee.provides)) continue;
    for (const service of employee.provides) {
      if (service.name.trim().toLowerCase() !== key) continue;
      const candidate = { employee, service: { name: service.name.trim(), description: service.description.trim() } };
      if (!best) {
        best = candidate;
        continue;
      }
      const candidatePriority = SERVICE_RANK_PRIORITY[candidate.employee.rank];
      const bestPriority = SERVICE_RANK_PRIORITY[best.employee.rank];
      if (
        candidatePriority < bestPriority ||
        (candidatePriority === bestPriority && candidate.employee.name.localeCompare(best.employee.name) < 0)
      ) {
        best = candidate;
      }
    }
  }
  return best;
}

function buildCrossRequestBrief(input: {
  requester: Employee;
  service: { name: string; description: string };
  prompt: string;
}): string {
  return [
    "## Cross-service request",
    "",
    `**From**: ${input.requester.displayName} (${input.requester.department})`,
    `**Service**: ${input.service.name} - ${input.service.description}`,
    "",
    "### Request",
    input.prompt,
    "",
    "---",
    "Handle this as a priority request from a colleague.",
  ].join("\n");
}

function chainToRoot(name: string, hierarchy: import("../../../shared/types.js").OrgHierarchy): string[] {
  const out: string[] = [];
  let current: string | null | undefined = name;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    out.push(current);
    current = hierarchy.nodes[current]?.parentName ?? null;
  }
  return out;
}

function resolveCrossRequestRoute(
  fromEmployee: string,
  providerEmployee: string,
  hierarchy: import("../../../shared/types.js").OrgHierarchy,
): { route: string[]; managers: string[] } {
  const fromChain = chainToRoot(fromEmployee, hierarchy);
  const providerChain = chainToRoot(providerEmployee, hierarchy);
  const providerSet = new Set(providerChain);
  const common = fromChain.find((name) => providerSet.has(name));
  if (!common) {
    return { route: [fromEmployee, providerEmployee], managers: [] };
  }
  const up = fromChain.slice(0, fromChain.indexOf(common) + 1);
  const down = providerChain.slice(0, providerChain.indexOf(common)).reverse();
  const route = [...up, ...down];
  const managers = route.filter((name) => {
    if (name === fromEmployee || name === providerEmployee) return false;
    const rank = hierarchy.nodes[name]?.employee.rank;
    return rank === "manager" || rank === "executive";
  });
  return { route, managers };
}

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

async function reconcileDepartmentBoardView(department: string, context: ApiContext): Promise<void> {
  const { reconcileDepartmentOrphanedTickets } = await import("../../orphaned-ticket-reconciler.js");
  reconcileDepartmentOrphanedTickets(department, {
    engines: context.sessionManager?.getEngines?.() ?? new Map(),
    orgDir: ORG_DIR,
    getSession,
    listSessions,
    emit: context.emit,
    cause: "periodic",
  });
}

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

function hasChangedBoardTicket(
  incoming: Record<string, unknown>,
  current: import("../../board-service.js").BoardTicket | undefined,
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

function validateBoardAssigneesForDepartment(
  department: string,
  payload: unknown,
  currentTickets: import("../../board-service.js").BoardTicket[],
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
    const directoryDepartments = entries
      .filter((entry) => entry.isDirectory() && !RESERVED_ORG_DIRS.has(entry.name))
      .map((entry) => entry.name);
    const { resolveOrgHierarchy, withPortalExecutive } = await import("../../org-hierarchy.js");
    const scanWarnings: OrgWarning[] = [];
    const orgRegistry = withPortalExecutive(scanOrg(scanWarnings), context.getConfig().portal?.portalName);
    const departments = [
      ...new Set([
        ...directoryDepartments,
        ...[...orgRegistry.values()]
          .map((employee) => employee.department.trim())
          .filter(Boolean),
      ]),
    ];
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
        executionProfileSummary: computeExecutionProfileSummary(emp),
      };
    });
    json(res, {
      departments,
      boardDepartments: directoryDepartments,
      employees,
      hierarchy: {
        root: hierarchy.root,
        sorted: hierarchy.sorted,
        // Parse failures happen inside scanOrg, before the hierarchy is even
        // built, so they're surfaced here alongside (not inside)
        // resolveOrgHierarchy's own structural warnings (broken refs, cycles).
        warnings: [...scanWarnings, ...hierarchy.warnings],
      },
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/org/services") {
    json(res, { services: buildOrgServices(scanOrg()) });
    return true;
  }

  if (method === "POST" && pathname === "/api/org/cross-request") {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      badRequest(res, "body must be a JSON object");
      return true;
    }

    const fromEmployee = typeof body.fromEmployee === "string" ? body.fromEmployee.trim() : "";
    const serviceName = typeof body.service === "string" ? body.service.trim() : "";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const parentSessionId = typeof body.parentSessionId === "string" && body.parentSessionId.trim()
      ? body.parentSessionId.trim()
      : undefined;
    if (!fromEmployee) {
      badRequest(res, "fromEmployee must be a non-empty string");
      return true;
    }
    if (!serviceName) {
      badRequest(res, "service must be a non-empty string");
      return true;
    }
    if (!prompt) {
      badRequest(res, "prompt must be a non-empty string");
      return true;
    }
    if (parentSessionId && !getSession(parentSessionId)) {
      notFound(res);
      return true;
    }

    const registry = scanOrg();
    const requester = registry.get(fromEmployee);
    if (!requester || !isActiveEmployee(requester)) {
      notFound(res);
      return true;
    }
    const availableServices = buildOrgServices(registry);
    const provider = findServiceProvider(registry, serviceName);
    if (!provider) {
      json(res, {
        error: `No active provider is registered for service "${serviceName}"`,
        code: "no_service_provider",
        requestedService: serviceName,
        availableServices,
      }, 422);
      return true;
    }
    const engine = context.sessionManager.getEngine(provider.employee.engine);
    if (!engine) {
      serverError(res, `Provider engine "${provider.employee.engine}" is not available`);
      return true;
    }

    const { resolveOrgHierarchy, withPortalExecutive } = await import("../../org-hierarchy.js");
    const hierarchy = resolveOrgHierarchy(withPortalExecutive(registry, context.getConfig().portal?.portalName));
    const routed = resolveCrossRequestRoute(requester.name, provider.employee.name, hierarchy);
    const brief = buildCrossRequestBrief({ requester, service: provider.service, prompt });
    const now = Date.now();
    const session = createSession({
      engine: provider.employee.engine,
      source: "web",
      sourceRef: `cross-request:${now}:${provider.employee.name}`,
      connector: "web",
      sessionKey: `cross-request:${now}:${provider.employee.name}`,
      replyContext: { source: "web" },
      employee: provider.employee.name,
      parentSessionId,
      model: provider.employee.model,
      effortLevel: provider.employee.effortLevel,
      title: `Cross request: ${provider.service.name}`,
      prompt: brief,
      promptExcerpt: prompt,
      portalName: context.getConfig().portal?.portalName,
      transportMeta: {
        crossRequest: {
          fromEmployee: requester.name,
          service: provider.service.name,
          provider: provider.employee.name,
          route: routed.route,
          managers: routed.managers,
        },
      },
    });
    insertMessage(session.id, "user", brief);
    const { dispatchEmployeeSessionRun } = await import("../../mid-pair-orchestrator.js");
    void dispatchEmployeeSessionRun(session, brief, engine, context.getConfig(), context, provider.employee);
    context.emit("session:created", { sessionId: session.id, employee: provider.employee.name });
    if (session.parentSessionId) {
      const talkParent = getSession(session.parentSessionId);
      if (talkParent?.source === "talk") {
        context.emit("talk:focus", { cooId: session.id, label: provider.service.name, parentId: talkParent.id });
      }
    }
    json(res, {
      sessionId: session.id,
      provider: {
        name: provider.employee.name,
        displayName: provider.employee.displayName,
        department: provider.employee.department,
      },
      route: routed.route,
      managers: routed.managers,
      service: provider.service.name,
    }, 201);
    return true;
  }

  if (method === "GET" && params) {
    const orgRegistry = scanOrg();
    const { resolveOrgHierarchy, withPortalExecutive } = await import("../../org-hierarchy.js");
    const hierarchyRegistry = withPortalExecutive(orgRegistry, context.getConfig().portal?.portalName);
    const emp = orgRegistry.get(params.name) ?? hierarchyRegistry.get(params.name);
    if (!emp) {
      notFound(res);
      return true;
    }
    const hierarchy = resolveOrgHierarchy(hierarchyRegistry);
    const node = hierarchy.nodes[params.name];
    json(res, {
      ...emp,
      parentName: node?.parentName ?? null,
      directReports: node?.directReports ?? [],
      depth: node?.depth ?? 0,
      chain: node?.chain ?? [params.name],
      executionProfileSummary: computeExecutionProfileSummary(emp),
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
      const principal = (req as HttpRequest & { cuttlefishPrincipal?: GatewayPrincipal }).cuttlefishPrincipal;
      if (!isManagerNameAuthorizedForPrincipal(managerName, principal)) {
        json(res, { error: "Session-scoped callers may only act as their own bound manager identity" }, 403);
        return true;
      }
      const auth = authorizeManagerScope(registry, managerName, [params.name], context.getConfig().portal?.portalName);
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

    const result = validateEmployeeUpdate(context.getConfig(), current, employeeUpdate, registry.keys());
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
    try {
      const archived = archiveEmployeeBoardTickets(ORG_DIR, name);
      for (const department of archived.departments) {
        context.emit("board:updated", { department });
      }
    } catch (err) {
      context.reloadOrg?.();
      context.emit("org:updated", { employee: name, action: "deleted" });
      logger.error(`Employee ${name} was deleted but their Kanban cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      serverError(res, "Employee was deleted, but their Kanban ticket cleanup failed");
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
    const { applyOrgChange, recordHrDecisionMessage } = await import("../../hr-steward.js");
    const { getApproval, resolveApproval } = await import("../../approvals.js");
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
    const approvalSessionId = request.approvalId ? (getApproval(request.approvalId)?.sessionId ?? null) : null;
    if (request.approvalId) {
      try {
        const resolved = resolveApproval(request.approvalId, "approved", actor);
        context.emit("approval:resolved", {
          approvalId: resolved.id,
          sessionId: resolved.sessionId,
          state: "approved",
        });
      } catch {
        /* already resolved — proceed to apply idempotently */
      }
    }
    recordHrDecisionMessage(approvalSessionId, request, { action: "approved", actor }, context);
    updateChangeRequestStatus(params.id, "approved");
    const applied = await applyOrgChange(request, context);
    if (!applied.ok) {
      recordHrDecisionMessage(approvalSessionId, request, { action: "failed", actor, error: applied.error ?? null }, context);
      json(res, { status: "error", error: applied.error, changeRequest: getChangeRequest(params.id) }, 400);
      return true;
    }
    recordHrDecisionMessage(approvalSessionId, request, { action: "applied", actor }, context);
    json(res, { status: "ok", changeRequest: getChangeRequest(params.id) });
    return true;
  }

  params = matchRoute("/api/org/change-requests/:id/reject", pathname);
  if (method === "POST" && params) {
    const { getChangeRequest, updateChangeRequestStatus } = await import("../../org-changes.js");
    const { recordHrDecisionMessage } = await import("../../hr-steward.js");
    const { getApproval, resolveApproval } = await import("../../approvals.js");
    const request = getChangeRequest(params.id);
    if (!request) {
      notFound(res);
      return true;
    }
    if (!["pending_approval", "approved"].includes(request.status)) {
      json(res, { error: `change is ${request.status}, not awaiting approval` }, 409);
      return true;
    }
    const actor = resolveUserHeader(req.headers, context.getConfig().gateway.userHeader);
    const approvalSessionId = request.approvalId ? (getApproval(request.approvalId)?.sessionId ?? null) : null;
    if (request.approvalId) {
      try {
        const resolved = resolveApproval(request.approvalId, "rejected", actor);
        context.emit("approval:resolved", {
          approvalId: resolved.id,
          sessionId: resolved.sessionId,
          state: "rejected",
        });
      } catch {
        /* already resolved */
      }
    }
    const updated = updateChangeRequestStatus(params.id, "rejected");
    recordHrDecisionMessage(approvalSessionId, request, { action: "rejected", actor }, context);
    context.emit("org-change:updated", { id: params.id, status: "rejected" });
    json(res, { status: "ok", changeRequest: updated });
    return true;
  }

  params = matchRoute("/api/org/change-requests/:id/apply", pathname);
  if (method === "POST" && params) {
    const { getChangeRequest, updateChangeRequestStatus } = await import("../../org-changes.js");
    const { applyOrgChange, recordHrDecisionMessage } = await import("../../hr-steward.js");
    const { getApproval, resolveApproval } = await import("../../approvals.js");
    const request = getChangeRequest(params.id);
    if (!request) {
      notFound(res);
      return true;
    }
    if (!["pending_approval", "approved"].includes(request.status)) {
      json(res, { error: `Change request is '${request.status}' and cannot be applied` }, 409);
      return true;
    }
    const actor = resolveUserHeader(req.headers, context.getConfig().gateway.userHeader);
    const approvalSessionId = request.approvalId ? (getApproval(request.approvalId)?.sessionId ?? null) : null;
    if (request.approvalId) {
      try {
        const resolved = resolveApproval(request.approvalId, "approved", actor);
        context.emit("approval:resolved", {
          approvalId: resolved.id,
          sessionId: resolved.sessionId,
          state: "approved",
        });
      } catch {
        /* already resolved — continue idempotently */
      }
    }
    recordHrDecisionMessage(approvalSessionId, request, { action: "approved", actor }, context);
    if (request.status === "pending_approval") {
      updateChangeRequestStatus(params.id, "approved");
    }
    const applied = await applyOrgChange(request, context);
    if (!applied.ok) {
      recordHrDecisionMessage(approvalSessionId, request, { action: "failed", actor, error: applied.error ?? null }, context);
      json(res, { status: "error", error: applied.error, changeRequest: getChangeRequest(params.id) }, 400);
      return true;
    }
    recordHrDecisionMessage(approvalSessionId, request, { action: "applied", actor }, context);
    json(res, { status: "ok", changeRequest: getChangeRequest(params.id) });
    return true;
  }

  params = matchRoute("/api/org/departments/:name", pathname);
  if (method === "PATCH" && params) {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as Record<string, unknown>;
    const nextName = typeof body.name === "string" ? body.name.trim() : "";
    const { renameDepartment } = await import("../../department-rename.js");
    const result = renameDepartment(params.name, nextName);
    if (!result.ok) {
      json(res, { error: result.error }, result.status);
      return true;
    }
    context.reloadOrg?.();
    context.emit("org:updated", {
      action: "department-renamed",
      previousDepartment: result.previousDepartment,
      department: result.department,
      employees: result.employees,
    });
    if (result.movedDirectory) {
      context.emit("board:updated", { department: result.department, previousDepartment: result.previousDepartment });
    }
    json(res, { status: "ok", ...result });
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
      // The department exists but has no board yet — that's an empty board, not a
      // missing resource. Returning 200 with an empty state (instead of 404) keeps
      // the dashboard's per-department board fetches quiet: a brand-new org has no
      // board.json until the first ticket is written, and a 404 there only produces
      // console-error noise on every poll that could mask a real failure.
      json(res, defaultBoardState());
      return true;
    }
    try {
      await reconcileDepartmentBoardView(params.name, context);
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
      await reconcileDepartmentBoardView(routeParams.name, context);
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
    if (!shouldExposeSessionForTicket(ticket, session)) {
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
    const body = req.method === "POST" ? await readJsonBody(req, res).then((r) => (r.ok ? r.body : {})) : {};
    const routeToManager = (body as Record<string, unknown>).routeToManager === true;
    const result = await dispatchTicket(
      params.name,
      params.id,
      { source: "manual", routeToManager },
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
      if (result.reason === "employee-not-active") {
        json(res, { reason: result.reason, error: "Assigned agent is not active (draft, disabled, or retired)." }, 409);
        return true;
      }
      if (result.reason === "already-running") {
        json(res, { reason: result.reason, error: "Ticket already has a running session." }, 409);
        return true;
      }
      if (result.reason === "manual-only") {
        json(res, { reason: result.reason, error: "This ticket is marked manual only and cannot be auto-dispatched." }, 409);
        return true;
      }
      if (result.reason === "invalid-resource") {
        json(res, { reason: result.reason, error: "Ticket resource path or URL is invalid for this gateway." }, 400);
        return true;
      }
      if (result.reason === "resource-blocked") {
        json(res, { reason: result.reason, error: "Ticket resource was blocked by untrusted-content screening." }, 409);
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
      const currentTickets = readBoardState(ORG_DIR, params.name)?.tickets ?? [];
      const assigneeError = validateBoardAssigneesForDepartment(params.name, parsed.body, currentTickets);
      if (assigneeError) {
        badRequest(res, assigneeError);
        return true;
      }
      const activeSessionIds = new Set(listSessions().map((session) => session.id));
      const { rejected } = writeMergedBoardPartial(ORG_DIR, params.name, parsed.body, { activeSessionIds });
      if (rejected.length > 0) {
        logger.warn(
          `PUT /api/org/departments/${params.name}/board: accepted valid tickets, rejected ${rejected.length} invalid: ` +
          rejected.map((r) => `[${r.index}] ${r.error}`).join("; "),
        );
      }
      context.emit("board:updated", { department: params.name });
      json(res, rejected.length > 0 ? { status: "partial", rejectedTickets: rejected } : { status: "ok" });
      return true;
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
    return true;
  }

  return false;
}
