import { v4 as uuidv4 } from 'uuid';
import type { ChatBlock, ChatBlockEnvelope } from '../../shared/types.js';
import { blockFallbackText, mergeBlock, validateBlockEnvelope } from '../../shared/blocks.js';
import { initDb } from './core.js';
import type { MediaAttachment as MessageMedia, SessionMessage } from '@cuttlefish/contracts';

export type { MessageMedia, SessionMessage };

/** Extra `partial` marker for rows swept at boot; see clearAllPartialMessages(). */
const PARTIAL_QUARANTINED = 2;

export interface QuarantinedMessage extends SessionMessage {
  sessionId: string;
}

function parseMediaColumn(value: unknown): MessageMedia[] | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as MessageMedia[]) : undefined;
  } catch {
    return undefined;
  }
}

function parseBlocksColumn(value: unknown): ChatBlock[] | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const blocks = parsed.flatMap((block) => {
      const result = validateBlockEnvelope({ op: "put", block });
      return result.ok ? [result.envelope.block] : [];
    });
    return blocks.length > 0 ? blocks : undefined;
  } catch {
    return undefined;
  }
}

function blockFallbackCandidates(block: ChatBlock, fallbackText?: string): string[] {
  return [
    fallbackText,
    blockFallbackText(block),
    block.title,
    block.summary,
    block.type,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function isSyntheticBlockContent(content: string, block: ChatBlock | undefined, fallbackText?: string): boolean {
  if (!block) return false;
  const trimmed = content.trim();
  return blockFallbackCandidates(block, fallbackText).some((candidate) => candidate.trim() === trimmed);
}

function isSyntheticBlockRow(rowId: string, content: string, block: ChatBlock | undefined, fallbackText?: string): boolean {
  if (!block) return false;
  if (rowId.startsWith(`block-${block.id}-`)) return true;
  return isSyntheticBlockContent(content, block, fallbackText);
}

export function insertMessage(sessionId: string, role: string, content: string, media?: MessageMedia[], blocks?: ChatBlock[]): string {
  const db = initDb();
  const id = uuidv4();
  const mediaJson = media && media.length > 0 ? JSON.stringify(media) : null;
  const blocksJson = blocks && blocks.length > 0 ? JSON.stringify(blocks) : null;
  db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp, media, blocks) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id, sessionId, role, content, Date.now(), mediaJson, blocksJson,
  );
  return id;
}

export function getMessages(sessionId: string): SessionMessage[] {
  const db = initDb();
  const rows = db
    .prepare('SELECT id, role, content, timestamp, media, partial, seq, tool_call, blocks FROM messages WHERE session_id = ? AND (partial IS NULL OR partial != ?) ORDER BY timestamp ASC, seq ASC')
    .all(sessionId, PARTIAL_QUARANTINED) as Array<{ id: string; role: string; content: string; timestamp: number; media: string | null; partial: number | null; seq: number | null; tool_call: string | null; blocks: string | null }>;
  return rows.map((r) => {
    const msg: SessionMessage = { id: r.id, role: r.role, content: r.content, timestamp: r.timestamp };
    const media = parseMediaColumn(r.media);
    const blocks = parseBlocksColumn(r.blocks);
    if (media) msg.media = media;
    if (blocks) msg.blocks = blocks;
    if (r.partial) msg.partial = true;
    if (r.tool_call) msg.toolCall = r.tool_call;
    return msg;
  });
}

