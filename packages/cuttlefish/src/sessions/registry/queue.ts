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
  // Read-then-insert must be one atomic unit: two concurrent enqueues for the
  // same session_key could otherwise read the same MAX(position) and produce
  // duplicate position values (DAT-SESS-007). Position ties are additionally
  // self-mitigated by the created_at secondary sort in the read paths below,
  // but the transaction removes the race rather than just tolerating it.
  const insert = db.transaction(() => {
    const position = (db.prepare(
      "SELECT COALESCE(MAX(position), 0) + 1 as pos FROM queue_items WHERE session_key = ? AND status IN ('pending', 'running')"
    ).get(sessionKey) as { pos: number }).pos;
    db.prepare(
      "INSERT INTO queue_items (id, session_id, session_key, prompt, status, position, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)"
    ).run(id, sessionId, sessionKey, prompt, position, new Date().toISOString());
  });
  insert();
  return id;
}

/**
 * Atomically claim a pending queue item for dispatch (FSR-CF-007). The
 * status flip only takes effect `WHERE status = 'pending'`, so this is a
 * compare-and-swap claim rather than a blind write: at most one caller can
 * ever win the claim on a given item, which is what makes it safe to call
 * this durably *before* the engine dispatch side-effect runs (mirrors the
 * claim-lease idiom in external-outbox.ts's claimPendingExternalOutboxItems
 * and the atomic-claim idiom in webhook-replay.ts's claimConnectorWebhookReplay).
 * Returns true only if this call performed the claim.
 *
 * Residual risk: if the process crashes after a successful claim but before
 * the engine call is confirmed, recoverStaleQueueItems() below will still
 * reset the item to 'pending' on restart so it isn't stranded forever — that
 * restart-recovery reset remains at-least-once by design (this file has no
 * signal for "the engine call was actually sent"; only the dispatch call
 * site could record that). What this claim fixes is the concurrent-claim
 * race: two callers can no longer both observe 'pending' and both dispatch
 * the same item.
 */
export function markQueueItemRunning(itemId: string): boolean {
  const db = initDb();
  const result = db.prepare(
    "UPDATE queue_items SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'"
  ).run(new Date().toISOString(), itemId);
  return result.changes > 0;
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

/**
 * Boot-time recovery for items orphaned by a crash: any item still 'running'
 * from a previous process (a claim that markQueueItemRunning committed
 * durably before dispatch, per FSR-CF-007) is handed back to 'pending' so it
 * isn't stranded. Only rows in the transient 'running' state are touched —
 * 'pending', 'cancelled', and 'completed' rows are left exactly as they are,
 * so recovery never re-arms an item that already settled.
 */
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
