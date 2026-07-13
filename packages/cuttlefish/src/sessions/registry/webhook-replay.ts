import { createHash, randomUUID } from 'node:crypto';
import { initDb } from './core.js';

export interface ClaimConnectorWebhookReplayInput {
  connector: string;
  keys: string[];
  now: number;
  ttlMs: number;
}

class ReplayAlreadyClaimedError extends Error {}

function hashReplayKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function normalizeKeys(keys: string[]): string[] {
  return [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
}

/**
 * Atomically claim one or more provider replay keys. Keys are hashed before
 * persistence, and a claim succeeds only if every key is new or expired. The
 * shared claim id lets a failed downstream dispatch release only its own keys.
 */
export function claimConnectorWebhookReplay(input: ClaimConnectorWebhookReplayInput): string | null {
  const connector = input.connector.trim();
  const keys = normalizeKeys(input.keys);
  if (!connector) throw new Error('connector is required for webhook replay protection');
  if (keys.length === 0) throw new Error('at least one webhook replay key is required');
  if (!Number.isFinite(input.now) || !Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
    throw new Error('webhook replay claim requires a positive finite TTL');
  }

  const db = initDb();
  const claimId = randomUUID();
  const expiresAt = input.now + input.ttlMs;
  const keyHashes = keys.map(hashReplayKey);
  const apply = db.transaction(() => {
    const claim = db.prepare(`
      INSERT INTO connector_webhook_replay (connector, key_hash, claim_id, expires_at_ms, created_at_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(connector, key_hash) DO UPDATE SET
        claim_id = excluded.claim_id,
        expires_at_ms = excluded.expires_at_ms,
        created_at_ms = excluded.created_at_ms
      WHERE connector_webhook_replay.expires_at_ms <= ?
    `);
    for (const keyHash of keyHashes) {
      const result = claim.run(connector, keyHash, claimId, expiresAt, input.now, input.now);
      if (result.changes !== 1) throw new ReplayAlreadyClaimedError();
    }
    db.prepare('DELETE FROM connector_webhook_replay WHERE expires_at_ms <= ?').run(input.now);
    return claimId;
  });

  try {
    return apply();
  } catch (err) {
    if (err instanceof ReplayAlreadyClaimedError) return null;
    throw err;
  }
}

/** Release a replay claim only when it still belongs to the failed dispatcher. */
export function releaseConnectorWebhookReplay(input: { connector: string; keys: string[]; claimId: string }): void {
  const connector = input.connector.trim();
  const keys = normalizeKeys(input.keys);
  if (!connector || !input.claimId || keys.length === 0) return;
  const placeholders = keys.map(() => '?').join(', ');
  initDb().prepare(`
    DELETE FROM connector_webhook_replay
    WHERE connector = ? AND claim_id = ? AND key_hash IN (${placeholders})
  `).run(connector, input.claimId, ...keys.map(hashReplayKey));
}
