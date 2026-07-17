import type http from "node:http";
import fs from "node:fs";
import type { WebSocket, WebSocketServer } from "ws";
import type { Connector } from "../../shared/types.js";
import { logger } from "../../shared/logger.js";
import type { HookRegistry } from "../hook-registry.js";
import type { PtyLifecycleManager } from "../../engines/pty-lifecycle.js";
import type { OrchestrationRuntime } from "../../orchestration/runtime.js";

export type GatewayCleanup = () => Promise<void>;

interface GatewayCleanupDeps {
  claudeLifecycle: PtyLifecycleManager;
  connectors: Connector[];
  gatewayInfoFile: string;
  getRunningSessions: () => Array<{ id: string }>;
  hookRegistry: HookRegistry;
  interruptSession: (sessionId: string) => void;
  killEngines: () => void;
  orchestrationRuntime: OrchestrationRuntime | undefined;
  ptyWss: WebSocketServer;
  server: http.Server;
  stopBoardWorker: () => void;
  stopStuckTicketWatchdog: () => void;
  stopLeaderAckReconciler: () => void;
  stopScheduler: () => void;
  stopStatusReconciler: () => void;
  stopWatchers: () => Promise<void>;
  stopWsHeartbeat: () => void;
  uploadCleanupTimer: NodeJS.Timeout;
  mcpConfigSweepTimer?: NodeJS.Timeout;
  knowledgeRelayTimer?: NodeJS.Timeout;
  stopEmailService?: () => void;
  /** Release the macOS sleep assertion (no-op if not held). */
  stopSleepGuard?: () => void;
  /** Kill the Kokoro TTS sidecar (if one was spawned this session). */
  stopTts?: () => void;
  wsClients: Set<WebSocket>;
  wss: WebSocketServer;
}

export function createGatewayCleanup({
  claudeLifecycle,
  connectors,
  gatewayInfoFile,
  getRunningSessions,
  hookRegistry,
  interruptSession,
  killEngines,
  orchestrationRuntime,
  ptyWss,
  server,
  stopBoardWorker,
  stopStuckTicketWatchdog,
  stopLeaderAckReconciler,
  stopScheduler,
  stopStatusReconciler,
  stopWatchers,
  stopWsHeartbeat,
  uploadCleanupTimer,
  mcpConfigSweepTimer,
  knowledgeRelayTimer,
  stopEmailService,
  stopSleepGuard,
  stopTts,
  wsClients,
  wss,
}: GatewayCleanupDeps): GatewayCleanup {
  return async () => {
    logger.info("Gateway cleanup starting...");

    stopStatusReconciler();
    stopBoardWorker();
    stopStuckTicketWatchdog();
    stopLeaderAckReconciler();
    clearInterval(uploadCleanupTimer);
    if (mcpConfigSweepTimer) clearInterval(mcpConfigSweepTimer);
    if (knowledgeRelayTimer) clearInterval(knowledgeRelayTimer);
    stopEmailService?.();

    try {
      stopTts?.();
    } catch (err) {
      logger.warn(`Failed to stop TTS sidecar: ${err instanceof Error ? err.message : err}`);
    }

    try {
      stopSleepGuard?.();
    } catch (err) {
      logger.warn(`Failed to release sleep guard: ${err instanceof Error ? err.message : err}`);
    }

    const runningSessions = getRunningSessions();
    for (const session of runningSessions) {
      interruptSession(session.id);
      logger.info(`Marked session ${session.id} as interrupted for resume`);
    }

    killEngines();

    await orchestrationRuntime?.prepareForShutdown("Interrupted: gateway shutting down gracefully");
    orchestrationRuntime?.close();

    try {
      claudeLifecycle.dispose();
    } catch (err) {
      logger.warn(`Failed to dispose PTY lifecycle manager: ${err instanceof Error ? err.message : err}`);
    }

    try {
      hookRegistry.dispose();
    } catch (err) {
      logger.warn(`Failed to dispose hook registry: ${err instanceof Error ? err.message : err}`);
    }

    try {
      fs.rmSync(gatewayInfoFile, { force: true });
    } catch (err) {
      logger.warn(`Failed to remove ${gatewayInfoFile}: ${err instanceof Error ? err.message : err}`);
    }

    stopScheduler();

    for (const connector of connectors) {
      try {
        await connector.stop();
      } catch (err) {
        logger.error(`Failed to stop ${connector.name} connector: ${err instanceof Error ? err.message : err}`);
      }
    }

    await stopWatchers();
    stopWsHeartbeat();

    for (const client of wsClients) {
      client.terminate();
    }
    wsClients.clear();
    for (const client of ptyWss.clients) {
      client.terminate();
    }

    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => ptyWss.close(() => resolve()));
    await new Promise<void>((resolve, reject) => {
      server.closeAllConnections?.();
      server.closeIdleConnections?.();
      server.close((err) => (err ? reject(err) : resolve()));
    });

    logger.info("Gateway shutdown complete");
  };
}
