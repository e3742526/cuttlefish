import fs from "node:fs";
import yaml from "js-yaml";
import { CONFIG_PATH } from "./paths.js";
import { safeWriteYaml } from "./safe-write.js";
import { KNOWLEDGE_OUTBOX_JSONL } from "./paths.js";
import type { BoardWorkerConfig, CuttlefishConfig, KnowledgeConfig } from "./types.js";
import { validateConfigShape } from "./config-schema.js";
export { validateConfigShape } from "./config-schema.js";

type ClaudeEngineConfig = CuttlefishConfig["engines"]["claude"];
type NormalizedBoardWorkerConfig = Required<NonNullable<CuttlefishConfig["boardWorker"]>> & {
  schedule: {
    weekday: { start: string; end: string };
    weekend: { start: string; end: string };
  };
  usage: { minRemainingPercent: number };
};

const DEFAULT_BOARD_WORKER_WINDOW = { start: "22:00", end: "04:00" } as const;
const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function normalizeWindow(
  raw: { start?: unknown; end?: unknown } | undefined,
): { start: string; end: string } {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_BOARD_WORKER_WINDOW };
  const start = typeof raw.start === "string" && TIME_OF_DAY_RE.test(raw.start)
    ? raw.start
    : DEFAULT_BOARD_WORKER_WINDOW.start;
  const end = typeof raw.end === "string" && TIME_OF_DAY_RE.test(raw.end)
    ? raw.end
    : DEFAULT_BOARD_WORKER_WINDOW.end;
  return { start, end };
}

function clampMinutes(value: unknown, fallback: number): number {
  const minutes = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.min(60, Math.floor(minutes)));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stripLegacyConnectorConfig(raw: unknown): unknown {
  if (!isPlainRecord(raw)) return raw;
  const config = structuredClone(raw);
  if (!isPlainRecord(config.connectors)) return config;

  const connectors = config.connectors;
  delete connectors.discord;
  delete connectors.telegram;

  if (Array.isArray(connectors.instances)) {
    const instances = connectors.instances.filter((entry) => {
      if (!isPlainRecord(entry)) return true;
      return entry.type !== "discord" && entry.type !== "discord-remote" && entry.type !== "telegram";
    });
    if (instances.length > 0) connectors.instances = instances;
    else delete connectors.instances;
  }

  return config;
}

export function normalizeClaudeEngineConfig(raw: ClaudeEngineConfig): Required<Pick<ClaudeEngineConfig, "maxLivePtys">> & ClaudeEngineConfig {
  return {
    ...raw,
    maxLivePtys: raw.maxLivePtys ?? 8,
  };
}

export function normalizeBoardWorkerConfig(raw: BoardWorkerConfig | undefined): NormalizedBoardWorkerConfig {
  const weekday = normalizeWindow(raw?.schedule?.weekday);
  const weekend = normalizeWindow(raw?.schedule?.weekend);
  return {
    enabled: raw?.enabled ?? false,
    idleMinutes: clampMinutes(raw?.idleMinutes, 5),
    timezone: raw?.timezone ?? systemTimezone(),
    schedule: { weekday, weekend },
    usage: { minRemainingPercent: raw?.usage?.minRemainingPercent ?? 15 },
  };
}

export function normalizeKnowledgeConfig(raw: KnowledgeConfig | undefined): Required<KnowledgeConfig> {
  return {
    sink: {
      type: raw?.sink?.type ?? "noop",
      jsonl: {
        path: raw?.sink?.jsonl?.path ?? KNOWLEDGE_OUTBOX_JSONL,
      },
      webhook: {
        url: raw?.sink?.webhook?.url,
        token: raw?.sink?.webhook?.token,
        batchSize: raw?.sink?.webhook?.batchSize ?? 25,
        timeoutMs: raw?.sink?.webhook?.timeoutMs ?? 10_000,
        retry: {
          baseDelayMs: raw?.sink?.webhook?.retry?.baseDelayMs ?? 1_000,
          maxDelayMs: raw?.sink?.webhook?.retry?.maxDelayMs ?? 60_000,
        },
      },
    },
    readProvider: {
      type: raw?.readProvider?.type ?? "none",
      webhook: {
        url: raw?.readProvider?.webhook?.url,
        token: raw?.readProvider?.webhook?.token,
        timeoutMs: raw?.readProvider?.webhook?.timeoutMs ?? 10_000,
      },
    },
  };
}

export function loadConfig(): CuttlefishConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `Cuttlefish config not found at ${CONFIG_PATH}. Run "cuttlefish setup" first.`
    );
  }
  // config.yaml stores plaintext connector secrets, so it must not be
  // group/world-readable. Repair perms
  // on every load to harden installs created before this was enforced.
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch { /* best-effort */ }
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    throw new Error(`Invalid YAML in ${CONFIG_PATH}: ${(err as Error).message}`);
  }
  parsed = stripLegacyConnectorConfig(parsed);
  const problems = validateConfigShape(parsed);
  if (problems.length > 0) {
    throw new Error(
      `Invalid config at ${CONFIG_PATH}:\n  - ${problems.join("\n  - ")}`
    );
  }
  const config = parsed as CuttlefishConfig;
  const gateway = config.gateway as CuttlefishConfig["gateway"] | undefined;
  config.gateway = {
    ...(gateway ?? {}),
    port: gateway?.port ?? 8888,
    host: gateway?.host ?? "127.0.0.1",
  };
  config.engines.default = config.engines.default ?? "claude";
  config.connectors = config.connectors ?? {};
  config.email = config.email ?? {};
  const logging = config.logging as CuttlefishConfig["logging"] | undefined;
  config.logging = {
    ...(logging ?? {}),
    file: logging?.file ?? true,
    stdout: logging?.stdout ?? true,
    level: logging?.level ?? "info",
    maxSizeBytes: logging?.maxSizeBytes ?? 10 * 1024 * 1024,
    maxFiles: logging?.maxFiles ?? 5,
  };
  config.engines.claude = normalizeClaudeEngineConfig(config.engines.claude);
  config.boardWorker = normalizeBoardWorkerConfig(config.boardWorker);
  config.knowledge = normalizeKnowledgeConfig(config.knowledge);
  config.email = {
    enabled: config.email.enabled ?? false,
    pollIntervalSeconds: config.email.pollIntervalSeconds ?? 60,
    inboxes: config.email.inboxes ?? [],
  };
  return config;
}

/**
 * Atomically persist a config object to config.yaml. The live gateway
 * hot-reloads config.yaml via a file watcher, so a torn write would be
 * consumed mid-write — write to a tmp file in the same directory, then rename.
 * `dumpOptions` is forwarded to yaml.dump so call sites keep their formatting.
 */
export function saveConfigAtomic(config: unknown, dumpOptions?: yaml.DumpOptions): void {
  // Atomic + fsync-durable + audited (canonical config; hot-reloaded by a
  // watcher). mode 0o600: the file holds plaintext connector secrets and must
  // not be group/world-readable.
  safeWriteYaml(CONFIG_PATH, config, { mode: 0o600, dumpOptions, audit: { actor: "gateway", op: "config.save" } });
}
