import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { logger } from "../shared/logger.js";
import { ORCH_DB, ORCH_RECOVERY_DIR } from "../shared/paths.js";
import { writeRecoveryManifest } from "./store-recovery.js";
import { DEFAULT_LEASE_DURATION_MS, type TelemetryEvent } from "./types.js";
import { setMeta } from "./store-utils.js";

export const SCHEMA_VERSION = 4;
export const NEXT_SEQ_META_KEY = "scheduler_next_seq";
export const QUEUE_PAUSE_META_KEY = "queue_pause";

export interface StoreOpenOptions {
  recoverCorrupt?: boolean;
  now?: () => Date;
}

export interface OpenedStoreDatabase {
  db: Database.Database;
  recoveryEvent?: TelemetryEvent;
}

const CREATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leases (
  lease_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  coordinator_id TEXT NOT NULL,
  role TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  lease_duration_ms INTEGER NOT NULL DEFAULT ${DEFAULT_LEASE_DURATION_MS},
  heartbeat_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orch_leases_state ON leases (state);
CREATE INDEX IF NOT EXISTS idx_orch_leases_worker_state ON leases (worker_id, state);
CREATE INDEX IF NOT EXISTS idx_orch_leases_task ON leases (task_id);

CREATE TABLE IF NOT EXISTS allocations (
  allocation_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  coordinator_id TEXT NOT NULL,
  state TEXT NOT NULL,
  optional_roles_skipped_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orch_allocations_task ON allocations (task_id);

CREATE TABLE IF NOT EXISTS allocation_leases (
  allocation_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  PRIMARY KEY (allocation_id, lease_id),
  FOREIGN KEY (allocation_id) REFERENCES allocations(allocation_id) ON DELETE CASCADE,
  FOREIGN KEY (lease_id) REFERENCES leases(lease_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS queue_items (
  task_id TEXT NOT NULL,
  coordinator_id TEXT NOT NULL,
  state TEXT NOT NULL,
  missing_roles_json TEXT NOT NULL,
  priority TEXT NOT NULL,
  blocked_since TEXT NOT NULL,
  last_blocked_at TEXT NOT NULL,
  blocked_attempts INTEGER NOT NULL DEFAULT 1,
  resume_on_json TEXT NOT NULL,
  request_json TEXT NOT NULL,
  PRIMARY KEY (task_id, coordinator_id)
);
CREATE INDEX IF NOT EXISTS idx_orch_queue_priority ON queue_items (priority, blocked_since, task_id);

CREATE TABLE IF NOT EXISTS telemetry_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  task_id TEXT,
  worker_id TEXT,
  provider TEXT,
  family TEXT,
  role TEXT,
  timestamp TEXT NOT NULL,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_orch_telemetry_time ON telemetry_events (timestamp, event_id);

CREATE TABLE IF NOT EXISTS live_run_continuations (
  task_id TEXT NOT NULL,
  coordinator_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  state TEXT NOT NULL,
  task_json TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_dispatched_at TEXT,
  allocation_id TEXT,
  last_error TEXT,
  PRIMARY KEY (task_id, coordinator_id)
);
CREATE INDEX IF NOT EXISTS idx_orch_live_run_state ON live_run_continuations (state, updated_at, task_id, coordinator_id);

CREATE TABLE IF NOT EXISTS task_pauses (
  task_id TEXT NOT NULL,
  coordinator_id TEXT NOT NULL,
  paused_at TEXT NOT NULL,
  pause_reason TEXT,
  manager_name TEXT,
  PRIMARY KEY (task_id, coordinator_id)
);

CREATE TABLE IF NOT EXISTS orchestration_holds (
  hold_id TEXT PRIMARY KEY,
  manager_name TEXT NOT NULL,
  state TEXT NOT NULL,
  roles_json TEXT NOT NULL,
  worker_ids_json TEXT NOT NULL,
  task_id TEXT,
  coordinator_id TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orch_holds_state_expiry ON orchestration_holds (state, expires_at);

CREATE TABLE IF NOT EXISTS artifact_records (
  artifact_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  coordinator_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  lane TEXT,
  path TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_orch_artifacts_task_kind ON artifact_records (task_id, kind, lane);
CREATE INDEX IF NOT EXISTS idx_orch_artifacts_run_kind ON artifact_records (task_id, coordinator_id, kind, lane);

CREATE TABLE IF NOT EXISTS patch_apply_attempts (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  winner_lane TEXT NOT NULL,
  state TEXT NOT NULL,
  base_cwd TEXT NOT NULL,
  patch_path TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orch_patch_apply_task ON patch_apply_attempts (task_id, created_at);
`;

export function openStoreDatabase(dbPath: string, opts: StoreOpenOptions = {}): OpenedStoreDatabase {
  try {
    return { db: openDatabase(dbPath) };
  } catch (err) {
    if (!isSqliteCorruptionError(err)) {
      throw err;
    }
    if (opts.recoverCorrupt === false || dbPath === ":memory:" || !fs.existsSync(dbPath)) {
      throw err;
    }
    const now = opts.now ?? (() => new Date());
    const quarantine = moveCorruptDatabase(dbPath, now);
    const recoveredAt = now().toISOString();
    const message = "orchestration state could not be trusted; in-flight leases and queue require operator review";
    const recoveryManifestPath = writeRecoveryManifest(resolveRecoveryDir(dbPath), {
      recoveredAt,
      originalDbPath: dbPath,
      corruptDbPath: quarantine.corruptDbPath,
      corruptWalPath: quarantine.corruptWalPath,
      corruptShmPath: quarantine.corruptShmPath,
      message,
      operatorGuidance: "Inspect the quarantined database files manually if recovery is needed. Cuttlefish started with an empty orchestration database and did not requeue work automatically.",
    });
    logger.warn(`orchestration store: moved corrupt DB to ${quarantine.corruptDbPath}; starting empty and surfacing recovery telemetry`);
    return {
      db: openDatabase(dbPath),
      recoveryEvent: {
        eventId: "evt_store_corrupt_recovered_1",
        type: "store_corrupt_recovered",
        timestamp: recoveredAt,
        detail: {
          corruptPath: quarantine.corruptDbPath,
          recoveryManifestPath,
          message,
        },
      },
    };
  }
}

function isSqliteCorruptionError(err: unknown): boolean {
  const code = typeof err === "object" && err && "code" in err ? String((err as { code?: unknown }).code) : "";
  if (code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB") return true;
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return message.includes("database disk image is malformed")
    || message.includes("file is not a database")
    || message.includes("not a database");
}

function openDatabase(dbPath: string): Database.Database {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath, { timeout: 5000 });
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    db.exec(CREATE_SCHEMA);
    ensureLeaseDurationColumn(db);
    ensureAllocationUpdatedAtColumn(db);
    ensureQueueDiagnosticsColumns(db);
    ensureArtifactCoordinatorColumn(db);
    setMeta(db, "schema_version", String(SCHEMA_VERSION));
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

function ensureArtifactCoordinatorColumn(db: Database.Database): void {
  const columns = db.pragma("table_info(artifact_records)") as Array<{ name: string }>;
  if (columns.some((column) => column.name === "coordinator_id")) return;
  db.prepare("ALTER TABLE artifact_records ADD COLUMN coordinator_id TEXT").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_orch_artifacts_run_kind ON artifact_records (task_id, coordinator_id, kind, lane)").run();
}

function ensureLeaseDurationColumn(db: Database.Database): void {
  const columns = db.pragma("table_info(leases)") as Array<{ name: string }>;
  if (columns.some((column) => column.name === "lease_duration_ms")) return;
  db.prepare(`ALTER TABLE leases ADD COLUMN lease_duration_ms INTEGER NOT NULL DEFAULT ${DEFAULT_LEASE_DURATION_MS}`).run();
}

function ensureAllocationUpdatedAtColumn(db: Database.Database): void {
  const columns = db.pragma("table_info(allocations)") as Array<{ name: string }>;
  if (columns.some((column) => column.name === "updated_at")) return;
  db.prepare("ALTER TABLE allocations ADD COLUMN updated_at TEXT").run();
  db.prepare("UPDATE allocations SET updated_at = created_at WHERE updated_at IS NULL").run();
}

interface QuarantinedDatabasePaths {
  corruptDbPath: string;
  corruptWalPath?: string;
  corruptShmPath?: string;
}

function moveCorruptDatabase(dbPath: string, now: () => Date): QuarantinedDatabasePaths {
  const basePath = nextCorruptPath(dbPath, now);
  return {
    corruptDbPath: renameIfExists(dbPath, basePath) ?? basePath,
    corruptWalPath: renameIfExists(`${dbPath}-wal`, `${basePath}-wal`),
    corruptShmPath: renameIfExists(`${dbPath}-shm`, `${basePath}-shm`),
  };
}

function nextCorruptPath(dbPath: string, now: () => Date): string {
  const stamp = now().toISOString().replace(/[^0-9A-Za-z]+/g, "-").replace(/-$/, "");
  let candidate = `${dbPath}.corrupt.${stamp}`;
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = `${dbPath}.corrupt.${stamp}.${index++}`;
  }
  return candidate;
}

function renameIfExists(source: string, target: string): string | undefined {
  if (!fs.existsSync(source)) return undefined;
  fs.renameSync(source, target);
  return target;
}

function resolveRecoveryDir(dbPath: string): string {
  return dbPath === ORCH_DB ? ORCH_RECOVERY_DIR : path.join(path.dirname(dbPath), "orchestration-recovery");
}

function ensureQueueDiagnosticsColumns(db: Database.Database): void {
  const columns = db.pragma("table_info(queue_items)") as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "last_blocked_at")) {
    db.prepare("ALTER TABLE queue_items ADD COLUMN last_blocked_at TEXT").run();
    db.prepare("UPDATE queue_items SET last_blocked_at = blocked_since WHERE last_blocked_at IS NULL").run();
  }
  if (!columns.some((column) => column.name === "blocked_attempts")) {
    db.prepare("ALTER TABLE queue_items ADD COLUMN blocked_attempts INTEGER NOT NULL DEFAULT 1").run();
  }
}
