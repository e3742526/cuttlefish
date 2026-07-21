import path from "node:path";
import { createHash } from "node:crypto";
import type { Engine, EngineResult, CuttlefishConfig, Session, StreamDelta } from "../shared/types.js";
import { isInterruptibleEngine } from "../shared/types.js";
import { rungKey } from "../shared/model-escalation.js";
import { resolveModelFallback } from "../shared/model-fallback.js";
import { recordEngineRateLimit } from "../shared/usage-status.js";
import { effortLevelsForModel, engineAvailable, isKnownEngine, engineUnavailableMessage } from "../shared/models.js";
import { createApproval } from "./approvals.js";
import { isAutonomousVerdictSession } from "./autonomous-mode.js";
import { buildContext } from "../sessions/context.js";
import { buildContextPacket, contextManagerMode, logContextPacketMetadata } from "../sessions/context-manager/index.js";
import { accumulateSessionCost, createSession, listChildSessions, getSession, updateSession, patchSessionTransportMeta, insertMessage, insertPartialMessage, updatePartialMessage, deletePartialMessages, finalizePartialMessages, getMessages } from "../sessions/registry.js";
import { logger } from "../shared/logger.js";
import { CUTTLEFISH_HOME } from "../shared/paths.js";
import { resolveEffort } from "../shared/effort.js";
import { resolveEngineInvocation } from "../shared/engine-arg-resolver.js";
import { runWithEngineEnvironment } from "../shared/engine-env.js";
import { detectRateLimit } from "../shared/rateLimit.js";
import {
  handleRateLimit,
  rateLimitFallbackNotice,
  rateLimitSummary,
  rateLimitTimeoutError,
  rateLimitWaitingNotice,
} from "../sessions/rate-limit-handler.js";
import { notifyConnectorNotification, notifyParentSession, notifyRateLimited, notifyRateLimitResumed } from "../sessions/callbacks.js";
import { markTranscriptSyncedThrough } from "./external-turns.js";
import { getOrchestratorPersona } from "../talk/orchestrator-persona.js";
import { buildManagerDelegationPlan, buildManagerDelegationTelemetry, isInitialManagerDelegationTurn, resolveSupervisedNodes } from "../sessions/manager-delegation.js";
import { feedTalkText, flushTalkSpeech, discardTalkSpeech } from "../talk/tts-stream.js";
import { isTalkMuted } from "../talk/mute-state.js";
import { maybeEmitTalkGraph } from "../talk/graph.js";
import { createModelFallbackHandoff } from "./model-fallback.js";
import { deliverConnectorReply } from "./connector-reply.js";
import { isTurnSuperseded, clearSupersededTurnMeta } from "./session-turn-state.js";
import { resultAlreadyInStreamedBlocks, shouldPreserveStreamedBlocks } from "./streamed-blocks.js";
import type { ApiContext } from "./api/context.js";
import { parseLeaseTransportMeta } from "../orchestration/lease-meta.js";
import { emitSessionSummaryBestEffort, knowledgeRelayOptions } from "../knowledge/outbox-service.js";
import { positiveNumberOr, resolveStallLeaderName, resolveTurnStallWatchdogConfig, shouldNotifyLeaderReviewOnStall, shouldRetrySameEngineAfterStall } from "./turn-stall-policy.js";
export { resolveStallLeaderName, resolveTurnStallWatchdogConfig, shouldNotifyLeaderReviewOnStall, shouldRetrySameEngineAfterStall } from "./turn-stall-policy.js";
import { isExecutionDepthBlocked } from "./employee-execution.js";
import { createScopedSessionToken } from "./auth.js";
import { prepareWebSessionRun } from "./web-session-preflight.js";
import { isHumanDelegateRole, isHumanDelegationModelAllowed, operatorDelegationPromptHash, readOperatorDelegationScopesForTurn } from "../sessions/operator-delegation.js";

export function resolveFallbackContinuationSession(
  updated: Session | undefined,
  sessionId: string,
  lookup: (id: string) => Session | undefined = getSession,
): Session | undefined {
  return updated ?? lookup(sessionId);
}

export function isEngineDiedNoOutput(options: {
  wasInterrupted: boolean;
  wasSuperseded: boolean;
  hasPartialOutput: boolean;
  error?: string;
  result: string;
}): boolean {
  const rawResultIsInterrupt = /^Interrupted\b/i.test(options.result.trim());
  const exitReason = options.error ?? options.result;
  return options.wasInterrupted &&
    !options.wasSuperseded &&
    !options.hasPartialOutput &&
    /process exited/i.test(exitReason) &&
    (!options.result.trim() || rawResultIsInterrupt);
}

/**
 * The web runner has three successful completion paths: its normal engine
 * result plus rate-limit fallback and retry callbacks. Keep their accounting
 * rule in one place so command-center usage cannot drift by completion path.
 */
export function recordSuccessfulWebSessionTurn(
  sessionId: string,
  result: Pick<EngineResult, "cost" | "numTurns" | "error">,
): void {
  if (result.error) return;
  accumulateSessionCost(sessionId, result.cost ?? 0, result.numTurns ?? 1);
}

/**
 * Web/queue session execution orchestrator.
 *
 * Extracted verbatim from `api.ts` (audit AS-001) without behavior change. Owns
 * a single web/connector/cron/talk turn: engine resolution, context build,
 * streaming, partial-message persistence, rate-limit recovery / model fallback,
 * completion callbacks, and connector reply relay.
 */
