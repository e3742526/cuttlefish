import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import type {
  CollaborationSendRequest,
  OperatorDelegationScope,
  ProjectDeleteRequest,
  ProjectTreeNode,
} from "@cuttlefish/contracts";
import { OPERATOR_DELEGATION_SCOPES } from "../../../sessions/operator-delegation.js";
import {
  getSession,
  listLatestAgentMessageTimestamps,
  listSessions,
} from "../../../sessions/registry.js";
import { scanOrg } from "../../org.js";
import { resolveOrgHierarchy, withPortalExecutive } from "../../org-hierarchy.js";
import { resolveUserHeader } from "../../connector-reply.js";
import type { GatewayPrincipal } from "../../auth.js";
import { readJsonBody } from "../../http-helpers.js";
import { buildProjectGraph, type ProjectGraphEntry, type ProjectGraphNode } from "../../../collaboration/project-graph.js";
import { managementFeed, projectFeed, summarizeProject } from "../../../collaboration/feed-projection.js";
import {
  COO_RECIPIENT_ID,
  latestDirectManagementSession,
  latestWritableSessionForEmployee,
  managementRoster,
  resolveManagementRecipients,
  resolveTeamRecipients,
} from "../../../collaboration/recipient-resolution.js";
import { dispatchCollaborationMessage } from "../../../collaboration/dispatch.js";
import { deleteProjectTree } from "../../../collaboration/project-deletion.js";
import type { ApiContext } from "../context.js";
import { matchRoute } from "../match-route.js";
import { buildSessionJobStateMap, serializeSession } from "../serialize-session.js";
import { json } from "../responses.js";

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 200;

function pageLimit(url: URL): number {
  return Math.min(MAX_PAGE_LIMIT, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "", 10) || DEFAULT_PAGE_LIMIT));
}

function principalOf(req: HttpRequest): GatewayPrincipal | undefined {
  return (req as HttpRequest & { cuttlefishPrincipal?: GatewayPrincipal }).cuttlefishPrincipal;
}

function parseScopes(value: unknown): OperatorDelegationScope[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const allowed = new Set<string>(OPERATOR_DELEGATION_SCOPES);
  const scopes = [...new Set(value)];
  return scopes.every((scope): scope is OperatorDelegationScope => typeof scope === "string" && allowed.has(scope))
    ? scopes
    : null;
}

function apiState(context: ApiContext) {
  const sessions = listSessions();
  const graph = buildProjectGraph(sessions);
  const jobStates = buildSessionJobStateMap(sessions, context);
  const latestMessages = listLatestAgentMessageTimestamps();
  const publicSessions = sessions.map((session) => serializeSession(
    session,
    context,
    jobStates.get(session.id),
    latestMessages.get(session.id),
  ));
  const publicGraph = buildProjectGraph(publicSessions);
  const config = context.getConfig();
  const employees = withPortalExecutive(scanOrg(), config.portal?.portalName);
  const hierarchy = resolveOrgHierarchy(employees);
  const roster = managementRoster(employees, config.portal?.portalName ?? "Cuttlefish");
  return { sessions, graph, publicGraph, employees, hierarchy, roster };
}

function publicTree(nodes: ProjectGraphNode<ReturnType<typeof serializeSession>>[]): ProjectTreeNode[] {
  return nodes.map((node) => ({
    session: node.session,
    depth: node.depth,
    children: publicTree(node.children),
  }));
}

function projectForPrincipal(
  project: ProjectGraphEntry<{ id: string }>,
  principal: GatewayPrincipal | undefined,
): boolean {
  return principal?.kind !== "session" || project.sessions.some((session) => session.id === principal.sessionId);
}

function projectCursor(project: ProjectGraphEntry<{ id: string; lastActivity?: string }>): string {
  return Buffer.from(JSON.stringify({ lastActivity: project.sessions[0]?.lastActivity ?? "", id: project.rootSessionId }), "utf8").toString("base64url");
}

