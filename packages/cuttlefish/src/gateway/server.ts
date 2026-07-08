import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Engine, CuttlefishConfig } from "../shared/types.js";
import { loadConfig, normalizeClaudeEngineConfig } from "../shared/config.js";
import { seedTrust, cleanupSessionSettings } from "../shared/claude-settings.js";
import { configureLogger, logger } from "../shared/logger.js";
import { buildKnowledgeReadProvider } from "../knowledge/read/index.js";
import { buildKnowledgeSink } from "../knowledge/sinks/index.js";
import { knowledgeRelayOptions, relayPendingKnowledgeOutbox } from "../knowledge/outbox-service.js";
import { invalidateModelRegistry, refreshAiderModels, refreshCodexModels, refreshGrokModels, refreshHermesModels, refreshPiModels } from "../shared/models.js";
import { CLAUDE_SETTINGS_DIR, GATEWAY_INFO_FILE, HOOK_RELAY_SCRIPT, CUTTLEFISH_HOME, ORCH_DB, ORG_DIR } from "../shared/paths.js";
import { Semaphore } from "../shared/async-lock.js";
import { CodexEngine } from "../engines/codex.js";
import { CodexInteractiveEngine } from "../engines/codex-interactive.js";
import { InteractiveClaudeEngine } from "../engines/claude-interactive.js";
import { GrokEngine } from "../engines/grok.js";
import { GrokInteractiveEngine } from "../engines/grok-interactive.js";
import { HermesAcpEngine } from "../engines/hermes-acp.js";
import { HermesInteractiveEngine } from "../engines/hermes-interactive.js";
import { KiloEngine } from "../engines/kilo.js";
import { KiroEngine } from "../engines/kiro.js";
import { OllamaEngine } from "../engines/ollama.js";
import { PiEngine } from "../engines/pi.js";
import { PtyLifecycleManager } from "../engines/pty-lifecycle.js";
import type { PtyViewEngine } from "../engines/pty-view-engine.js";
import { AntigravityEngine } from "../engines/antigravity.js";
import { AiderEngine } from "../engines/aider.js";
import { AiderInteractiveEngine } from "../engines/aider-interactive.js";
import { buildEmailIngestPrompt, annotateEmailSession } from "../email/ingest.js";
import { ImapEmailMailboxClient } from "../email/client.js";
import { EmailService } from "../email/service.js";
import { markEmailMessageRunFailed } from "../email/store.js";
import type { OrchestrationRuntime } from "../orchestration/runtime.js";
import { initDb, clearAllPartialMessages, createSession, getInterruptedSessions, getSession, getSessionBySessionKey, listSessions, recoverStaleQueueItems, recoverStaleSessions, updateSession } from "../sessions/registry.js";
import { SessionManager } from "../sessions/manager.js";
import { initStt } from "../stt/stt.js";
import { shutdownTalkTts } from "../talk/tts-stream.js";
import { loadJobs } from "../cron/jobs.js";
import { reloadScheduler, startScheduler, stopScheduler } from "../cron/scheduler.js";
import { startBoardWorker } from "./board-worker.js";
import { startStuckTicketWatchdog } from "./stuck-ticket-watchdog.js";
import { logBoardSummary } from "./board-service.js";
import { syncBoardForEvent } from "./board-sync.js";
import { ensureGatewayAuthToken, shouldRequireGatewayAuth, validateGatewayExposure } from "./auth.js";
import { assertFetchOk, jsonApiHeaders } from "./internal-auth.js";
import { createGatewayNotificationSink } from "./notification-sink.js";
import { createGatewayOrchestrationRuntime } from "./orchestration-runtime-factory.js";
import {
  refreshDeferredOrchestrationRuntimeIfDrained,
  refreshOrchestrationRuntimeForOrgReload,
  swapOrchestrationRuntime,
  type OrchestrationRuntimeRefreshState,
} from "./orchestration-runtime-manager.js";
import { scanOrg } from "./org.js";
import { screenUntrustedText, screeningMetaForSession, screeningNotification } from "./content-screening.js";
import { reconcileOrphanedTickets } from "./orphaned-ticket-reconciler.js";
import { openUntrustedContentCheckpoint } from "./security-review.js";
import { startStatusReconciler } from "./status-reconciler.js";
import { buildLeaderAckEscalationPrompt, startLeaderAckReconciler, type LeaderAckEscalationDispatch } from "./leader-ack-reconciler.js";
import { syncExternalTurn } from "./external-turns.js";
import { HookRegistry } from "./hook-registry.js";
import { gatewayBaseUrl, readGatewayInfo, staleGatewayPids, updateGatewayPtyPids, writeGatewayInfo } from "./gateway-info.js";
import { startWatchers, stopWatchers, syncSkillSymlinks } from "./watcher.js";
import { cleanupOldUploads, ensureFilesDir } from "./files.js";
import { handleApiRequest, resumePendingWebQueueItems, type ApiContext } from "./api.js";
import { dispatchWebSessionRun } from "./api/session-dispatch.js";
import { startConfiguredConnectors } from "./server/connectors.js";
import { createGatewayCleanup, type GatewayCleanup } from "./server/cleanup.js";
import { createSleepGuard } from "./sleep-guard.js";
import { serveStatic, isAllowedCorsOrigin } from "./server/http-static.js";
import { bindOrchestrationRuntimeHandlers } from "./server/orchestration.js";
import { createGatewayTransports } from "./server/transports.js";
import { recoverOrphanedRunsAtStartup } from "../shared/run-recovery.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export { isAllowedCorsOrigin, serveStatic };

