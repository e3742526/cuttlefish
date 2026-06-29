import fs from "node:fs";
import type {
  Connector,
  Employee,
  Engine,
  IncomingMessage,
  KnowledgeSink,
  CuttlefishConfig,
  Session,
  Target,
} from "../shared/types.js";
import { isInterruptibleEngine } from "../shared/types.js";
import {
  accumulateSessionCost,
  createSession,
  deleteSession,
  getSession,
  getSessionBySessionKey,
  getMessages,
  insertMessage,
  updateSession,
} from "./registry.js";
import { notifyConnectorNotification, notifyParentSession, notifyRateLimited, notifyRateLimitResumed } from "./callbacks.js";
import type { SessionNotificationSink } from "./notification-sink.js";
import { buildContext } from "./context.js";
import { SessionQueue } from "./queue.js";
import { CUTTLEFISH_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { resolveEffort } from "../shared/effort.js";
import { effortLevelsForModel, engineAvailable, isKnownEngine, engineUnavailableMessage } from "../shared/models.js";
import { detectRateLimit, isDeadSessionError } from "../shared/rateLimit.js";
import { getClaudeExpectedResetAt, isLikelyNearClaudeUsageLimit } from "../shared/usageAwareness.js";
import { getRecordedReset, usageConfig } from "../shared/usage-status.js";
import { loadJobs } from "../cron/jobs.js";
import { setCronJobEnabled, triggerCronJob } from "../cron/scheduler.js";
import { checkBudget } from "../gateway/budgets.js";
import { markTranscriptSyncedThrough } from "../gateway/external-turns.js";
import { resolveMcpServers, writeMcpConfigFile, cleanupMcpConfigFile } from "../mcp/resolver.js";
import {
  handleRateLimit,
  rateLimitFallbackNotice,
  rateLimitPausedNotice,
  rateLimitSummary,
  rateLimitTimeoutError,
  rateLimitWaitingNotice,
} from "./rate-limit-handler.js";
import { finalizeManagedSessionTurn, maybeRevertEngineOverride, mergeTransportMeta } from "./manager-helpers.js";
import { isUntrustedSource, wrapUntrustedMessage } from "./untrusted-input.js";
import { createScopedSessionToken } from "../gateway/auth.js";
export { mergeTransportMeta } from "./manager-helpers.js";

export type RouteOptions = {
  employee?: Employee;
  engine?: string;
  model?: string;
  title?: string;
};
export class SessionManager {
  private config: CuttlefishConfig;
  private engines: Map<string, Engine>;
  private connectorNames: string[];
  private queue = new SessionQueue();
  private connectorProvider: () => Map<string, Connector> = () => new Map();
  private notificationSink: SessionNotificationSink | undefined;
  private knowledgeSink: KnowledgeSink | undefined;
  private apiToken: string | undefined;

  constructor(
    config: CuttlefishConfig,
    engines: Map<string, Engine>,
    connectorNames: string[] = [],
    apiToken?: string,
  ) {
    this.config = config;
    this.engines = engines;
    this.connectorNames = connectorNames;
    this.apiToken = apiToken;
  }
  setConnectorProvider(provider: () => Map<string, Connector>): void {
    this.connectorProvider = provider;
  }
  setConfig(config: CuttlefishConfig): void {
    this.config = config;
  }
  setNotificationSink(sink: SessionNotificationSink): void {
    this.notificationSink = sink;
  }
  setKnowledgeSink(sink: KnowledgeSink | undefined): void {
    this.knowledgeSink = sink;
  }
  getEngine(name: string): Engine | undefined {
    return this.engines.get(name);
  }
  getEngines(): Map<string, Engine> {
    return this.engines;
  }
  getQueue(): SessionQueue {
    return this.queue;
  }

  async route(msg: IncomingMessage, connector: Connector, opts: RouteOptions = {}): Promise<{ sessionId: string } | void> {
    if (await this.handleCommand(msg, connector)) return;

    let session = getSessionBySessionKey(msg.sessionKey);
    if (!session) {
      session = createSession({
        engine: opts.engine ?? opts.employee?.engine ?? this.config.engines.default,
        source: msg.source,
        sourceRef: msg.sessionKey,
        connector: msg.connector,
        sessionKey: msg.sessionKey,
        replyContext: msg.replyContext,
        messageId: msg.messageId,
        transportMeta: msg.transportMeta,
        employee: opts.employee?.name ?? undefined,
        model: opts.model ?? opts.employee?.model ?? undefined,
        effortLevel: opts.employee?.effortLevel ?? undefined,
        title: opts.title,
        prompt: msg.text,
        portalName: this.config.portal?.portalName,
      });
      logger.info(
        `Created new session ${session.id} for ${msg.sessionKey}` +
        (opts.employee ? ` (employee: ${opts.employee.name})` : ""),
      );
    } else {
      const mergedMeta = mergeTransportMeta(session.transportMeta, msg.transportMeta);
      session = updateSession(session.id, {
        replyContext: msg.replyContext,
        messageId: msg.messageId ?? null,
        transportMeta: mergedMeta,
        ...(opts.model ? { model: opts.model } : {}),
      }) ?? session;
    }

    session = maybeRevertEngineOverride(session);
    this.queue.clearCancelled(msg.sessionKey);

    const target = connector.reconstructTarget(msg.replyContext);
    target.messageTs ??= msg.messageId;

    const attachmentPaths = msg.attachments
      .map((attachment) => attachment.localPath)
      .filter((filePath): filePath is string => !!filePath);

    if (session.status === "waiting") {
      const recordedReset = getRecordedReset(session.engine, usageConfig(this.config).fallbackWindowMins);
      const expectedResetAt = typeof recordedReset === "number" ? new Date(recordedReset * 1000) : getClaudeExpectedResetAt();
      const resumeText = expectedResetAt
        ? expectedResetAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
        : null;
      await connector.replyMessage(
        target,
        rateLimitPausedNotice(session.engine, resumeText),
      ).catch(() => {});
    }

    if (session.status === "running" && this.queue.isRunning(msg.sessionKey) && connector.getCapabilities().reactions) {
      await connector.addReaction(target, "clock1").catch(() => {});
    }

    const sessionId = session.id;

    await this.queue.enqueue(msg.sessionKey, () =>
      this.runSession(session!, msg, attachmentPaths, connector, target, opts.employee),
    );

    return { sessionId };
  }

  private async runSession(
    session: Session,
    msg: IncomingMessage,
    attachments: string[],
    connector: Connector,
    target: Target,
    employee?: Employee,
  ): Promise<void> {
    const liveSession = getSession(session.id);
    if (!liveSession) {
      logger.warn(`Skipping queued turn for deleted session ${session.id}`);
      return;
    }
    session = liveSession;

    const engine = this.engines.get(session.engine);
    if (!engine) {
      logger.error(`Engine "${session.engine}" not found for session ${session.id}`);
      await connector.replyMessage(target, `Error: engine "${session.engine}" not available.`);
      return;
    }

    insertMessage(session.id, "user", msg.text);

    // Pre-flight: fail fast with an actionable error if the engine's CLI binary
    // isn't installed. Otherwise the (interactive PTY) engine spawns a missing
    // command, exits silently, and the turn produces no output and no error.
    if (isKnownEngine(session.engine) && !engineAvailable(this.config, session.engine)) {
      const errMsg = engineUnavailableMessage(this.config, session.engine);
      logger.error(`Session ${session.id} blocked: ${errMsg}`);
      const erroredSession = updateSession(session.id, {
        status: "error",
        lastActivity: new Date().toISOString(),
        lastError: errMsg,
      });
      insertMessage(session.id, "assistant", `⛔ ${errMsg}`);
      await connector.replyMessage(target, `⛔ ${errMsg}`).catch(() => {});
      // Wake the parent COO if this was a delegated child session (parity with
      // the normal error path; no-op for top-level sessions).
      if (erroredSession) {
        notifyParentSession(erroredSession, { error: errMsg }, { alwaysNotify: employee?.alwaysNotify, sink: this.notificationSink });
      }
      return;
    }

    const capabilities = connector.getCapabilities();
    const decorateMessages = session.source !== "cron";

    if (decorateMessages && capabilities.reactions) {
      await connector.addReaction(target, "eyes").catch(() => {});
    }

    // Set native typing indicator (Slack assistant.threads.setStatus)
    const threadTs = target.thread || target.messageTs;
    if (decorateMessages && connector.setTypingStatus) {
      await connector.setTypingStatus(target.channel, threadTs, "is thinking...").catch(() => {});
    }

    // Resolve MCP config before try block so it's accessible in catch for cleanup
    let mcpConfigPath: string | undefined;

    let hierarchy: import("../shared/types.js").OrgHierarchy | undefined;
    try {
      const { scanOrg } = await import("../gateway/org.js");
      const { resolveOrgHierarchy, withPortalExecutive } = await import("../gateway/org-hierarchy.js");
      hierarchy = resolveOrgHierarchy(withPortalExecutive(scanOrg(), this.config.portal?.portalName));
    } catch { /* fallback to filesystem scan in context builder */ }

    try {
      const systemPrompt = buildContext({
        source: session.source,
        channel: msg.channel,
        thread: msg.thread,
        user: msg.user,
        cwd: session.cwd || CUTTLEFISH_HOME,
        employee,
        connectors: this.connectorNames,
        config: this.config,
        sessionId: session.id,
        sessionToken: this.apiToken ? createScopedSessionToken(session.id, this.apiToken) : undefined,
        channelName: (msg.transportMeta?.channelName as string) || undefined,
        hierarchy,
      });

      // Per-engine config keyed by engine name; unconfigured optional engines
      // resolve to {} (engine falls back to dynamic bin/model resolution).
      const engineConfig =
        (this.config.engines as unknown as Record<string, { bin?: string; model?: string; effortLevel?: string; childEffortOverride?: string } | undefined>)[
          session.engine
        ] ?? {};
      if (session.engine === "claude" || session.engine === "codex") {
        const mcpConfig = resolveMcpServers(this.config.mcp, employee);
        if (Object.keys(mcpConfig.mcpServers).length > 0) {
          mcpConfigPath = writeMcpConfigFile(mcpConfig, session.id);
        }
      }

      const effortLevel = resolveEffort(
        engineConfig,
        session,
        employee,
        effortLevelsForModel(this.config, session.engine, session.model ?? undefined),
      );

      // Mark running only after preflight (system prompt / engine config / effort)
      // succeeded — and inside the try, so any failure transitions to "error" in the
      // catch below instead of leaving the session stuck looking "running".
      updateSession(session.id, {
        status: "running",
        replyContext: msg.replyContext,
        messageId: msg.messageId ?? null,
        transportMeta: mergeTransportMeta(session.transportMeta, msg.transportMeta),
        lastActivity: new Date().toISOString(),
      });

      // If we previously switched engines while rate-limited, inject a sync transcript
      // so the original engine can resume with full context when it comes back online.
      const syncSinceIso = (session.transportMeta as any)?.claudeSyncSince;
      let promptToRun = isUntrustedSource(session.source)
        ? wrapUntrustedMessage(msg.text, { source: session.source, user: msg.user })
        : msg.text;
      const syncSinceMs = typeof syncSinceIso === "string" ? new Date(syncSinceIso).getTime() : NaN;
      const syncRequested = session.engine === "claude" && typeof syncSinceIso === "string" && Number.isFinite(syncSinceMs);
      if (syncRequested) {
        const sinceMessages = getMessages(session.id)
          .filter((m) => (m.role === "user" || m.role === "assistant") && m.timestamp >= syncSinceMs)
          .map((m) => `${m.role.toUpperCase()}: ${m.content}`);
        const transcript = sinceMessages.slice(-20).join("\n\n");
        promptToRun =
          `We temporarily switched engines due to a usage limit on ${session.engine}. Sync your context with this transcript (most recent last), then respond to the last USER message.\n\n${transcript}`;
      }

      // Budget enforcement — check BEFORE engine.run()
      if (session.employee) {
        const budgetConfig = (this.config as any).budgets?.employees as Record<string, number> | undefined;
        if (budgetConfig && session.employee in budgetConfig) {
          const budgetStatus = checkBudget(session.employee, budgetConfig);
          if (budgetStatus === 'paused') {
            logger.warn(`Session ${session.id} blocked: employee "${session.employee}" has exceeded their budget`);
            const pausedMsg = `Budget limit exceeded for employee "${session.employee}". Session blocked.`;
            updateSession(session.id, {
              status: 'error',
              lastActivity: new Date().toISOString(),
              lastError: pausedMsg,
            });
            if (decorateMessages && connector.setTypingStatus) {
              await connector.setTypingStatus(target.channel, threadTs, '').catch(() => {});
            }
            await connector.replyMessage(target, `⛔ ${pausedMsg}`).catch(() => {});
            if (decorateMessages && capabilities.reactions) {
              await connector.removeReaction(target, 'eyes').catch(() => {});
            }
            return;
          }
        }
      }

      // Heuristic preflight warning: Claude usage limits don't expose a precise "remaining" budget.
      // If we've hit the limit recently and this looks like a heavy turn, warn before we spend time.
      if (decorateMessages && session.engine === "claude" && isLikelyNearClaudeUsageLimit()) {
        const modelName = (session.model ?? engineConfig.model ?? "").toLowerCase();
        const heavyEffort = ["high", "xhigh", "max"].includes((effortLevel || "").toLowerCase());
        const heavyModel = modelName.includes("opus");
        const looksBig = attachments.length > 0 || msg.text.length > 6000;
        if ((heavyEffort || heavyModel) && looksBig) {
          const expectedResetAt = getClaudeExpectedResetAt();
          const resumeText = expectedResetAt
            ? expectedResetAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
            : null;
          await connector.replyMessage(
            target,
            `⚠️ Heads up: Claude usage limits were hit recently, and this looks like a bigger task. If you're near the limit, it may pause${resumeText ? ` until ~${resumeText}` : ""}.`,
          ).catch(() => {});
        }
      }

      const result = await engine.run({
        prompt: promptToRun,
        resumeSessionId: session.engineSessionId ?? undefined,
        systemPrompt,
        cwd: session.cwd || CUTTLEFISH_HOME,
        bin: engineConfig.bin,
        model: session.model ?? engineConfig.model,
        effortLevel,
        cliFlags: employee?.cliFlags,
        mcpConfigPath,
        attachments: attachments.length > 0 ? attachments : undefined,
        sessionId: session.id,
        source: session.source,
        onLateRecovery: ({ result: lateText, sessionId: engineSid }) => {
          const live = getSession(session.id);
          if (!live || live.status === "running") return;
          insertMessage(session.id, "assistant", lateText);
          const recovered = updateSession(session.id, {
            ...(engineSid.trim() ? { engineSessionId: engineSid } : {}),
            status: "idle",
            lastActivity: new Date().toISOString(),
            lastError: null,
          });
          // The parent/channel already saw this turn fail — label the late answer
          // so it reads as a supersede, not a fresh unprompted turn.
          const labelled = `(recovered — this supersedes the earlier reported failure)\n\n${lateText}`;
          notifyParentSession(recovered ?? live, { result: labelled, error: null }, { alwaysNotify: employee?.alwaysNotify, sink: this.notificationSink });
          void connector.replyMessage(target, labelled).catch(() => {});
          logger.info(`Session ${session.id} recovered by late Stop after a failed turn`);
        },
      });

      const wasInterrupted = result.error?.startsWith("Interrupted");

      // Dead session detection: if the engine session ID is stale (expired/invalid),
      // clear cached engine sessions from transportMeta so the next attempt starts fresh.
      // Also sets a flag so we skip the rate-limit retry loop below (a dead session
      // error can contain text like "429" that would otherwise match RATE_LIMIT_ERROR_RE).
      const isDead = !wasInterrupted && isDeadSessionError(result);
      if (isDead) {
        logger.warn(`Dead session detected for ${session.id} — clearing stale engine IDs`);
        const meta = { ...(session.transportMeta || {}) } as Record<string, unknown>;
        delete meta["engineSessions"];
        delete meta["engineOverride"];
        updateSession(session.id, {
          engineSessionId: null,
          transportMeta: meta as any,
        });
        // Update local reference so subsequent code doesn't re-read stale IDs
        session = { ...session, engineSessionId: null, transportMeta: meta as any };
      }

      // Detect rate limit / usage limit errors and auto-retry.
      // Skip entirely for dead sessions — they are not rate limits.
      const rateLimit = (!wasInterrupted && !isDead) ? detectRateLimit(result) : { limited: false as const };
      if (rateLimit.limited) {
        const waitEmoji = "hourglass_flowing_sand";
        const sourceEngine = session.engine;

        const outcome = await handleRateLimit({
          session,
          prompt: msg.text,
          systemPrompt,
          engineConfig,
          effortLevel,
          cliFlags: employee?.cliFlags,
          mcpConfigPath,
          attachments,
          config: this.config,
          engines: this.engines,
          employee,
          engine,
          rateLimit,
          originalResult: result,
          hooks: {
            onFallbackStart: async ({ resumeAt, originalEngine, fallbackName }) => {
              const resumeText = resumeAt
                ? resumeAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
                : null;

              notifyConnectorNotification(
                `⚠️ ${rateLimitSummary(originalEngine)} reached. Session ${session.id}${session.employee ? ` (${session.employee})` : ""} switching to ${fallbackName}.`,
                { sink: this.notificationSink },
              );

              await connector.replyMessage(
                target,
                rateLimitFallbackNotice(originalEngine, fallbackName, resumeText),
              ).catch(() => {});

              // Switching away from the source engine — drop any warm PTY so it isn't orphaned.
              if (engine && isInterruptibleEngine(engine)) {
                engine.kill(session.id, "Interrupted: engine switched");
              }
            },
            onFallbackComplete: async (fallbackResult) => {
              const fallbackText = fallbackResult.result?.trim()
                ? fallbackResult.result
                : fallbackResult.error || "(No response from engine)";

              insertMessage(session.id, "assistant", fallbackText);
              if (fallbackResult.cost || fallbackResult.numTurns) {
                accumulateSessionCost(session.id, fallbackResult.cost ?? 0, fallbackResult.numTurns ?? 1);
              }

              if (decorateMessages && connector.setTypingStatus) {
                await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
              }
              await connector.replyMessage(target, fallbackText).catch(() => {});
              if (decorateMessages && capabilities.reactions) {
                await connector.removeReaction(target, "eyes").catch(() => {});
              }

              const updated = updateSession(session.id, {
                engineSessionId: fallbackResult.sessionId,
                ...(typeof fallbackResult.contextTokens === "number" ? { lastContextTokens: fallbackResult.contextTokens } : {}),
                status: fallbackResult.error ? "error" : "idle",
                replyContext: msg.replyContext,
                messageId: msg.messageId ?? null,
                transportMeta: mergeTransportMeta(getSessionBySessionKey(msg.sessionKey)?.transportMeta ?? session.transportMeta, msg.transportMeta),
                lastActivity: new Date().toISOString(),
                lastError: fallbackResult.error ?? null,
              });
              if (updated) {
                notifyParentSession(updated, { result: fallbackResult.result, error: fallbackResult.error ?? null, cost: fallbackResult.cost, durationMs: fallbackResult.durationMs }, { alwaysNotify: employee?.alwaysNotify, sink: this.notificationSink });
              }
            },
            onWaitingStart: async ({ resumeAt }) => {
              const resumeText = resumeAt
                ? resumeAt.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
                : null;

              // Send a deterministic connector notification — does not depend on the LLM
              notifyConnectorNotification(
                `⚠️ ${rateLimitSummary(sourceEngine)} reached. Session ${session.id}${session.employee ? ` (${session.employee})` : ""} paused${resumeText ? ` until ${resumeText}` : ""}.`,
                { sink: this.notificationSink },
              );

              // Clear "thinking" UI and show waiting state
              if (decorateMessages && connector.setTypingStatus) {
                await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
              }
              if (decorateMessages && capabilities.reactions) {
                await connector.removeReaction(target, "eyes").catch(() => {});
                await connector.addReaction(target, waitEmoji).catch(() => {});
              }

              const waitingSession = getSessionBySessionKey(msg.sessionKey) ?? session;
              notifyRateLimited(
                waitingSession,
                resumeAt
                  ? resumeAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
                  : undefined,
                { sink: this.notificationSink },
              );

              await connector.replyMessage(
                target,
                rateLimitWaitingNotice(sourceEngine, resumeText),
              ).catch(() => {});
            },
            onRetryAttempt: async () => {
              // Show active processing again
              if (decorateMessages && connector.setTypingStatus) {
                await connector.setTypingStatus(target.channel, threadTs, "is thinking...").catch(() => {});
              }
              if (decorateMessages && capabilities.reactions) {
                await connector.removeReaction(target, waitEmoji).catch(() => {});
                await connector.addReaction(target, "eyes").catch(() => {});
              }
            },
            onStillLimited: async () => {
              // Return to waiting UI state
              if (decorateMessages && connector.setTypingStatus) {
                await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
              }
              if (decorateMessages && capabilities.reactions) {
                await connector.removeReaction(target, "eyes").catch(() => {});
                await connector.addReaction(target, waitEmoji).catch(() => {});
              }
            },
            onRetrySuccess: async (retryResult) => {
              // Success or different error — handle normally
              const retryText = retryResult.result?.trim()
                ? retryResult.result
                : retryResult.error || "(No response from engine)";

              insertMessage(session.id, "assistant", retryText);
              if (retryResult.cost || retryResult.numTurns) {
                accumulateSessionCost(session.id, retryResult.cost ?? 0, retryResult.numTurns ?? 1);
              }

              // Clear typing indicator & reactions
              if (decorateMessages && connector.setTypingStatus) {
                await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
              }
              if (decorateMessages && capabilities.reactions) {
                await connector.removeReaction(target, "eyes").catch(() => {});
                await connector.removeReaction(target, waitEmoji).catch(() => {});
              }

              await connector.replyMessage(target, retryText).catch(() => {});
              const retryUpdated = updateSession(session.id, {
                ...(retryResult.sessionId?.trim() ? { engineSessionId: retryResult.sessionId } : {}),
                ...(typeof retryResult.contextTokens === "number" ? { lastContextTokens: retryResult.contextTokens } : {}),
                status: retryResult.error ? "error" : "idle",
                replyContext: msg.replyContext,
                messageId: msg.messageId ?? null,
                transportMeta: mergeTransportMeta(getSessionBySessionKey(msg.sessionKey)?.transportMeta ?? session.transportMeta, msg.transportMeta),
                lastActivity: new Date().toISOString(),
                lastError: retryResult.error ?? null,
              });
              if (retryUpdated) {
                notifyRateLimitResumed(retryUpdated, { sink: this.notificationSink });
                notifyConnectorNotification(
                  `✅ ${rateLimitSummary(sourceEngine)} cleared. Session ${session.id}${session.employee ? ` (${session.employee})` : ""} resumed.`,
                  { sink: this.notificationSink },
                );
                notifyParentSession(retryUpdated, { result: retryResult.result, error: retryResult.error ?? null, cost: retryResult.cost, durationMs: retryResult.durationMs }, { alwaysNotify: employee?.alwaysNotify, sink: this.notificationSink });
              }
            },
            onTimeout: async () => {
              const timeoutError = rateLimitTimeoutError(sourceEngine);
              notifyConnectorNotification(
                `❌ ${timeoutError}. Session ${session.id}${session.employee ? ` (${session.employee})` : ""} has been stopped.`,
                { sink: this.notificationSink },
              );
              await connector.replyMessage(target, "Usage limit didn't reset in time. Please try again later.").catch(() => {});
              updateSession(session.id, {
                status: "error",
                lastActivity: new Date().toISOString(),
                lastError: timeoutError,
              });

              // Clear reactions on failure
              if (decorateMessages && capabilities.reactions) {
                await connector.removeReaction(target, "eyes").catch(() => {});
                await connector.removeReaction(target, waitEmoji).catch(() => {});
              }
            },
          },
        });

        void outcome; // outcome handled entirely via hooks
        return;
      }

      await finalizeManagedSessionTurn({
        session,
        msg,
        result,
        connector,
        target,
        threadTs,
        capabilities,
        decorateMessages,
        wasInterrupted: Boolean(wasInterrupted),
        syncRequested,
        rateLimitLimited: Boolean(rateLimit.limited),
        employee,
        notificationSink: this.notificationSink,
        knowledgeSink: this.knowledgeSink,
        config: this.config,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Session ${session.id} error: ${errMsg}`);

      const erroredSession = updateSession(session.id, {
        status: "error",
        lastActivity: new Date().toISOString(),
        lastError: errMsg,
      });
      if (erroredSession) {
        notifyParentSession(erroredSession, { error: errMsg }, { alwaysNotify: employee?.alwaysNotify, sink: this.notificationSink });
      }

      // Clear typing indicator on error
      if (decorateMessages && connector.setTypingStatus) {
        await connector.setTypingStatus(target.channel, threadTs, "").catch(() => {});
      }

      await connector.replyMessage(target, `Error: ${errMsg}`).catch(() => {});

      if (decorateMessages && capabilities.reactions) {
        await connector.removeReaction(target, "eyes").catch(() => {});
        await connector.removeReaction(target, "hourglass_flowing_sand").catch(() => {});
      }
    } finally {
      // Clean up temp attachment files downloaded from Slack
      for (const filePath of attachments) {
        try {
          fs.rmSync(filePath, { force: true });
        } catch {
          // Ignore cleanup errors — best effort
        }
      }

      if (mcpConfigPath) cleanupMcpConfigFile(session.id);
      // NOTE: the interactive engine's per-session --settings file is intentionally
      // NOT cleaned up here. A warm PTY survives across turns and re-reads that file
      // on every hook invocation — its lifetime is owned by PtyLifecycleManager
      // (onCleanup → cleanupSessionSettings), not the per-turn runSession lifecycle.
    }
  }

  async handleCommand(msg: IncomingMessage, connector: Connector): Promise<boolean> {
    const text = msg.text.trim();
    const target = connector.reconstructTarget(msg.replyContext);
    target.messageTs ??= msg.messageId;

    if (text === "/new" || text.startsWith("/new ")) {
      this.resetSession(msg.sessionKey);
      await connector.replyMessage(target, "Session reset. Starting fresh.");
      logger.info(`Session reset for ${msg.sessionKey}`);
      return true;
    }

    if (text === "/status" || text.startsWith("/status ")) {
      const session = getSessionBySessionKey(msg.sessionKey);
      if (!session) {
        await connector.replyMessage(target, "No active session for this conversation.");
        return true;
      }
      const queueDepth = this.queue.getPendingCount(session.sessionKey);
      const transportState = this.queue.getTransportState(session.sessionKey, session.status);
      const info = [
        `Session: ${session.id}`,
        `Engine: ${session.engine}`,
        `Connector: ${session.connector || session.source}`,
        `Model: ${session.model || this.config.engines[session.engine as "claude" | "codex" | "antigravity" | "grok" | "pi" | "kiro" | "hermes" | "ollama" | "kilo"]?.model || "default"}`,
        `State: ${transportState}`,
        `Queue depth: ${queueDepth}`,
        `Created: ${session.createdAt}`,
        `Last activity: ${session.lastActivity}`,
        session.lastError ? `Last error: ${session.lastError}` : null,
      ].filter(Boolean).join("\n");

      await connector.replyMessage(target, info);
      return true;
    }

    if (text.startsWith("/model")) {
      const nextModel = text.slice("/model".length).trim();
      if (!nextModel) {
        await connector.replyMessage(target, "Usage: /model <model-name>");
        return true;
      }

      const session = getSessionBySessionKey(msg.sessionKey);
      if (!session) {
        await connector.replyMessage(target, "No active session for this conversation.");
        return true;
      }

      updateSession(session.id, {
        model: nextModel,
        lastActivity: new Date().toISOString(),
      });
      await connector.replyMessage(target, `Model updated to \`${nextModel}\` for this session.`);
      return true;
    }

    if (text === "/doctor" || text.startsWith("/doctor ")) {
      const connectors = Array.from(this.connectorProvider().values());
      const connectorLines = connectors.length > 0
        ? connectors.map((candidate) => {
            const health = candidate.getHealth();
            return `- ${candidate.name}: ${health.status}${health.detail ? ` (${health.detail})` : ""}`;
          })
        : ["- none"];
      const info = [
        `Default engine: ${this.config.engines.default}`,
        `Claude: ${this.config.engines.claude.model}`,
        `Codex: ${this.config.engines.codex.model}`,
        ...(this.config.engines.antigravity ? [`Antigravity: ${this.config.engines.antigravity.model ?? "Gemini 3.5 Flash (Medium)"}`] : []),
        ...(this.config.engines.grok ? [`Grok: ${this.config.engines.grok.model ?? "grok-build"}`] : []),
        ...(this.config.engines.ollama ? [`Ollama: ${this.config.engines.ollama.model ?? "gemma4"}`] : []),
        ...(this.config.engines.kilo ? [`Kilo: ${this.config.engines.kilo.model ?? "default"}`] : []),
        "Connectors:",
        ...connectorLines,
      ].join("\n");
      await connector.replyMessage(target, info);
      return true;
    }

    if (text.startsWith("/cron")) {
      return this.handleCronCommand(text, connector, target);
    }

    return false;
  }

  resetSession(sessionKey: string): void {
    const session = getSessionBySessionKey(sessionKey);
    if (session) {
      // Tear down any live/warm engine process before deleting the session.
      const engine = this.engines.get(session.engine);
      if (engine && isInterruptibleEngine(engine)) {
        engine.kill(session.id, "Interrupted: session reset");
      }
      deleteSession(session.id);
      logger.info(`Deleted session ${session.id}`);
    }
  }

  private async handleCronCommand(text: string, connector: Connector, target: Target): Promise<boolean> {
    const [_, subcommand = "", ...rest] = text.split(/\s+/);
    const arg = rest.join(" ").trim();

    if (!subcommand || subcommand === "list") {
      const jobs = loadJobs();
      if (jobs.length === 0) {
        await connector.replyMessage(target, "No cron jobs configured.");
        return true;
      }

      const lines = jobs.map((job) =>
        `- ${job.name} (${job.id}) — ${job.enabled ? "enabled" : "disabled"} — ${job.schedule}`,
      );
      await connector.replyMessage(target, ["Cron jobs:", ...lines].join("\n"));
      return true;
    }

    if (subcommand === "run") {
      if (!arg) {
        await connector.replyMessage(target, "Usage: /cron run <job-id-or-name>");
        return true;
      }
      const result = await triggerCronJob(arg);
      await connector.replyMessage(
        target,
        !result.found
          ? `Cron job "${arg}" not found.`
          : !result.started
            ? `Cron job "${result.job.name}" already running; skipped overlap.`
            : `Triggered cron job "${result.job.name}".`,
      );
      return true;
    }

    if (subcommand === "enable" || subcommand === "disable") {
      if (!arg) {
        await connector.replyMessage(target, `Usage: /cron ${subcommand} <job-id-or-name>`);
        return true;
      }
      const job = setCronJobEnabled(arg, subcommand === "enable");
      await connector.replyMessage(
        target,
        job
          ? `Cron job "${job.name}" ${job.enabled ? "enabled" : "disabled"}.`
          : `Cron job "${arg}" not found.`,
      );
      return true;
    }

    await connector.replyMessage(target, "Usage: /cron [list|run|enable|disable] <job-id-or-name>");
    return true;
  }
}