function decodeProjectCursor(cursor: string | null): { lastActivity: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return typeof parsed.lastActivity === "string" && typeof parsed.id === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export async function handleCollaborationRoutes(
  method: string,
  pathname: string,
  req: HttpRequest,
  url: URL,
  res: ServerResponse,
  context: ApiContext,
): Promise<boolean> {
  if (!pathname.startsWith("/api/projects") && !pathname.startsWith("/api/management")) return false;
  const principal = principalOf(req);
  const state = apiState(context);

  if (method === "GET" && pathname === "/api/projects") {
    const query = url.searchParams.get("q")?.trim().toLowerCase();
    const decoded = decodeProjectCursor(url.searchParams.get("cursor"));
    let projects = state.publicGraph.projects.filter((project) => projectForPrincipal(project, principal));
    if (query) {
      projects = projects.filter((project) => {
        const summary = summarizeProject(project);
        return [summary.title, summary.rootSessionId, ...summary.participantIds].join(" ").toLowerCase().includes(query);
      });
    }
    if (decoded) {
      projects = projects.filter((project) => {
        const activity = project.sessions[0]?.lastActivity ?? "";
        return activity < decoded.lastActivity || (activity === decoded.lastActivity && project.rootSessionId > decoded.id);
      });
    }
    const limit = pageLimit(url);
    const page = projects.slice(0, limit);
    json(res, {
      projects: page.map(summarizeProject),
      nextCursor: projects.length > page.length && page.at(-1) ? projectCursor(page.at(-1)!) : null,
    });
    return true;
  }

  const treeParams = matchRoute("/api/projects/:rootSessionId/tree", pathname);
  if (method === "GET" && treeParams) {
    const project = state.publicGraph.projects.find((entry) => entry.rootSessionId === treeParams.rootSessionId);
    if (!project || !projectForPrincipal(project, principal)) {
      json(res, { error: "Project not found" }, 404);
      return true;
    }
    json(res, { project: summarizeProject(project), tree: publicTree(project.tree) });
    return true;
  }

  const feedParams = matchRoute("/api/projects/:rootSessionId/feed", pathname);
  if (method === "GET" && feedParams) {
    const project = state.graph.projects.find((entry) => entry.rootSessionId === feedParams.rootSessionId);
    if (!project || !projectForPrincipal(project, principal)) {
      json(res, { error: "Project not found" }, 404);
      return true;
    }
    const sessionId = url.searchParams.get("sessionId");
    if (sessionId && !project.sessions.some((session) => session.id === sessionId)) {
      json(res, { error: "Session does not belong to this project" }, 400);
      return true;
    }
    json(res, projectFeed({
      project,
      employees: state.employees,
      cursor: url.searchParams.get("cursor"),
      limit: pageLimit(url),
      sessionId,
    }));
    return true;
  }

  const messageParams = matchRoute("/api/projects/:rootSessionId/messages", pathname);
  if (method === "POST" && messageParams) {
    if (principal?.kind === "session") {
      json(res, { error: "Project messages require a direct human operator", code: "operator_only" }, 403);
      return true;
    }
    const project = state.graph.projects.find((entry) => entry.rootSessionId === messageParams.rootSessionId);
    if (!project) {
      json(res, { error: "Project not found" }, 404);
      return true;
    }
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as CollaborationSendRequest;
    const resolved = resolveTeamRecipients({
      requestedIds: body.recipientIds,
      recipientMode: body.recipientMode,
      confirmAllRecipients: body.confirmAllRecipients,
      projectSessions: project.sessions,
      employees: state.employees,
    });
    if (resolved.error) {
      json(res, { error: resolved.error }, 400);
      return true;
    }
    const targets = resolved.recipientIds.map((recipientId) => ({
      recipientId,
      employee: state.employees.get(recipientId),
      session: latestWritableSessionForEmployee(project.sessions, recipientId),
    }));
    const result = await dispatchCollaborationMessage({
      lane: "team",
      message: body.message,
      targets,
      projectRootSessionId: project.rootSessionId,
      context,
      principal,
      userId: resolveUserHeader(req.headers, context.getConfig().gateway.userHeader),
    });
    json(res, result.ok ? result.response : { error: result.error, ...(result.code ? { code: result.code } : {}) }, result.statusCode);
    return true;
  }

  const deleteParams = matchRoute("/api/projects/:rootSessionId", pathname);
  if (method === "DELETE" && deleteParams) {
    if (principal?.kind === "session") {
      json(res, { error: "Project deletion requires a direct human operator", code: "operator_only" }, 403);
      return true;
    }
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as ProjectDeleteRequest;
    if (typeof body.expectedTitle !== "string" || !Number.isInteger(body.expectedSessionCount) || typeof body.confirmation !== "string") {
      json(res, { error: "expectedTitle, expectedSessionCount, and confirmation are required" }, 400);
      return true;
    }
    const result = deleteProjectTree({ rootSessionId: deleteParams.rootSessionId, ...body, context });
    json(res, result.ok
      ? { status: "deleted", count: result.deletedIds.length, deletedIds: result.deletedIds, ...(result.warning ? { warning: result.warning } : {}) }
      : { error: result.error, code: result.code, ...(result.actualCount !== undefined ? { actualCount: result.actualCount } : {}), ...(result.activeSessionIds ? { activeSessionIds: result.activeSessionIds } : {}) },
    result.ok ? 200 : result.statusCode);
    return true;
  }

  if (principal?.kind === "session") {
    json(res, { error: "Management collaboration requires a direct human operator", code: "operator_only" }, 403);
    return true;
  }

  if (method === "GET" && pathname === "/api/management/feed") {
    const projectRootSessionId = url.searchParams.get("projectRootSessionId");
    json(res, managementFeed({
      sessions: state.sessions,
      managerIds: new Set(state.roster.filter((recipient) => recipient.active).map((recipient) => recipient.id)),
      employees: state.employees,
      projectBySessionId: state.graph.projectBySessionId,
      cursor: url.searchParams.get("cursor"),
      limit: pageLimit(url),
      projectRootSessionId,
    }));
    return true;
  }

  if (method === "GET" && pathname === "/api/management/recipients") {
    const projectRootSessionId = url.searchParams.get("projectRootSessionId");
    const project = projectRootSessionId
      ? state.graph.projects.find((entry) => entry.rootSessionId === projectRootSessionId)
      : undefined;
    const resolution = resolveManagementRecipients({
      projectParticipantIds: project?.sessions.flatMap((session) => session.employee ? [session.employee] : []),
      roster: state.roster,
      hierarchy: state.hierarchy,
    });
    json(res, { recipients: resolution.recipients, defaultRecipientId: resolution.defaultRecipientId, defaultReason: resolution.defaultReason });
    return true;
  }

  if (method === "POST" && pathname === "/api/management/messages") {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as CollaborationSendRequest;
    const project = body.projectRootSessionId
      ? state.graph.projects.find((entry) => entry.rootSessionId === body.projectRootSessionId)
      : undefined;
    if (body.projectRootSessionId && !project) {
      json(res, { error: "Project not found" }, 404);
      return true;
    }
    const resolution = resolveManagementRecipients({
      requestedIds: body.recipientIds,
      recipientMode: body.recipientMode,
      confirmAllRecipients: body.confirmAllRecipients,
      projectParticipantIds: project?.sessions.flatMap((session) => session.employee ? [session.employee] : []),
      roster: state.roster,
      hierarchy: state.hierarchy,
    });
    if (resolution.error) {
      json(res, { error: resolution.error, recipients: resolution.recipients }, 400);
      return true;
    }
    const scopes = parseScopes(body.operatorDelegationScopes);
    if (scopes === null) {
      json(res, { error: "operatorDelegationScopes contains an invalid scope" }, 400);
      return true;
    }
    if (scopes.length > 0) {
      const explicitSingle = body.recipientMode !== "all" && body.recipientIds?.length === 1 && resolution.recipientIds.length === 1;
      const target = resolution.recipientIds[0];
      if (!explicitSingle || (target !== COO_RECIPIENT_ID && target !== "program-manager")) {
        json(res, { error: "Authority requires one explicitly selected Cuttlefish COO or Program Manager recipient", code: "operator_delegation_target_forbidden" }, 403);
        return true;
      }
    }
    const targets = resolution.recipientIds.map((recipientId) => ({
      recipientId,
      employee: recipientId === COO_RECIPIENT_ID ? undefined : state.employees.get(recipientId),
      session: latestDirectManagementSession(state.sessions, recipientId),
    }));
    const result = await dispatchCollaborationMessage({
      lane: "management",
      message: body.message,
      targets,
      projectRootSessionId: project?.rootSessionId,
      context,
      principal,
      userId: resolveUserHeader(req.headers, context.getConfig().gateway.userHeader),
      operatorDelegationScopes: scopes.length > 0 ? scopes : undefined,
    });
    json(res, result.ok ? result.response : { error: result.error, ...(result.code ? { code: result.code } : {}) }, result.statusCode);
    return true;
  }

  return false;
}
