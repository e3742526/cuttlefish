import path from 'node:path';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { SESSIONS_DB } from '../../shared/paths.js';
import { logger } from '../../shared/logger.js';
import { isSqliteCorruptionError, quarantineCorruptDb } from '../../shared/sqlite-corruption.js';
import type { JsonObject, ReplyContext, Session } from '../../shared/types.js';
import { installBaseSchema, installPostMigrationSchema } from './schema.js';
import { migrateApprovalsSchema, migrateExternalOutboxSchema, migrateFilesSchema, migrateMessagesSchema, migrateSessionsSchema } from './migrations.js';
import { backfillFtsSync, disableFtsForProcess, migrateFtsSchema } from './search.js';

let db: Database.Database;

export function parseJsonObject(value: unknown, label?: string): JsonObject | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as JsonObject;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    logger.warn(`registry: dropped corrupt JSON in ${label ?? 'session field'}`);
    return null;
  }
}

export function rowToSession(row: Record<string, unknown>): Session {
  const replyContext = parseJsonObject(row.reply_context, 'reply_context');
  const transportMeta = parseJsonObject(row.transport_meta, 'transport_meta');
  const sessionKey = ((row.session_key as string) || (row.source_ref as string));
  const connector = (row.connector as string) ?? (row.source as string) ?? null;
  return {
    id: row.id as string,
    engine: row.engine as string,
    engineSessionId: (row.engine_session_id as string) ?? null,
    source: row.source as string,
    sourceRef: row.source_ref as string,
    connector,
    sessionKey,
    replyContext: replyContext as ReplyContext | null,
    messageId: (row.message_id as string) ?? null,
    transportMeta,
    employee: (row.employee as string) ?? null,
    model: (row.model as string) ?? null,
    title: (row.title as string) ?? null,
    promptExcerpt: (row.prompt_excerpt as string) ?? null,
    parentSessionId: (row.parent_session_id as string) ?? null,
    userId: (row.user_id as string) ?? null,
    effortLevel: (row.effort_level as string) ?? null,
    cwd: (row.cwd as string) ?? null,
    status: row.status as Session['status'],
    totalCost: (row.total_cost as number) ?? 0,
    totalTurns: (row.total_turns as number) ?? 0,
    lastContextTokens: (row.last_context_tokens as number) ?? null,
    createdAt: row.created_at as string,
    lastActivity: row.last_activity as string,
    lastError: (row.last_error as string) ?? null,
  };
}

export function getMeta(database: Database.Database, key: string): string | null {
  const row = database.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setMeta(database: Database.Database, key: string, value: string): void {
  database
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

function applyConnectionPragmas(database: Database.Database): void {
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  // Enforce foreign keys (OFF by default in SQLite). The only declared FK is
  // approvals.session_id -> sessions.id ON DELETE CASCADE, so this backs the
  // app-level orphan cleanup (deleteSession) with DB-level integrity. The
  // approvals-table rebuild migration toggles this OFF/ON around itself.
  database.pragma('foreign_keys = ON');
}

function openDb(): Database.Database {
  mkdirSync(path.dirname(SESSIONS_DB), { recursive: true });
  try {
    const database = new Database(SESSIONS_DB, { timeout: 5000 });
    applyConnectionPragmas(database);
    return database;
  } catch (err) {
    if (isSqliteCorruptionError(err)) {
      quarantineCorruptDb(SESSIONS_DB);
      const fresh = new Database(SESSIONS_DB, { timeout: 5000 });
      applyConnectionPragmas(fresh);
      return fresh;
    }
    throw err;
  }
}

export function initDb(): Database.Database {
  if (db) return db;
  db = openDb();
  installBaseSchema(db);
  migrateMessagesSchema(db);
  migrateFtsSchema(db);
  try {
    backfillFtsSync(db);
  } catch (err) {
    disableFtsForProcess(db, err);
  }
  migrateSessionsSchema(db);
  // Upgrade the outbox table before post-migration schema installation adds
  // indexes that depend on its newest columns.
  migrateExternalOutboxSchema(db);
  installPostMigrationSchema(db);
  migrateFilesSchema(db);
  migrateApprovalsSchema(db);
  return db;
}
