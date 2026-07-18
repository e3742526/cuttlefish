import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import type { Session } from "../shared/types.js";
import { RUN_LEDGER_DB } from "../shared/paths.js";
import {
  type CanonicalRunState,
  type ParentChildLinkRecord,
  type PolicySnapshotReference,
  type RetryReplayLinkRecord,
  type RunArtifactReference,
  type RunErrorRecord,
  type RunEventRecord,
  type RunRecord,
  canonicalRunStateSchema,
  parentChildLinkRecordSchema,
  policySnapshotReferenceSchema,
  retryReplayLinkRecordSchema,
  runArtifactReferenceSchema,
  runErrorRecordSchema,
  runEventRecordSchema,
  runRecordSchema,
  TERMINAL_RUN_STATES,
} from "./types.js";
import { isSqliteCorruptionError, quarantineCorruptDb } from "../shared/sqlite-corruption.js";

const SCHEMA_VERSION = 1;

/** Thrown when a run transition would leave a terminal state (STT-RL-001). */
export class RunLedgerTransitionError extends Error {}

const CREATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT,
  source TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  engine TEXT NOT NULL,
  title TEXT,
  prompt_excerpt TEXT,
  current_state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  last_session_status TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_ledger_session ON runs (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_ledger_state ON runs (current_state, updated_at DESC);

CREATE TABLE IF NOT EXISTS run_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_ledger_events_run ON run_events (run_id, created_at, event_id);

CREATE TABLE IF NOT EXISTS run_errors (
  error_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  event_id TEXT,
  error_kind TEXT NOT NULL,
  error_message TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_ledger_errors_run ON run_errors (run_id, created_at, error_id);

CREATE TABLE IF NOT EXISTS run_artifact_refs (
  reference_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  artifact_id TEXT,
  relation TEXT NOT NULL,
  locator TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_ledger_artifacts_run ON run_artifact_refs (run_id, created_at, reference_id);

CREATE TABLE IF NOT EXISTS policy_snapshot_refs (
  reference_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  policy_scope TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_ledger_policy_run ON policy_snapshot_refs (run_id, created_at, reference_id);

CREATE TABLE IF NOT EXISTS retry_replay_links (
  link_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  related_run_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_ledger_links_run ON retry_replay_links (run_id, relation_type, created_at);

CREATE TABLE IF NOT EXISTS parent_child_run_links (
  parent_run_id TEXT NOT NULL,
  child_run_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (parent_run_id, child_run_id, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_run_ledger_parent_child_parent ON parent_child_run_links (parent_run_id, created_at, child_run_id);
CREATE INDEX IF NOT EXISTS idx_run_ledger_parent_child_child ON parent_child_run_links (child_run_id, created_at, parent_run_id);
`;

// SEC-CFDB-001: the run-ledger DB (and its WAL/SHM sidecars) must not be
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

export interface CreateRunInput {
  runId?: string;
  sessionId?: string | null;
  source: string;
  sourceRef: string;
  engine: string;
  title?: string | null;
  promptExcerpt?: string | null;
  createdAt?: string;
  parentRunId?: string | null;
  retryOfRunId?: string | null;
  replayOfRunId?: string | null;
  initialSessionStatus?: string | null;
}

export interface TransitionRunInput {
  runId: string;
  nextState: CanonicalRunState;
  at?: string;
  payload?: Record<string, unknown> | null;
  errorKind?: string | null;
  errorMessage?: string | null;
}

export interface SessionRunSyncInput {
  before: Session;
  after: Session;
}

export interface LinkRunInput {
  runId: string;
  relatedRunId: string;
  relationType: "retry" | "replay";
  createdAt?: string;
}

export interface ParentChildRunLinkInput {
  parentRunId: string;
  childRunId: string;
  relationType?: "spawned";
  createdAt?: string;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function parseNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseRunRow(row: Record<string, unknown>): RunRecord {
  return runRecordSchema.parse({
    runId: row.run_id,
    sessionId: parseNullableString(row.session_id),
    source: row.source,
    sourceRef: row.source_ref,
    engine: row.engine,
    title: parseNullableString(row.title),
    promptExcerpt: parseNullableString(row.prompt_excerpt),
    currentState: row.current_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: parseNullableString(row.started_at),
    completedAt: parseNullableString(row.completed_at),
    lastError: parseNullableString(row.last_error),
    lastSessionStatus: parseNullableString(row.last_session_status),
  });
}

function parseRunEventRow(row: Record<string, unknown>): RunEventRecord {
  return runEventRecordSchema.parse({
    eventId: row.event_id,
    runId: row.run_id,
    eventType: row.event_type,
    fromState: parseNullableString(row.from_state),
    toState: parseNullableString(row.to_state),
    payload: parseJsonObject(row.payload_json),
    createdAt: row.created_at,
  });
}

function parseRunErrorRow(row: Record<string, unknown>): RunErrorRecord {
  return runErrorRecordSchema.parse({
    errorId: row.error_id,
    runId: row.run_id,
    eventId: parseNullableString(row.event_id),
    errorKind: row.error_kind,
    errorMessage: row.error_message,
    details: parseJsonObject(row.details_json),
    createdAt: row.created_at,
  });
}

function parseArtifactRow(row: Record<string, unknown>): RunArtifactReference {
  return runArtifactReferenceSchema.parse({
    referenceId: row.reference_id,
    runId: row.run_id,
    artifactId: parseNullableString(row.artifact_id),
    relation: row.relation,
    locator: parseNullableString(row.locator),
    createdAt: row.created_at,
  });
}

function parsePolicyRow(row: Record<string, unknown>): PolicySnapshotReference {
  return policySnapshotReferenceSchema.parse({
    referenceId: row.reference_id,
    runId: row.run_id,
    policyScope: row.policy_scope,
    snapshotId: row.snapshot_id,
    createdAt: row.created_at,
  });
}

function parseLinkRow(row: Record<string, unknown>): RetryReplayLinkRecord {
  return retryReplayLinkRecordSchema.parse({
    linkId: row.link_id,
    runId: row.run_id,
    relatedRunId: row.related_run_id,
    relationType: row.relation_type,
    createdAt: row.created_at,
  });
}

function parseParentChildRow(row: Record<string, unknown>): ParentChildLinkRecord {
  return parentChildLinkRecordSchema.parse({
    parentRunId: row.parent_run_id,
    childRunId: row.child_run_id,
    relationType: row.relation_type,
    createdAt: row.created_at,
  });
}

function currentRunIdOf(session: Pick<Session, "transportMeta">): string | null {
  const meta = session.transportMeta as Record<string, unknown> | null | undefined;
  const active = meta?.activeRunId;
  if (typeof active === "string" && active.trim()) return active;
  const latest = meta?.latestRunId;
  return typeof latest === "string" && latest.trim() ? latest : null;
}

function mapSessionStatusToCanonical(
  currentState: CanonicalRunState,
  beforeStatus: Session["status"],
  afterStatus: Session["status"],
): CanonicalRunState | null {
  switch (afterStatus) {
    case "running":
      return "running";
    case "waiting":
      return "blocked";
    case "error":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "idle":
      if (beforeStatus === "running" || beforeStatus === "waiting" || beforeStatus === "interrupted") {
        return "completed";
      }
      if (currentState === "running" || currentState === "blocked" || currentState === "interrupted") {
        return "completed";
      }
      return null;
  }
}

export class RunLedgerStore {
  private constructor(private readonly db: Database.Database) {}

  static open(dbPath = RUN_LEDGER_DB): RunLedgerStore {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    try {
      return RunLedgerStore.openConnection(dbPath);
    } catch (err) {
      // FSR-CF-001: a corrupt run-ledger file must not crash daemon boot. The
      // sibling sessions/artifact-lineage stores already quarantine-and-rebuild;
      // this brings the run ledger to parity. Only recover on-disk databases —
      // an in-memory open cannot be corrupt on disk.
      if (dbPath !== ":memory:" && isSqliteCorruptionError(err)) {
        quarantineCorruptDb(dbPath, "run-ledger");
        return RunLedgerStore.openConnection(dbPath);
      }
      throw err;
    }
  }

  private static openConnection(dbPath: string): RunLedgerStore {
    const db = new Database(dbPath, { timeout: 5000 });
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.exec(CREATE_SCHEMA);
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(SCHEMA_VERSION));
    if (dbPath !== ":memory:") chmodDbFiles(dbPath);
    return new RunLedgerStore(db);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  getSchemaVersion(): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
    return row?.value ?? null;
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as Record<string, unknown> | undefined;
    return row ? parseRunRow(row) : undefined;
  }

  listRunsForSession(sessionId: string): RunRecord[] {
    const rows = this.db.prepare("SELECT * FROM runs WHERE session_id = ? ORDER BY created_at, run_id").all(sessionId) as Record<string, unknown>[];
    return rows.map(parseRunRow);
  }

  listRuns(opts: { states?: string[]; engine?: string; sessionId?: string; limit?: number } = {}): RunRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.states && opts.states.length > 0) {
      conditions.push(`current_state IN (${opts.states.map(() => "?").join(", ")})`);
      params.push(...opts.states);
    }
    if (opts.engine) {
      conditions.push("engine = ?");
      params.push(opts.engine);
    }
    if (opts.sessionId) {
      conditions.push("session_id = ?");
      params.push(opts.sessionId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit && opts.limit > 0 ? ` LIMIT ${Math.floor(opts.limit)}` : "";
    const rows = this.db.prepare(`SELECT * FROM runs ${where} ORDER BY created_at DESC, run_id${limit}`).all(...params) as Record<string, unknown>[];
    return rows.map(parseRunRow);
  }

  listEvents(runId: string): RunEventRecord[] {
    const rows = this.db.prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY created_at, event_id").all(runId) as Record<string, unknown>[];
    return rows.map(parseRunEventRow);
  }

  listRunErrors(runId: string): RunErrorRecord[] {
    const rows = this.db.prepare("SELECT * FROM run_errors WHERE run_id = ? ORDER BY created_at, error_id").all(runId) as Record<string, unknown>[];
    return rows.map(parseRunErrorRow);
  }

  listArtifactReferences(runId: string): RunArtifactReference[] {
    const rows = this.db.prepare("SELECT * FROM run_artifact_refs WHERE run_id = ? ORDER BY created_at, reference_id").all(runId) as Record<string, unknown>[];
    return rows.map(parseArtifactRow);
  }

  listPolicySnapshotReferences(runId: string): PolicySnapshotReference[] {
    const rows = this.db.prepare("SELECT * FROM policy_snapshot_refs WHERE run_id = ? ORDER BY created_at, reference_id").all(runId) as Record<string, unknown>[];
    return rows.map(parsePolicyRow);
  }

  listRetryReplayLinks(runId: string): RetryReplayLinkRecord[] {
    const rows = this.db.prepare("SELECT * FROM retry_replay_links WHERE run_id = ? ORDER BY created_at, link_id").all(runId) as Record<string, unknown>[];
    return rows.map(parseLinkRow);
  }

  listChildRunLinks(parentRunId: string): ParentChildLinkRecord[] {
    const rows = this.db.prepare("SELECT * FROM parent_child_run_links WHERE parent_run_id = ? ORDER BY created_at, child_run_id").all(parentRunId) as Record<string, unknown>[];
    return rows.map(parseParentChildRow);
  }

  createRun(input: CreateRunInput): RunRecord {
    const runId = input.runId ?? uuidv4();
    const createdAt = input.createdAt ?? new Date().toISOString();
    const record = runRecordSchema.parse({
      runId,
      sessionId: input.sessionId ?? null,
      source: input.source,
      sourceRef: input.sourceRef,
      engine: input.engine,
      title: input.title ?? null,
      promptExcerpt: input.promptExcerpt ?? null,
      currentState: "created",
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      completedAt: null,
      lastError: null,
      lastSessionStatus: input.initialSessionStatus ?? null,
    });

    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO runs (
          run_id, session_id, source, source_ref, engine, title, prompt_excerpt,
          current_state, created_at, updated_at, started_at, completed_at, last_error, last_session_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.runId,
        record.sessionId,
        record.source,
        record.sourceRef,
        record.engine,
        record.title,
        record.promptExcerpt,
        record.currentState,
        record.createdAt,
        record.updatedAt,
        record.startedAt,
        record.completedAt,
        record.lastError,
        record.lastSessionStatus,
      );
      this.appendEvent(record.runId, "run_created", null, "created", createdAt, {
        sessionId: record.sessionId,
        source: record.source,
        sourceRef: record.sourceRef,
      });
      if (input.parentRunId) {
        this.linkParentChildRun({ parentRunId: input.parentRunId, childRunId: record.runId, createdAt });
      }
      if (input.retryOfRunId) {
        this.linkRetryReplayRun({ runId: record.runId, relatedRunId: input.retryOfRunId, relationType: "retry", createdAt });
      }
      if (input.replayOfRunId) {
        this.linkRetryReplayRun({ runId: record.runId, relatedRunId: input.replayOfRunId, relationType: "replay", createdAt });
      }
    });

    return record;
  }

  transitionRun(input: TransitionRunInput): RunRecord {
    const current = this.getRun(input.runId);
    if (!current) throw new Error(`Run ${input.runId} not found`);
    const nextState = canonicalRunStateSchema.parse(input.nextState);
    if (current.currentState === nextState) return current;
    // Legal-transition guard (STT-RL-001): a run in a final state
    // (completed / dead_lettered) must never be reactivated. Retries and replays
    // create a NEW run id rather than resurrecting the terminal one, so this
    // never blocks a legitimate flow.
    if ((TERMINAL_RUN_STATES as readonly string[]).includes(current.currentState)) {
      throw new RunLedgerTransitionError(
        `Illegal run transition ${current.currentState} → ${nextState} for ${input.runId}: ${current.currentState} is terminal`,
      );
    }

    const at = input.at ?? new Date().toISOString();
    const startedAt = nextState === "running" && !current.startedAt ? at : current.startedAt;
    const completedAt = nextState === "completed" ? at : current.completedAt;
    const lastError = input.errorMessage ?? (nextState === "completed" ? null : current.lastError);

    this.transaction(() => {
      this.db.prepare(`
        UPDATE runs
           SET current_state = ?, updated_at = ?, started_at = ?, completed_at = ?, last_error = ?
         WHERE run_id = ?
      `).run(nextState, at, startedAt, completedAt, lastError, input.runId);
      const eventId = this.appendEvent(input.runId, "state_transition", current.currentState, nextState, at, input.payload ?? null);
      if (input.errorMessage) {
        this.insertRunError({
          runId: input.runId,
          eventId,
          errorKind: input.errorKind ?? nextState,
          errorMessage: input.errorMessage,
          details: input.payload ?? null,
          createdAt: at,
        });
      }
    });

    return this.getRun(input.runId)!;
  }

  syncSessionUpdate(input: SessionRunSyncInput): RunRecord | undefined {
    const runId = currentRunIdOf(input.after) ?? currentRunIdOf(input.before);
    if (!runId) return undefined;
    const current = this.getRun(runId);
    if (!current) return undefined;
    const at = input.after.lastActivity || new Date().toISOString();
    const nextState = mapSessionStatusToCanonical(current.currentState, input.before.status, input.after.status);

    this.transaction(() => {
      this.db.prepare(`
        UPDATE runs
           SET source = ?, source_ref = ?, engine = ?, title = ?, prompt_excerpt = ?, updated_at = ?,
               last_error = ?, last_session_status = ?
         WHERE run_id = ?
      `).run(
        input.after.source,
        input.after.sourceRef,
        input.after.engine,
        input.after.title,
        input.after.promptExcerpt ?? null,
        at,
        input.after.lastError,
        input.after.status,
        runId,
      );
      if (nextState && nextState !== current.currentState) {
        try {
          this.transitionRun({
            runId,
            nextState,
            at,
            payload: {
              beforeStatus: input.before.status,
              afterStatus: input.after.status,
            },
            errorKind: input.after.lastError ? nextState : null,
            errorMessage: input.after.lastError,
          });
        } catch (err) {
          // A session update that maps to a transition out of a terminal run
          // (e.g. a settled session re-activated while its activeRunId still
          // points at the completed run) must not abort the whole session-sync
          // transaction. The run ledger keeps the terminal record; the live
          // session lifecycle is authoritative for the session itself. Retries
          // create a fresh run id, so this only fires on the reactivation edge.
          if (err instanceof RunLedgerTransitionError) {
            this.appendEvent(runId, "error_recorded", current.currentState, current.currentState, at, {
              afterStatus: input.after.status,
              suppressedTransition: nextState,
            });
          } else {
            throw err;
          }
        }
      } else if (input.after.lastError && input.after.lastError !== current.lastError) {
        this.appendEvent(runId, "error_recorded", current.currentState, current.currentState, at, {
          afterStatus: input.after.status,
        });
        this.insertRunError({
          runId,
          eventId: null,
          errorKind: input.after.status,
          errorMessage: input.after.lastError,
          details: { afterStatus: input.after.status },
          createdAt: at,
        });
      }
    });

    return this.getRun(runId);
  }

  linkRetryReplayRun(input: LinkRunInput): RetryReplayLinkRecord {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const record = retryReplayLinkRecordSchema.parse({
      linkId: uuidv4(),
      runId: input.runId,
      relatedRunId: input.relatedRunId,
      relationType: input.relationType,
      createdAt,
    });
    this.db.prepare(`
      INSERT INTO retry_replay_links (link_id, run_id, related_run_id, relation_type, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(record.linkId, record.runId, record.relatedRunId, record.relationType, record.createdAt);
    this.appendEvent(record.runId, "run_linked", null, null, createdAt, {
      relationType: record.relationType,
      relatedRunId: record.relatedRunId,
    });
    return record;
  }

  linkParentChildRun(input: ParentChildRunLinkInput): ParentChildLinkRecord {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const record = parentChildLinkRecordSchema.parse({
      parentRunId: input.parentRunId,
      childRunId: input.childRunId,
      relationType: input.relationType ?? "spawned",
      createdAt,
    });
    this.db.prepare(`
      INSERT INTO parent_child_run_links (parent_run_id, child_run_id, relation_type, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(parent_run_id, child_run_id, relation_type) DO NOTHING
    `).run(record.parentRunId, record.childRunId, record.relationType, record.createdAt);
    return record;
  }

  addArtifactReference(input: Omit<RunArtifactReference, "referenceId"> & { referenceId?: string }): RunArtifactReference {
    const record = runArtifactReferenceSchema.parse({
      referenceId: input.referenceId ?? uuidv4(),
      runId: input.runId,
      artifactId: input.artifactId,
      relation: input.relation,
      locator: input.locator,
      createdAt: input.createdAt,
    });
    this.db.prepare(`
      INSERT INTO run_artifact_refs (reference_id, run_id, artifact_id, relation, locator, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(record.referenceId, record.runId, record.artifactId, record.relation, record.locator, record.createdAt);
    this.appendEvent(record.runId, "artifact_linked", null, null, record.createdAt, {
      artifactId: record.artifactId,
      relation: record.relation,
      locator: record.locator,
    });
    return record;
  }

  addPolicySnapshotReference(input: Omit<PolicySnapshotReference, "referenceId"> & { referenceId?: string }): PolicySnapshotReference {
    const record = policySnapshotReferenceSchema.parse({
      referenceId: input.referenceId ?? uuidv4(),
      runId: input.runId,
      policyScope: input.policyScope,
      snapshotId: input.snapshotId,
      createdAt: input.createdAt,
    });
    this.db.prepare(`
      INSERT INTO policy_snapshot_refs (reference_id, run_id, policy_scope, snapshot_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(record.referenceId, record.runId, record.policyScope, record.snapshotId, record.createdAt);
    this.appendEvent(record.runId, "policy_snapshot_linked", null, null, record.createdAt, {
      policyScope: record.policyScope,
      snapshotId: record.snapshotId,
    });
    return record;
  }

  private appendEvent(
    runId: string,
    eventType: RunEventRecord["eventType"],
    fromState: CanonicalRunState | null,
    toState: CanonicalRunState | null,
    createdAt: string,
    payload: Record<string, unknown> | null,
  ): string {
    const eventId = uuidv4();
    this.db.prepare(`
      INSERT INTO run_events (event_id, run_id, event_type, from_state, to_state, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, runId, eventType, fromState, toState, payload ? JSON.stringify(payload) : null, createdAt);
    return eventId;
  }

  private insertRunError(input: {
    runId: string;
    eventId: string | null;
    errorKind: string;
    errorMessage: string;
    details: Record<string, unknown> | null;
    createdAt: string;
  }): void {
    const record = runErrorRecordSchema.parse({
      errorId: uuidv4(),
      runId: input.runId,
      eventId: input.eventId,
      errorKind: input.errorKind,
      errorMessage: input.errorMessage,
      details: input.details,
      createdAt: input.createdAt,
    });
    this.db.prepare(`
      INSERT INTO run_errors (error_id, run_id, event_id, error_kind, error_message, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.errorId,
      record.runId,
      record.eventId,
      record.errorKind,
      record.errorMessage,
      record.details ? JSON.stringify(record.details) : null,
      record.createdAt,
    );
  }
}
