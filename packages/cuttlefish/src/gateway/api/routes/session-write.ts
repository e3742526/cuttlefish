import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { validateCwd, validateNewSessionSelection, validateSessionPatch } from "../../../sessions/session-patch.js";
import {
  cancelAllPendingQueueItems,
  cancelQueueItemForSession,
  coercePortalEmployee,
  createSession,
  deletePartialMessages,
  deleteSession,
  deleteSessions,
  duplicateSession,
  enqueueQueueItem,
  getQueueItems,
  getSession,
  hasPendingQueueItemBefore,
  insertMessage,
  type UpdateSessionFields,
  updateSession,
} from "../../../sessions/registry.js";
import { forkEngineSession } from "../../../sessions/fork.js";
import { CUTTLEFISH_HOME } from "../../../shared/paths.js";
import { getClaudeExpectedResetAt } from "../../../shared/usageAwareness.js";
import { logger } from "../../../shared/logger.js";
import { isInterruptibleEngine } from "../../../shared/types.js";
import { maybeEmitTalkGraph } from "../../../talk/graph.js";
import { createPtyAccessToken } from "../../auth.js";
import { fileIdsToMedia, handleSessionAttachment, rehomeAttachmentsToSession } from "../../files.js";
import { readJsonBody } from "../../http-helpers.js";
import {
  buildResolvedRunAttachments,
  listRunAttachments,
  mergeRunAttachments,
  resolveIncomingRunAttachments,
  setRunAttachmentsOnTransportMeta,
} from "../../run-attachments.js";
import { exportRunBundle } from "../../run-bundles.js";
import { supersedeRunningTurn } from "../../session-turn-state.js";
import { resolveUserHeader } from "../../connector-reply.js";
import type { ApiContext } from "../context.js";
import { matchRoute } from "../match-route.js";
import { badRequest, json, notFound, serverError } from "../responses.js";
import { serializeSession } from "../serialize-session.js";
import {
  dispatchWebSessionRun,
  dispatchPendingWebQueueHeadForSessionKey,
  killSessionEngines,
  maybeRevertEngineOverride,
  redispatchPendingWebQueueItemsForSessionKey,
} from "../session-dispatch.js";
import { HR_EMPLOYEE_NAME, HR_SESSION_KEY } from "../../org-policy.js";
import { getReusableHrSession } from "../../hr-session.js";
import { acknowledgeLeaderAck } from "../../../sessions/leader-ack.js";

function combinedResourceSpecs(body: Record<string, unknown>): unknown[] {
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const resources = Array.isArray(body.resources) ? body.resources : [];
  return [...attachments, ...resources];
}

async function attachResourcesToSession(
  session: import("../../../shared/types.js").Session,
  body: Record<string, unknown>,
  context: ApiContext,
): Promise<{
  session: import("../../../shared/types.js").Session;
  promptBlock: string | null;
  engineAttachments: string[];
}> {
  const existing = listRunAttachments(session);
  const incomingSpecs = combinedResourceSpecs(body);
  if (incomingSpecs.length === 0) {
    const resolved = buildResolvedRunAttachments(existing);
    return {
      session,
      promptBlock: resolved.promptBlock,
      engineAttachments: resolved.engineAttachments,
    };
  }

  const legacyFileIds = Array.isArray(body.attachments)
    ? body.attachments.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  if (legacyFileIds.length > 0) rehomeAttachmentsToSession(legacyFileIds, session.id);

  const incoming = await resolveIncomingRunAttachments(incomingSpecs, context);
  const merged = mergeRunAttachments(existing, incoming);
  const updated = updateSession(session.id, {
    transportMeta: setRunAttachmentsOnTransportMeta(session.transportMeta, merged),
  }) ?? session;
  const resolved = buildResolvedRunAttachments(merged);
  return {
    session: updated,
    promptBlock: resolved.promptBlock,
    engineAttachments: resolved.engineAttachments,
  };
}

function describeSessionResources(session: import("../../../shared/types.js").Session): {
  promptBlock: string | null;
  engineAttachments: string[];
} {
  const resolved = buildResolvedRunAttachments(listRunAttachments(session));
  return {
    promptBlock: resolved.promptBlock,
    engineAttachments: resolved.engineAttachments,
  };
}

function singletonEmployeeSessionKey(employeeName: string | null | undefined): string | null {
  return employeeName === HR_EMPLOYEE_NAME ? HR_SESSION_KEY : null;
}

