import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { logger } from "../shared/logger.js";
import { ORCH_DB, ORCH_RECOVERY_DIR } from "../shared/paths.js";
import { writeRecoveryManifest } from "./store-recovery.js";
import { DEFAULT_LEASE_DURATION_MS, type TelemetryEvent } from "./types.js";
import { setMeta } from "./store-utils.js";

export const SCHEMA_VERSION = 5;
export const NEXT_SEQ_META_KEY = "scheduler_next_seq";
export const QUEUE_PAUSE_META_KEY = "queue_pause";
export const SCHEMA_VERSION_META_KEY = "schema_version";
export const BOOT_GENERATION_META_KEY = "boot_generation";

export interface StoreOpenOptions {
  recoverCorrupt?: boolean;
  now?: () => Date;
}

export interface OpenedStoreDatabase {
  db: Database.Database;
  /**
   * Monotonic counter that increments every time the orchestration DB is
   * opened (i.e. every daemon boot). Used alongside wall-clock cutoffs to
   * detect stale in-flight state left behind by a prior process, without
   * relying solely on a clock that may skew or jump (NTP adjustments,
   * manual changes).
   */
  bootGeneration: number;
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
    const opened = openDatabase(dbPath);
    return { db: opened.db, bootGeneration: opened.bootGeneration };
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
    const reopened = openDatabase(dbPath);
    return {
      db: reopened.db,
      bootGeneration: reopened.bootGeneration,
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

// SEC-CFDB-001: the orchestration DB (and its WAL/SHM sidecars) must not be
// world/group readable. Applied on every open (not just first creation) so
// an existing install with looser default-OS-perm files gets tightened up
// over time without a migration. Sidecars are created lazily by SQLite once
// WAL mode is enabled, so a missing file here is expected, not an error.
function chmodDbFiles(dbPath: string): void {
  if (process.platform === "win32") return;
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // best-effort; sidecar may not exist yet
    }
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

function openDatabase(dbPath: string): { db: Database.Database; bootGeneration: number } {
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
    ensureContinuationRunIdColumn(db);
    ensureContinuationBootGenerationColumn(db);
    assertSchemaVersionNotNewer(db);
    setMeta(db, SCHEMA_VERSION_META_KEY, String(SCHEMA_VERSION));
    const bootGeneration = advanceBootGeneration(db);
    if (dbPath !== ":memory:") chmodDbFiles(dbPath);
    return { db, bootGeneration };
  } catch (err) {
    db.close();
    throw err;
  }
}

function getMetaValue(db: Database.Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

/**
 * TMP-CUT-015: the running binary stamps its SCHEMA_VERSION on every open,
 * but never checked what was already stamped there. A DB last written by a
 * *newer* binary (schema_version greater than this binary's SCHEMA_VERSION)
 * may contain schema shapes this binary's migrations don't know about;
 * silently continuing risks misreading or corrupting that state. A DB
 * stamped with a *lower* version is the normal upgrade case, already
 * handled by the additive `ensure*Column` migrations above, so it is
 * intentionally not guarded here.
 */
function assertSchemaVersionNotNewer(db: Database.Database): void {
  const stamped = getMetaValue(db, SCHEMA_VERSION_META_KEY);
  if (stamped === undefined) return;
  const stampedVersion = Number(stamped);
  if (!Number.isFinite(stampedVersion)) return;
  if (stampedVersion > SCHEMA_VERSION) {
    throw new Error(
      `orchestration DB schema_version (${stampedVersion}) is newer than this binary's SCHEMA_VERSION (${SCHEMA_VERSION}); ` +
        "refusing to open with an older binary to avoid misreading or corrupting a newer schema. Upgrade cuttlefish before opening this database.",
    );
  }
}

/**
 * TMP-CUT-013: increments a durable counter every time this DB is opened
 * (i.e. every daemon boot). Continuation records are stamped with the boot
 * generation active when they were created so stale-continuation recovery
 * at boot can cross-check against it, as a signal independent of wall-clock
 * time (which can skew or jump).
 */
function advanceBootGeneration(db: Database.Database): number {
  const stamped = getMetaValue(db, BOOT_GENERATION_META_KEY);
  const previous = stamped !== undefined ? Number(stamped) : 0;
  const next = Number.isFinite(previous) && previous > 0 ? previous + 1 : 1;
  setMeta(db, BOOT_GENERATION_META_KEY, String(next));
  return next;
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

function ensureContinuationRunIdColumn(db: Database.Database): void {
  const columns = db.pragma("table_info(live_run_continuations)") as Array<{ name: string }>;
  if (columns.some((column) => column.name === "run_id")) return;
  db.prepare("ALTER TABLE live_run_continuations ADD COLUMN run_id TEXT").run();
}

function ensureContinuationBootGenerationColumn(db: Database.Database): void {
  const columns = db.pragma("table_info(live_run_continuations)") as Array<{ name: string }>;
  if (columns.some((column) => column.name === "boot_generation")) return;
  db.prepare("ALTER TABLE live_run_continuations ADD COLUMN boot_generation INTEGER").run();
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
