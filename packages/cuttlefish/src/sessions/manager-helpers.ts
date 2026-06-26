import type { Connector, Employee, EngineResult, IncomingMessage, KnowledgeSink, Session } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { emitSessionSummaryBestEffort, knowledgeRelayOptions } from "../knowledge/outbox-service.js";
import { notifyParentSession } from "./callbacks.js";
import {
  accumulateSessionCost,
  getMessages,
  getSession,
  getSessionBySessionKey,
  insertMessage,
  updateSession,
} from "./registry.js";
import type { SessionNotificationSink } from "./notification-sink.js";
import type { CuttlefishConfig } from "../shared/types.js";
import { markTranscriptSyncedThrough } from "../gateway/external-turns.js";

export function maybeRevertEngineOverride(session: Session): Session {
  const meta = (session.transportMeta || {}) as Record<string, unknown>;
  const override = meta["engineOverride"] as Record<string, unknown> | undefined;
  if (!override) return session;

  const originalEngine = typeof override.originalEngine === "string" ? override.originalEngine : null;
  const originalEngineSessionId = typeof override.originalEngineSessionId === "string"
    ? override.originalEngineSessionId
    : null;
  const syncSince = typeof override.syncSince === "string" ? override.syncSince : null;
  const untilIso = typeof override.until === "string" ? override.until : null;
  if (!originalEngine || !untilIso) return session;

  const until = new Date(untilIso);
  if (Number.isNaN(until.getTime()) || until.getTime() > Date.now()) return session;

  const engineSessionsRaw = meta["engineSessions"];
  const engineSessions = (engineSessionsRaw && typeof engineSessionsRaw === "object" && !Array.isArray(engineSessionsRaw))
    ? { ...(engineSessionsRaw as Record<string, unknown>) }
    : {};
  if (session.engine && session.engineSessionId) engineSessions[String(session.engine)] = session.engineSessionId;

  const restoredSessionId = originalEngineSessionId
    ?? (typeof engineSessions[originalEngine] === "string" ? (engineSessions[originalEngine] as string) : null);

  const nextMeta = { ...meta, engineSessions } as Record<string, unknown>;
  if (originalEngine === "claude" && syncSince && session.engine !== "claude") nextMeta["claudeSyncSince"] = syncSince;
  delete nextMeta["engineOverride"];
  return updateSession(session.id, {
    engine: originalEngine,
    engineSessionId: restoredSessionId,
    transportMeta: nextMeta as any,
    lastError: null,
  }) ?? session;
}

export function mergeTransportMeta(
  existing: Session["transportMeta"],
  incoming: IncomingMessage["transportMeta"],
): Session["transportMeta"] {
  const baseExisting = (existing && typeof existing === "object" && !Array.isArray(existing))
    ? (existing as Record<string, unknown>)
    : {};
  const baseIncoming = (incoming && typeof incoming === "object" && !Array.isArray(incoming))
    ? (incoming as Record<string, unknown>)
    : {};
  const merged: Record<string, unknown> = { ...baseExisting, ...baseIncoming };
  for (const key of ["engineOverride", "engineSessions", "claudeSyncSince", "transcriptSyncedThrough"]) {
    if (baseExisting[key] !== undefined) merged[key] = baseExisting[key];
  }
  return merged as any;
}

export async function finalizeManagedSessionTurn(input: {
  session: Session;
  msg: IncomingMessage;
  result: EngineResult;
  connector: Connector;
  target: { channel: string };
  threadTs: string | undefined;
  capabilities: { reactions?: boolean };
  decorateMessages: boolean;
  wasInterrupted: boolean;
  syncRequested: boolean;
  rateLimitLimited: boolean;
  employee?: Employee;
  notificationSink?: SessionNotificationSink;
  knowledgeSink?: KnowledgeSink;
  config: CuttlefishConfig;
}): Promise<void> {
  const responseText = input.result.result?.trim()
    ? input.result.result
    : input.result.error || "(No response from engine)";

  if (!getSession(input.session.id)) {
    logger.warn(`Dropping engine result for deleted session ${input.session.id}`);
    return;
  }

  insertMessage(input.session.id, "assistant", responseText);
  if (input.result.cost || input.result.numTurns) {
    accumulateSessionCost(input.session.id, input.result.cost ?? 0, input.result.numTurns ?? 1);
  }
  if (input.decorateMessages && input.connector.setTypingStatus) {
    await input.connector.setTypingStatus(input.target.channel, input.threadTs, "").catch(() => {});
  }
  if (!input.wasInterrupted) {
    await input.connector.replyMessage(input.target, responseText);
  }
  if (input.decorateMessages && input.capabilities.reactions) {
    await input.connector.removeReaction(input.target, "eyes").catch(() => {});
  }
  const updatedSession = updateSession(input.session.id, {
    ...(input.result.sessionId?.trim() ? { engineSessionId: input.result.sessionId } : {}),
    ...(typeof input.result.contextTokens === "number" ? { lastContextTokens: input.result.contextTokens } : {}),
    status: input.wasInterrupted ? "idle" : (input.result.error ? "error" : "idle"),
    replyContext: input.msg.replyContext,
    messageId: input.msg.messageId ?? null,
    transportMeta: (() => {
      const merged = mergeTransportMeta(getSessionBySessionKey(input.msg.sessionKey)?.transportMeta ?? input.session.transportMeta, input.msg.transportMeta) as Record<string, unknown>;
      if (input.syncRequested && !input.rateLimitLimited && !input.wasInterrupted) delete merged["claudeSyncSince"];
      return merged as any;
    })(),
    lastActivity: new Date().toISOString(),
    lastError: input.wasInterrupted ? null : (input.result.error ?? null),
  });
  if (!input.wasInterrupted && input.session.engine === "claude") {
    markTranscriptSyncedThrough(input.session.id, input.result.sessionId);
  }
  if (updatedSession) {
    notifyParentSession(
      updatedSession,
      { result: input.result.result, error: input.wasInterrupted ? null : (input.result.error ?? null), cost: input.result.cost, durationMs: input.result.durationMs },
      { alwaysNotify: input.employee?.alwaysNotify, sink: input.notificationSink },
    );
  }
  if (updatedSession && input.knowledgeSink) {
    try {
      await emitSessionSummaryBestEffort({
        session: updatedSession,
        messages: getMessages(updatedSession.id),
        sink: input.knowledgeSink,
        ...knowledgeRelayOptions(input.config),
      });
    } catch (err) {
      logger.warn(`knowledge: failed to export session summary ${updatedSession.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  logger.info(
    `Session ${input.session.id} completed in ${input.result.durationMs ?? 0}ms` +
    (input.result.cost ? ` ($${input.result.cost.toFixed(4)})` : ""),
  );
}