export async function handleSessionWriteRoutes(
  method: string,
  pathname: string,
  req: HttpRequest,
  res: ServerResponse,
  context: ApiContext,
): Promise<boolean> {
  let params = matchRoute("/api/sessions/:id", pathname);
  if ((method === "PUT" || method === "PATCH") && params) {
    const session = getSession(params.id);
    if (!session) {
      notFound(res);
      return true;
    }
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as any;
    const updates: UpdateSessionFields = {};
    if (body.title !== undefined) {
      if (typeof body.title !== "string") {
        badRequest(res, "title must be a string");
        return true;
      }
      const trimmed = body.title.trim();
      if (!trimmed) {
        badRequest(res, "title must not be empty");
        return true;
      }
      updates.title = trimmed.slice(0, 200);
    }
    if (body.model !== undefined || body.effortLevel !== undefined) {
      const configForPatch = context.getConfig();
      const engineConfigForPatch =
        (configForPatch.engines as unknown as Record<string, { model?: string } | undefined>)[session.engine] ?? {};
      const patch = validateSessionPatch(configForPatch, session.engine, session.model, body, {
        engineSessionId: session.engineSessionId,
        defaultModel: engineConfigForPatch.model,
      });
      if (!patch.ok) {
        badRequest(res, patch.error || "invalid model/effort");
        return true;
      }
      if (patch.updates?.model !== undefined) updates.model = patch.updates.model;
      if (patch.updates?.effortLevel !== undefined) updates.effortLevel = patch.updates.effortLevel;
    }
    if (Object.keys(updates).length === 0) {
      badRequest(res, "no valid fields to update");
      return true;
    }
    const updated = updateSession(params.id, updates);
    if (!updated) {
      notFound(res);
      return true;
    }
    context.emit("session:updated", { sessionId: params.id });
    json(res, serializeSession(updated, context));
    return true;
  }

  params = matchRoute("/api/sessions/:id/pty-token", pathname);
  if (method === "POST" && params) {
    const session = getSession(params.id);
    if (!session) {
      notFound(res);
      return true;
    }
    if (!context.apiToken) {
      json(res, { error: "PTY auth unavailable" }, 503);
      return true;
    }
    const ptyEngine = context.ptyViewEngines?.[session.engine];
    if (!ptyEngine) {
      json(res, { error: "Session engine has no PTY view" }, 409);
      return true;
    }
    json(res, { token: createPtyAccessToken(params.id, context.apiToken), expiresInMs: 60_000 });
    return true;
  }

  params = matchRoute("/api/sessions/:id", pathname);
  if (method === "DELETE" && params) {
    const session = getSession(params.id);
    if (!session) {
      notFound(res);
      return true;
    }
    logger.info(`Killing engine process for deleted session ${params.id}`);
    killSessionEngines(context, session, "Interrupted: session deleted");
    context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);
    maybeEmitTalkGraph(params.id, "removed", { getSession, emit: context.emit });
    const deleted = deleteSession(params.id);
    if (!deleted) {
      notFound(res);
      return true;
    }
    logger.info(`Session deleted: ${params.id}`);
    json(res, { status: "deleted" });
    return true;
  }

  params = matchRoute("/api/sessions/:id/stop", pathname);
  if (method === "POST" && params) {
    const session = getSession(params.id);
    if (!session) {
      notFound(res);
      return true;
    }
    const killResult = killSessionEngines(context, session, "Interrupted by user");
    context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);
    const stopped = killResult.interruptible > 0 || session.status !== "running";
    if (stopped) {
      updateSession(params.id, { status: "idle", lastActivity: new Date().toISOString(), lastError: null });
      context.emit("session:stopped", { sessionId: params.id });
    }
    json(res, {
      status: stopped ? "stopped" : "not_stopped",
      stopped,
      interruptible: killResult.interruptible > 0,
      sessionId: params.id,
    }, stopped ? 200 : 409);
    return true;
  }

  params = matchRoute("/api/sessions/:id/reset", pathname);
  if (method === "POST" && params) {
    const session = getSession(params.id);
    if (!session) {
      notFound(res);
      return true;
    }
    killSessionEngines(context, session, "Interrupted: session reset");
    context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);
    const meta = { ...(session.transportMeta || {}) } as Record<string, unknown>;
    delete meta.engineSessions;
    delete meta.engineOverride;
    updateSession(params.id, {
      status: "idle",
      engineSessionId: null,
      lastActivity: new Date().toISOString(),
      lastError: null,
      transportMeta: meta as any,
    });
    logger.info(`Session ${params.id} reset via API (cleared engineSessions, engineOverride, engineSessionId, lastError)`);
    context.emit("session:updated", { sessionId: params.id });
    json(res, { status: "reset", sessionId: params.id });
    return true;
  }

  params = matchRoute("/api/sessions/:id/duplicate", pathname);
  if (method === "POST" && params) {
    const source = getSession(params.id);
    if (!source) {
      notFound(res);
      return true;
    }
    if (!source.engineSessionId) {
      badRequest(res, "Session has no engine session ID — cannot duplicate");
      return true;
    }

    let newSessionId: string | null = null;
    try {
      const { session: newSession, messageCount } = duplicateSession(params.id);
      newSessionId = newSession.id;

      const interactive = source.engine === "claude" && context.interactiveClaudeEngine
        ? {
            sourceCuttlefishSessionId: params.id,
            engine: context.interactiveClaudeEngine,
            bin: context.getConfig().engines.claude.bin,
          }
        : undefined;
      const forkResult = await forkEngineSession(source.engine, source.engineSessionId, CUTTLEFISH_HOME, interactive);
      updateSession(newSession.id, { engineSessionId: forkResult.engineSessionId });

      const result = getSession(newSession.id)!;
      logger.info(`Session duplicated: ${params.id} → ${newSession.id} (engine: ${forkResult.engineSessionId}, ${messageCount} messages)`);
      context.emit("session:created", { sessionId: newSession.id });
      json(res, serializeSession(result, context));
      return true;
    } catch (err: any) {
      if (newSessionId) {
        try { deleteSession(newSessionId); } catch {}
      }
      logger.error(`Failed to duplicate session ${params.id}: ${err.message}`);
      json(res, { error: `Duplicate failed: ${err.message}` }, 500);
      return true;
    }
  }

  const queueItemParams = matchRoute("/api/sessions/:id/queue/:itemId", pathname);
  if (method === "DELETE" && queueItemParams) {
    const session = getSession(queueItemParams.id);
    if (!session) {
      notFound(res);
      return true;
    }
    const sessionKey = session.sessionKey || session.sourceRef || session.id;
    const cancelled = cancelQueueItemForSession(queueItemParams.itemId, session.id, sessionKey);
    if (!cancelled) {
      json(res, { error: "Item not found or already running" }, 409);
      return true;
    }
    context.emit("queue:updated", { sessionId: queueItemParams.id, sessionKey: session.sessionKey });
    json(res, { status: "cancelled", itemId: queueItemParams.itemId });
    return true;
  }

  params = matchRoute("/api/sessions/:id/queue", pathname);
  if (method === "DELETE" && params) {
    const session = getSession(params.id);
    if (!session) {
      notFound(res);
      return true;
    }
    const sessionKey = session.sessionKey || session.sourceRef || session.id;
    const pendingBefore = getQueueItems(sessionKey).filter((item) => item.status === "pending").length;
    context.sessionManager.getQueue().clearQueue(sessionKey);
    const cancelled = cancelAllPendingQueueItems(sessionKey);
    context.emit("queue:updated", { sessionId: params.id, sessionKey, depth: 0 });
    const status =
      pendingBefore === 0 ? "empty" :
      cancelled < pendingBefore ? "partial" :
      "cleared";
    json(res, { status, cancelled, requested: pendingBefore });
    return true;
  }

  params = matchRoute("/api/sessions/:id/queue/pause", pathname);
  if (method === "POST" && params) {
    const session = getSession(params.id);
    if (!session) {
      notFound(res);
      return true;
    }
    const sessionKey = session.sessionKey || session.sourceRef || session.id;
    context.sessionManager.getQueue().pauseQueue(sessionKey);
    context.emit("queue:updated", { sessionId: params.id, sessionKey, paused: true });
    json(res, { status: "paused", sessionId: params.id });
    return true;
  }

  params = matchRoute("/api/sessions/:id/queue/resume", pathname);
  if (method === "POST" && params) {
    const session = getSession(params.id);
    if (!session) {
      notFound(res);
      return true;
    }
    const sessionKey = session.sessionKey || session.sourceRef || session.id;
    context.sessionManager.getQueue().resumeQueue(sessionKey);
    const redispatched = redispatchPendingWebQueueItemsForSessionKey(context, sessionKey);
    context.emit("queue:updated", { sessionId: params.id, sessionKey, paused: false });
    json(res, { status: "resumed", sessionId: params.id, redispatched });
    return true;
  }

  if (method === "POST" && pathname === "/api/sessions/bulk-delete") {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as any;
    const ids: string[] = body.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      badRequest(res, "ids array is required");
      return true;
    }

    const sessionsToDelete = ids
      .map((id) => getSession(id))
      .filter((session): session is NonNullable<ReturnType<typeof getSession>> => Boolean(session));
    const existingIds = sessionsToDelete.map((session) => session.id);
    const missingIds = ids.filter((id) => !existingIds.includes(id));

    for (const id of ids) {
      const session = getSession(id);
      if (!session) continue;
      killSessionEngines(context, session, "Interrupted: session deleted");
      context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);
    }

    for (const id of existingIds) {
      maybeEmitTalkGraph(id, "removed", { getSession, emit: context.emit });
    }
    const count = deleteSessions(existingIds);
    const deletedIds = existingIds.filter((id) => !getSession(id));
    for (const id of deletedIds) {
      context.emit("session:deleted", { sessionId: id });
    }
    const failedIds = ids.filter((id) => !deletedIds.includes(id));
    if (failedIds.length > 0 || count !== existingIds.length) {
      logger.warn(`Bulk delete partial: deleted ${deletedIds.length}/${ids.length} sessions`);
      json(res, {
        status: "partial",
        count: deletedIds.length,
        requested: ids.length,
        deletedIds,
        failedIds,
        missingIds,
        error: `Deleted ${deletedIds.length} of ${ids.length} selected sessions`,
      }, 409);
      return true;
    }
    logger.info(`Bulk deleted ${count} sessions`);
    json(res, { status: "deleted", count, requested: ids.length, deletedIds });
    return true;
  }

  if (method === "POST" && pathname === "/api/sessions") {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as any;
    const prompt = body.prompt || body.message;
    if (!prompt) {
      badRequest(res, "prompt or message is required");
      return true;
    }
    const config = context.getConfig();
    const employeeName = coercePortalEmployee(body.employee, config.portal?.portalName);
    let employeeDefaults: { engine: string; model: string; effortLevel?: string } | undefined;
    if (employeeName) {
      const { scanOrg } = await import("../../org.js");
      const emp = scanOrg().get(employeeName);
      if (emp) {
        employeeDefaults = { engine: emp.engine, model: emp.model };
        if (emp.effortLevel) employeeDefaults.effortLevel = emp.effortLevel;
      }
    }
    const selection = validateNewSessionSelection(config, {
      engine: body.engine,
      model: body.model,
      effortLevel: body.effortLevel,
    }, employeeDefaults);
    if (!selection.ok) {
      badRequest(res, selection.error || "invalid engine/model/effort");
      return true;
    }
    let cwd: string | undefined;
    if (body.cwd !== undefined) {
      const validatedCwd = validateCwd(body.cwd, { roots: config.workspaces?.roots });
      if (!validatedCwd.ok) {
        badRequest(res, validatedCwd.error || "invalid cwd");
        return true;
      }
      cwd = validatedCwd.cwd;
    }
    const engineName = selection.engine || config.engines.default;
    const singletonSessionKey = singletonEmployeeSessionKey(employeeName);
    const sessionKey = singletonSessionKey ?? `web:${Date.now()}`;
    const userId = resolveUserHeader(req.headers, config.gateway.userHeader);
    const existingSingletonSession = singletonSessionKey ? getReusableHrSession() : undefined;
    let session = existingSingletonSession
      ? maybeRevertEngineOverride(existingSingletonSession)
      : createSession({
          engine: engineName,
          source: "web",
          sourceRef: sessionKey,
          connector: "web",
          sessionKey,
          replyContext: { source: "web" },
          userId,
          employee: employeeName,
          parentSessionId: body.parentSessionId,
          effortLevel: selection.effortLevel,
          model: selection.model,
          prompt,
          promptExcerpt: typeof body.promptExcerpt === "string" ? body.promptExcerpt : undefined,
          cwd,
          portalName: config.portal?.portalName,
        });
    if (!existingSingletonSession) {
      logger.info(`Web session created: ${session.id} (model=${selection.model || "default"})`);
      if (session.parentSessionId) {
        const talkParent = getSession(session.parentSessionId);
        if (talkParent?.source === "talk") {
          const label = String(body.employee || prompt || "task").replace(/\s+/g, " ").trim().slice(0, 48);
          context.emit("talk:focus", { cooId: session.id, label, parentId: talkParent.id });
        }
      }
      maybeEmitTalkGraph(session.id, "added", { getSession, emit: context.emit });
    }
    const newSessionMedia = fileIdsToMedia(body.attachments);
    let attached;
    try {
      attached = await attachResourcesToSession(session, body, context);
    } catch (err) {
      badRequest(res, err instanceof Error ? err.message : "invalid resources");
      return true;
    }
    session = attached.session;
    insertMessage(session.id, "user", prompt, newSessionMedia.length > 0 ? newSessionMedia : undefined);

    const dispatchEngineName = session.engine || engineName;
    const ptyEngine = body.mode === "interactive" ? context.ptyViewEngines?.[dispatchEngineName] : undefined;
    const engine = ptyEngine ?? context.sessionManager.getEngine(dispatchEngineName);
    if (!engine) {
      updateSession(session.id, {
        status: "error",
        lastError: `Engine "${dispatchEngineName}" not available`,
      });
      json(res, { ...serializeSession({ ...session, status: "error", lastError: `Engine "${dispatchEngineName}" not available` }, context) }, 201);
      return true;
    }

    const singletonWasRunning = Boolean(existingSingletonSession && session.status === "running");
    if (session.status === "interrupted" || session.status === "idle") {
      session = updateSession(session.id, {
        status: "running",
        lastActivity: new Date().toISOString(),
        lastError: null,
      }) ?? { ...session, status: "running", lastError: null };
    }

    const queueSessionKey = session.sessionKey || session.sourceRef || session.id;
    const queueItemId = enqueueQueueItem(session.id, queueSessionKey, prompt);
    context.emit("queue:updated", { sessionId: session.id, sessionKey: queueSessionKey });
    if (singletonWasRunning) {
      context.emit("session:queued", { sessionId: session.id, message: prompt });
    }
    if (hasPendingQueueItemBefore(queueSessionKey, queueItemId)) {
      dispatchPendingWebQueueHeadForSessionKey(context, queueSessionKey);
    } else {
      dispatchWebSessionRun(session, prompt, engine, config, context, {
        queueItemId,
        attachments: attached.engineAttachments.length > 0 ? attached.engineAttachments : undefined,
        resourceContext: attached.promptBlock,
      });
    }

    json(res, serializeSession(session, context), 201);
    return true;
  }

  params = matchRoute("/api/sessions/:id/message", pathname);
  if (method === "POST" && params) {
    const existingSession = getSession(params.id);
    if (!existingSession) {
      notFound(res);
      return true;
    }
    const session = maybeRevertEngineOverride(existingSession);
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as any;
    const prompt = body.message || body.prompt;
    if (!prompt) {
      badRequest(res, "message is required");
      return true;
    }

    if (session.parentSessionId) {
      const talkParent = getSession(session.parentSessionId);
      if (talkParent?.source === "talk") {
        context.emit("talk:focus", { cooId: session.id, label: session.title || "", parentId: talkParent.id });
      }
    }
    maybeEmitTalkGraph(session.id, "status", { getSession, emit: context.emit });

    const messageRole: string = body.role === "notification" ? "notification" : "user";
    const isNotification = messageRole === "notification";
    const displayMessage =
      typeof body.displayMessage === "string" && body.displayMessage.trim()
        ? body.displayMessage
        : prompt;

    const config = context.getConfig();
    const ptyEngine = body.mode === "interactive" ? context.ptyViewEngines?.[session.engine] : undefined;
    const engine = ptyEngine ?? context.sessionManager.getEngine(session.engine);
    if (!engine) {
      serverError(res, `Engine "${session.engine}" not available`);
      return true;
    }

    const turnRunning = session.status === "running" && isInterruptibleEngine(engine)
      && ("isTurnRunning" in engine ? (engine as any).isTurnRunning(session.id) : engine.isAlive(session.id));
    const shouldInterruptRunningTurn =
      !isNotification &&
      (config.sessions?.interruptOnNewMessage ?? true) &&
      turnRunning;
    if (shouldInterruptRunningTurn) supersedeRunningTurn(session);

    const userMedia = isNotification ? [] : fileIdsToMedia(body.attachments);
    let attached;
    if (isNotification) {
      attached = { session, ...describeSessionResources(session) };
    } else {
      try {
        attached = await attachResourcesToSession(session, body, context);
      } catch (err) {
        badRequest(res, err instanceof Error ? err.message : "invalid resources");
        return true;
      }
    }
    insertMessage(
      session.id,
      messageRole,
      isNotification ? displayMessage : prompt,
      userMedia.length > 0 ? userMedia : undefined,
    );
    if (isNotification) {
      context.emit("session:notification", { sessionId: session.id, message: displayMessage });
    } else if (acknowledgeLeaderAck(session.id, session, { acknowledgedBy: session.parentSessionId ?? null })) {
      context.emit("session:updated", { sessionId: session.id });
    }

    if (!isNotification && session.status === "waiting") {
      const expectedResetAt = getClaudeExpectedResetAt();
      const resumeText = expectedResetAt
        ? expectedResetAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
        : null;
      const queuedText =
        `⏳ Still paused due to Claude usage limit${resumeText ? ` (resets ${resumeText})` : ""}. Your message is queued and will run automatically.`;
      insertMessage(session.id, "notification", queuedText);
      context.emit("session:notification", { sessionId: session.id, message: queuedText });
    }

    if (session.status === "running") {
      if (shouldInterruptRunningTurn) {
        logger.info(`Interrupting running session ${session.id} for new message`);
        engine.kill(session.id, "Interrupted: new message received");
        context.emit("session:interrupted", { sessionId: session.id, reason: "new message" });
      } else if (!isNotification) {
        context.emit("session:queued", { sessionId: session.id, message: prompt });
      }
    }

    if (session.status === "interrupted") {
      logger.info(`Resuming interrupted session ${session.id} (engineSessionId: ${session.engineSessionId})`);
      updateSession(session.id, {
        status: "running",
        lastActivity: new Date().toISOString(),
        lastError: null,
      });
      context.emit("session:resumed", { sessionId: session.id });
    }

    context.sessionManager.getQueue().clearCancelled(session.sessionKey || session.sourceRef || session.id);
    const sessionKey = session.sessionKey || session.sourceRef || session.id;
    let queueItemId: string | undefined;
    if (!isNotification) {
      queueItemId = enqueueQueueItem(session.id, sessionKey, prompt);
      context.emit("queue:updated", { sessionId: session.id, sessionKey });
    }
    if (queueItemId && hasPendingQueueItemBefore(sessionKey, queueItemId)) {
      dispatchPendingWebQueueHeadForSessionKey(context, sessionKey);
    } else {
      dispatchWebSessionRun(session, prompt, engine, config, context, {
        queueItemId,
        attachments: attached.engineAttachments.length > 0 ? attached.engineAttachments : undefined,
        resourceContext: attached.promptBlock,
      });
    }

    json(res, { status: "queued", sessionId: session.id });
    return true;
  }

  params = matchRoute("/api/sessions/:id/attachments", pathname);
  if (method === "POST" && params) {
    const session = getSession(params.id);
    if (!session) {
      notFound(res);
      return true;
    }
    await handleSessionAttachment(req, res, params.id, context);
    return true;
  }

  params = matchRoute("/api/sessions/:id/resources", pathname);
  if (params) {
    const session = getSession(params.id);
    if (!session) {
      notFound(res);
      return true;
    }
    if (method === "GET") {
      json(res, { attachments: serializeSession(session, context).attachments ?? [] });
      return true;
    }
    if (method === "POST") {
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return true;
      const body = parsed.body as Record<string, unknown>;
      let attached;
      try {
        attached = await attachResourcesToSession(session, body, context);
      } catch (err) {
        badRequest(res, err instanceof Error ? err.message : "invalid resources");
        return true;
      }
      context.emit("session:updated", { sessionId: session.id });
      json(res, { attachments: serializeSession(attached.session, context).attachments ?? [] }, 201);
      return true;
    }
  }

  params = matchRoute("/api/sessions/:id/bundle", pathname);
  if (method === "POST" && params) {
    const session = getSession(params.id);
    if (!session) {
      notFound(res);
      return true;
    }
    try {
      const bundle = exportRunBundle(session.id, context);
      context.emit("bundle:exported", { bundleId: bundle.id, sessionId: session.id, bundlePath: bundle.bundlePath });
      json(res, bundle, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : "bundle export failed";
      if (message.includes("not found")) {
        notFound(res);
        return true;
      }
      if (message.includes("not complete enough")) {
        json(res, { error: message }, 409);
        return true;
      }
      throw err;
    }
    return true;
  }

  return false;
}
