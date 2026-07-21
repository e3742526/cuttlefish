import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import type { ApprovalDecision } from "../../../shared/types.js";
import { applyCheckpointDecision, CheckpointDecisionConflictError, createCheckpoint, getCheckpoint, listCheckpoints, parseCheckpointPayload } from "../../checkpoints.js";
import type { ApiContext } from "../context.js";
import { readJsonBody } from "../../http-helpers.js";
import { matchRoute } from "../match-route.js";
import { badRequest, json, notFound } from "../responses.js";
import { serializeSession } from "../serialize-session.js";
import { resolveUserHeader } from "../../connector-reply.js";
import { principalBodySessionForbidden, type GatewayPrincipal } from "../../scoped-token.js";
import { delegatedApprovalActor, isAuthorizedHumanDelegatePrincipal } from "../../manager-auth.js";

function parseDecision(value: unknown): ApprovalDecision | null {
  return value === "approved" || value === "rejected" || value === "deferred" || value === "revised"
    ? value
    : null;
}

export async function handleCheckpointRoutes(
  method: string,
  pathname: string,
  req: HttpRequest,
  url: URL,
  res: ServerResponse,
  context: ApiContext,
): Promise<boolean> {
  if (method === "GET" && pathname === "/api/checkpoints") {
    const state = (url.searchParams.get("state") ?? "pending") as import("../../../shared/types.js").Approval["state"] | "all";
    const sessionId = url.searchParams.get("sessionId") ?? undefined;
    json(res, listCheckpoints({ state, sessionId }));
    return true;
  }

  if (method === "POST" && pathname === "/api/checkpoints") {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
      badRequest(res, "Invalid JSON body");
      return true;
    }
    const body = parsed.body as Record<string, unknown>;
    const principal = (req as HttpRequest & { cuttlefishPrincipal?: GatewayPrincipal }).cuttlefishPrincipal;
    const requestedSessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : "";
    if (principalBodySessionForbidden(principal, requestedSessionId)) {
      json(res, { error: "A session-scoped token can create a checkpoint only for its own session" }, 403);
      return true;
    }
    const sessionId = principal?.kind === "session" ? principal.sessionId : requestedSessionId;
    if (!sessionId) {
      badRequest(res, "sessionId is required");
      return true;
    }
    try {
      const created = createCheckpoint({
        sessionId,
        payload: parseCheckpointPayload(body),
        pauseSession: body.pauseSession !== false,
      }, context);
      json(res, {
        checkpoint: created.checkpoint,
        ...(created.session ? { session: serializeSession(created.session, context) } : {}),
      }, 201);
    } catch (err) {
      if (err instanceof Error && /required|not found/.test(err.message)) {
        if (err.message.includes("not found")) notFound(res);
        else badRequest(res, err.message);
        return true;
      }
      throw err;
    }
    return true;
  }

  let params = matchRoute("/api/checkpoints/:id", pathname);
  if (method === "GET" && params) {
    const checkpoint = getCheckpoint(params.id);
    if (!checkpoint) {
      notFound(res);
      return true;
    }
    json(res, checkpoint);
    return true;
  }

  params = matchRoute("/api/checkpoints/:id/decision", pathname);
  if (method === "POST" && params) {
    const checkpoint = getCheckpoint(params.id);
    if (!checkpoint) {
      notFound(res);
      return true;
    }
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
      badRequest(res, "Invalid JSON body");
      return true;
    }
    const body = parsed.body as Record<string, unknown>;
    const decision = parseDecision(body.decision);
    if (!decision) {
      badRequest(res, "decision must be approved, rejected, deferred, or revised");
      return true;
    }
    const principal = (req as HttpRequest & { cuttlefishPrincipal?: GatewayPrincipal }).cuttlefishPrincipal;
    const requiredScopes = decision === "approved" ? ["approve", "decide"] as const : ["decide"] as const;
    if (principal?.kind === "session" && !isAuthorizedHumanDelegatePrincipal(principal, [...requiredScopes])) {
      json(res, { error: "This session does not have explicit delegated authority for that decision" }, 403);
      return true;
    }
    const actor = principal?.kind === "session"
      ? delegatedApprovalActor(principal)
      : resolveUserHeader(req.headers, context.getConfig().gateway.userHeader) ?? null;
    try {
      const resolved = await applyCheckpointDecision(
        checkpoint.id,
        {
          decision,
          actor,
          notes: typeof body.notes === "string" ? body.notes : null,
          resultingAction: typeof body.resultingAction === "string" ? body.resultingAction : null,
          resumePrompt: typeof body.resumePrompt === "string" ? body.resumePrompt : null,
        },
        context,
      );
      json(res, {
        checkpoint: resolved.checkpoint,
        ...(resolved.session ? { session: serializeSession(resolved.session, context) } : {}),
        ...(resolved.idempotent ? { idempotent: true } : {}),
      });
    } catch (err) {
      if (err instanceof CheckpointDecisionConflictError) {
        json(res, {
          error: err.message,
          code: "checkpoint_decision_conflict",
          requestedDecision: err.requestedDecision,
          currentDecision: err.checkpoint.state,
          checkpoint: err.checkpoint,
        }, 409);
        return true;
      }
      if (err instanceof Error) {
        if (err.message.includes("resumePrompt is required") || err.message.includes("not available")) {
          json(res, { error: err.message }, 422);
          return true;
        }
        if (err.message.includes("not found")) {
          notFound(res);
          return true;
        }
      }
      throw err;
    }
    return true;
  }

  return false;
}