export function applyBlockEnvelope(
  sessionId: string,
  input: ChatBlockEnvelope,
  fallbackText?: string,
  options?: { partial?: boolean; seq?: number },
): string | null {
  const result = validateBlockEnvelope(input);
  if (!result.ok) throw new Error(result.error);
  const envelope = result.envelope;
  const db = initDb();
  const partialOnly = options?.partial === true;
  const rows = db
    .prepare(`SELECT id, content, blocks FROM messages WHERE session_id = ? AND role = ?${partialOnly ? ' AND partial = 1' : ''} ORDER BY timestamp ASC, seq ASC`)
    .all(sessionId, 'assistant') as Array<{ id: string; content: string; blocks: string | null }>;
  const existing = rows
    .map((row) => ({ row, blocks: parseBlocksColumn(row.blocks) ?? [] }))
    .find((entry) => entry.blocks.some((block) => block.id === envelope.block.id));

  if (envelope.op === 'remove') {
    if (!existing) return null;
    const oldBlock = existing.blocks.find((block) => block.id === envelope.block.id);
    const remainingBlocks = existing.blocks.filter((block) => block.id !== envelope.block.id);
    if (remainingBlocks.length > 0) {
      db.prepare('UPDATE messages SET blocks = ? WHERE id = ?').run(JSON.stringify(remainingBlocks), existing.row.id);
    } else if (isSyntheticBlockRow(existing.row.id, existing.row.content, oldBlock, fallbackText)) {
      db.prepare('DELETE FROM messages WHERE id = ?').run(existing.row.id);
    } else {
      db.prepare('UPDATE messages SET blocks = NULL WHERE id = ?').run(existing.row.id);
    }
    return existing.row.id;
  }

  if (existing) {
    const oldBlock = existing.blocks.find((block) => block.id === envelope.block.id);
    const nextBlocks = existing.blocks.map((block) =>
      block.id === envelope.block.id
        ? envelope.op === "patch" ? mergeBlock(block, envelope.block) : envelope.block
        : block,
    );
    const target = nextBlocks.find((block) => block.id === envelope.block.id) ?? envelope.block;
    const nextContent = isSyntheticBlockRow(existing.row.id, existing.row.content, oldBlock, fallbackText)
      ? fallbackText?.trim() || blockFallbackText(target)
      : existing.row.content;
    db.prepare('UPDATE messages SET content = ?, blocks = ? WHERE id = ?').run(
      nextContent,
      JSON.stringify(nextBlocks),
      existing.row.id,
    );
    return existing.row.id;
  }

  if (envelope.op === 'patch') return null;

  const id = `block-${envelope.block.id}-${uuidv4()}`;
  if (partialOnly) {
    db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp, partial, seq, blocks) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').run(
      id,
      sessionId,
      'assistant',
      fallbackText?.trim() || blockFallbackText(envelope.block),
      Date.now(),
      options?.seq ?? 0,
      JSON.stringify([envelope.block]),
    );
  } else {
    db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp, blocks) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      sessionId,
      'assistant',
      fallbackText?.trim() || blockFallbackText(envelope.block),
      Date.now(),
      JSON.stringify([envelope.block]),
    );
  }
  return id;
}

export function insertPartialMessage(sessionId: string, role: string, content: string, seq: number, toolCall?: string): string {
  const db = initDb();
  const id = uuidv4();
  db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp, partial, seq, tool_call) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').run(
    id, sessionId, role, content, Date.now(), seq, toolCall ?? null,
  );
  return id;
}

export function updatePartialMessage(id: string, content: string): void {
  const db = initDb();
  db.prepare('UPDATE messages SET content = ? WHERE id = ? AND partial = 1').run(content, id);
}

export function updateMessageContent(id: string, content: string): void {
  const db = initDb();
  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, id);
}

export function deletePartialMessages(sessionId: string): number {
  const db = initDb();
  return db.prepare('DELETE FROM messages WHERE session_id = ? AND partial = 1').run(sessionId).changes;
}

export function finalizePartialMessages(sessionId: string): number {
  const db = initDb();
  return db.prepare('UPDATE messages SET partial = NULL WHERE session_id = ? AND partial = 1').run(sessionId).changes;
}

/**
 * Boot-time recovery sweep. Messages still marked `partial = 1` belong to a
 * turn that never finished writing (e.g. the process crashed mid-stream) —
 * they are not safe to display as live/in-progress state on the next boot.
 *
 * Rather than deleting them outright (which would silently discard whatever
 * content had been streamed so far), mark them `partial = 2` (quarantined).
 * Quarantined rows are excluded from the normal getMessages() read path but
 * remain in the table for operator inspection via getQuarantinedMessages().
 */
export function clearAllPartialMessages(): number {
  const db = initDb();
  return db.prepare('UPDATE messages SET partial = ? WHERE partial = 1').run(PARTIAL_QUARANTINED).changes;
}

/**
 * Lists messages quarantined by clearAllPartialMessages(), optionally scoped
 * to one session. Intended for operator inspection/recovery of content left
 * over from a crash mid-write; these rows are never returned by getMessages().
 */
export function getQuarantinedMessages(sessionId?: string): QuarantinedMessage[] {
  const db = initDb();
  const rows = (
    sessionId
      ? db
        .prepare('SELECT id, session_id, role, content, timestamp, media, seq, tool_call, blocks FROM messages WHERE session_id = ? AND partial = ? ORDER BY timestamp ASC, seq ASC')
        .all(sessionId, PARTIAL_QUARANTINED)
      : db
        .prepare('SELECT id, session_id, role, content, timestamp, media, seq, tool_call, blocks FROM messages WHERE partial = ? ORDER BY timestamp ASC, seq ASC')
        .all(PARTIAL_QUARANTINED)
  ) as Array<{ id: string; session_id: string; role: string; content: string; timestamp: number; media: string | null; seq: number | null; tool_call: string | null; blocks: string | null }>;
  return rows.map((r) => {
    const msg: QuarantinedMessage = { id: r.id, sessionId: r.session_id, role: r.role, content: r.content, timestamp: r.timestamp, partial: true };
    const media = parseMediaColumn(r.media);
    const blocks = parseBlocksColumn(r.blocks);
    if (media) msg.media = media;
    if (blocks) msg.blocks = blocks;
    if (r.tool_call) msg.toolCall = r.tool_call;
    return msg;
  });
}
