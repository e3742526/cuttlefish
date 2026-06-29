import { randomUUID } from 'node:crypto';
import { initDb } from './core.js';

export interface QueueItem {
  id: string;
  sessionId: string;
  sessionKey: string;
  prompt: string;
  status: "pending" | "running" | "cancelled" | "completed";
  position: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export function enqueueQueueItem(sessionId: string, sessionKey: string, prompt: string): string {
  const db = initDb();
  const id = randomUUID();
  const position = (db.prepare(
    "SELECT COALESCE(MAX(position), 0) + 1 as pos FROM queue_items WHERE session_key = ? AND status IN ('pending', 'running')"
  ).get(sessionKey) as { pos: number }).pos;
  db.prepare(
    "INSERT INTO queue_items (id, session_id, session_key, prompt, status, position, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)"
  ).run(id, sessionId, sessionKey, prompt, position, new Date().toISOString());
  return id;
}

export function markQueueItemRunning(itemId: string): void {
  const db = initDb();
  db.prepare("UPDATE queue_items SET status = 'running', started_at = ? WHERE id = ?")
    .run(new Date().toISOString(), itemId);
}

export function markQueueItemCompleted(itemId: string): void {
  const db = initDb();
  db.prepare("UPDATE queue_items SET status = 'completed', completed_at = ? WHERE id = ?")
    .run(new Date().toISOString(), itemId);
}

export function getQueueItem(itemId: string): QueueItem | undefined {
  const db = initDb();
  return db.prepare(
    "SELECT id, session_id as sessionId, session_key as sessionKey, prompt, status, position, created_at as createdAt, started_at as startedAt, completed_at as completedAt FROM queue_items WHERE id = ?"
  ).get(itemId) as QueueItem | undefined;
}

export function cancelQueueItem(itemId: string): boolean {
  const db = initDb();
  const result = db.prepare(
    "UPDATE queue_items SET status = 'cancelled' WHERE id = ? AND status = 'pending'"
  ).run(itemId);
  return result.changes > 0;
}

export function cancelQueueItemForSession(itemId: string, sessionId: string, sessionKey: string): boolean {
  const db = initDb();
  const result = db.prepare(
    "UPDATE queue_items SET status = 'cancelled' WHERE id = ? AND status = 'pending' AND (session_id = ? OR session_key = ?)"
  ).run(itemId, sessionId, sessionKey);
  return result.changes > 0;
}

export function getQueueItems(sessionKey: string): QueueItem[] {
  const db = initDb();
  return db.prepare(
    "SELECT id, session_id as sessionId, session_key as sessionKey, prompt, status, position, created_at as createdAt, started_at as startedAt, completed_at as completedAt FROM queue_items WHERE session_key = ? AND status IN ('pending', 'running') ORDER BY position ASC, created_at ASC"
  ).all(sessionKey) as QueueItem[];
}

export function listPendingQueueItems(sessionKey: string): QueueItem[] {
  const db = initDb();
  return db.prepare(
    "SELECT id, session_id as sessionId, session_key as sessionKey, prompt, status, position, created_at as createdAt, started_at as startedAt, completed_at as completedAt FROM queue_items WHERE session_key = ? AND status = 'pending' ORDER BY position ASC, created_at ASC"
  ).all(sessionKey) as QueueItem[];
}

export function hasPendingQueueItemBefore(sessionKey: string, itemId: string): boolean {
  const items = listPendingQueueItems(sessionKey);
  const index = items.findIndex((item) => item.id === itemId);
  return index > 0;
}

export function cancelAllPendingQueueItems(sessionKey: string): number {
  const db = initDb();
  const result = db.prepare(
    "UPDATE queue_items SET status = 'cancelled' WHERE session_key = ? AND status = 'pending'"
  ).run(sessionKey);
  return result.changes;
}

export function pauseQueueKey(sessionKey: string): void {
  const db = initDb();
  db.prepare(
    "INSERT OR REPLACE INTO queue_pauses (session_key, paused_at) VALUES (?, ?)"
  ).run(sessionKey, new Date().toISOString());
}

export function resumeQueueKey(sessionKey: string): void {
  const db = initDb();
  db.prepare("DELETE FROM queue_pauses WHERE session_key = ?").run(sessionKey);
}

export function listPausedQueueKeys(): string[] {
  const db = initDb();
  return db.prepare("SELECT session_key as sessionKey FROM queue_pauses ORDER BY paused_at ASC")
    .all()
    .map((row) => (row as { sessionKey: string }).sessionKey);
}

export function recoverStaleQueueItems(): number {
  const db = initDb();
  const result = db.prepare(
    "UPDATE queue_items SET status = 'pending', started_at = NULL WHERE status = 'running'"
  ).run();
  return result.changes;
}

export function listAllPendingQueueItems(): QueueItem[] {
  const db = initDb();
  return db.prepare(
    "SELECT id, session_id as sessionId, session_key as sessionKey, prompt, status, position, created_at as createdAt, started_at as startedAt, completed_at as completedAt FROM queue_items WHERE status = 'pending' ORDER BY created_at ASC, position ASC"
  ).all() as QueueItem[];
}
