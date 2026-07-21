import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import type { JsonObject, ListableApprovalType, Approval } from "../../../shared/types.js";
import { getApproval, listApprovals, resolveApproval } from "../../approvals.js";
import { getSession, insertMessage, patchSessionTransportMeta, updateSession, deletePartialMessages } from "../../../sessions/registry.js";
import { CUTTLEFISH_HOME } from "../../../shared/paths.js";
import type { ApiContext } from "../context.js";
import { matchRoute } from "../match-route.js";
import { badRequest, json, notFound } from "../responses.js";
import { serializeSession } from "../serialize-session.js";
import { dispatchWebSessionRun } from "../session-dispatch.js";
import { resolveUserHeader } from "../../connector-reply.js";
import type { GatewayPrincipal } from "../../auth.js";
import { delegatedApprovalActor, isAuthorizedHumanDelegatePrincipal } from "../../manager-auth.js";

function approvalActor(req: HttpRequest, context: ApiContext): string | null {
  const principal = (req as HttpRequest & { cuttlefishPrincipal?: GatewayPrincipal }).cuttlefishPrincipal;
  return principal?.kind === "session"
    ? delegatedApprovalActor(principal)
    : resolveUserHeader(req.headers, context.getConfig().gateway.userHeader) ?? null;
}

export async function handleApprovalRoutes(
  method: string,
  pathname: string,
  req: HttpRequest,
  url: URL,
  res: ServerResponse,
  context: ApiContext,
): Promise<boolean> {
  if (method === "GET" && pathname === "/api/approvals") {
    const stateParam = (url.searchParams.get("state") ?? "pending") as
      | "pending" | "approved" | "rejected" | "all";
    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    // checkpoint approvals are served via /api/checkpoints/:id/decision
    json(res, listApprovals({ state: stateParam, sessionId }).filter((approval): approval is Approval & { type: ListableApprovalType } => approval.type !== "checkpoint"));
    return true;
  }

  let approvalParams = matchRoute("/api/approvals/:id/approve", pathname);
  if (method === "POST" && approvalParams) {
    const approval = getApproval(approvalParams.id);
    if (!approval) {
      notFound(res);
      return true;
    }
    const principal = (req as HttpRequest & { cuttlefishPrincipal?: GatewayPrincipal }).cuttlefishPrincipal;
    if (principal?.kind === "session" && !isAuthorizedHumanDelegatePrincipal(principal, ["approve", "decide"])) {
      json(res, { error: "This session does not have explicit delegated approval authority" }, 403);
      return true;
    }
    const config = context.getConfig();
    const actor = approvalActor(req, context);

    if (approval.type === "checkpoint") {
      json(res, { error: "checkpoint approvals must be resolved via POST /api/checkpoints/:id/decision" }, 409);
      return true;
    }

    if (approval.type === "org-change") {
      // Domain choreography lives in hr-steward.ts's resolveOrgChangeApproval
      // — the ONE approve funnel shared with the autonomous dual-model path —
      // so this route only validates, delegates, and translates the outcome.
      const { resolveOrgChangeApproval } = await import("../../hr-steward.js");
      const outcome = await resolveOrgChangeApproval(approval, { kind: "human", actor }, context);
      switch (outcome.status) {
        case "missing_change_request_id":
          badRequest(res, "approval payload missing changeRequestId");
          return true;
        case "change_not_found":
          notFound(res);
          return true;
        case "conflict":
          json(res, { error: outcome.message }, 409);
          return true;
        case "already_applied":
          json(res, { approval: outcome.approval, changeRequest: outcome.request, status: "ok" });
          return true;
        case "apply_failed":
          json(res, { status: "error", error: outcome.error, approval: outcome.approval, changeRequest: outcome.request }, 400);
          return true;
        case "applied":
          json(res, { approval: outcome.approval, changeRequest: outcome.request, status: "ok" });
          return true;
      }
      // Unreachable — every outcome status returns above; guard so a future
      // outcome variant can never fall through into the non-org-change branches.
      return true;
    }

    if (approval.type !== "fallback") {
      if (approval.state !== "pending") {
        json(res, { error: `approval already ${approval.state}` }, 409);
        return true;
      }
      const resolved = resolveApproval(approval.id, "approved", actor);
      context.emit("approval:resolved", { approvalId: resolved.id, sessionId: resolved.sessionId, state: "approved" });
      json(res, { approval: resolved });
      return true;
    }

    const session = getSession(approval.sessionId);
    if (!session) {
      if (approval.state !== "pending") {
        json(res, { error: `approval already ${approval.state}` }, 409);
        return true;
      }
      notFound(res);
      return true;
    }
    const to = (approval.payload.to ?? {}) as { engine?: string; model?: string; effortLevel?: string | null };
    if (!to.engine) {
      badRequest(res, "approval payload missing target engine");
      return true;
    }
    const nextEngine = context.sessionManager.getEngine(to.engine);
    if (!nextEngine) {
      json(res, { error: `fallback target engine '${to.engine}' is not available` }, 422);
      return true;
    }

    const handoffPath = typeof approval.payload.handoffPath === "string" ? approval.payload.handoffPath : null;
    let handoffMd = "";
    if (handoffPath) {
      try { handoffMd = fs.readFileSync(path.join(CUTTLEFISH_HOME, handoffPath), "utf-8"); } catch { /* fall back to minimal prompt */ }
    }

    const prevMeta = (session.transportMeta ?? {}) as Record<string, unknown>;
    const prevFallback = (prevMeta.modelFallback ?? {}) as Record<string, unknown>;
    const fallbackStatus = typeof prevFallback.status === "string" ? prevFallback.status : null;
    const fallbackApprovalId = typeof prevFallback.approvalId === "string" ? prevFallback.approvalId : null;
    const approvedAt = typeof prevFallback.approvedAt === "string" ? prevFallback.approvedAt : new Date().toISOString();
    const canResumeApprovedFallback = approval.state === "approved" &&
      fallbackApprovalId === approval.id &&
      (
        fallbackStatus === "approval_resume_pending" ||
        fallbackStatus === "running_on_fallback_pending_dispatch" ||
        fallbackStatus === "running_on_fallback"
      );
    if (approval.state !== "pending" && !canResumeApprovedFallback) {
      json(res, { error: `approval already ${approval.state}` }, 409);
      return true;
    }

    const nextFallbackMeta = {
      ...prevFallback,
      approvalId: approval.id,
      approvedAt,
    } as JsonObject;

    if (approval.state === "pending" && fallbackStatus !== "approval_resume_pending") {
      patchSessionTransportMeta(session.id, {
        modelFallback: { ...nextFallbackMeta, status: "approval_resume_pending" } as JsonObject,
      });
    }

    const resolved = approval.state === "approved"
      ? approval
      : resolveApproval(approval.id, "approved", actor);

    if (canResumeApprovedFallback && fallbackStatus === "running_on_fallback") {
      json(res, { approval: resolved, session: serializeSession(session, context) });
      return true;
    }

    let rolled = updateSession(session.id, {
      engine: to.engine,
      model: to.model ?? session.model ?? undefined,
      effortLevel: (to.effortLevel ?? session.effortLevel) ?? undefined,
      engineSessionId: null,
      status: "running",
      lastActivity: new Date().toISOString(),
      lastError: null,
    }) ?? session;
    patchSessionTransportMeta(session.id, {
      modelFallback: { ...nextFallbackMeta, status: "running_on_fallback_pending_dispatch" } as JsonObject,
    });
    rolled = getSession(session.id) ?? rolled;
    deletePartialMessages(session.id);
    if (fallbackStatus !== "running_on_fallback_pending_dispatch" && fallbackStatus !== "running_on_fallback") {
      insertMessage(session.id, "notification", `✅ Fallback approved → ${to.engine}/${to.model ?? "default"}. Resuming on fallback.`);
    }
    context.emit("approval:resolved", { approvalId: resolved.id, sessionId: session.id, state: "approved" });
    context.emit("session:updated", { sessionId: session.id });

    const fallbackPrompt = handoffMd
      ? "You are taking over this task after a model fallback. Read the handoff packet below, preserve prior decisions and technical truth, then continue the original task.\n\n" + handoffMd
      : "Continue this conversation and respond to the last USER message after an operator-approved model fallback.";
    dispatchWebSessionRun(rolled, fallbackPrompt, nextEngine, config, context);
    patchSessionTransportMeta(session.id, {
      modelFallback: { ...nextFallbackMeta, status: "running_on_fallback" } as JsonObject,
    });
    rolled = getSession(session.id) ?? rolled;
    json(res, { approval: resolved, session: serializeSession(rolled, context) });
    return true;
  }

  approvalParams = matchRoute("/api/approvals/:id/reject", pathname);
  if (method === "POST" && approvalParams) {
    const approval = getApproval(approvalParams.id);
    if (!approval) {
      notFound(res);
      return true;
    }
    const principal = (req as HttpRequest & { cuttlefishPrincipal?: GatewayPrincipal }).cuttlefishPrincipal;
    if (principal?.kind === "session" && !isAuthorizedHumanDelegatePrincipal(principal, ["decide"])) {
      json(res, { error: "This session does not have explicit delegated decision authority" }, 403);
      return true;
    }
    if (approval.type === "checkpoint") {
      json(res, { error: "checkpoint approvals must be resolved via POST /api/checkpoints/:id/decision" }, 409);
      return true;
    }
    if (approval.type === "org-change") {
      const changeRequestId =
        typeof approval.payload.changeRequestId === "string" && approval.payload.changeRequestId.trim()
          ? approval.payload.changeRequestId.trim()
          : null;
      if (!changeRequestId) {
        badRequest(res, "approval payload missing changeRequestId");
        return true;
      }
      const { getChangeRequest, updateChangeRequestStatus } = await import("../../org-changes.js");
      const { recordHrDecisionMessage } = await import("../../hr-steward.js");
      const request = getChangeRequest(changeRequestId);
      if (!request) {
        notFound(res);
        return true;
      }
      if (approval.state !== "pending" && approval.state !== "rejected") {
        json(res, { error: `approval already ${approval.state}` }, 409);
        return true;
      }
      const config = context.getConfig();
      const actor = approvalActor(req, context);
      const resolved = approval.state === "rejected"
        ? approval
        : resolveApproval(approval.id, "rejected", actor);
      const updated = request.status === "rejected"
        ? request
        : updateChangeRequestStatus(changeRequestId, "rejected");
      recordHrDecisionMessage(resolved.sessionId, request, { action: "rejected", actor }, context);
      context.emit("approval:resolved", { approvalId: resolved.id, sessionId: resolved.sessionId, state: "rejected" });
      context.emit("org-change:updated", { id: changeRequestId, status: "rejected" });
      json(res, { approval: resolved, changeRequest: updated, status: "ok" });
      return true;
    }

    if (approval.state !== "pending") {
      json(res, { error: `approval already ${approval.state}` }, 409);
      return true;
    }
    const config = context.getConfig();
    const actor = approvalActor(req, context);
    const resolved = resolveApproval(approval.id, "rejected", actor);
    const session = getSession(approval.sessionId);
    if (session) {
      const prevMeta = (session.transportMeta ?? {}) as Record<string, unknown>;
      const prevFallback = (prevMeta.modelFallback ?? {}) as Record<string, unknown>;
      updateSession(session.id, {
        status: "error",
        lastError: "Model fallback rejected by operator",
        lastActivity: new Date().toISOString(),
      });
      patchSessionTransportMeta(session.id, {
        modelFallback: { ...prevFallback, status: "rejected", rejectedAt: new Date().toISOString() } as JsonObject,
      });
      insertMessage(session.id, "notification", "🚫 Model fallback rejected by operator. Session stopped — surfaced, not silently stalled.");
      context.emit("session:updated", { sessionId: session.id });
    }
    context.emit("approval:resolved", { approvalId: resolved.id, sessionId: approval.sessionId, state: "rejected" });
    json(res, { approval: resolved });
    return true;
  }

  return false;
}
