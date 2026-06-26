import { v4 as uuidv4 } from "uuid";
import type { ExternalKnowledgeEnvelope } from "../../shared/types.js";
import { initDb } from "./core.js";

export type ExternalOutboxStatus = "pending" | "delivered";

export interface ExternalOutboxItem {
  id: string;
  topic: string;
  schemaVersion: string;
  partitionKey: string | null;
  idempotencyKey: string;
  envelope: ExternalKnowledgeEnvelope;
  sinkName: string;
  status: ExternalOutboxStatus;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  remoteId: string | null;
  lastError: string | null;
  createdAt: string;
}

function rowToExternalOutboxItem(row: Record<string, unknown>): ExternalOutboxItem {
  return {
    id: row.id as string,
    topic: row.topic as string,
    schemaVersion: row.schema_version as string,
    partitionKey: (row.partition_key as string) ?? null,
    idempotencyKey: row.idempotency_key as string,
    envelope: JSON.parse(row.envelope_json as string) as ExternalKnowledgeEnvelope,
    sinkName: row.sink_name as string,
    status: row.status as ExternalOutboxStatus,
    attemptCount: Number(row.attempt_count ?? 0),
    nextAttemptAt: (row.next_attempt_at as string) ?? null,
    lastAttemptAt: (row.last_attempt_at as string) ?? null,
    deliveredAt: (row.delivered_at as string) ?? null,
    remoteId: (row.remote_id as string) ?? null,
    lastError: (row.last_error as string) ?? null,
    createdAt: row.created_at as string,
  };
}

export function enqueueExternalOutboxItem(input: {
  envelope: ExternalKnowledgeEnvelope;
  sinkName: string;
}): ExternalOutboxItem {
  const db = initDb();
  const now = new Date().toISOString();
  const existing = db.prepare(
    "SELECT * FROM external_outbox WHERE sink_name = ? AND idempotency_key = ? LIMIT 1",
  ).get(input.sinkName, input.envelope.idempotencyKey) as Record<string, unknown> | undefined;
  if (existing) return rowToExternalOutboxItem(existing);

  const id = uuidv4();
  db.prepare(`
    INSERT INTO external_outbox (
      id, topic, schema_version, partition_key, idempotency_key, envelope_json, sink_name, status, attempt_count, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
  `).run(
    id,
    input.envelope.topic,
    input.envelope.schemaVersion,
    input.envelope.partitionKey,
    input.envelope.idempotencyKey,
    JSON.stringify(input.envelope),
    input.sinkName,
    now,
  );
  return getExternalOutboxItem(id)!;
}

export function listPendingExternalOutboxItems(limit = 25): ExternalOutboxItem[] {
  const db = initDb();
  const now = new Date().toISOString();
  const rows = db.prepare(`
    SELECT *
    FROM external_outbox
    WHERE status = 'pending'
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY created_at ASC
    LIMIT ?
  `).all(now, limit) as Record<string, unknown>[];
  return rows.map(rowToExternalOutboxItem);
}

export function markExternalOutboxDelivered(id: string, remoteId?: string | null): ExternalOutboxItem | undefined {
  const db = initDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE external_outbox
    SET status = 'delivered',
        delivered_at = ?,
        remote_id = ?,
        last_error = NULL,
        next_attempt_at = NULL
    WHERE id = ?
  `).run(now, remoteId ?? null, id);
  return getExternalOutboxItem(id);
}

export function markExternalOutboxFailed(id: string, error: string, nextAttemptAt: string): ExternalOutboxItem | undefined {
  const db = initDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE external_outbox
    SET attempt_count = attempt_count + 1,
        last_attempt_at = ?,
        last_error = ?,
        next_attempt_at = ?
    WHERE id = ?
  `).run(now, error, nextAttemptAt, id);
  return getExternalOutboxItem(id);
}

export function getExternalOutboxItem(id: string): ExternalOutboxItem | undefined {
  const db = initDb();
  const row = db.prepare("SELECT * FROM external_outbox WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToExternalOutboxItem(row) : undefined;
}

export function listExternalOutboxItems(filter?: { status?: ExternalOutboxStatus; limit?: number }): ExternalOutboxItem[] {
  const db = initDb();
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (filter?.status) {
    conditions.push("status = ?");
    values.push(filter.status);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filter?.limit ?? 100;
  const rows = db.prepare(`
    SELECT *
    FROM external_outbox
    ${where}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...values, limit) as Record<string, unknown>[];
  return rows.map(rowToExternalOutboxItem);
}
