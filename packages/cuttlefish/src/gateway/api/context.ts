import type { Engine, CuttlefishConfig, KnowledgeReadProvider, KnowledgeSink } from "../../shared/types.js";
import type { OrchestrationConfig } from "../../orchestration/types.js";
import type { OrchestrationRuntime } from "../../orchestration/runtime.js";
import type { SessionNotificationSink } from "../../sessions/notification-sink.js";
import type { SessionManager } from "../../sessions/manager.js";
import type { EmailService } from "../../email/service.js";
import type { Semaphore } from "../../shared/async-lock.js";

export interface ApiContext {
  config: CuttlefishConfig;
  sessionManager: SessionManager;
  startTime: number;
  getConfig: () => CuttlefishConfig;
  emit: (event: string, payload: unknown) => void;
  connectors: Map<string, import("../../shared/types.js").Connector>;
  notificationSink?: SessionNotificationSink;
  knowledgeSink?: KnowledgeSink;
  knowledgeReadProvider?: KnowledgeReadProvider;
  relayKnowledgeOutbox?: () => Promise<{ attempted: number; delivered: number; failed: number }>;
  reloadConnectorInstances?: () => Promise<{ started: string[]; stopped: string[]; errors: string[] }>;
  /** Re-read config.yaml into memory immediately (same as the file-watcher does,
   *  but synchronous). Call after a handler writes config.yaml so getConfig()
   *  reflects the change without waiting on the debounced watcher (~1s). */
  reloadConfig?: () => void;
  hookRegistry?: import("../hook-registry.js").HookRegistry;
  hookSecret?: string;
  /** Gateway API token generated into gateway.json. Used to mint short-lived PTY websocket tokens. */
  apiToken?: string;
  /** Gateway auth token generated into gateway.json. Used by route-local high-risk mutation guards. */
  gatewayAuthToken?: string;
  /** Test-injectable Cuttlefish home for auth device storage. Defaults to shared CUTTLEFISH_HOME. */
  cuttlefishHome?: string;
  /** PTY-backed Claude engine used by CLI-mode message sends so the user sees the
   *  prompt + response stream into the live xterm. Distinct from the headless
   *  "claude" engine in sessionManager (which chat/cron/connectors use). */
  interactiveClaudeEngine?: import("../../engines/claude-interactive.js").InteractiveClaudeEngine;
  /** PTY-capable engines keyed by engine name. Used by CLI-mode web sends. */
  ptyViewEngines?: Record<string, Engine & import("../../engines/pty-view-engine.js").PtyViewEngine>;
  /** Synchronously re-scan org/ into the gateway's in-memory employee registry
   *  (and drop warm PTYs). Called after an employee YAML write so the next session
   *  spawn sees the new persona/model immediately, rather than waiting ~800ms for
   *  the chokidar watcher. Wired in server.ts; same body as the watcher's onOrgChange. */
  reloadOrg?: () => void;
  /** In-memory (never persisted) post-settle background activity per session,
   *  maintained in server.ts from the interactive engine's onBackgroundActivity
   *  callback. lastActivityAt is epoch ms; serializeSession converts to ISO. */
  backgroundActivity?: Map<string, { activeStreams: number; lastActivityAt: number }>;
  /** Optional email inbox polling + inspection service. */
  emailService?: EmailService;
  /** Optional test/embedding override for observe-only orchestration routes. */
  orchestration?: {
    runtime?: OrchestrationRuntime;
    config?: OrchestrationConfig;
    configDir?: string;
    dbPath?: string;
    now?: () => Date;
    telemetryLogPath?: string;
    worktreeRoot?: string;
    dualLaneStateDir?: string;
    recoveryDir?: string;
  };
  /** Ledger-0007 Finding 2: bounds concurrent turn dispatches gateway-wide (the
   *  default (non-orchestration) dispatch path had no cap). Optional so tests
   *  that construct a minimal ApiContext keep working unchanged; absence means
   *  "no cap enforced" at the one call site that reads it. */
  runSemaphore?: Semaphore;
}
