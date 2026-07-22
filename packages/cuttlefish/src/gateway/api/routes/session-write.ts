import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { resolveModelAlias, validateCwd, validateNewSessionSelection, validateSessionPatch } from "../../../sessions/session-patch.js";
import { getModelRegistry } from "../../../shared/models.js";
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
  listChildSessions,
  patchSessionTransportMeta,
  type UpdateSessionFields,
  updateSession,
} from "../../../sessions/registry.js";
import { forkEngineSession } from "../../../sessions/fork.js";
import { CUTTLEFISH_HOME, ORG_DIR } from "../../../shared/paths.js";
import { getClaudeExpectedResetAt } from "../../../shared/usageAwareness.js";
import { logger } from "../../../shared/logger.js";
import { isInterruptibleEngine, type CuttlefishConfig } from "../../../shared/types.js";
import { clearTalkAttachments } from "../../../talk/attachments.js";
import { maybeEmitTalkGraph } from "../../../talk/graph.js";
import { clearTalkMuted } from "../../../talk/mute-state.js";
import { createPtyAccessToken } from "../../auth.js";
import { fileIdsToMedia, handleSessionAttachment } from "../../files.js";
import { readJsonBody } from "../../http-helpers.js";
import { attachResourcesToSession, describeSessionResources } from "../../session-resources.js";
import { exportRunBundle } from "../../run-bundles.js";
import { supersedeRunningTurn } from "../../session-turn-state.js";
import { resolveUserHeader } from "../../connector-reply.js";
import type { ApiContext } from "../context.js";
import { matchRoute } from "../match-route.js";
import { badRequest, json, notFound, serverError } from "../responses.js";
import { serializeSession } from "../serialize-session.js";
import {
  dispatchPendingWebQueueHeadForSessionKey,
  killSessionEngines,
  maybeRevertEngineOverride,
  redispatchPendingWebQueueItemsForSessionKey,
} from "../session-dispatch.js";
import { HR_EMPLOYEE_NAME, HR_SESSION_KEY } from "../../org-policy.js";
import { findHrSessionProfileConflict, getReusableHrSession } from "../../hr-session.js";
import { isHrHumanOnlyBlocked } from "../../manager-auth.js";
import type { GatewayPrincipal } from "../../auth.js";
import { acknowledgeLeaderAck } from "../../../sessions/leader-ack.js";
import { claimManagerDelegationSynthesis, markManagerDelegationSynthesisDispatched } from "../../../sessions/manager-delegation.js";
import { dispatchEmployeeSessionRun } from "../../mid-pair-orchestrator.js";
import { buildWorkspaceProfilePrompt, resolveWorkspaceProfile, type ResolvedWorkspaceProfile } from "../../workspace-profiles.js";
import { archiveSessionBoardTickets } from "../../board-service.js";
import {
  buildOperatorDelegationGrant,
  isHumanDelegateRole,
  isHumanDelegationModelAllowed,
  parseOperatorDelegationScopes,
} from "../../../sessions/operator-delegation.js";
import { continueSession } from "../../continue-session.js";

function configuredEngineModel(config: CuttlefishConfig, engine: string): string | undefined {
  return (config.engines as unknown as Record<string, { model?: string } | undefined>)[engine]?.model;
}

function singletonEmployeeSessionKey(employeeName: string | null | undefined): string | null {
  return employeeName === HR_EMPLOYEE_NAME ? HR_SESSION_KEY : null;
}

/**
 * A singleton session's stored `model` can predate today's alias resolution
 * (e.g. an old row still holds the literal "sonnet" from before the registry
 * grew a distinct "claude-sonnet-5" entry). Canonicalize it through the same
 * `resolveModelAlias` a fresh request goes through so the conflict check below
 * compares like-for-like instead of flagging the same model as a "switch".
 */
