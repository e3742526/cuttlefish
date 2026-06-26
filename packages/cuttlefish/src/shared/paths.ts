import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { assertCanonicalInstanceName, CANONICAL_INSTANCE_NAME, homeForInstance } from "./instance-home.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Resolve the home directory for the current instance. */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CUTTLEFISH_INSTANCE) assertCanonicalInstanceName(env.CUTTLEFISH_INSTANCE);
  if (env.CUTTLEFISH_HOME) return env.CUTTLEFISH_HOME;
  const instance = env.CUTTLEFISH_INSTANCE || CANONICAL_INSTANCE_NAME;
  return homeForInstance(instance);
}

export interface CuttlefishPaths {
  CUTTLEFISH_HOME: string;
  CONFIG_PATH: string;
  SESSIONS_DB: string;
  ORCH_DB: string;
  ORCH_CONFIG_DIR: string;
  ORCH_WORKTREE_ROOT: string;
  ORCH_RECOVERY_DIR: string;
  CRON_JOBS: string;
  AUDIT_LOG: string;
  APPROVALS_FILE: string;
  CRON_RUNS: string;
  ORG_DIR: string;
  SKILLS_DIR: string;
  DOCS_DIR: string;
  LOGS_DIR: string;
  TMP_DIR: string;
  ENGINE_LIMITS_DIR: string;
  CLAUDE_LIMITS_DIR: string;
  MODELS_DIR: string;
  STT_MODELS_DIR: string;
  PID_FILE: string;
  GATEWAY_INFO_FILE: string;
  CLAUDE_SETTINGS_DIR: string;
  HOOK_RELAY_SCRIPT: string;
  CLAUDE_SKILLS_DIR: string;
  AGENTS_SKILLS_DIR: string;
  FILES_DIR: string;
  UPLOADS_DIR: string;
  RUN_BUNDLES_DIR: string;
  MIGRATIONS_DIR: string;
  KNOWLEDGE_DIR: string;
  KNOWLEDGE_OUTBOX_JSONL: string;
}

function buildCuttlefishPaths(home: string): CuttlefishPaths {
  const tmpDir = path.join(home, "tmp");
  const engineLimitsDir = path.join(tmpDir, "engine-limits");
  return {
    CUTTLEFISH_HOME: home,
    CONFIG_PATH: path.join(home, "config.yaml"),
    SESSIONS_DB: path.join(home, "sessions", "registry.db"),
    ORCH_DB: path.join(home, "orchestration.db"),
    ORCH_CONFIG_DIR: path.join(home, "orchestration"),
    ORCH_WORKTREE_ROOT: path.join(home, "worktrees"),
    ORCH_RECOVERY_DIR: path.join(home, "orchestration-recovery"),
    CRON_JOBS: path.join(home, "cron", "jobs.json"),
    AUDIT_LOG: path.join(home, "audit.jsonl"),
    APPROVALS_FILE: path.join(home, "approvals.json"),
    CRON_RUNS: path.join(home, "cron", "runs"),
    ORG_DIR: path.join(home, "org"),
    SKILLS_DIR: path.join(home, "skills"),
    DOCS_DIR: path.join(home, "docs"),
    LOGS_DIR: path.join(home, "logs"),
    TMP_DIR: tmpDir,
    ENGINE_LIMITS_DIR: engineLimitsDir,
    CLAUDE_LIMITS_DIR: path.join(engineLimitsDir, "claude"),
    MODELS_DIR: path.join(home, "models"),
    STT_MODELS_DIR: path.join(home, "models", "whisper"),
    PID_FILE: path.join(home, "gateway.pid"),
    GATEWAY_INFO_FILE: path.join(home, "gateway.json"),
    CLAUDE_SETTINGS_DIR: path.join(home, "tmp", "settings"),
    HOOK_RELAY_SCRIPT: path.join(home, "hook-relay.mjs"),
    CLAUDE_SKILLS_DIR: path.join(home, ".claude", "skills"),
    AGENTS_SKILLS_DIR: path.join(home, ".agents", "skills"),
    FILES_DIR: path.join(home, "files"),
    UPLOADS_DIR: path.join(home, "uploads"),
    RUN_BUNDLES_DIR: path.join(tmpDir, "run-bundles"),
    MIGRATIONS_DIR: path.join(home, "migrations"),
    KNOWLEDGE_DIR: path.join(home, "knowledge"),
    KNOWLEDGE_OUTBOX_JSONL: path.join(home, "knowledge", "outbox.jsonl"),
  };
}

