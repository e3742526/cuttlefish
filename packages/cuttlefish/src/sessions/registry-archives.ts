import type Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { logger } from "../shared/logger.js";
import type {
  ArchiveKind,
  ArchivedSessionSnapshot,
  ProjectArchive,
  ProjectArchiveDetail,
  Session,
} from "../shared/types.js";
import type { SessionMessage } from "./registry/messages.js";
import { unlinkEmailReferencesForSessions } from "./registry/sessions.js";

export interface ArchiveRegistryDeps {
  getDb: () => Database.Database;
  getSession: (id: string) => Session | undefined;
  getMessages: (sessionId: string) => SessionMessage[];
}

function normalizeArchiveText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function rowToProjectArchive(row: Record<string, unknown>): ProjectArchive {
  return {
    id: row.id as string,
    label: (row.label as string) ?? null,
    note: (row.note as string) ?? null,
    kind: row.kind as ArchiveKind,
    sourceRef: (row.source_ref as string) ?? null,
    createdAt: row.created_at as string,
    sessionCount: (row.session_count as number) ?? 0,
  };
}

function parseArchivePayload(value: unknown, archiveId: string): { sessions: ArchivedSessionSnapshot[] } {
  if (typeof value !== "string" || !value.trim()) return { sessions: [] };
  try {
    const parsed = JSON.parse(value) as { sessions?: ArchivedSessionSnapshot[] };
    return { sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [] };
  } catch {
    logger.warn(`registry: dropped corrupt archive payload for ${archiveId}`);
    return { sessions: [] };
  }
}

export function snapshotSessionsForArchive(ids: string[], deps: ArchiveRegistryDeps): ArchivedSessionSnapshot[] {
  const snapshots: ArchivedSessionSnapshot[] = [];
  for (const id of ids) {
    const session = deps.getSession(id);
    if (!session) continue;
    snapshots.push({
      id: session.id,
      engine: session.engine,
      engineSessionId: session.engineSessionId,
      connector: session.connector,
      sessionKey: session.sessionKey,
      replyContext: session.replyContext,
      messageId: session.messageId,
      transportMeta: session.transportMeta,
      employee: session.employee,
      model: session.model,
      title: session.title,
      promptExcerpt: session.promptExcerpt ?? null,
      source: session.source,
      sourceRef: session.sourceRef,
      status: session.status,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity,
      totalCost: session.totalCost,
      totalTurns: session.totalTurns,
      lastContextTokens: session.lastContextTokens,
      lastError: session.lastError,
      parentSessionId: session.parentSessionId,
      userId: session.userId ?? null,
      effortLevel: session.effortLevel,
      cwd: session.cwd ?? null,
      messages: deps.getMessages(id).map((message) => ({
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
        ...(message.toolCall ? { toolCall: message.toolCall } : {}),
        ...(message.media ? { media: message.media } : {}),
      })),
    });
  }
  return snapshots;
}

export function createArchiveRecord(
  opts: {
    label?: string | null;
    note?: string | null;
    kind: ArchiveKind;
    sourceRef?: string | null;
    sessions: ArchivedSessionSnapshot[];
  },
  deps: ArchiveRegistryDeps,
): ProjectArchive {
  const db = deps.getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  const label = normalizeArchiveText(opts.label);
  const note = normalizeArchiveText(opts.note);
  const sourceRef = normalizeArchiveText(opts.sourceRef);
  const sessionCount = opts.sessions.length;
  db.prepare(
    `INSERT INTO archives (id, label, note, kind, source_ref, created_at, session_count, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    label,
    note,
    opts.kind,
    sourceRef,
    now,
    sessionCount,
    JSON.stringify({ sessions: opts.sessions }),
  );
  return { id, label, note, kind: opts.kind, sourceRef, createdAt: now, sessionCount };
}

export function createArchiveAndDeleteSessionsRecord(
  opts: {
    label?: string | null;
    note?: string | null;
    kind: ArchiveKind;
    sourceRef?: string | null;
    sessionIds: string[];
  },
  deps: ArchiveRegistryDeps,
): ProjectArchive | undefined {
  const snapshots = snapshotSessionsForArchive(opts.sessionIds, deps);
  if (snapshots.length === 0) return undefined;

  const db = deps.getDb();
  const id = uuidv4();
  const now = new Date().toISOString();
  const label = normalizeArchiveText(opts.label);
  const note = normalizeArchiveText(opts.note);
  const sourceRef = normalizeArchiveText(opts.sourceRef);
  const sessionCount = snapshots.length;
  const archive = { id, label, note, kind: opts.kind, sourceRef, createdAt: now, sessionCount };
  const ids = snapshots.map((snapshot) => snapshot.id);
  const placeholders = ids.map(() => "?").join(",");

  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO archives (id, label, note, kind, source_ref, created_at, session_count, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      label,
      note,
      opts.kind,
      sourceRef,
      now,
      sessionCount,
      JSON.stringify({ sessions: snapshots }),
    );

    const sessionKeys = db.prepare(
      `SELECT session_key as sessionKey FROM sessions WHERE id IN (${placeholders})`,
    ).all(...ids) as Array<{ sessionKey: string | null }>;
    const liveSessionKeys = sessionKeys
      .map((row) => row.sessionKey)
      .filter((sessionKey): sessionKey is string => Boolean(sessionKey));

    db.prepare(`DELETE FROM messages WHERE session_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM queue_items WHERE session_id IN (${placeholders})`).run(...ids);
    if (liveSessionKeys.length > 0) {
      const keyPlaceholders = liveSessionKeys.map(() => "?").join(",");
      db.prepare(`DELETE FROM queue_pauses WHERE session_key IN (${keyPlaceholders})`)
        .run(...liveSessionKeys);
    }
    // See deleteSession/deleteSessions: cached emails outlive the session that
    // processed them, so unlink (set NULL) instead of deleting so archiving a
    // session doesn't leave email_messages/email_ingest_state dangling.
    unlinkEmailReferencesForSessions(db, ids);
    db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...ids);
  });

  txn();
  return archive;
}

export function listArchiveRecords(deps: ArchiveRegistryDeps): ProjectArchive[] {
  const rows = deps.getDb()
    .prepare("SELECT id, label, note, kind, source_ref, created_at, session_count FROM archives ORDER BY created_at DESC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToProjectArchive);
}

export function getArchiveRecord(id: string, deps: ArchiveRegistryDeps): ProjectArchiveDetail | undefined {
  const row = deps.getDb().prepare("SELECT * FROM archives WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const summary = rowToProjectArchive(row);
  const payload = parseArchivePayload(row.payload, summary.id);
  return { ...summary, sessions: payload.sessions };
}

export function deleteArchiveRecord(id: string, deps: ArchiveRegistryDeps): boolean {
  const result = deps.getDb().prepare("DELETE FROM archives WHERE id = ?").run(id);
  return result.changes > 0;
}
