import type {
  ConnectorInstance,
  SlackConnectorConfig,
  WebConnectorConfig,
  WhatsAppConnectorConfig,
} from "./connectors.js";
import type { GlobalModelFallbackConfig } from "./engine.js";
import type { McpGlobalConfig } from "./mcp.js";
import type { ModelConfigEntry, ModelsConfig, PortalConfig } from "./models.js";
import type { CronDelivery } from "./operations.js";
import type { EmailConfig } from "./email.js";

export interface BoardWorkerScheduleWindow {
  start: string;
  end: string;
}

export interface BoardWorkerConfig {
  enabled?: boolean;
  idleMinutes?: number;
  timezone?: string;
  schedule?: {
    weekday?: BoardWorkerScheduleWindow;
    weekend?: BoardWorkerScheduleWindow;
  };
  usage?: {
    minRemainingPercent?: number;
  };
}

export interface OrchestrationRuntimeConfig {
  enabled?: boolean;
  configDir?: string;
  dbPath?: string;
  leaseDurationMs?: number;
  reaperIntervalMs?: number;
  worktreeRoot?: string;
  maxWorktrees?: number;
  sameFamilyReviewerFallback?: boolean;
  empiricalRouting?: boolean;
}

export interface KnowledgeWebhookRetryConfig {
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface KnowledgeWebhookSinkConfig {
  url?: string;
  token?: string;
  batchSize?: number;
  timeoutMs?: number;
  retry?: KnowledgeWebhookRetryConfig;
}

export interface KnowledgeJsonlSinkConfig {
  path?: string;
}

export interface KnowledgeSinkConfig {
  type?: "noop" | "jsonl" | "webhook";
  jsonl?: KnowledgeJsonlSinkConfig;
  webhook?: KnowledgeWebhookSinkConfig;
}

export interface KnowledgeReadProviderWebhookConfig {
  url?: string;
  token?: string;
  timeoutMs?: number;
}

export interface KnowledgeReadProviderConfig {
  type?: "none" | "webhook";
  webhook?: KnowledgeReadProviderWebhookConfig;
}

export interface KnowledgeConfig {
  sink?: KnowledgeSinkConfig;
  readProvider?: KnowledgeReadProviderConfig;
}

export interface CuttlefishConfig {
  cuttlefish?: { version?: string };
  workspaces?: {
    roots?: string[];
    defaultCwd?: string;
  };
  gateway: {
    port: number;
    host: string;
    streaming?: boolean;
    /** Opt-in unsafe local convenience: allow POST /api/files to write a custom managed path. Default false. */
    allowFileCustomPaths?: boolean;
    /** Opt-in unsafe local convenience: allow POST /api/files {open:true} to open uploaded files. Default false. */
    allowFileOpen?: boolean;
    /** Require token/cookie auth even on loopback. Network binds require auth by default. */
    authRequired?: boolean;
    /** Disable gateway auth. Refused on network binds unless insecureAllowUnauthenticatedNetwork is true. */
    authDisabled?: boolean;
    /** Explicit escape hatch for unauthenticated 0.0.0.0/LAN/Tailscale binds. */
    insecureAllowUnauthenticatedNetwork?: boolean;
    /** Opt-in: when set, POST /api/sessions reads the forwarded SSO identity
     *  from this request header (set by an auth proxy such as oauth2-proxy,
     *  Traefik forward-auth, or IAP) and persists it on the session. Accepts a
     *  single header name or a priority-ordered list. Unset = single-user
     *  no-op (sessions default to "web-user", header never read). */
    userHeader?: string | string[];
    /** Stall detection: inactivity threshold in ms before a stalled turn is flagged. */
    turnStallInactivityMs?: number;
    /** Stall detection: inactivity threshold in ms before a manager/leader review notice is emitted. */
    turnStallLeaderCheckMs?: number;
    /** Escalate a finished report to HR/COO when its leader has not acknowledged it within this many ms. */
    leaderAckTimeoutMs?: number;
    /** Cap on automatic leader-ack escalations per child session lineage before further timeouts are suppressed instead of re-paging HR. Default 1. */
    leaderAckMaxEscalations?: number;
    /** Stall detection: max ceiling in ms before hard-timeout. */
    turnStallCeilingMs?: number;
    /** Stall detection: number of retries before giving up. */
    turnStallRetries?: number;
    /** Opt-in: include resolved file paths in file API responses. Default false. */
    exposeResolvedFilePaths?: boolean;
  };
  engines: {
    default: "claude" | "codex" | "antigravity" | "grok" | "pi" | "hermes" | "kiro" | "ollama" | "kilo" | "aider";
    claude: {
      bin: string;
      model: string;
      effortLevel?: string;
      childEffortOverride?: string;
      maxLivePtys?: number;
    };
    codex: { bin: string; model: string; effortLevel?: string; childEffortOverride?: string };
    antigravity?: { bin?: string; model?: string; effortLevel?: string; childEffortOverride?: string };
    grok?: { bin?: string; model?: string; effortLevel?: string; childEffortOverride?: string };
    pi?: { bin?: string; model?: string; effortLevel?: string; childEffortOverride?: string };
    /** Ollama (`ollama` CLI) engine. `bin` optional — PATH-resolved. No effort. */
    ollama?: { bin?: string; model?: string };
    /** Aider (`aider` CLI) engine. `bin` optional — PATH-resolved. `model` optional —
     *  omit or set "default" to let aider auto-detect from env API keys. No effort. */
    aider?: { bin?: string; model?: string };
    /** Kilo (`kilo` CLI) engine. `bin` optional — PATH-resolved. */
    kilo?: { bin?: string; model?: string; effortLevel?: string; childEffortOverride?: string };
    /** Hermes (`hermes` CLI) engine. `bin` optional — PATH-resolved. No effort. */
    hermes?: { bin?: string; model?: string };
    /** Kiro engine. `bin` optional — PATH-resolved. */
    kiro?: { bin?: string; model?: string; effortLevel?: string; creditBudget?: number; billingAnchorDay?: number };
  };
  models?: ModelsConfig;
  connectors: Record<string, any> & {
    web?: WebConnectorConfig;
    slack?: SlackConnectorConfig;
    whatsapp?: WhatsAppConnectorConfig;
    instances?: ConnectorInstance[];
  };
  email?: EmailConfig;
  logging: { file: boolean; stdout: boolean; level: string };
  mcp?: McpGlobalConfig;
  modelFallback?: GlobalModelFallbackConfig;
  orchestration?: OrchestrationRuntimeConfig;
  sessions?: {
    maxDurationMinutes?: number;
    maxCostUsd?: number;
    interruptOnNewMessage?: boolean;
    rateLimitStrategy?: "wait" | "fallback";
    fallbackEngine?: "claude" | "codex" | "antigravity" | "grok" | "pi" | "kiro" | "hermes" | "ollama" | "kilo" | "aider";
    autoResumeOnBoot?: boolean;
  };
  boardWorker?: BoardWorkerConfig;
  cron?: {
    defaultDelivery?: CronDelivery;
    alertChannel?: string;
    alertConnector?: string;
    alertThresholdMs?: number;
  };
  notifications?: {
    connector?: string;
    channel?: string;
  };
  portal?: PortalConfig;
  context?: {
    maxChars?: number;
  };
  stt?: {
    enabled?: boolean;
    model?: string;
    /** @deprecated Use `languages` instead. Kept for backwards compat. */
    language?: string;
    languages?: string[];
  };
  /** /talk voice loop — optional, off unless explicitly configured. */
  talk?: {
    enabled?: boolean;
    /** Engine for the hands-free voice orchestrator session. When unset (or
     *  unavailable) the talk session falls back to `engines.default`, then to the
     *  first available engine — see talk/engine-resolver.ts. */
    engine?: string;
    /** Model for the hands-free voice orchestrator session (default: "sonnet" — capable enough to orchestrate). */
    orchestratorModel?: string;
    kokoro?: {
      voice?: string;
      modelDir?: string;
      sidecarPort?: number;
    };
  };
  knowledge?: KnowledgeConfig;
  remotes?: Record<string, { url: string; label?: string; token?: string }>;
  /** Feature flags (kill switches and opt-ins for in-progress features). */
  features?: {
    /** Enable multi-role employee execution (mid_pair tier). Default false — all employees run as solo. */
    multiRoleEmployeeExecution?: boolean;
  };
}
