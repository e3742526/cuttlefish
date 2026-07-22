import { getClaudeExpectedResetAt } from "../shared/usageAwareness.js";
import { logger } from "../shared/logger.js";
import { isInterruptibleEngine, type CuttlefishConfig } from "../shared/types.js";
import {
  deletePartialMessages,
  enqueueQueueItem,
  getSession,
  hasPendingQueueItemBefore,
  insertMessage,
  listChildSessions,
  patchSessionTransportMeta,
  updateSession,
} from "../sessions/registry.js";
import { acknowledgeLeaderAck } from "../sessions/leader-ack.js";
import {
  buildOperatorDelegationGrant,
  isHumanDelegateRole,
  isHumanDelegationModelAllowed,
  parseOperatorDelegationScopes,
  type OperatorDelegationScope,
} from "../sessions/operator-delegation.js";
import {
  claimManagerDelegationSynthesis,
  markManagerDelegationSynthesisDispatched,
} from "../sessions/manager-delegation.js";
import { maybeEmitTalkGraph } from "../talk/graph.js";
import type { GatewayPrincipal } from "./auth.js";
import type { ApiContext } from "./api/context.js";
import { maybeRevertEngineOverride } from "./api/session-dispatch.js";
import {
  dispatchPendingWebQueueHeadForSessionKey,
} from "./api/session-dispatch.js";
import { dispatchEmployeeSessionRun } from "./mid-pair-orchestrator.js";
import { supersedeRunningTurn } from "./session-turn-state.js";
import { attachResourcesToSession, attachmentMedia, describeSessionResources } from "./session-resources.js";

export interface ContinueSessionInput {
  sessionId: string;
  body: Record<string, unknown>;
  context: ApiContext;
  principal?: GatewayPrincipal;
  userId?: string | null;
  /** Structured Management authority selection. When supplied, the visible
   * message does not need to contain the legacy delegation directive. */
  operatorDelegationScopes?: OperatorDelegationScope[];
}

export interface ContinueSessionResult {
  statusCode: number;
  body: Record<string, unknown>;
  insertedMessageId?: string;
}

function configuredEngineModel(config: CuttlefishConfig, engine: string): string | undefined {
  return (config.engines as unknown as Record<string, { model?: string } | undefined>)[engine]?.model;
}