export async function runWebSession(
  session: Session,
  prompt: string,
  initialEngine: Engine,
  initialConfig: CuttlefishConfig,
  context: ApiContext,
  attachments?: string[],
  resourceContext?: string | null,
): Promise<void> {
  const prepared = prepareWebSessionRun({ session, prompt, engine: initialEngine, config: initialConfig, context });
  if (!prepared) return;
  let { currentSession, config, engine, isRoleChildSession } = prepared;

  let employee: import("../shared/types.js").Employee | undefined;
  if (currentSession.employee) {
    const { findEmployee } = await import("./org.js");
    const { scanOrg } = await import("./org.js");
    const registry = scanOrg();
    employee = findEmployee(currentSession.employee, registry);
  }

  // Recursion guard: child role sessions (executionDepth ≥ 1) must not expand
  // into fresh execution profiles. Log if triggered — indicates a dispatch bug.
  if (isRoleChildSession) {
    const role = (currentSession.transportMeta as Record<string, unknown>)?.["internalRole"] ?? "unknown";
    logger.warn(`[execution] Session ${currentSession.id} has executionDepth ≥ 1 (role: ${String(role)}) — execution profile expansion suppressed`);
  }
  // Role sessions are internal/silent (see employee-execution.ts): when a reviewer
  // or revision-implementer child completes, its parent must NOT receive a
  // notifyParentSession callback — that callback dispatches a brand-new turn on
  // the parent session (treating the child's report as an inbound chat message),
  // which would race with the mid_pair orchestrator still driving that same
  // parent session and double-run it. `employee` is intentionally unset on role
  // sessions, so `employee?.alwaysNotify` is undefined (not false) and would
  // otherwise pass the "notify" default — explicitly force it off here instead.
  const parentNotifyAlwaysNotify = isRoleChildSession ? false : employee?.alwaysNotify;

  if (isKnownEngine(currentSession.engine) && !engineAvailable(config, currentSession.engine)) {
    const errMsg = engineUnavailableMessage(config, currentSession.engine);
    logger.error(`Web session ${currentSession.id} blocked: ${errMsg}`);
    insertMessage(currentSession.id, "assistant", `⛔ ${errMsg}`);
    const erroredSession = updateSession(currentSession.id, {
      status: "error",
      lastActivity: new Date().toISOString(),
      lastError: errMsg,
    });
    context.emit("session:completed", { sessionId: currentSession.id, result: null, error: errMsg });
    maybeEmitTalkGraph(currentSession.id, "completed", { getSession, emit: context.emit });
    if (erroredSession) {
      notifyParentSession(erroredSession, { error: errMsg }, { alwaysNotify: parentNotifyAlwaysNotify, sink: context.notificationSink });
    }
    return;
  }

  const { scanOrg: scanOrgForHierarchy } = await import("./org.js");
  const { resolveOrgHierarchy, withPortalExecutive } = await import("./org-hierarchy.js");
  const orgHierarchy = resolveOrgHierarchy(withPortalExecutive(scanOrgForHierarchy(), config.portal?.portalName));
  const managerDelegationSupervisedNodes = employee
    ? resolveSupervisedNodes(employee.name, orgHierarchy, orgHierarchy.nodes[employee.name])
    : [];
  const managerDelegationReportCount = employee
    ? managerDelegationSupervisedNodes.length
    : 0;
  const managerDelegationChildSessionsBefore =
    employee && managerDelegationReportCount > 0 ? listChildSessions(currentSession.id).length : 0;
  let managerDelegationTelemetryLogged = false;
  const logManagerDelegationTelemetryOnce = () => {
    if (managerDelegationTelemetryLogged || !employee || managerDelegationReportCount <= 0) return;
    managerDelegationTelemetryLogged = true;
    const telemetry = buildManagerDelegationTelemetry({
      sessionId: currentSession.id,
      engine: currentSession.engine,
      employee,
      directReportCount: managerDelegationReportCount,
      childSessionsBefore: managerDelegationChildSessionsBefore,
      childSessionsAfter: listChildSessions(currentSession.id).length,
    });
    if (telemetry) logger.debug(`manager_delegation ${JSON.stringify(telemetry)}`);
  };

  const enforcedDelegation = await enforceManagerDelegationIfNeeded({
    session: currentSession,
    prompt,
    employee,
    supervisedNodes: managerDelegationSupervisedNodes,
    config,
    context,
    attachments,
    resourceContext,
    logTelemetry: logManagerDelegationTelemetryOnce,
  });
  if (enforcedDelegation) return;

  try {
    const operatorDelegationScopes = isHumanDelegateRole(currentSession.employee, currentSession.source)
      && isHumanDelegationModelAllowed(currentSession.engine, currentSession.model)
      ? readOperatorDelegationScopesForTurn(currentSession, prompt)
      : [];
    const scopedSessionToken = context.apiToken
      ? createScopedSessionToken(currentSession.id, context.apiToken, {
          delegatedScopes: operatorDelegationScopes,
          operatorDelegationId: operatorDelegationPromptHash(prompt),
        })
      : undefined;

    const systemPrompt = buildContext({
      source: currentSession.source,
      channel: currentSession.sourceRef,
      user: currentSession.userId ?? "web-user",
      cwd: currentSession.cwd || CUTTLEFISH_HOME,
      employee,
      connectors: Array.from(context.connectors.keys()),
      config,
      sessionId: currentSession.id,
      sessionToken: scopedSessionToken,
      operatorDelegationScopes,
      hierarchy: orgHierarchy,
      voicePersona: currentSession.source === "talk" ? getOrchestratorPersona() : undefined,
      talkThreads:
        currentSession.source === "talk"
          ? listChildSessions(currentSession.id).slice(0, 12).map((c) => ({
              id: c.id,
              label: c.title || "(untitled)",
              status: c.status,
              lastActivity: c.lastActivity,
            }))
          : undefined,
    });

    const engineConfig =
      (config.engines as unknown as Record<string, { bin?: string; model?: string; effortLevel?: string; childEffortOverride?: string } | undefined>)[
        currentSession.engine
      ] ?? {};
    const effortLevel = resolveEffort(
      engineConfig,
      currentSession,
      employee,
      effortLevelsForModel(config, currentSession.engine, currentSession.model ?? undefined),
    );

    const stallPolicy = resolveTurnStallWatchdogConfig(config);
    const stallLeaderCheckMs = Math.min(stallPolicy.leaderCheckMs, stallPolicy.inactivityMs);
    const stallInactivityMs = stallPolicy.inactivityMs;
    const stallHardCeilingMs = stallPolicy.hardCeilingMs;
    const maxStallRetries = stallPolicy.maxRetries;
    const killer = isInterruptibleEngine(engine) ? engine : null;
    const canKill = !!killer; // only engines we can interrupt get a watchdog
    let lastStreamAt = Date.now();
    let leaderReviewNotified = false;

    const leaderName = resolveStallLeaderName(orgHierarchy, employee?.name);
    const leaderReviewActor = leaderName ? `${leaderName} can` : "A manager can";
    const leaderReviewWorker = employee?.displayName ?? employee?.name ?? currentSession.employee ?? "This worker";
    const maybeNotifyLeaderReview = (idleMs: number) => {
      if (!shouldNotifyLeaderReviewOnStall({
        idleMs,
        leaderCheckMs: stallLeaderCheckMs,
        inactivityMs: stallInactivityMs,
        alreadyNotified: leaderReviewNotified,
      })) return;
      leaderReviewNotified = true;
      const idleMinutes = Math.max(1, Math.round(idleMs / 60_000));
      const fallbackMinutes = Math.max(1, Math.round(stallInactivityMs / 60_000));
      const reviewMessage =
        `🕒 Leader check: ${leaderReviewWorker} has been silent for ${idleMinutes} minute${idleMinutes === 1 ? "" : "s"}. ` +
        `${leaderReviewActor} switch this report to a different model/provider or take over if needed. ` +
        `Automatic fallback will interrupt after ${fallbackMinutes} minutes of silence.`;
      insertMessage(currentSession.id, "notification", reviewMessage);
      logger.warn(`[watchdog] web session ${currentSession.id} requested leader review after ${idleMinutes}m idle`);
      try {
        context.emit("session:updated", { sessionId: currentSession.id });
      } catch {
        /* best effort */
      }
    };

    const sessCfg = (config as unknown as { sessions?: Record<string, unknown> }).sessions ?? {};
    const maxEscalations = positiveNumberOr(sessCfg.maxModelEscalations, 2);
    const customLadder = Array.isArray(sessCfg.modelLadder)
      ? (sessCfg.modelLadder as import("../shared/model-escalation.js").ModelLadder)
      : undefined;
    const attemptEscalation = async (trigger: "stall" | "usage", detail: string): Promise<boolean> => {
      const live = getSession(currentSession.id);
      if (!live) return false;
      const meta = (live.transportMeta ?? {}) as Record<string, unknown>;
      const prev = (meta.escalation && typeof meta.escalation === "object" ? meta.escalation : {}) as {
        count?: number; tried?: unknown; history?: unknown;
      };
      const count = typeof prev.count === "number" ? prev.count : 0;
      if (count >= maxEscalations) return false;
      const curModel = live.model ?? "";
      const tried = new Set<string>([
        ...(Array.isArray(prev.tried) ? (prev.tried as unknown[]).filter((x): x is string => typeof x === "string") : []),
        rungKey(live.engine, curModel),
      ]);
      const failureReason = trigger === "usage" ? "quota_exhausted" : "timeout";
      const fallbackDecision = resolveModelFallback({
        employee,
        config,
        failureReason,
        fromEngine: live.engine,
        fromModel: curModel || undefined,
        triedRungs: tried,
        ladder: customLadder,
        excludeEngines: trigger === "usage" ? new Set([live.engine]) : undefined,
        isAvailable: (e) => isKnownEngine(e) && !!context.sessionManager.getEngine(e) && engineAvailable(config, e),
      });
      if (!fallbackDecision.target) return false;
      const candidate = fallbackDecision.target;
      const handoff = createModelFallbackHandoff({
        session: live,
        employeeName: employee?.displayName ?? employee?.name ?? live.employee,
        fromEngine: live.engine,
        fromModel: curModel || null,
        target: candidate,
        failureReason,
        prompt,
        detail,
        recentMessages: getMessages(currentSession.id).slice(-20).map((m) => ({ role: m.role, content: m.content, timestamp: m.timestamp })),
      });
      if (fallbackDecision.action === "ask_user") {
        const waitingMeta: Record<string, unknown> = {
          ...meta,
          modelFallback: {
            status: "approval_required",
            reason: failureReason,
            handoffPath: handoff.relativePath,
            from: { engine: live.engine, model: curModel || null },
            to: { engine: candidate.engine, model: candidate.model, effortLevel: candidate.effortLevel ?? null, source: candidate.source },
            createdAt: new Date().toISOString(),
          },
        };
        updateSession(currentSession.id, {
          status: "waiting",
          transportMeta: waitingMeta as any,
          lastActivity: new Date().toISOString(),
          lastError: "Model fallback approval required: " + live.engine + "/" + (curModel || "default") + " → " + candidate.engine + "/" + candidate.model,
        });
        insertMessage(currentSession.id, "notification", "🧭 Model fallback available: " + live.engine + "/" + (curModel || "default") + " → " + candidate.engine + "/" + candidate.model + ". Handoff: " + handoff.relativePath + ". Approval is required before switching.");
        context.emit("session:fallback-required", { sessionId: currentSession.id, handoffPath: handoff.relativePath, from: live.engine, to: candidate.engine, model: candidate.model, reason: failureReason });
        const approval = createApproval({
          sessionId: currentSession.id,
          type: "fallback",
          payload: {
            from: { engine: live.engine, model: curModel || null },
            to: { engine: candidate.engine, model: candidate.model, effortLevel: candidate.effortLevel ?? null, source: candidate.source },
            handoffPath: handoff.relativePath,
            reason: failureReason,
          },
        });
        context.emit("approval:created", { approvalId: approval.id, sessionId: currentSession.id, type: "fallback" });
        return true;
      }
      if (fallbackDecision.action !== "fallback") return false;
      const nextEngine = context.sessionManager.getEngine(candidate.engine);
      if (!nextEngine) return false;

      const nextMeta: Record<string, unknown> = {
        ...meta,
        escalation: {
          count: count + 1,
          tried: [...tried, rungKey(candidate.engine, candidate.model)],
          history: [
            ...(Array.isArray(prev.history) ? (prev.history as unknown[]) : []),
            { trigger, detail, from: { engine: live.engine, model: curModel || null }, to: { engine: candidate.engine, model: candidate.model }, via: candidate.via, source: candidate.source, handoffPath: handoff.relativePath },
          ],
        },
        modelFallback: {
          status: "running_on_fallback",
          reason: failureReason,
          handoffPath: handoff.relativePath,
          from: { engine: live.engine, model: curModel || null },
          to: { engine: candidate.engine, model: candidate.model, effortLevel: candidate.effortLevel ?? null, source: candidate.source },
          startedAt: new Date().toISOString(),
        },
      };
      const rolled = updateSession(currentSession.id, {
        engine: candidate.engine,
        model: candidate.model,
        effortLevel: candidate.effortLevel ?? live.effortLevel,
        engineSessionId: null,
        transportMeta: nextMeta as any,
        status: "running",
        lastActivity: new Date().toISOString(),
        lastError: "Fallback (" + trigger + "): " + live.engine + "/" + (curModel || "default") + " → " + candidate.engine + "/" + candidate.model,
      });
      deletePartialMessages(currentSession.id);
      logger.warn(
        "[model-fallback] session " + currentSession.id + " " + trigger + " (" + detail + ") — " +
          live.engine + "/" + (curModel || "default") + " → " + candidate.engine + "/" + candidate.model +
          " via " + candidate.source + "/" + candidate.via + " (fallback " + (count + 1) + "/" + maxEscalations + ", handoff " + handoff.relativePath + ")",
      );
      insertMessage(currentSession.id, "notification", "🔁 Model fallback: " + live.engine + "/" + (curModel || "default") + " → " + candidate.engine + "/" + candidate.model + ". Handoff: " + handoff.relativePath);
      try {
        context.emit("session:delta", {
          sessionId: currentSession.id,
          type: "text",
          content: "\n🔁 " + (live.employee ?? "worker") + " " + (trigger === "stall" ? "stalled" : "ran out of usage") + " on " + (curModel || live.engine) + "; continuing on fallback " + candidate.model + "…\n",
        });
      } catch { /* best effort */ }
      const fallbackPrompt = "You are taking over this task after a model fallback. Read the handoff packet below, preserve prior decisions and technical truth, then continue the original task.\n\n" + handoff.markdown;
      const continuationSession = resolveFallbackContinuationSession(rolled, currentSession.id);
      if (!continuationSession) {
        logger.info(`Skipping fallback continuation for missing session ${currentSession.id}`);
        return true;
      }
      await runWebSession(continuationSession, fallbackPrompt, nextEngine, config, context, attachments, resourceContext);
      return true;
    };

    let lastHeartbeatAt = 0;
    const runHeartbeat = setInterval(() => {
      const live = getSession(currentSession.id);
      if (!live) {
        clearInterval(runHeartbeat);
        return;
      }
      updateSession(currentSession.id, {
        status: "running",
        lastActivity: new Date().toISOString(),
      });
      const leaseMeta = parseLeaseTransportMeta(live.transportMeta);
      if (leaseMeta && context.orchestration?.runtime) {
        try {
          context.orchestration.runtime.heartbeatLease(leaseMeta.leaseId, leaseMeta.coordinatorId);
        } catch (err) {
          logger.warn(`Orchestration heartbeat failed for session ${currentSession.id}: ${err instanceof Error ? err.message : err}`);
        }
      }
      // 10s stays inside every consumer's window: the status reconciler's 45s
      // stale threshold, the UI's 15s stale hint, and the lease TTL (default
      // 1h). Stream deltas also refresh lastActivity, so this heartbeat only
      // carries quiet stretches of a turn.
    }, 10_000);

    let partialSeq = 0;
    let curTextId: string | null = null; // the growing text-block row, null between blocks
    let curText = "";
    let lastToolId: string | null = null; // last tool row, for the tool_result → "Used" update
    let partialFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushPartialText = () => {
      partialFlushTimer = null;
      if (!curText.trim()) return;
      if (curTextId) updatePartialMessage(curTextId, curText);
      else curTextId = insertPartialMessage(currentSession.id, "assistant", curText, partialSeq++);
    };
    const persistPartialDelta = (delta: StreamDelta) => {
      if (delta.type === "text" || delta.type === "text_snapshot") {
        if (typeof delta.content !== "string") return;
        if (delta.type === "text_snapshot") {
          if (delta.content.length > curText.length) curText = delta.content;
        } else {
          curText += delta.content;
        }
        if (!partialFlushTimer) partialFlushTimer = setTimeout(flushPartialText, 600);
      } else if (delta.type === "tool_use") {
        flushPartialText(); // finalize the text block before the tool
        if (partialFlushTimer) { clearTimeout(partialFlushTimer); partialFlushTimer = null; }
        const tool = delta.toolName || String(delta.content ?? "");
        lastToolId = insertPartialMessage(currentSession.id, "assistant", `Using ${tool}`, partialSeq++, tool);
        curTextId = null; curText = ""; // a fresh text block begins after the tool
      } else if (delta.type === "tool_result") {
        const tool = delta.toolName || String(delta.content ?? "");
        if (lastToolId) updatePartialMessage(lastToolId, `Used ${tool}`);
      }
    };

    const syncSinceIso = (currentSession.transportMeta as any)?.claudeSyncSince;
    const syncSinceMs = typeof syncSinceIso === "string" ? new Date(syncSinceIso).getTime() : NaN;
    const syncRequested = currentSession.engine === "claude" && typeof syncSinceIso === "string" && Number.isFinite(syncSinceMs);
    const basePromptToRun = syncRequested
      ? (() => {
        const sinceMessages = getMessages(currentSession.id)
          .filter((m) => (m.role === "user" || m.role === "assistant") && m.timestamp >= syncSinceMs)
          .map((m) => `${m.role.toUpperCase()}: ${m.content}`);
        const transcript = sinceMessages.slice(-20).join("\n\n");
        return `We temporarily switched engines due to a usage limit on ${currentSession.engine}. Sync your context with this transcript (most recent last), then respond to the last USER message.\n\n${transcript}`;
      })()
      : prompt;
    const promptToRun = resourceContext ? `${resourceContext}\n\n${basePromptToRun}` : basePromptToRun;
    const contextPacketMode = contextManagerMode(config);
    const contextPacket = contextPacketMode === "off"
      ? null
      : buildContextPacket({
          config,
          engine: currentSession.engine,
          model: currentSession.model ?? engineConfig.model,
          systemPrompt,
          prompt: promptToRun,
          historyMessages: getMessages(currentSession.id),
        });
    if (contextPacket) logContextPacketMetadata(contextPacket.metadata, currentSession.id);

    const turnStartedAt = Date.now();
    let result!: Awaited<ReturnType<typeof engine.run>>;
    let stalledReason: string | null = null;
    try {
    for (let stallAttempt = 0; ; stallAttempt++) {
      stalledReason = null;
      lastStreamAt = Date.now();
      const attemptStartedAt = Date.now();
      let stallKilled = false;
      let stallWatchdog: ReturnType<typeof setInterval> | null = null;
      stallWatchdog = canKill
        ? setInterval(() => {
            if (!getSession(currentSession.id)) { clearInterval(stallWatchdog!); return; }
            const idleMs = Date.now() - lastStreamAt;
            const totalMs = Date.now() - attemptStartedAt;
            maybeNotifyLeaderReview(idleMs);
            if (idleMs >= stallInactivityMs || totalMs >= stallHardCeilingMs) {
              stalledReason =
                idleMs >= stallInactivityMs
                  ? `no engine activity for ${Math.round(idleMs / 1000)}s`
                  : `turn exceeded the ${Math.round(stallHardCeilingMs / 1000)}s ceiling`;
              stallKilled = true;
              clearInterval(stallWatchdog!);
              logger.warn(
                `[watchdog] web session ${currentSession.id} (${currentSession.engine}) stalled: ${stalledReason} ` +
                  `— interrupting${shouldRetrySameEngineAfterStall(stallAttempt, maxStallRetries) ? " and retrying" : ""}`,
              );
              killer?.kill(currentSession.id, `Interrupted: stalled — ${stalledReason}`);
            }
          }, stallPolicy.tickMs)
        : null;
      try {
      // Reconcile explicit effort/cliFlags against the (possibly post-fallback)
      // engine's implicit capabilities — strip effort inputs an engine can't accept.
      const invocation = resolveEngineInvocation(config, currentSession.engine, {
        effortLevel,
        cliFlags: employee?.cliFlags,
      });

      result = await runWithEngineEnvironment(
        scopedSessionToken ? { CUTTLEFISH_SESSION_TOKEN: scopedSessionToken } : {},
        () => engine.run({
      prompt: contextPacket?.prompt ?? promptToRun,
      resumeSessionId: currentSession.engineSessionId ?? undefined,
      systemPrompt: contextPacket?.systemPrompt ?? systemPrompt,
      cwd: currentSession.cwd || CUTTLEFISH_HOME,
      bin: engineConfig.bin,
      model: currentSession.model ?? engineConfig.model,
      effortLevel: invocation.effortLevel,
      cliFlags: invocation.cliFlags,
      restrictToJudgeOnly: isAutonomousVerdictSession(currentSession.transportMeta),
      attachments: attachments?.length ? attachments : undefined,
      ...(contextPacket?.historyMessages ? { historyMessages: contextPacket.historyMessages } : {}),
      sessionId: currentSession.id,
      source: currentSession.source,
      onActivity: () => { lastStreamAt = Date.now(); },
      onStream: (delta) => {
        if (!getSession(currentSession.id)) return;
        if (delta.type === "context") {
          const ctx = Number(delta.content);
          if (Number.isFinite(ctx) && ctx > 0) {
            updateSession(currentSession.id, { lastContextTokens: ctx });
          }
        }
        const now = Date.now();
        lastStreamAt = now; // any delta is proof of life — feeds the stall watchdog
        if (now - lastHeartbeatAt >= 2000) {
          lastHeartbeatAt = now;
          updateSession(currentSession.id, {
            status: "running",
            lastActivity: new Date(now).toISOString(),
          });
        }
        try {
          context.emit("session:delta", {
            sessionId: currentSession.id,
            type: delta.type,
            content: delta.content,
            toolName: delta.toolName,
            toolId: delta.toolId,
            input: delta.input,
          });
        } catch (err) {
          logger.warn(`Failed to emit stream delta for session ${currentSession.id}: ${err instanceof Error ? err.message : err}`);
        }
        try {
          persistPartialDelta(delta);
        } catch (err) {
          logger.warn(`Failed to persist partial block for session ${currentSession.id}: ${err instanceof Error ? err.message : err}`);
        }
        if (
          currentSession.source === "talk" &&
          !isTalkMuted(currentSession.id) &&
          delta.type === "text" &&
          typeof delta.content === "string"
        ) {
          feedTalkText(currentSession.id, delta.content, config.talk?.kokoro, context.emit);
        }
      },
      onLateRecovery: ({ result: lateText, sessionId: engineSid }) => {
        const live = getSession(currentSession.id);
        if (!live || live.status === "running") return;
        insertMessage(currentSession.id, "assistant", lateText);
        const recovered = updateSession(currentSession.id, {
          ...(engineSid.trim() ? { engineSessionId: engineSid } : {}),
          status: "idle",
          lastActivity: new Date().toISOString(),
          lastError: null,
        });
        const labelled = `(recovered — this supersedes the earlier reported failure)\n\n${lateText}`;
        if (recovered) {
          notifyParentSession(recovered, { result: labelled, error: null }, { alwaysNotify: parentNotifyAlwaysNotify, sink: context.notificationSink });
          void deliverConnectorReply(recovered, labelled, context.connectors, { emit: context.emit }).catch((err) => {
            logger.warn(`Failed to deliver connector reply for session ${recovered.id}: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
        context.emit("session:completed", {
          sessionId: currentSession.id,
          employee: currentSession.employee || config.portal?.portalName || "Cuttlefish",
          title: currentSession.title,
          result: lateText,
          error: null,
        });
        logger.info(`Web session ${currentSession.id} recovered by late Stop after a failed turn`);
      },
        }),
      );
      } finally {
        if (stallWatchdog) clearInterval(stallWatchdog);
      }
      if (!stallKilled || !shouldRetrySameEngineAfterStall(stallAttempt, maxStallRetries)) break;
      deletePartialMessages(currentSession.id);
      logger.warn(
        `[watchdog] web session ${currentSession.id} retrying after stall ` +
          `(attempt ${stallAttempt + 2}/${maxStallRetries + 1})`,
      );
    }
    } finally {
      clearInterval(runHeartbeat);
      if (partialFlushTimer) { clearTimeout(partialFlushTimer); partialFlushTimer = null; }
      flushPartialText();
    }
    logManagerDelegationTelemetryOnce();

    if (!getSession(currentSession.id)) {
      logger.info(`Skipping completion for deleted web session ${currentSession.id}`);
      return;
    }

    if (stalledReason) {
      if (await attemptEscalation("stall", stalledReason)) return;
      const attempts = maxStallRetries + 1;
      const errMsg =
        `Stalled: ${stalledReason}. Auto-recovery exhausted after ${attempts} ` +
        `attempt${attempts === 1 ? "" : "s"} and model escalation found no stronger model — needs attention.`;
      logger.error(`Web session ${currentSession.id} stalled out: ${errMsg}`);
      deletePartialMessages(currentSession.id);
      insertMessage(currentSession.id, "assistant", `⛔ ${errMsg}`);
      const stalledSession = updateSession(currentSession.id, {
        status: "error",
        lastActivity: new Date().toISOString(),
        lastError: errMsg,
      });
      context.emit("session:completed", { sessionId: currentSession.id, result: null, error: errMsg, stalled: true });
      maybeEmitTalkGraph(currentSession.id, "completed", { getSession, emit: context.emit });
      if (stalledSession) {
        notifyParentSession(stalledSession, { error: errMsg }, { alwaysNotify: parentNotifyAlwaysNotify, sink: context.notificationSink });
        void deliverConnectorReply(stalledSession, `⛔ ${errMsg}`, context.connectors, { emit: context.emit }).catch((err) => {
          logger.warn(`Failed to deliver connector reply for session ${stalledSession.id}: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      return;
    }

    // Some interactive-engine exits surface the raw interrupt as `result`
    // instead of `error`. Treat both representations as the same terminal
    // condition so cron records do not turn a crashed run into success.
    const interruptionReason = result.error?.trim() || result.result.trim();
    const wasInterrupted = /^Interrupted\b/i.test(interruptionReason);
    const wasSuperseded = !wasInterrupted && isTurnSuperseded(currentSession.id, turnStartedAt);

    // An "Interrupted" result is normally a QUIET preemption — the user switched
    // engine, a newer turn superseded this one, or a stall-retry kicked in — and
    // should leave no error noise. But an engine that DIES on spawn before emitting
    // anything ALSO surfaces as an interrupt ("… process exited"), and that is a
    // real failure the user must see, not a silent no-op. Distinguish it: an
    // interrupt whose turn produced no streamed output and was not superseded by a
    // newer turn is an engine crash, so surface it instead of swallowing it. (This
    // is the silent-first-turn-failure seam: without it a bad engine bin, an
    // unauthenticated CLI, or a crash-on-spawn leaves the chat blank with no clue.)
    const engineDiedNoOutput = isEngineDiedNoOutput({
      wasInterrupted,
      wasSuperseded,
      hasPartialOutput: getMessages(currentSession.id).some((m) => m.partial),
      error: result.error,
      result: result.result,
    });

    const quietPreempted = (wasInterrupted || wasSuperseded) && !engineDiedNoOutput;

    if (engineDiedNoOutput) {
      // Turn the raw interrupt into a visible, actionable chat notification and let
      // the normal error path below mark the session errored + emit the error.
      const engineLabel = currentSession.engine;
      result.error = `The ${engineLabel} engine exited before responding — the CLI failed to start or crashed on spawn (no reply was produced).`;
      result.result = "";
      insertMessage(
        currentSession.id,
        "notification",
        `⚠️ ${result.error} Check that the "${engineLabel}" CLI is installed and signed in, then try again.`,
      );
    }

    if (!quietPreempted && isOrchestrationImplementationTurn(currentSession) && !result.error && !result.result?.trim()) {
      result.error = "Orchestration implementation turn produced no output";
    }

    const streamedBlocks = getMessages(currentSession.id).filter((m) => m.partial);
    const preserveStreamedBlocks = shouldPreserveStreamedBlocks({ quietPreempted, streamedBlocks });
    const resultAlreadyPersisted = preserveStreamedBlocks && resultAlreadyInStreamedBlocks(result.result, streamedBlocks);
    if (preserveStreamedBlocks) finalizePartialMessages(currentSession.id);
    else deletePartialMessages(currentSession.id);

    const rateLimit = !quietPreempted ? detectRateLimit(result) : { limited: false as const };

    if (rateLimit.limited) {
      recordEngineRateLimit(currentSession.engine, rateLimit.resetsAt);
      if (await attemptEscalation("usage", "engine usage/quota limit")) {
        return;
      }
      if (currentSession.source === "talk") discardTalkSpeech(currentSession.id);
      const emitDelta = (delta: StreamDelta) => {
        context.emit("session:delta", {
          sessionId: currentSession.id,
          type: delta.type,
          content: delta.content,
          toolName: delta.toolName,
        });
      };

      const outcome = await handleRateLimit({
        session: currentSession,
        prompt,
        systemPrompt,
        engineConfig,
        effortLevel,
        cliFlags: employee?.cliFlags,
        attachments: attachments?.length ? attachments : undefined,
        config,
        engines: context.sessionManager.getEngines(),
        employee,
        engine,
        sessionToken: scopedSessionToken,
        rateLimit,
        originalResult: result,
        hooks: {
          onFallbackStart: ({ resumeAt, originalEngine, fallbackName }) => {
            const resumeText = resumeAt
              ? resumeAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
              : null;
            const notificationText = rateLimitFallbackNotice(originalEngine, fallbackName, resumeText);
            insertMessage(currentSession.id, "notification", notificationText);

            notifyConnectorNotification(
              `⚠️ ${rateLimitSummary(originalEngine)} reached. Session ${currentSession.id}${currentSession.employee ? ` (${currentSession.employee})` : ""} switching to ${fallbackName}.`,
              { sink: context.notificationSink },
            );

            if (engine && isInterruptibleEngine(engine)) {
              engine.kill(currentSession.id, "Interrupted: engine switched");
            }
          },
          onFallbackStream: emitDelta,
          onFallbackComplete: (fallbackResult) => {
            if (fallbackResult.result) {
              insertMessage(currentSession.id, "assistant", fallbackResult.result);
            }

            const completedFallback = updateSession(currentSession.id, {
              engineSessionId: fallbackResult.sessionId,
              status: fallbackResult.error ? "error" : "idle",
              lastActivity: new Date().toISOString(),
              lastError: fallbackResult.error ?? null,
            });
            if (completedFallback) {
              recordSuccessfulWebSessionTurn(completedFallback.id, fallbackResult);
              notifyParentSession(completedFallback, { result: fallbackResult.result, error: fallbackResult.error ?? null, cost: fallbackResult.cost, durationMs: fallbackResult.durationMs }, { alwaysNotify: parentNotifyAlwaysNotify, sink: context.notificationSink });
              if (fallbackResult.result) {
                void deliverConnectorReply(completedFallback, fallbackResult.result, context.connectors, { emit: context.emit }).catch((err) => {
                  logger.warn(`Failed to deliver connector reply for session ${completedFallback.id}: ${err instanceof Error ? err.message : String(err)}`);
                });
              }
            }

            context.emit("session:completed", {
              sessionId: currentSession.id,
              employee: currentSession.employee || config.portal?.portalName || "Cuttlefish",
              title: currentSession.title,
              result: fallbackResult.result,
              error: fallbackResult.error || null,
              cost: fallbackResult.cost,
              durationMs: fallbackResult.durationMs,
            });
            maybeEmitTalkGraph(currentSession.id, "completed", { getSession, emit: context.emit });
          },
          onWaitingStart: ({ resumeAt }) => {
            const resumeText = resumeAt
              ? resumeAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
              : null;
            const sourceEngine = currentSession.engine;

            notifyConnectorNotification(
              `⚠️ ${rateLimitSummary(sourceEngine)} reached. Session ${currentSession.id}${currentSession.employee ? ` (${currentSession.employee})` : ""} paused${resumeText ? ` until ${resumeText}` : ""}.`,
              { sink: context.notificationSink },
            );

            const notificationText =
              rateLimitWaitingNotice(sourceEngine, resumeText);
            insertMessage(currentSession.id, "notification", notificationText);

            const waitingSession = getSession(currentSession.id);
            notifyRateLimited(
              (waitingSession ?? { ...currentSession, status: "waiting" }) as Session,
              resumeAt
                ? resumeAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
                : undefined,
              { sink: context.notificationSink },
            );

            context.emit("session:rate-limited", {
              sessionId: currentSession.id,
              employee: currentSession.employee,
              error: result.error,
              resetsAt: rateLimit.resetsAt ?? null,
            });
          },
          onRetryStream: emitDelta,
          onRetrySuccess: (retryResult) => {
            if (retryResult.result) {
              insertMessage(currentSession.id, "assistant", retryResult.result);
            }
            const sourceEngine = currentSession.engine;

            const completedAfterRetry = updateSession(currentSession.id, {
              ...(retryResult.sessionId?.trim() ? { engineSessionId: retryResult.sessionId } : {}),
              status: retryResult.error ? "error" : "idle",
              lastActivity: new Date().toISOString(),
              lastError: retryResult.error ?? null,
            });

            if (completedAfterRetry) {
              recordSuccessfulWebSessionTurn(completedAfterRetry.id, retryResult);
              notifyRateLimitResumed(completedAfterRetry, { sink: context.notificationSink });
              notifyConnectorNotification(
                `✅ ${rateLimitSummary(sourceEngine)} cleared. Session ${currentSession.id}${currentSession.employee ? ` (${currentSession.employee})` : ""} resumed.`,
                { sink: context.notificationSink },
              );
              notifyParentSession(completedAfterRetry, { result: retryResult.result, error: retryResult.error ?? null, cost: retryResult.cost, durationMs: retryResult.durationMs }, { alwaysNotify: parentNotifyAlwaysNotify, sink: context.notificationSink });
              if (retryResult.result) {
                void deliverConnectorReply(completedAfterRetry, retryResult.result, context.connectors, { emit: context.emit }).catch((err) => {
                  logger.warn(`Failed to deliver connector reply for session ${completedAfterRetry.id}: ${err instanceof Error ? err.message : String(err)}`);
                });
              }
            }

            context.emit("session:completed", {
              sessionId: currentSession.id,
              employee: currentSession.employee || config.portal?.portalName || "Cuttlefish",
              title: currentSession.title,
              result: retryResult.result,
              error: retryResult.error || null,
              cost: retryResult.cost,
              durationMs: retryResult.durationMs,
            });
            maybeEmitTalkGraph(currentSession.id, "completed", { getSession, emit: context.emit });
          },
          onTimeout: () => {
            const sourceEngine = currentSession.engine;
            const timeoutError = rateLimitTimeoutError(sourceEngine);
            notifyConnectorNotification(
              `❌ ${timeoutError}. Session ${currentSession.id}${currentSession.employee ? ` (${currentSession.employee})` : ""} has been stopped.`,
              { sink: context.notificationSink },
            );
            const erroredSession = updateSession(currentSession.id, {
              status: "error",
              lastActivity: new Date().toISOString(),
              lastError: timeoutError,
            });
            if (erroredSession) {
              notifyParentSession(erroredSession, { error: timeoutError }, { alwaysNotify: parentNotifyAlwaysNotify, sink: context.notificationSink });
            }
            context.emit("session:completed", {
              sessionId: currentSession.id,
              result: null,
              error: timeoutError,
            });
            maybeEmitTalkGraph(currentSession.id, "completed", { getSession, emit: context.emit });
          },
        },
      });

      void outcome; // outcome handled entirely via hooks
      return;
    }

    if (result.result && !resultAlreadyPersisted && !quietPreempted) {
      insertMessage(currentSession.id, "assistant", result.result);
    }

    if (currentSession.source === "talk") {
      if (quietPreempted || isTalkMuted(currentSession.id)) discardTalkSpeech(currentSession.id);
      else void flushTalkSpeech(currentSession.id, config.talk?.kokoro, context.emit);
    }

    const completedSession = updateSession(currentSession.id, {
      // A stopped/superseded turn can settle after its replacement has already
      // cleared or changed the resume id. Never let that stale completion put
      // its engine session id back onto the durable session record.
      ...(!quietPreempted && result.sessionId?.trim() ? { engineSessionId: result.sessionId } : {}),
      ...(typeof result.contextTokens === "number" ? { lastContextTokens: result.contextTokens } : {}),
      status: quietPreempted ? "idle" : (result.error ? "error" : "idle"),
      lastActivity: new Date().toISOString(),
      lastError: quietPreempted ? null : (result.error ?? null),
    });
    if (!quietPreempted && currentSession.engine === "claude") {
      markTranscriptSyncedThrough(currentSession.id, result.sessionId);
    }
    if (syncRequested && !rateLimit.limited && !quietPreempted) {
      patchSessionTransportMeta(currentSession.id, (current) => {
        const nextMeta = { ...current } as Record<string, unknown>;
        delete nextMeta["claudeSyncSince"];
        return nextMeta as any;
      });
    }
    clearSupersededTurnMeta(currentSession.id);
    const reportedError = quietPreempted ? null : (result.error ?? null);
    if (completedSession && !quietPreempted) {
      recordSuccessfulWebSessionTurn(completedSession.id, result);
      notifyParentSession(completedSession, { result: result.result, error: reportedError, cost: result.cost, durationMs: result.durationMs }, { alwaysNotify: parentNotifyAlwaysNotify, sink: context.notificationSink });
    }

    if (completedSession && !quietPreempted && result.result) {
      await deliverConnectorReply(completedSession, result.result, context.connectors, { emit: context.emit });
    }
    if (completedSession && !quietPreempted && context.knowledgeSink) {
      try {
        await emitSessionSummaryBestEffort({
          session: completedSession,
          messages: getMessages(completedSession.id),
          sink: context.knowledgeSink,
          ...knowledgeRelayOptions(context.getConfig()),
        });
      } catch (err) {
        logger.warn(`knowledge: failed to export session summary ${completedSession.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    context.emit("session:completed", {
      sessionId: currentSession.id,
      employee: currentSession.employee || config.portal?.portalName || "Cuttlefish",
      title: currentSession.title,
      result: quietPreempted ? null : result.result,
      error: reportedError,
      cost: result.cost,
      durationMs: result.durationMs,
    });
    maybeEmitTalkGraph(currentSession.id, "completed", { getSession, emit: context.emit });

    logger.info(
      `Web session ${currentSession.id} completed` +
      (result.durationMs ? ` in ${result.durationMs}ms` : "") +
      (result.cost ? ` ($${result.cost.toFixed(4)})` : ""),
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logManagerDelegationTelemetryOnce();
    if (!getSession(currentSession.id)) {
      logger.info(`Skipping error handling for deleted web session ${currentSession.id}: ${errMsg}`);
      return;
    }
    deletePartialMessages(currentSession.id);
    const erroredSession = updateSession(currentSession.id, {
      status: "error",
      lastActivity: new Date().toISOString(),
      lastError: errMsg,
    });
    if (erroredSession) {
      notifyParentSession(erroredSession, { error: errMsg }, { alwaysNotify: parentNotifyAlwaysNotify, sink: context.notificationSink });
    }
    context.emit("session:completed", {
      sessionId: currentSession.id,
      result: null,
      error: errMsg,
    });
    maybeEmitTalkGraph(currentSession.id, "completed", { getSession, emit: context.emit });
    logger.error(`Web session ${currentSession.id} error: ${errMsg}`);
  }
}

function isOrchestrationImplementationTurn(session: Session): boolean {
  const lease = (session.transportMeta as Record<string, unknown> | undefined)?.orchestrationLease as { role?: unknown } | undefined;
  if (!lease) return false;
  const role = typeof lease.role === "string" ? lease.role.toLowerCase() : "";
  return !role.includes("review");
}

async function enforceManagerDelegationIfNeeded(input: {
  session: Session;
  prompt: string;
  employee: import("../shared/types.js").Employee | undefined;
  supervisedNodes: import("../shared/types.js").OrgNode[];
  config: CuttlefishConfig;
  context: ApiContext;
  attachments?: string[];
  resourceContext?: string | null;
  logTelemetry: () => void;
}): Promise<boolean> {
  const { session, prompt, employee, supervisedNodes, config, context } = input;
  if (!employee || employee.mcp === false || supervisedNodes.length === 0) return false;
  // A parented manager already received a bounded work package from its
  // delegator. Keyword-only gateway fan-out loses that package's acceptance
  // criteria and caused nested workers to start without an actionable task.
  // Let the manager read the full brief and use its delegation discipline to
  // create semantically complete child assignments itself.
  if (session.parentSessionId) return false;
  if (isExecutionDepthBlocked(session.transportMeta as Record<string, unknown> | undefined)) return false;
  if (!isInitialManagerDelegationTurn(getMessages(session.id))) return false;

  const promptHash = delegationPromptHash(prompt, input.resourceContext);
  const meta = ((session.transportMeta ?? {}) as Record<string, unknown>);
  const enforcedHashes = Array.isArray(meta.managerDelegationEnforcedPromptHashes)
    ? meta.managerDelegationEnforcedPromptHashes.filter((value): value is string => typeof value === "string")
    : [];
  if (enforcedHashes.includes(promptHash)) return false;

  const plan = buildManagerDelegationPlan({ manager: employee, prompt, supervisedNodes });
  if (!plan.enforced || plan.matches.length === 0) return false;

  const runnableMatches = plan.matches.filter((match) => {
    const childEngine = context.sessionManager.getEngine(match.employee.engine);
    if (!childEngine) {
      logger.warn(`[manager-delegation] cannot enforce delegation from ${employee.name} to ${match.employee.name}: engine "${match.employee.engine}" unavailable`);
      return false;
    }
    return true;
  });
  if (runnableMatches.length === 0) return false;

  const now = new Date().toISOString();
  const delegatedTo: string[] = [];
  const childSessionIds: string[] = [];
  const delegatedChildren: Array<{
    child: Session;
    match: typeof runnableMatches[number];
    engine: import("../shared/types.js").Engine;
  }> = [];
  for (const match of runnableMatches) {
    const child = createSession({
      engine: match.employee.engine,
      source: session.source,
      sourceRef: `${session.sourceRef}:manager-delegation:${promptHash}:${match.employee.name}`,
      connector: session.connector ?? session.source,
      sessionKey: `${session.sessionKey || session.sourceRef}:manager-delegation:${promptHash}:${match.employee.name}`,
      replyContext: session.replyContext,
      transportMeta: {
        managerDelegation: {
          enforced: true,
          parentEmployee: employee.name,
          matchedKeywords: match.matchedKeywords,
          promptHash,
        },
      },
      employee: match.employee.name,
      parentSessionId: session.id,
      model: match.employee.model,
      effortLevel: match.employee.effortLevel,
      title: `Delegated to ${match.employee.displayName}`,
      prompt: match.prompt,
      promptExcerpt: match.prompt,
      cwd: session.cwd,
      portalName: config.portal?.portalName,
    });
    delegatedTo.push(match.employee.name);
    childSessionIds.push(child.id);
    insertMessage(child.id, "user", match.prompt);
    maybeEmitTalkGraph(child.id, "added", { getSession, emit: context.emit });

    const childEngine = context.sessionManager.getEngine(match.employee.engine);
    if (!childEngine) continue;
    delegatedChildren.push({ child, match, engine: childEngine });
  }

  if (delegatedTo.length === 0) return false;

  const summary = `Delegated specialist work to ${delegatedTo.map((name) => `\`${name}\``).join(", ")}. I’ll synthesize after the report${delegatedTo.length === 1 ? "" : "s"} come back.`;
  insertMessage(session.id, "assistant", summary);
  const nextHashes = [...enforcedHashes.filter((hash) => hash !== promptHash), promptHash].slice(-20);
  const updated = updateSession(session.id, {
    status: "idle",
    transportMeta: {
      ...meta,
      managerDelegationEnforcedPromptHashes: nextHashes,
      managerDelegationEnforcement: {
        promptHash,
        delegatedTo,
        childSessionIds,
        completedChildSessionIds: [],
        reason: plan.reason,
        occurredAt: now,
        synthesisDispatched: false,
      },
    } as any,
    lastActivity: now,
    lastError: null,
  });

  // Persist the expected-child barrier before any child can finish and send a
  // callback. Starting children inside the creation loop left a small fast-run
  // race where an immediate result could wake the parent before this metadata
  // existed, bypassing the one-synthesis guard.
  for (const { child, match, engine: childEngine } of delegatedChildren) {
    void context.sessionManager.getQueue().enqueue(child.sessionKey || child.sourceRef, async () => {
      context.emit("session:started", { sessionId: child.id });
      // Delegated children receive only their bounded assignment. Parent files
      // and resource context can contain manager-only data, so they are never
      // forwarded implicitly with automatic delegation.
      await runWebSession(child, match.prompt, childEngine, config, context);
    }).catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[manager-delegation] delegated child ${child.id} dispatch error: ${errMsg}`);
      updateSession(child.id, {
        status: "error",
        lastActivity: new Date().toISOString(),
        lastError: errMsg,
      });
      context.emit("session:completed", { sessionId: child.id, result: null, error: errMsg });
      maybeEmitTalkGraph(child.id, "completed", { getSession, emit: context.emit });
    });
  }
  input.logTelemetry();
  context.emit("session:updated", { sessionId: session.id });
  context.emit("manager:delegated", {
    sessionId: session.id,
    employee: employee.name,
    delegatedTo,
    promptHash,
    enforced: true,
  });
  if (updated) {
    void deliverConnectorReply(updated, summary, context.connectors, { emit: context.emit }).catch((err) => {
      logger.warn(`Failed to deliver manager delegation notice for session ${updated.id}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  logger.info(`[manager-delegation] enforced delegation for session ${session.id}: ${employee.name} -> ${delegatedTo.join(", ")}`);
  return true;
}

function delegationPromptHash(prompt: string, resourceContext?: string | null): string {
  return createHash("sha256")
    .update(resourceContext ?? "")
    .update("\n---prompt---\n")
    .update(prompt)
    .digest("hex")
    .slice(0, 16);
}