function applyRuntimePaths(paths: CuttlefishPaths): void {
  CUTTLEFISH_HOME = paths.CUTTLEFISH_HOME;
  CONFIG_PATH = paths.CONFIG_PATH;
  SESSIONS_DB = paths.SESSIONS_DB;
  ORCH_DB = paths.ORCH_DB;
  ORCH_CONFIG_DIR = paths.ORCH_CONFIG_DIR;
  ORCH_WORKTREE_ROOT = paths.ORCH_WORKTREE_ROOT;
  ORCH_RECOVERY_DIR = paths.ORCH_RECOVERY_DIR;
  CRON_JOBS = paths.CRON_JOBS;
  AUDIT_LOG = paths.AUDIT_LOG;
  APPROVALS_FILE = paths.APPROVALS_FILE;
  CRON_RUNS = paths.CRON_RUNS;
  ORG_DIR = paths.ORG_DIR;
  SKILLS_DIR = paths.SKILLS_DIR;
  DOCS_DIR = paths.DOCS_DIR;
  LOGS_DIR = paths.LOGS_DIR;
  TMP_DIR = paths.TMP_DIR;
  ENGINE_LIMITS_DIR = paths.ENGINE_LIMITS_DIR;
  CLAUDE_LIMITS_DIR = paths.CLAUDE_LIMITS_DIR;
  MODELS_DIR = paths.MODELS_DIR;
  STT_MODELS_DIR = paths.STT_MODELS_DIR;
  PID_FILE = paths.PID_FILE;
  GATEWAY_INFO_FILE = paths.GATEWAY_INFO_FILE;
  CLAUDE_SETTINGS_DIR = paths.CLAUDE_SETTINGS_DIR;
  HOOK_RELAY_SCRIPT = paths.HOOK_RELAY_SCRIPT;
  CLAUDE_SKILLS_DIR = paths.CLAUDE_SKILLS_DIR;
  AGENTS_SKILLS_DIR = paths.AGENTS_SKILLS_DIR;
  FILES_DIR = paths.FILES_DIR;
  UPLOADS_DIR = paths.UPLOADS_DIR;
  RUN_BUNDLES_DIR = paths.RUN_BUNDLES_DIR;
  MIGRATIONS_DIR = paths.MIGRATIONS_DIR;
  KNOWLEDGE_DIR = paths.KNOWLEDGE_DIR;
  KNOWLEDGE_OUTBOX_JSONL = paths.KNOWLEDGE_OUTBOX_JSONL;
}

export function getCuttlefishPaths(env: NodeJS.ProcessEnv = process.env): CuttlefishPaths {
  return buildCuttlefishPaths(resolveHome(env));
}

export function refreshCuttlefishPaths(env: NodeJS.ProcessEnv = process.env): CuttlefishPaths {
  const paths = getCuttlefishPaths(env);
  applyRuntimePaths(paths);
  return paths;
}

export function setCuttlefishHomeForTest(home: string): CuttlefishPaths {
  process.env.CUTTLEFISH_HOME = home;
  return refreshCuttlefishPaths();
}

const initialPaths = getCuttlefishPaths();

export let CUTTLEFISH_HOME = initialPaths.CUTTLEFISH_HOME;
export let CONFIG_PATH = initialPaths.CONFIG_PATH;
export let SESSIONS_DB = initialPaths.SESSIONS_DB;
/** Durable state for the inert provider-neutral matrix scheduler. */
export let ORCH_DB = initialPaths.ORCH_DB;
/** Default repo-local operator config directory for matrix orchestration YAML. */
export let ORCH_CONFIG_DIR = initialPaths.ORCH_CONFIG_DIR;
/** Default root for temporary matrix orchestration git worktrees. */
export let ORCH_WORKTREE_ROOT = initialPaths.ORCH_WORKTREE_ROOT;
/** Operator-visible recovery manifests for quarantined orchestration databases. */
export let ORCH_RECOVERY_DIR = initialPaths.ORCH_RECOVERY_DIR;
export let CRON_JOBS = initialPaths.CRON_JOBS;
/** Hash-chained, append-only integrity ledger for safe-write file mutations. */
export let AUDIT_LOG = initialPaths.AUDIT_LOG;
/** Persisted approval queue (model-fallback + future tool/custom approvals). */
export let APPROVALS_FILE = initialPaths.APPROVALS_FILE;
export let CRON_RUNS = initialPaths.CRON_RUNS;
export let ORG_DIR = initialPaths.ORG_DIR;
export let SKILLS_DIR = initialPaths.SKILLS_DIR;
export let DOCS_DIR = initialPaths.DOCS_DIR;
export let LOGS_DIR = initialPaths.LOGS_DIR;
export let TMP_DIR = initialPaths.TMP_DIR;
export let ENGINE_LIMITS_DIR = initialPaths.ENGINE_LIMITS_DIR;
export let CLAUDE_LIMITS_DIR = initialPaths.CLAUDE_LIMITS_DIR;
export let MODELS_DIR = initialPaths.MODELS_DIR;
export let STT_MODELS_DIR = initialPaths.STT_MODELS_DIR;
export let PID_FILE = initialPaths.PID_FILE;
/** Gateway connection info (port + hook secret + pids) for hook-relay discovery. */
export let GATEWAY_INFO_FILE = initialPaths.GATEWAY_INFO_FILE;
/** Per-session Claude Code --settings files. */
export let CLAUDE_SETTINGS_DIR = initialPaths.CLAUDE_SETTINGS_DIR;
/** The hook-relay script written once at boot. */
export let HOOK_RELAY_SCRIPT = initialPaths.HOOK_RELAY_SCRIPT;
export let CLAUDE_SKILLS_DIR = initialPaths.CLAUDE_SKILLS_DIR;
export let AGENTS_SKILLS_DIR = initialPaths.AGENTS_SKILLS_DIR;
export let FILES_DIR = initialPaths.FILES_DIR;
/** Date-bucketed storage for files attached to / emitted by sessions. */
export let UPLOADS_DIR = initialPaths.UPLOADS_DIR;
/** Managed export directories for portable run bundles. */
export let RUN_BUNDLES_DIR = initialPaths.RUN_BUNDLES_DIR;
export let MIGRATIONS_DIR = initialPaths.MIGRATIONS_DIR;
export let KNOWLEDGE_DIR = initialPaths.KNOWLEDGE_DIR;
export let KNOWLEDGE_OUTBOX_JSONL = initialPaths.KNOWLEDGE_OUTBOX_JSONL;

export const TEMPLATE_DIR = path.join(__dirname, "..", "..", "..", "template");
export const TEMPLATE_MIGRATIONS_DIR = path.join(TEMPLATE_DIR, "migrations");

/** Path to the global instances registry; tests/tools may isolate it explicitly. */
export const INSTANCES_REGISTRY = process.env.CUTTLEFISH_INSTANCES_REGISTRY || path.join(os.homedir(), ".cuttlefish", "instances.json");