export async function continueSession(input: ContinueSessionInput): Promise<ContinueSessionResult> {
  const existingSession = getSession(input.sessionId);
  if (!existingSession) return { statusCode: 404, body: { error: "Not found" } };
  let session = maybeRevertEngineOverride(existingSession);
  const body = input.body;
  const prompt = (typeof body.message === "string" ? body.message : typeof body.prompt === "string" ? body.prompt : "").trim();
  if (!prompt) return { statusCode: 400, body: { error: "message is required" } };

  if (session.parentSessionId) {
    const talkParent = getSession(session.parentSessionId);
    if (talkParent?.source === "talk") {
      input.context.emit("talk:focus", { cooId: session.id, label: session.title || "", parentId: talkParent.id });
    }
  }
  maybeEmitTalkGraph(session.id, "status", { getSession, emit: input.context.emit });

  const messageRole = body.role === "notification" ? "notification" : "user";
  const isNotification = messageRole === "notification";
  const displayMessage = typeof body.displayMessage === "string" && body.displayMessage.trim()
    ? body.displayMessage
    : prompt;
  const config = input.context.getConfig();
  const legacyScopes = isNotification ? null : parseOperatorDelegationScopes(prompt);
  const requestedDelegationScopes = input.operatorDelegationScopes?.length
    ? input.operatorDelegationScopes
    : legacyScopes;
  if (requestedDelegationScopes) {
    if (input.principal?.kind === "session") {
      return { statusCode: 403, body: { error: "Only a direct human operator message can delegate operator authority", code: "operator_delegation_human_only" } };
    }
    if (!isHumanDelegateRole(session.employee, session.source)) {
      return { statusCode: 403, body: { error: "Human-delegated authority is limited to Cuttlefish (COO) and Program Manager", code: "operator_delegation_role_forbidden" } };
    }
    const delegationModel = session.model ?? configuredEngineModel(config, session.engine);
    if (!isHumanDelegationModelAllowed(session.engine, delegationModel)) {
      return { statusCode: 403, body: { error: "Human-delegated authority requires GPT-5.5, GPT-5.6-sol, Opus 4.8, or Fable", code: "operator_delegation_model_forbidden" } };
    }
    if (!session.model && delegationModel) session = updateSession(session.id, { model: delegationModel }) ?? session;
    session = patchSessionTransportMeta(session.id, {
      operatorDelegation: buildOperatorDelegationGrant({
        prompt,
        scopes: requestedDelegationScopes,
        grantedBy: input.userId,
      }) as never,
    }) ?? session;
    input.context.emit("session:updated", { sessionId: session.id });
  }

  const ptyEngine = body.mode === "interactive" ? input.context.ptyViewEngines?.[session.engine] : undefined;
  const engine = ptyEngine ?? input.context.sessionManager.getEngine(session.engine);
  if (!engine) return { statusCode: 500, body: { error: `Engine "${session.engine}" not available` } };

  const turnRunning = session.status === "running" && isInterruptibleEngine(engine)
    && ("isTurnRunning" in engine ? (engine as { isTurnRunning(id: string): boolean }).isTurnRunning(session.id) : engine.isAlive(session.id));
  const shouldInterruptRunningTurn = !isNotification
    && (config.sessions?.interruptOnNewMessage ?? true)
    && turnRunning;
  if (shouldInterruptRunningTurn) supersedeRunningTurn(session);

  const userMedia = isNotification ? [] : attachmentMedia(body);
  let attached;
  if (isNotification) {
    attached = { session, ...describeSessionResources(session) };
  } else {
    try {
      attached = await attachResourcesToSession(session, body, input.context);
    } catch (error) {
      return { statusCode: 400, body: { error: error instanceof Error ? error.message : "invalid resources" } };
    }
  }
  const insertedMessageId = insertMessage(
    session.id,
    messageRole,
    isNotification ? displayMessage : prompt,
    userMedia.length > 0 ? userMedia : undefined,
  );
  if (isNotification) {
    input.context.emit("session:notification", { sessionId: session.id, message: displayMessage });
    const currentSession = getSession(session.id) ?? session;
    const synthesis = claimManagerDelegationSynthesis(
      currentSession.id,
      currentSession.transportMeta,
      listChildSessions(currentSession.id),
    );
    if (!synthesis.shouldDispatch) {
      return {
        statusCode: 200,
        body: {
          status: "notification_recorded",
          sessionId: session.id,
          ...(synthesis.reason === "waiting_for_children" ? { pendingChildSessionIds: synthesis.pendingChildSessionIds } : {}),
        },
        insertedMessageId,
      };
    }
    if (synthesis.tracked) {
      session = updateSession(currentSession.id, {
        transportMeta: markManagerDelegationSynthesisDispatched(currentSession.transportMeta),
      }) ?? currentSession;
    }
  } else if (acknowledgeLeaderAck(session.id, session, { acknowledgedBy: session.parentSessionId ?? null })) {
    input.context.emit("session:updated", { sessionId: session.id });
  }

  if (!isNotification && session.status === "waiting") {
    const expectedResetAt = getClaudeExpectedResetAt();
    const resumeText = expectedResetAt
      ? expectedResetAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
      : null;
    const queuedText = `⏳ Still paused due to Claude usage limit${resumeText ? ` (resets ${resumeText})` : ""}. Your message is queued and will run automatically.`;
    insertMessage(session.id, "notification", queuedText);
    input.context.emit("session:notification", { sessionId: session.id, message: queuedText });
  }
  if (session.status === "running") {
    if (shouldInterruptRunningTurn) {
      logger.info(`Interrupting running session ${session.id} for new message`);
      engine.kill(session.id, "Interrupted: new message received");
      input.context.emit("session:interrupted", { sessionId: session.id, reason: "new message" });
    } else if (!isNotification) {
      input.context.emit("session:queued", { sessionId: session.id, message: prompt });
    }
  }
  if (session.status === "interrupted") {
    logger.info(`Resuming interrupted session ${session.id} (engineSessionId: ${session.engineSessionId})`);
    updateSession(session.id, { status: "running", lastActivity: new Date().toISOString(), lastError: null });
    input.context.emit("session:resumed", { sessionId: session.id });
  }

  input.context.sessionManager.getQueue().clearCancelled(session.sessionKey || session.sourceRef || session.id);
  const sessionKey = session.sessionKey || session.sourceRef || session.id;
  let queueItemId: string | undefined;
  if (!isNotification) {
    queueItemId = enqueueQueueItem(session.id, sessionKey, prompt);
    input.context.emit("queue:updated", { sessionId: session.id, sessionKey });
  }
  if (attached.blocked) {
    return { statusCode: 200, body: { status: "checkpoint_required", sessionId: session.id }, insertedMessageId };
  }
  if (queueItemId && hasPendingQueueItemBefore(sessionKey, queueItemId)) {
    dispatchPendingWebQueueHeadForSessionKey(input.context, sessionKey);
  } else {
    let followUpEmployee;
    if (session.employee && !session.parentSessionId) {
      const { scanOrg } = await import("./org.js");
      followUpEmployee = scanOrg().get(session.employee);
    }
    dispatchEmployeeSessionRun(session, prompt, engine, config, input.context, followUpEmployee, {
      queueItemId,
      attachments: attached.engineAttachments.length > 0 ? attached.engineAttachments : undefined,
      resourceContext: attached.promptBlock,
    });
  }
  return { statusCode: 200, body: { status: "queued", sessionId: session.id }, insertedMessageId };
}