function canonicalizeExistingHrProfile(
  session: Pick<import("../../../shared/types.js").Session, "engine" | "model" | "effortLevel" | "cwd">,
  config: import("../../../shared/types.js").CuttlefishConfig,
): Pick<import("../../../shared/types.js").Session, "engine" | "model" | "effortLevel" | "cwd"> {
  if (!session.model) return session;
  const knownModelIds = new Set((getModelRegistry(config)[session.engine]?.models ?? []).map((m) => m.id));
  const canonicalModel = resolveModelAlias(session.engine, session.model, knownModelIds);
  return canonicalModel === session.model ? session : { ...session, model: canonicalModel };
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
    // Drop per-session in-memory talk state (mute flag, attachments) — these
    // registries otherwise retain deleted-session entries for the daemon's life.
    clearTalkMuted(params.id);
    clearTalkAttachments(params.id);
    const deleted = deleteSession(params.id);
    if (!deleted) {
      notFound(res);
      return true;
    }
    try {
      const archived = archiveSessionBoardTickets(ORG_DIR, [params.id]);
      for (const department of archived.departments) {
        context.emit("board:updated", { department });
      }
    } catch (err) {
      context.emit("session:deleted", { sessionId: params.id });
      logger.error(`Session ${params.id} was deleted but its Kanban cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      serverError(res, "Session was deleted, but its Kanban ticket cleanup failed");
      return true;
    }
    context.emit("session:deleted", { sessionId: params.id });
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
    const wasRunning = session.status === "running";
    const killResult = killSessionEngines(context, session, "Interrupted by user");
    context.sessionManager.getQueue().clearQueue(session.sessionKey || session.sourceRef || session.id);
    const stopped = killResult.interruptible > 0 || session.status !== "running";
    if (stopped) {
      // Current Grok releases cannot resume a turn that was terminated locally:
      // passing the retained id makes the next message attempt a remote restore
      // and fail with a 404. A genuine Grok Stop therefore starts the next turn
      // fresh, while engines with supported resume semantics keep their ids.
      updateSession(params.id, {
        status: "idle",
        lastActivity: new Date().toISOString(),
        lastError: null,
        ...(wasRunning && session.engine === "grok" ? { engineSessionId: null } : {}),
      });
      context.emit("session:stopped", { sessionId: params.id });
    }
    json(res, {
      status: stopped ? "stopped" : "not_stopped",
      stopped,
      // Reflects the session's own recorded status before this call, not
      // killResult.interruptible: that counter only means "an interruptible
      // engine type is attached," not "a live process existed for this
      // session," so it can't reliably signal whether a turn was actually
      // running. This lets callers avoid a misleading "run stopped"
      // confirmation when the session was already idle.
      wasRunning,
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
    const redispatched = await redispatchPendingWebQueueItemsForSessionKey(context, sessionKey);
    context.emit("queue:updated", { sessionId: params.id, sessionKey, paused: false });
    json(res, { status: "resumed", sessionId: params.id, redispatched });
    return true;
  }

  if (method === "POST" && pathname === "/api/sessions/bulk-delete") {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as any;
    // De-duplicate: a duplicate id would otherwise be counted twice in
    // deletedIds/failedIds against a single underlying row, misreporting a
    // fully successful delete as a partial (409) failure.
    const ids: string[] = Array.isArray(body.ids) ? [...new Set(body.ids)] : body.ids;
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
    try {
      const archived = archiveSessionBoardTickets(ORG_DIR, deletedIds);
      for (const department of archived.departments) {
        context.emit("board:updated", { department });
      }
    } catch (err) {
      for (const id of deletedIds) {
        context.emit("session:deleted", { sessionId: id });
      }
      logger.error(`Bulk-deleted session Kanban cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      serverError(res, "Sessions were deleted, but their Kanban ticket cleanup failed");
      return true;
    }
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
    const prompt = (typeof body.prompt === "string" ? body.prompt : typeof body.message === "string" ? body.message : "").trim();
    if (!prompt) {
      badRequest(res, "prompt or message is required");
      return true;
    }
    // Ledger-0007 Finding 2: fail fast with 429 before creating a session row
    // if the gateway-wide concurrent-run cap already looks full. This is a
    // best-effort pre-check (the permit is released immediately after the
    // probe) — the authoritative acquire/hold happens inside
    // dispatchWebSessionRun's own run() closure moments later, so a
    // concurrent request landing in the gap between this probe and that real
    // acquire will still be correctly serialized there, just without the
    // early 429.
    if (context.runSemaphore) {
      const probeRelease = context.runSemaphore.tryAcquire(context.getConfig().sessions?.maxConcurrentRuns);
      if (!probeRelease) {
        json(res, { error: "Too many concurrent runs — retry shortly", retryAfterMs: 2000 }, 429);
        return true;
      }
      probeRelease();
    }
    const config = context.getConfig();
    let workspaceProfile: ResolvedWorkspaceProfile | undefined;
    if (body.workspaceProfile !== undefined && body.workspaceProfile !== null && body.workspaceProfile !== "") {
      const resolved = resolveWorkspaceProfile(config, body.workspaceProfile);
      if (!resolved.ok) {
        json(res, { error: resolved.error }, resolved.status);
        return true;
      }
      workspaceProfile = resolved.profile;
    }
    const dispatchPrompt = workspaceProfile
      ? buildWorkspaceProfilePrompt(workspaceProfile, prompt)
      : prompt;
    const employeeName = coercePortalEmployee(body.employee, config.portal?.portalName);
    const principal = (req as HttpRequest & { cuttlefishPrincipal?: GatewayPrincipal }).cuttlefishPrincipal;
    const isParentedRequest = typeof body.parentSessionId === "string" && body.parentSessionId.trim().length > 0;
    // HR is an operator-facing advisory lane. It is deliberately not a worker
    // that managers, agents, or orchestration flows can delegate to; otherwise
    // singleton reuse can cross-contaminate a human HR thread and lose a child
    // callback. Human operators retain direct, top-level HR access.
    if (isHrHumanOnlyBlocked(employeeName, { isDirectTopLevelHumanRequest: !isParentedRequest && principal?.kind !== "session" })) {
      json(res, {
        error: "HR / Org Steward accepts direct top-level requests from a human operator only",
        code: "hr_human_only",
      }, 403);
      return true;
    }
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
    let cwd: string | undefined = workspaceProfile?.cwd;
    if (body.cwd !== undefined) {
      const validatedCwd = validateCwd(body.cwd, { roots: config.workspaces?.roots });
      if (!validatedCwd.ok) {
        badRequest(res, validatedCwd.error || "invalid cwd");
        return true;
      }
      cwd = validatedCwd.cwd;
    }
    const engineName = selection.engine || config.engines.default;
    const delegationModel = selection.model ?? configuredEngineModel(config, engineName);
    const singletonSessionKey = singletonEmployeeSessionKey(employeeName);
    const sessionKey = singletonSessionKey ?? `web:${Date.now()}`;
    const userId = resolveUserHeader(req.headers, config.gateway.userHeader);
    const requestedDelegationScopes = parseOperatorDelegationScopes(prompt);
    if (requestedDelegationScopes) {
      if (principal?.kind === "session") {
        json(res, { error: "Only a direct human operator message can delegate operator authority", code: "operator_delegation_human_only" }, 403);
        return true;
      }
      if (!isHumanDelegateRole(employeeName, "web")) {
        json(res, { error: "Human-delegated authority is limited to Cuttlefish (COO) and Program Manager", code: "operator_delegation_role_forbidden" }, 403);
        return true;
      }
      if (!isHumanDelegationModelAllowed(engineName, delegationModel)) {
        json(res, { error: "Human-delegated authority requires GPT-5.5, GPT-5.6-sol, Opus 4.8, or Fable", code: "operator_delegation_model_forbidden" }, 403);
        return true;
      }
    }
    const operatorDelegation = requestedDelegationScopes
      ? buildOperatorDelegationGrant({ prompt: dispatchPrompt, scopes: requestedDelegationScopes, grantedBy: userId })
      : undefined;
    const existingSingletonSession = singletonSessionKey ? getReusableHrSession() : undefined;
    const requestedHrProfile = existingSingletonSession
      ? {
          ...(body.engine !== undefined ? { engine: engineName } : {}),
          ...(body.model !== undefined && selection.model !== undefined ? { model: selection.model } : {}),
          ...(body.effortLevel !== undefined && selection.effortLevel !== undefined ? { effortLevel: selection.effortLevel } : {}),
          ...(body.cwd !== undefined || workspaceProfile?.cwd !== undefined ? { cwd: cwd ?? null } : {}),
        }
      : undefined;
    const hrSingletonConfigurationConflict = existingSingletonSession && requestedHrProfile
      ? findHrSessionProfileConflict(canonicalizeExistingHrProfile(existingSingletonSession, config), {
          ...(requestedHrProfile.engine !== undefined ? { engine: requestedHrProfile.engine } : {}),
          ...(requestedHrProfile.cwd !== undefined ? { cwd: requestedHrProfile.cwd } : {}),
        })
      : null;
    // The singleton keeps one engine and working directory, but an operator's
    // explicit model/effort selection is safe to apply to the next queued turn.
    // Existing-session PATCH already supports that same in-place behavior; the
    // create-and-reuse path must not reject it merely because it is HR.
    if (hrSingletonConfigurationConflict && existingSingletonSession) {
      json(res, {
        error: `HR singleton session cannot switch ${hrSingletonConfigurationConflict.field} from ${hrSingletonConfigurationConflict.existing ?? "default"} to ${hrSingletonConfigurationConflict.requested ?? "default"}; continue it without an override or start a separate non-HR session.`,
        code: "hr_singleton_profile_conflict",
        sessionId: existingSingletonSession.id,
        field: hrSingletonConfigurationConflict.field,
      }, 409);
      return true;
    }
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
          model: operatorDelegation ? delegationModel : selection.model,
          prompt: dispatchPrompt,
          promptExcerpt: typeof body.promptExcerpt === "string" ? body.promptExcerpt : prompt,
          cwd,
          portalName: config.portal?.portalName,
          transportMeta: workspaceProfile || operatorDelegation
            ? {
                ...(operatorDelegation ? { operatorDelegation: operatorDelegation as any } : {}),
                ...(workspaceProfile ? {
                workspaceProfile: {
                  id: workspaceProfile.id,
                  label: workspaceProfile.label,
                  cwd: workspaceProfile.cwd ?? null,
                },
              } : {}),
              }
            : undefined,
        });
    if (existingSingletonSession && requestedHrProfile && (requestedHrProfile.model !== undefined || requestedHrProfile.effortLevel !== undefined)) {
      session = updateSession(session.id, {
        ...(requestedHrProfile.model !== undefined ? { model: requestedHrProfile.model } : {}),
        ...(requestedHrProfile.effortLevel !== undefined ? { effortLevel: requestedHrProfile.effortLevel } : {}),
      }) ?? session;
      context.emit("session:updated", { sessionId: session.id });
    }
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

    // Resolve the dispatching employee so dispatchEmployeeSessionRun can decide
    // whether mid_pair applies. Only top-level (non-child) sessions are eligible —
    // the recursion guard (executionDepth check) additionally prevents role child
    // sessions from expanding further, enforced at run time in run-web-session.ts.
    let execEmp: import("../../../shared/types.js").Employee | undefined;
    if (employeeName && !session.parentSessionId) {
      const { scanOrg: scanOrgForExec } = await import("../../org.js");
      execEmp = scanOrgForExec().get(employeeName);
    }

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
    if (attached.blocked) {
      json(res, serializeSession(session, context), 201);
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
    const queueItemId = enqueueQueueItem(session.id, queueSessionKey, dispatchPrompt);
    context.emit("queue:updated", { sessionId: session.id, sessionKey: queueSessionKey });
    if (singletonWasRunning) {
      context.emit("session:queued", { sessionId: session.id, message: prompt });
    }
    if (hasPendingQueueItemBefore(queueSessionKey, queueItemId)) {
      dispatchPendingWebQueueHeadForSessionKey(context, queueSessionKey);
    } else if (!attached.blocked) {
      dispatchEmployeeSessionRun(session, dispatchPrompt, engine, config, context, execEmp, {
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
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const principal = (req as HttpRequest & { cuttlefishPrincipal?: GatewayPrincipal }).cuttlefishPrincipal;
    const result = await continueSession({
      sessionId: params.id,
      body: parsed.body as Record<string, unknown>,
      context,
      principal,
      userId: resolveUserHeader(req.headers, context.getConfig().gateway.userHeader),
    });
    json(res, result.body, result.statusCode);
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
      const body = parsed.body as any;
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
