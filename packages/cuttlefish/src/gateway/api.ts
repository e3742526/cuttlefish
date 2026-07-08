import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { getSession, updateSession } from "../sessions/registry.js";
import { logger } from "../shared/logger.js";
import { handleTalkApi } from "../talk/routes.js";
import { handleFilesRequest } from "./files.js";
import { readJsonBody } from "./http-helpers.js";
import { handleHookPost, isLoopback } from "./hook-endpoint.js";
import { openSecurityCheckpoint } from "./security-review.js";
import { scanOrg } from "./org.js";
import { resolveEffectiveExecution } from "./employee-execution.js";
import type { ApiContext } from "./api/context.js";
import { json, notFound, serverError } from "./api/responses.js";
import { handleSessionQueryRoutes } from "./api/session-query-routes.js";
import { handleApprovalRoutes } from "./api/routes/approvals.js";
import { handleArtifactRoutes } from "./api/routes/artifacts.js";
import { handleArchiveRoutes } from "./api/routes/archives.js";
import { handleAuthRoutes } from "./api/routes/auth.js";
import { handleCheckpointRoutes } from "./api/routes/checkpoints.js";
import { handleConnectorRoutes } from "./api/routes/connectors.js";
import { handleCronRoutes } from "./api/routes/cron.js";
import { handleEmailRoutes } from "../email/routes.js";
import { handleFsRoutes } from "./api/routes/fs.js";
import { handleKnowledgeRoutes } from "./api/routes/knowledge.js";
import { handleOrgRoutes } from "./api/routes/org.js";
import { handleOrchestrationRoutes } from "./api/orchestration-routes.js";
import { handleSessionWriteRoutes } from "./api/routes/session-write.js";
import { handleSkillRoutes } from "./api/routes/skills.js";
import { handleStatusRoutes } from "./api/routes/status.js";
import { handleSystemRoutes } from "./api/routes/system.js";
import { handleInspectRoutes } from "./api/routes/inspect.js";

export type { ApiContext } from "./api/context.js";
export { normalizeBlockDeltaForTurn, shouldPersistFinalAssistantMessage, finalBlocksForAssistantMessage } from "./api/block-finalize.js";
export { matchRoute } from "./api/match-route.js";
export { serializeSession, isSessionLiveRunning } from "./api/serialize-session.js";
export { resumePendingWebQueueItems } from "./api/session-dispatch.js";
export { isSensitiveConfigKey, sanitizeConfigForApi, deepMerge } from "./config-sanitize.js";
export { resolveUserHeader, deliverConnectorReply } from "./connector-reply.js";
export { loadRawTranscript, scheduleTranscriptBackfill } from "./transcript-backfill.js";

const HOOK_BODY_MAX_BYTES = 64 * 1024;
const SESSION_LIST_PER_GROUP = 50;

/** maxToolCalls was accepted on an employee's execution profile but never
 *  enforced — resolve it here for the hook endpoint's PreToolUse counter. */
function resolveMaxToolCallsForSession(cuttlefishSessionId: string): number | undefined {
  const session = getSession(cuttlefishSessionId);
  if (!session?.employee) return undefined;
  const employee = scanOrg().get(session.employee);
  if (!employee) return undefined;
  return resolveEffectiveExecution(employee).maxToolCalls;
}

type ResWithEncoding = ServerResponse & { __acceptEncoding?: string };

export async function handleApiRequest(
  req: HttpRequest,
  res: ServerResponse,
  context: ApiContext,
): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const method = req.method || "GET";
  (res as ResWithEncoding).__acceptEncoding = req.headers["accept-encoding"];

  try {
    if (await handleAuthRoutes(method, pathname, req, res, context)) return;
    if (await handleOrchestrationRoutes(method, pathname, res, context, req)) return;
    if (await handleStatusRoutes(method, pathname, res, context)) return;
    if (await handleSessionQueryRoutes(method, pathname, url, res, context, SESSION_LIST_PER_GROUP)) return;
    if (await handleArchiveRoutes(method, pathname, req, res, context)) return;
    if (await handleSessionWriteRoutes(method, pathname, req, res, context)) return;
    if (await handleCheckpointRoutes(method, pathname, req, url, res, context)) return;
    if (await handleArtifactRoutes(method, pathname, req, url, res, context)) return;
    if (await handleFsRoutes(method, pathname, url, res, context)) return;
    if (await handleKnowledgeRoutes(method, pathname, req, url, res, context)) return;
    if (await handleApprovalRoutes(method, pathname, req, url, res, context)) return;
    if (await handleCronRoutes(method, pathname, req, url, res, context)) return;
    if (await handleOrgRoutes(method, pathname, req, res, context)) return;
    if (await handleSkillRoutes(method, pathname, res)) return;
    if (await handleSystemRoutes(method, pathname, req, url, res, context)) return;
    if (await handleEmailRoutes(method, pathname, req, url, res, context)) return;
    if (await handleConnectorRoutes(method, pathname, req, res, context)) return;
    if (handleInspectRoutes(method, pathname, res, context)) return;

    if (pathname.startsWith("/api/talk/")) {
      const handled = await handleTalkApi(req, res, context);
      if (handled) return;
    }

    if (pathname.startsWith("/api/files")) {
      const handled = await handleFilesRequest(req, res, pathname, method, context);
      if (handled) return;
    }

    if (method === "POST" && pathname === "/api/internal/hook") {
      if (!context.hookRegistry || !context.hookSecret) {
        json(res, { error: "Interactive mode not active" }, 503);
        return;
      }
      const remote = req.socket.remoteAddress;
      if (!isLoopback(remote)) {
        json(res, { message: "forbidden" }, 403);
        return;
      }
      const contentLength = Number(req.headers["content-length"] ?? NaN);
      if (Number.isFinite(contentLength) && contentLength > HOOK_BODY_MAX_BYTES) {
        json(res, { error: "Payload too large" }, 413);
        return;
      }
      const parsed = await readJsonBody(req, res, { maxBytes: HOOK_BODY_MAX_BYTES });
      if (!parsed.ok) return;
      const hookBody = parsed.body as { cuttlefishSessionId?: string; hook?: import("./hook-registry.js").HookPayload };
      const result = handleHookPost(
        {
          reg: context.hookRegistry,
          secret: context.hookSecret,
          remoteAddress: remote,
          onSecurityReview: (input) => openSecurityCheckpoint(input, context),
          getMaxToolCalls: resolveMaxToolCallsForSession,
        },
        req.headers["x-cuttlefish-hook-secret"] as string | undefined,
        hookBody,
      );
      if (
        result.status === 200 &&
        hookBody.cuttlefishSessionId &&
        (hookBody.hook?.hook_event_name === "SessionStart" || hookBody.hook?.hook_event_name === "Stop") &&
        typeof hookBody.hook?.session_id === "string" &&
        hookBody.hook.session_id
      ) {
        const existing = getSession(hookBody.cuttlefishSessionId);
        if (existing && existing.engineSessionId !== hookBody.hook.session_id) {
          updateSession(hookBody.cuttlefishSessionId, { engineSessionId: hookBody.hook.session_id });
        }
      }
      json(res, { message: result.body }, result.status);
      return;
    }

    notFound(res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`API error: ${msg}`);
    serverError(res, msg);
  }
}