function screenNotificationPrompt(text: string, source: string, workerText: string): string {
  return text === workerText
    ? workerText
    : `[BEGIN UNTRUSTED MESSAGE via ${source} — sanitized before execution]\n${workerText}\n[END UNTRUSTED MESSAGE]`;
}

export async function startGateway(config: CuttlefishConfig): Promise<GatewayCleanup> {
  const bootId = randomUUID().slice(0, 8);

  configureLogger({
    level: config.logging.level,
    stdout: config.logging.stdout,
    file: config.logging.file,
    maxSizeBytes: config.logging.maxSizeBytes,
    maxFiles: config.logging.maxFiles,
  });

  const gatewayName = config.portal?.portalName || "Cuttlefish";
  logger.info(`Starting ${gatewayName} gateway (boot ${bootId}, pid ${process.pid})...`);

  initDb();
  ensureFilesDir();
  try { cleanupOldUploads(30); } catch { }
  const uploadCleanupTimer = setInterval(() => {
    try { cleanupOldUploads(30); } catch { }
  }, 24 * 60 * 60 * 1000);
  uploadCleanupTimer.unref?.();

  const recovered = recoverStaleSessions();
  if (recovered > 0) {
    logger.info(`Recovered ${recovered} stale session(s) — marked as "interrupted" for resume`);
  }
  const resumable = getInterruptedSessions();
  if (resumable.length > 0) {
    logger.info(`${resumable.length} interrupted session(s) available for resume:`);
    for (const s of resumable) {
      logger.info(`  - ${s.id} (engine: ${s.engine}, employee: ${s.employee || "none"}, engineSessionId: ${s.engineSessionId})`);
    }
  }
  const recoveredQueue = recoverStaleQueueItems();
  if (recoveredQueue > 0) {
    logger.info(`Recovered ${recoveredQueue} in-flight queue item(s) from previous run — reset to pending`);
  }
  const sweptPartials = clearAllPartialMessages();

  // Sweep orphaned run-ledger entries: any run in non-terminal state with no
  // live session or orchestration allocation gets marked `interrupted`.
  // Orchestration-engine runs are skipped only when the orchestration runtime
  // is enabled, because it performs its own finer-grained boot-time sweep.
  const liveSessionIds = new Set(listSessions({ status: 'running' }).map((s) => s.id));
  recoverOrphanedRunsAtStartup(liveSessionIds, config.orchestration?.enabled === true);
  if (sweptPartials > 0) {
    logger.info(`Swept ${sweptPartials} stranded mid-turn partial message(s) from previous run`);
  }

  const port = config.gateway.port || 8888;
  const host = config.gateway.host || "127.0.0.1";
  let currentConfig = config;

  const exposure = validateGatewayExposure(config);
  if (!exposure.ok) throw new Error(exposure.error);
  const gatewayAuthToken = ensureGatewayAuthToken(CUTTLEFISH_HOME);
  if (shouldRequireGatewayAuth(config)) logger.info("Gateway auth enabled for privileged API and WebSocket routes");

  const claudeCfg = normalizeClaudeEngineConfig(config.engines.claude);
  const oldInfo = readGatewayInfo(GATEWAY_INFO_FILE);
  if (oldInfo) {
    for (const pid of staleGatewayPids(oldInfo)) {
      try {
        process.kill(pid, "SIGTERM");
        logger.info(`Reaping stale pid ${pid} from prior gateway`);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") {
          logger.warn(`Unexpected error reaping stale pid ${pid}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }

  const gatewayInfo = writeGatewayInfo(GATEWAY_INFO_FILE, { port, host, pid: process.pid, token: gatewayAuthToken });
  const hookRegistry = new HookRegistry();

  const relayCandidates = [
    path.join(__dirname, "..", "..", "..", "assets", "hook-relay.mjs"),
    path.join(__dirname, "..", "..", "assets", "hook-relay.mjs"),
    path.join(__dirname, "..", "assets", "hook-relay.mjs"),
  ];
  try {
    const relaySrc = relayCandidates.find((candidate) => fs.existsSync(candidate));
    if (relaySrc) fs.copyFileSync(relaySrc, HOOK_RELAY_SCRIPT);
    else logger.warn("hook-relay.mjs asset not found in any candidate location; interactive Claude hooks may not work");
  } catch (err) {
    logger.warn(`Failed to copy hook-relay.mjs: ${err instanceof Error ? err.message : err}`);
  }

  try {
    seedTrust(path.join(os.homedir(), ".claude.json"), CUTTLEFISH_HOME);
  } catch (err) {
    logger.warn(`Failed to seed Claude trust: ${err instanceof Error ? err.message : err}`);
  }

  let codexLifecycle: PtyLifecycleManager | undefined;
  let antigravityLifecycle: PtyLifecycleManager | undefined;
  let grokLifecycle: PtyLifecycleManager | undefined;
  let hermesLifecycle: PtyLifecycleManager | undefined;
  let aiderLifecycle: PtyLifecycleManager | undefined;

  function refreshPtyPids(): void {
    try {
      const pids = [
        ...claudeLifecycle.livePids(),
        ...(codexLifecycle ? codexLifecycle.livePids() : []),
        ...(antigravityLifecycle ? antigravityLifecycle.livePids() : []),
        ...(grokLifecycle ? grokLifecycle.livePids() : []),
        ...(hermesLifecycle ? hermesLifecycle.livePids() : []),
        ...(aiderLifecycle ? aiderLifecycle.livePids() : []),
      ];
      updateGatewayPtyPids(GATEWAY_INFO_FILE, pids);
    } catch {
    }
  }

  const claudeLifecycle = new PtyLifecycleManager({
    maxLivePtys: claudeCfg.maxLivePtys!,
    onAdopt: () => refreshPtyPids(),
    onCleanup: (id) => {
      cleanupSessionSettings(CLAUDE_SETTINGS_DIR, id);
      hookRegistry.unregister(id);
      refreshPtyPids();
    },
  });
  const interactiveClaudeEngine = new InteractiveClaudeEngine(claudeLifecycle, hookRegistry);
  codexLifecycle = new PtyLifecycleManager({
    maxLivePtys: claudeCfg.maxLivePtys!,
    onAdopt: () => refreshPtyPids(),
    onCleanup: () => refreshPtyPids(),
  });
  const codexInteractiveEngine = new CodexInteractiveEngine(codexLifecycle);
  antigravityLifecycle = new PtyLifecycleManager({
    maxLivePtys: claudeCfg.maxLivePtys!,
    onAdopt: () => refreshPtyPids(),
    onCleanup: () => refreshPtyPids(),
  });
  const antigravityEngine = new AntigravityEngine(antigravityLifecycle);
  grokLifecycle = new PtyLifecycleManager({
    maxLivePtys: claudeCfg.maxLivePtys!,
    onAdopt: () => refreshPtyPids(),
    onCleanup: () => refreshPtyPids(),
  });
  const grokInteractiveEngine = new GrokInteractiveEngine(grokLifecycle);
  hermesLifecycle = new PtyLifecycleManager({
    maxLivePtys: claudeCfg.maxLivePtys!,
    onAdopt: () => refreshPtyPids(),
    onCleanup: () => refreshPtyPids(),
  });
  const hermesInteractiveEngine = new HermesInteractiveEngine(hermesLifecycle);
  aiderLifecycle = new PtyLifecycleManager({
    maxLivePtys: claudeCfg.maxLivePtys!,
    onAdopt: () => refreshPtyPids(),
    onCleanup: () => refreshPtyPids(),
  });
  const aiderInteractiveEngine = new AiderInteractiveEngine(aiderLifecycle);
  const piEngine = new PiEngine();
  const kiroEngine = new KiroEngine({ configProvider: () => currentConfig });
  const ollamaEngine = new OllamaEngine();
  const kiloEngine = new KiloEngine();
  const aiderEngine = new AiderEngine();
  logger.info("Engines initialized: claude (interactive PTY), codex (headless + interactive PTY), antigravity (interactive PTY), grok (headless + interactive PTY), hermes (headless + interactive PTY), pi, kiro (headless), ollama (headless), kilo (headless), aider (headless + interactive PTY)");

  const codexEngine = new CodexEngine();
  const grokEngine = new GrokEngine();
  const hermesEngine = new HermesAcpEngine();
  const engines = new Map<string, Engine>();
  engines.set("claude", interactiveClaudeEngine);
  logger.info("Claude work turns: INTERACTIVE PTY (cc_entrypoint=cli, Max-subsidized)");
  engines.set("codex", codexEngine);
  engines.set("antigravity", antigravityEngine);
  engines.set("grok", grokEngine);
  engines.set("hermes", hermesEngine);
  engines.set("pi", piEngine);
  engines.set("kiro", kiroEngine);
  engines.set("ollama", ollamaEngine);
  engines.set("kilo", kiloEngine);
  engines.set("aider", aiderEngine);

  const ptyViewEngines: Record<string, Engine & PtyViewEngine> = {
    claude: interactiveClaudeEngine,
    codex: codexInteractiveEngine,
    antigravity: antigravityEngine,
    grok: grokInteractiveEngine,
    hermes: hermesInteractiveEngine,
    aider: aiderInteractiveEngine,
  };

  const connectorNames: string[] = [];
  if (config.connectors?.slack?.appToken && config.connectors?.slack?.botToken) connectorNames.push("slack");
  if (config.connectors?.whatsapp) connectorNames.push("whatsapp");

  const sessionManager = new SessionManager(config, engines, connectorNames, gatewayAuthToken);
  let employeeRegistry = scanOrg();
  logger.info(`Loaded ${employeeRegistry.size} employee(s) from org directory`);

  const { connectors, connectorMap, reloadConnectorInstances } = startConfiguredConnectors({
    config,
    sessionManager,
    getEmployeeRegistry: () => employeeRegistry,
  });
  sessionManager.setConnectorProvider(() => connectorMap);

  const cronJobs = loadJobs();
  startScheduler(cronJobs, sessionManager, config, connectorMap);
  logger.info(`Loaded ${cronJobs.length} cron job(s)`);

  const startTime = Date.now();
  const wsClients = new Set<import("ws").WebSocket>();
  const emit = (event: string, payload: unknown): void => {
    const message = JSON.stringify({ event, payload, ts: Date.now() });
    for (const client of wsClients) {
      if (client.readyState === 1) {
        try {
          client.send(message);
        } catch (err) {
          logger.warn(`WebSocket send failed, removing dead client: ${err instanceof Error ? err.message : err}`);
          wsClients.delete(client);
        }
      }
    }
    if (
      event === "session:started" || event === "session:completed" ||
      event === "session:fallback-required" || event === "approval:resolved"
    ) {
      try {
        syncBoardForEvent(event, payload, {
          getSession,
          resolveDepartment: (name) => employeeRegistry.get(name)?.department,
          orgDir: ORG_DIR,
          emit,
        });
      } catch (err) {
        logger.warn(`[board-sync] failed for ${event}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  const refreshDynamicModels = (cfg: CuttlefishConfig): void => {
    void Promise.all([refreshCodexModels(cfg), refreshPiModels(cfg), refreshGrokModels(cfg), refreshHermesModels(cfg), refreshAiderModels(cfg)])
      .finally(() => emit("engines:updated", {}));
  };
  refreshDynamicModels(currentConfig);

  let orchestrationRuntime: OrchestrationRuntime | undefined;
  const orchestrationRefreshState: OrchestrationRuntimeRefreshState = { pending: false };
  let apiContext: ApiContext;

  const reloadOrg = (): void => {
    employeeRegistry = scanOrg();
    logger.info(`Org directory changed, reloaded ${employeeRegistry.size} employee(s)`);
    interactiveClaudeEngine.killIdle();
    codexInteractiveEngine.killIdle();
    antigravityEngine.killIdle();
    grokInteractiveEngine.killIdle();
    hermesInteractiveEngine.killIdle();
    aiderInteractiveEngine.killIdle();
    orchestrationRuntime = refreshOrchestrationRuntimeForOrgReload(
      apiContext,
      currentConfig,
      orchestrationRuntime,
      (nextConfig) => createGatewayOrchestrationRuntime(nextConfig, employeeRegistry),
      { refreshState: orchestrationRefreshState, reason: "org_reload" },
    );
    bindOrchestrationRuntimeHandlers(orchestrationRuntime, apiContext);
    emit("org:changed", {});
  };

  const backgroundActivity = new Map<string, { activeStreams: number; lastActivityAt: number }>();
  interactiveClaudeEngine.onBackgroundActivity((sessionId, info) => {
    if (info) backgroundActivity.set(sessionId, info);
    else backgroundActivity.delete(sessionId);
    emit("session:background", {
      sessionId,
      backgroundActivity: info
        ? { activeStreams: info.activeStreams, lastActivityAt: new Date(info.lastActivityAt).toISOString() }
        : null,
    });
  });

  hookRegistry.setUnclaimedHookHandler((cuttlefishSessionId, payload) => {
    try {
      syncExternalTurn(cuttlefishSessionId, emit, payload);
    } catch (err) {
      logger.warn(`Unclaimed-Stop sync failed for session ${cuttlefishSessionId}: ${err instanceof Error ? err.message : err}`);
    }
  });

  // Ledger-0007 Finding 2: default cap on concurrent turn dispatches; a
  // per-call `sessions.maxConcurrentRuns` override (hot-reloadable) takes
  // precedence at each acquire() — see session-dispatch.ts.
  const DEFAULT_MAX_CONCURRENT_RUNS = 12;
  const runSemaphore = new Semaphore(DEFAULT_MAX_CONCURRENT_RUNS);
  apiContext = {
    config: currentConfig,
    sessionManager,
    startTime,
    getConfig: () => currentConfig,
    emit,
    connectors: connectorMap,
    reloadConnectorInstances,
    hookRegistry,
    hookSecret: gatewayInfo.secret,
    apiToken: gatewayInfo.token,
    interactiveClaudeEngine,
    ptyViewEngines,
    reloadOrg,
    backgroundActivity,
    gatewayAuthToken,
    runSemaphore,
  };
  const emailService = new EmailService(currentConfig.email, {
    client: new ImapEmailMailboxClient(),
    onAutoIngest: async (message) => {
      const sessionKey = `email:${message.inboxId}:${message.threadKey}`;
      const existing = getSessionBySessionKey(sessionKey);
      const session = existing ?? createSession({
        engine: currentConfig.engines.default,
        source: "email",
        sourceRef: `${sessionKey}:${message.providerMessageId}`,
        connector: "email",
        sessionKey,
        title: message.subject ?? `Email ${message.inboxId}`,
        prompt: buildEmailIngestPrompt(message),
        promptExcerpt: message.subject ?? message.fromAddress ?? `Email ${message.inboxId}`,
      });
      annotateEmailSession(session.id, message);

      // CF2-205: email auto-ingest previously dispatched straight to the
      // engine with only the soft wrapUntrustedMessage() wrapper
      // (email/ingest.ts) applied — no heuristic/LLM classification,
      // quarantine, or checkpoint, unlike the connector/cron path's
      // untrustedContentGate (wired below via
      // sessionManager.setUntrustedContentGate). Run the same
      // screenUntrustedText gate here before dispatching.
      const screened = await screenUntrustedText(
        {
          text: message.textBody,
          source: "email_body",
          location: sessionKey,
          operatorIntent: message.subject ?? session.promptExcerpt ?? null,
        },
        apiContext,
      );
      const screenedMeta = { ...(session.transportMeta || {}) } as Record<string, unknown>;
      screenedMeta["latestUntrustedContentScreening"] = screeningMetaForSession(screened.screening);
      updateSession(session.id, { transportMeta: screenedMeta as any });
      if (screened.blocked) {
        openUntrustedContentCheckpoint(
          { sessionId: session.id, location: sessionKey, screening: screened.screening },
          apiContext,
        );
        logger.info(`Email ${message.id} quarantined pending human review (session ${session.id})`);
        return session.id;
      }

      const runningSession = updateSession(session.id, {
        status: "running",
        lastActivity: new Date().toISOString(),
        lastError: null,
      }) ?? session;
      const engine = apiContext.sessionManager.getEngine(runningSession.engine);
      if (!engine) throw new Error(`Engine "${runningSession.engine}" not available`);
      void dispatchWebSessionRun(
        runningSession,
        buildEmailIngestPrompt(message),
        engine,
        currentConfig,
        apiContext,
        { attachments: message.attachments.map((attachment) => attachment.artifactId).filter((id): id is string => typeof id === "string" && id.length > 0) },
      ).then(() => {
        // Reflect a failed agent run back onto the email record so `ingested` is not a
        // silent false-success: the run is dispatched fire-and-forget and records its
        // outcome on the session, so mirror a session error onto the email message.
        const finished = getSession(runningSession.id);
        if (finished?.status === "error") {
          markEmailMessageRunFailed(message.id, finished.lastError ?? "agent run failed");
        }
      }).catch(() => { /* dispatch already records failures on the session */ });
      return runningSession.id;
    },
  });
  apiContext.emailService = emailService;
  let knowledgeSink = buildKnowledgeSink(currentConfig);
  let knowledgeReadProvider = buildKnowledgeReadProvider(currentConfig);
  const relayKnowledgeOutbox = async (): Promise<{ attempted: number; delivered: number; failed: number }> =>
    relayPendingKnowledgeOutbox({
      sink: knowledgeSink,
      ...knowledgeRelayOptions(currentConfig),
    });
  apiContext.knowledgeSink = knowledgeSink;
  apiContext.knowledgeReadProvider = knowledgeReadProvider;
  apiContext.relayKnowledgeOutbox = relayKnowledgeOutbox;
  const notificationSink = createGatewayNotificationSink(apiContext);
  apiContext.notificationSink = notificationSink;
  sessionManager.setNotificationSink(notificationSink);
  sessionManager.setKnowledgeSink(knowledgeSink);
  sessionManager.setUntrustedContentGate(async ({ session, text }) => {
    const screened = await screenUntrustedText(
      {
        text,
        source: session.source === "email" ? "email_body" : "connector_message",
        location: session.sourceRef,
        operatorIntent: session.promptExcerpt ?? session.title ?? null,
      },
      apiContext,
    );
    const nextMeta = { ...(session.transportMeta || {}) } as Record<string, unknown>;
    nextMeta["latestUntrustedContentScreening"] = screeningMetaForSession(screened.screening);
    updateSession(session.id, { transportMeta: nextMeta as any });
    const prompt = screenNotificationPrompt(text, session.source, screened.workerText);
    if (screened.blocked) {
      openUntrustedContentCheckpoint(
        {
          sessionId: session.id,
          location: session.sourceRef,
          screening: screened.screening,
        },
        apiContext,
      );
      return {
        action: "checkpoint" as const,
        prompt,
        screening: screened.screening,
        notification: screeningNotification(screened.screening),
      };
    }
    return {
      action: "allow" as const,
      prompt,
      screening: screened.screening,
    };
  });
  orchestrationRuntime = createGatewayOrchestrationRuntime(currentConfig, employeeRegistry);
  if (orchestrationRuntime) {
    bindOrchestrationRuntimeHandlers(orchestrationRuntime, apiContext);
    apiContext.orchestration = { runtime: orchestrationRuntime };
  }

  const reloadConfig = (): void => {
    try {
      const nextConfig = loadConfig();
      // Re-run the boot-time exposure guard on every reload. A live PUT /api/config
      // that would expose an unauthenticated network gateway must be rejected here,
      // not merely at startup — otherwise the unsafe combination takes effect until
      // the next restart. On rejection, keep running with the prior config.
      const exposureOnReload = validateGatewayExposure(nextConfig);
      if (!exposureOnReload.ok) {
        logger.error(`Refusing config reload: ${exposureOnReload.error}`);
        return;
      }
      currentConfig = nextConfig;
      apiContext.config = currentConfig;
      emailService.setConfig(currentConfig.email);
      emailService.start();
      sessionManager.setConfig(currentConfig);
      knowledgeSink = buildKnowledgeSink(currentConfig);
      knowledgeReadProvider = buildKnowledgeReadProvider(currentConfig);
      apiContext.knowledgeSink = knowledgeSink;
      apiContext.knowledgeReadProvider = knowledgeReadProvider;
      sessionManager.setKnowledgeSink(knowledgeSink);
      invalidateModelRegistry();
      refreshDynamicModels(currentConfig);
      orchestrationRuntime = swapOrchestrationRuntime(
        apiContext,
        currentConfig,
        orchestrationRuntime,
        (nextConfig) => createGatewayOrchestrationRuntime(nextConfig, employeeRegistry),
        { refreshState: orchestrationRefreshState, reason: "config_reload" },
      );
      bindOrchestrationRuntimeHandlers(orchestrationRuntime, apiContext);
      logger.info("Config reloaded successfully");
      logBoardSummary(ORG_DIR, (msg) => logger.info(msg));
      emit("config:reloaded", {});
    } catch (err) {
      logger.error(`Failed to reload config: ${err instanceof Error ? err.message : err}`);
    }
  };
  apiContext.reloadConfig = reloadConfig;
  emailService.start();
  void relayKnowledgeOutbox();
  // Retry backstop only: the happy path relays on enqueue, so this timer just
  // re-drives previously-failed deliveries. 60s keeps the idle daemon from
  // running a claim query 4×/min against an (almost always) empty outbox.
  const knowledgeRelayTimer = setInterval(() => {
    void relayKnowledgeOutbox();
  }, 60_000);
  knowledgeRelayTimer.unref?.();

  const replayDeferredOrchestrationRuntimeRefresh = (): void => {
    if (!orchestrationRefreshState.pending) return;
    orchestrationRuntime = refreshDeferredOrchestrationRuntimeIfDrained(
      apiContext,
      currentConfig,
      orchestrationRuntime,
      orchestrationRefreshState,
      (nextConfig) => createGatewayOrchestrationRuntime(nextConfig, employeeRegistry),
    );
    bindOrchestrationRuntimeHandlers(orchestrationRuntime, apiContext);
  };

  void resumePendingWebQueueItems(apiContext);
  reconcileOrphanedTickets({ engines, orgDir: ORG_DIR, getSession, listSessions, emit, cause: "startup" });
  logBoardSummary(ORG_DIR, (msg) => logger.info(msg));

  const sleepGuard = createSleepGuard();

  const stopStatusReconciler = startStatusReconciler({
    engines,
    emit,
    notificationSink,
    onAfterSweep: () => {
      reconcileOrphanedTickets({ engines, orgDir: ORG_DIR, getSession, listSessions, emit });
      replayDeferredOrchestrationRuntimeRefresh();
      // Reconcile the macOS sleep assertion with real activity: held only
      // while sessions are running, released when the gateway goes idle.
      sleepGuard.update(listSessions({ status: "running" }).length > 0);
    },
  });
  const stopBoardWorker = startBoardWorker({ context: apiContext, orgDir: ORG_DIR });
  const stopStuckTicketWatchdog = startStuckTicketWatchdog({ context: apiContext, orgDir: ORG_DIR });
  let stopLeaderAckReconciler = () => {};

  const webDir = path.resolve(__dirname, "..", "..", "web");
  const authRequiredNow = (): boolean => shouldRequireGatewayAuth(currentConfig);
  const transports = createGatewayTransports({
    apiContext,
    authRequiredNow,
    gatewayAuthToken,
    gatewayName: `${gatewayName} (boot ${bootId})`,
    handleApiRequest: (req, res) => handleApiRequest(req, res, apiContext),
    host,
    cuttlefishHome: CUTTLEFISH_HOME,
    port,
    ptyViewEngines,
    getSession,
    webDir,
    wsClients,
  });

  syncSkillSymlinks();
  try {
    initStt();
  } catch (err) {
    logger.warn(`STT init skipped: ${err instanceof Error ? err.message : err}`);
  }

  startWatchers({
    onConfigReload: reloadConfig,
    onCronReload: () => {
      const updatedJobs = loadJobs();
      reloadScheduler(updatedJobs, currentConfig, connectorMap);
      logger.info(`Cron jobs reloaded (${updatedJobs.length} job(s))`);
      emit("cron:reloaded", {});
    },
    onOrgChange: reloadOrg,
    onSkillsChange: () => {
      logger.info("Skills changed, notifying clients");
      emit("skills:changed", {});
    },
  });

  await transports.startListening();

  stopLeaderAckReconciler = startLeaderAckReconciler({
    emit,
    getConfig: () => currentConfig,
    dispatchEscalation: async ({ childSession, recipient, ackLeaderName, timeoutMs }: LeaderAckEscalationDispatch) => {
      const gateway = readGatewayInfo(GATEWAY_INFO_FILE);
      if (!gateway) throw new Error("gateway info unavailable");
      const response = await fetch(`${gatewayBaseUrl(gateway)}/api/sessions`, {
        method: "POST",
        headers: jsonApiHeaders(gateway.token),
        body: JSON.stringify({
          employee: recipient.name,
          prompt: buildLeaderAckEscalationPrompt({ childSession, recipient, ackLeaderName, timeoutMs }),
          promptExcerpt: `Leader acknowledgement timeout for ${childSession.employee || childSession.id}`,
        }),
        // Fired from the reconciler timer — a stalled connection must not hold
        // the callback (and its response body) open indefinitely.
        signal: AbortSignal.timeout(30_000),
      });
      await assertFetchOk(response, "leader acknowledgement escalation");
    },
  });

  if (resumable.length > 0) {
    setTimeout(() => {
      emit("sessions:interrupted", {
        count: resumable.length,
        sessions: resumable.map((s) => ({
          id: s.id,
          engine: s.engine,
          employee: s.employee,
          title: s.title,
          lastActivity: s.lastActivity,
        })),
      });
    }, 1000);
  }

  // Seed the sleep guard from current state; the status reconciler sweep keeps
  // it reconciled from here on (acquired while sessions run, released at idle).
  sleepGuard.update(listSessions({ status: "running" }).length > 0);

  return createGatewayCleanup({
    stopSleepGuard: () => sleepGuard.stop(),
    stopTts: () => shutdownTalkTts(),
    claudeLifecycle,
    connectors,
    gatewayInfoFile: GATEWAY_INFO_FILE,
    getRunningSessions: () => listSessions({ status: "running" }),
    hookRegistry,
    interruptSession: (sessionId) => {
      updateSession(sessionId, {
        status: "interrupted",
        lastActivity: new Date().toISOString(),
        lastError: "Interrupted: gateway shutting down gracefully",
      });
    },
    killEngines: () => {
      interactiveClaudeEngine.killAll();
      codexEngine.killAll();
      codexInteractiveEngine.killAll();
      antigravityEngine.killAll();
      grokEngine.killAll();
      grokInteractiveEngine.killAll();
      hermesEngine.killAll();
      hermesInteractiveEngine.killAll();
      piEngine.killAll();
      kiroEngine.killAll();
      ollamaEngine.killAll();
      kiloEngine.killAll();
      aiderEngine.killAll();
      aiderInteractiveEngine.killAll();
    },
    orchestrationRuntime,
    ptyWss: transports.ptyWss,
    server: transports.server,
    stopBoardWorker,
    stopStuckTicketWatchdog,
    stopLeaderAckReconciler,
    stopScheduler,
    stopStatusReconciler,
    stopEmailService: () => emailService.stop(),
    stopWatchers,
    stopWsHeartbeat: transports.stopWsHeartbeat,
    uploadCleanupTimer,
    knowledgeRelayTimer,
    wsClients: transports.wsClients,
    wss: transports.wss,
  });
}
