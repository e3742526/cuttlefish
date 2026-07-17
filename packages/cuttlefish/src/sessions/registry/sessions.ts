import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { JsonObject, ReplyContext, Session } from '../../shared/types.js';
import { initDb, parseJsonObject, rowToSession } from './core.js';
import { portalEmployeeSlug } from '../../shared/portal-slug.js';
import { getRunLedger } from '../../run-ledger/index.js';

export interface CreateSessionOpts {
  engine: string;
  source: string;
  sourceRef: string;
  connector?: string | null;
  sessionKey?: string;
  replyContext?: ReplyContext | null;
  messageId?: string;
  transportMeta?: JsonObject | null;
  employee?: string | null;
  model?: string;
  title?: string;
  parentSessionId?: string;
  userId?: string | null;
  effortLevel?: string;
  cwd?: string | null;
  promptExcerpt?: string;
}

function sessionRunIdFromMeta(
  meta: JsonObject | null | undefined,
  key: 'activeRunId' | 'latestRunId' | 'retryOfRunId' | 'replayOfRunId',
): string | null {
  const value = meta && typeof meta === 'object' ? meta[key] : null;
  return typeof value === 'string' && value.trim() ? value : null;
}

function resolveParentRunId(parentSessionId: string | null | undefined): string | null {
  if (!parentSessionId) return null;
  const parent = getSession(parentSessionId);
  if (!parent) return null;
  return sessionRunIdFromMeta(parent.transportMeta, 'activeRunId')
    ?? sessionRunIdFromMeta(parent.transportMeta, 'latestRunId');
}

function withRunMeta(meta: JsonObject | null | undefined, runId: string): JsonObject {
  const next: JsonObject = { ...(meta ?? {}) };
  delete next.retryOfRunId;
  delete next.replayOfRunId;
  next.activeRunId = runId;
  next.latestRunId = runId;
  return next;
}

function syncRunLedgerForSessionUpdate(before: Session, after: Session): void {
  getRunLedger().syncSessionUpdate({ before, after });
}

function computeGroupKey(source: string, sourceRef: string, employee: string | null | undefined): string {
  if (source === 'cron' || sourceRef.startsWith('cron:')) return CRON_GROUP;
  const normalized = employee?.trim();
  return normalized ? normalized : DIRECT_GROUP;
}

function getNextSessionNumber(): number {
  const db = initDb();
  const row = db.prepare('SELECT MAX(rowid) as maxRowid FROM sessions').get() as { maxRowid: number | null };
  return (row.maxRowid ?? 0) + 1;
}

function generateTitle(prompt?: string): string {
  const num = getNextSessionNumber();
  if (!prompt) return `#${num}`;
  const cleaned = prompt.replace(/\n/g, ' ').replace(/@\w+/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return `#${num}`;
  const summary = cleaned.slice(0, 30).trim();
  return `#${num} - ${summary}${cleaned.length > 30 ? '...' : ''}`;
}

export function promptExcerptOf(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined;
  const flat = prompt.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > 140 ? flat.slice(0, 139).trimEnd() + '…' : flat;
}

export function createSession(opts: CreateSessionOpts & { prompt?: string; portalName?: string }): Session {
  const db = initDb();
  const now = new Date().toISOString();
  const id = uuidv4();
  const title = opts.title ?? generateTitle(opts.prompt);
  const promptExcerpt = promptExcerptOf(opts.promptExcerpt) ?? promptExcerptOf(opts.prompt) ?? null;
  const sessionKey = opts.sessionKey ?? opts.sourceRef;
  const connector = opts.connector ?? opts.source;
  const groupKey = computeGroupKey(opts.source, opts.sourceRef, opts.employee);
  const replyContext = opts.replyContext ? JSON.stringify(opts.replyContext) : null;
  const transportMeta = opts.transportMeta ? JSON.stringify(opts.transportMeta) : null;

  db.prepare(`
    INSERT INTO sessions (
      id, engine, source, source_ref, connector, session_key, reply_context, message_id, transport_meta,
      employee, group_key, model, title, prompt_excerpt, parent_session_id, user_id, effort_level, cwd, status, created_at, last_activity
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)
  `).run(
    id,
    opts.engine,
    opts.source,
    opts.sourceRef,
    connector,
    sessionKey,
    replyContext,
    opts.messageId ?? null,
    transportMeta,
    opts.employee ?? null,
    groupKey,
    opts.model ?? null,
    title,
    promptExcerpt,
    opts.parentSessionId ?? null,
    opts.userId ?? null,
    opts.effortLevel ?? null,
    opts.cwd ?? null,
    now,
    now,
  );

  return {
    id,
    engine: opts.engine,
    engineSessionId: null,
    source: opts.source,
    sourceRef: opts.sourceRef,
    connector,
    sessionKey,
    replyContext: opts.replyContext ?? null,
    messageId: opts.messageId ?? null,
    transportMeta: opts.transportMeta ?? null,
    employee: opts.employee ?? null,
    model: opts.model ?? null,
    title,
    promptExcerpt,
    parentSessionId: opts.parentSessionId ?? null,
    userId: opts.userId ?? null,
    effortLevel: opts.effortLevel ?? null,
    cwd: opts.cwd ?? null,
    status: 'idle',
    totalCost: 0,
    totalTurns: 0,
    lastContextTokens: null,
    createdAt: now,
    lastActivity: now,
    lastError: null,
  };
}

export function getSession(id: string): Session | undefined {
  const db = initDb();
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : undefined;
}

export function getSessionBySourceRef(sourceRef: string): Session | undefined {
  return getSessionBySessionKey(sourceRef);
}

export function getSessionBySessionKey(sessionKey: string): Session | undefined {
  const db = initDb();
  const row = db.prepare('SELECT * FROM sessions WHERE session_key = ? ORDER BY last_activity DESC LIMIT 1').get(sessionKey) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : undefined;
}

/**
 * Atomic get-or-create for a session_key: the lookup and the insert run inside
 * a single db.transaction so two near-simultaneous first-contact messages for
 * the same new session_key can't both miss the getter and both create a
 * session (a split-brain conversation with one half unreachable).
 */
export function getOrCreateSessionBySessionKey(
  sessionKey: string,
  opts: CreateSessionOpts & { prompt?: string; portalName?: string },
): { session: Session; created: boolean } {
  const db = initDb();
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT * FROM sessions WHERE session_key = ? ORDER BY last_activity DESC LIMIT 1').get(sessionKey) as Record<string, unknown> | undefined;
    if (row) return { session: rowToSession(row), created: false };
    return { session: createSession({ ...opts, sessionKey }), created: true };
  });
  return tx();
}

export interface UpdateSessionFields {
  engine?: string;
  engineSessionId?: string | null;
  status?: Session['status'];
  model?: string | null;
  effortLevel?: string | null;
  lastContextTokens?: number | null;
  replyContext?: ReplyContext | null;
  messageId?: string | null;
  transportMeta?: JsonObject | null;
  lastActivity?: string;
  lastError?: string | null;
  title?: string;
  userId?: string | null;
}

export const VALID_SESSION_STATUSES: ReadonlySet<Session['status']> = new Set([
  'idle',
  'running',
  'error',
  'waiting',
  'interrupted',
]);

export function isValidSessionStatus(status: unknown): status is Session['status'] {
  return typeof status === 'string' && VALID_SESSION_STATUSES.has(status as Session['status']);
}

export function updateSession(id: string, updates: UpdateSessionFields): Session | undefined {
  const db = initDb();

  if (updates.status !== undefined && !isValidSessionStatus(updates.status)) {
    throw new Error(`Illegal session status: ${JSON.stringify(updates.status)}`);
  }

  const tx = db.transaction((sessionId: string) => {
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const before = rowToSession(row);
    const sets: string[] = [];
    const values: unknown[] = [];

    if (updates.engine !== undefined) { sets.push('engine = ?'); values.push(updates.engine); }
    if (updates.engineSessionId !== undefined) { sets.push('engine_session_id = ?'); values.push(updates.engineSessionId); }
    if (updates.status !== undefined) { sets.push('status = ?'); values.push(updates.status); }
    if (updates.model !== undefined) { sets.push('model = ?'); values.push(updates.model); }
    if (updates.effortLevel !== undefined) { sets.push('effort_level = ?'); values.push(updates.effortLevel); }
    if (updates.lastContextTokens !== undefined) { sets.push('last_context_tokens = ?'); values.push(updates.lastContextTokens); }
    if (updates.replyContext !== undefined) { sets.push('reply_context = ?'); values.push(updates.replyContext ? JSON.stringify(updates.replyContext) : null); }
    if (updates.messageId !== undefined) { sets.push('message_id = ?'); values.push(updates.messageId); }
    if (updates.transportMeta !== undefined) { sets.push('transport_meta = ?'); values.push(updates.transportMeta ? JSON.stringify(updates.transportMeta) : null); }
    if (updates.lastActivity !== undefined) { sets.push('last_activity = ?'); values.push(updates.lastActivity); }
    if (updates.lastError !== undefined) { sets.push('last_error = ?'); values.push(updates.lastError); }
    if (updates.title !== undefined) { sets.push('title = ?'); values.push(updates.title); }
    if (updates.userId !== undefined) { sets.push('user_id = ?'); values.push(updates.userId); }

    if (sets.length === 0) return before;

    values.push(sessionId);
    db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    const updatedRow = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Record<string, unknown> | undefined;
    const after = updatedRow ? rowToSession(updatedRow) : undefined;
    if (after) syncRunLedgerForSessionUpdate(before, after);
    return after;
  });

  return tx(id);
}

export function patchSessionTransportMeta(
  id: string,
  patch: JsonObject | ((current: JsonObject) => JsonObject | null),
): Session | undefined {
  const db = initDb();
  const tx = db.transaction((sessionId: string) => {
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    // Include the session id in the label so a corrupt transport_meta blob
    // (parseJsonObject warns and defaults to {}) can be traced back to the
    // affected session instead of silently vanishing into a generic log line.
    const current = parseJsonObject(row.transport_meta, `transport_meta (session ${sessionId})`) ?? {};
    const next = typeof patch === 'function'
      ? patch({ ...current })
      : { ...current, ...patch };
    db.prepare('UPDATE sessions SET transport_meta = ? WHERE id = ?')
      .run(next ? JSON.stringify(next) : null, sessionId);
    const updated = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Record<string, unknown> | undefined;
    return updated ? rowToSession(updated) : undefined;
  });
  return tx(id);
}

export function beginSessionRun(input: {
  sessionId: string;
  prompt?: string;
  replyContext?: ReplyContext | null;
  messageId?: string | null;
  transportMeta?: JsonObject | null;
  now?: string;
}): Session | undefined {
  const db = initDb();
  const now = input.now ?? new Date().toISOString();

  const tx = db.transaction((sessionId: string) => {
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const current = rowToSession(row);
    const runId = uuidv4();
    const parentRunId = resolveParentRunId(current.parentSessionId);
    const mergedTransportMeta = withRunMeta(input.transportMeta ?? current.transportMeta, runId);
    const replayOfRunId = sessionRunIdFromMeta(current.transportMeta, 'replayOfRunId');
    const retryOfRunId = sessionRunIdFromMeta(current.transportMeta, 'retryOfRunId');

    getRunLedger().createRun({
      runId,
      sessionId: current.id,
      source: current.source,
      sourceRef: current.sourceRef,
      engine: current.engine,
      title: current.title,
      promptExcerpt: promptExcerptOf(input.prompt) ?? current.promptExcerpt ?? null,
      createdAt: now,
      parentRunId,
      retryOfRunId,
      replayOfRunId,
      initialSessionStatus: current.status,
    });

    if (current.status === 'running') {
      getRunLedger().transitionRun({
        runId,
        nextState: 'running',
        at: now,
        payload: { reason: 'session_already_running' },
      });
    }

    db.prepare(`
      UPDATE sessions
         SET reply_context = ?,
             message_id = ?,
             transport_meta = ?,
             last_activity = ?,
             last_error = NULL
       WHERE id = ?
    `).run(
      input.replyContext !== undefined ? (input.replyContext ? JSON.stringify(input.replyContext) : null) : (current.replyContext ? JSON.stringify(current.replyContext) : null),
      input.messageId !== undefined ? input.messageId : current.messageId,
      JSON.stringify(mergedTransportMeta),
      now,
      sessionId,
    );

    const updatedRow = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Record<string, unknown> | undefined;
    return updatedRow ? rowToSession(updatedRow) : undefined;
  });

  return tx(input.sessionId);
}

export interface ListSessionsFilter {
  status?: Session['status'];
  source?: string;
  engine?: string;
}

export function listRecentCwds(limit = 8): string[] {
  const db = initDb();
  const rows = db
    .prepare(
      `SELECT cwd, MAX(last_activity) AS last
         FROM sessions
        WHERE cwd IS NOT NULL AND cwd != ''
        GROUP BY cwd
        ORDER BY last DESC
        LIMIT ?`,
    )
    .all(limit) as Array<{ cwd: string }>;
  return rows.map((r) => r.cwd);
}

export function listSessions(filter?: ListSessionsFilter): Session[] {
  const db = initDb();
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (filter?.status) { conditions.push('status = ?'); values.push(filter.status); }
  if (filter?.source) { conditions.push('source = ?'); values.push(filter.source); }
  if (filter?.engine) { conditions.push('engine = ?'); values.push(filter.engine); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM sessions ${where} ORDER BY last_activity DESC`).all(...values) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

export const CRON_GROUP = '__cron__';
export const DIRECT_GROUP = '__direct__';

export function coercePortalEmployee(
  employee: string | null | undefined,
  portalName: string | null | undefined,
): string | null {
  const emp = employee?.trim();
  if (!emp) return null;
  const slug = portalName ? portalEmployeeSlug(portalName) : null;
  if (slug && emp.toLowerCase() === slug) return null;
  return emp;
}

export function listRecentPerGroup(perGroup: number, portalSlug?: string | null): Session[] {
  const db = initDb();
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY group_key ORDER BY last_activity DESC) AS __rn
         FROM sessions
       ) WHERE __rn <= ? ORDER BY last_activity DESC`,
    )
    .all(perGroup) as Record<string, unknown>[];
  if (!portalSlug) return rows.map(rowToSession);

  const directIds = new Set<string>();
  const slug = portalEmployeeSlug(portalSlug);
  const directRows: Record<string, unknown>[] = [];
  const out: Record<string, unknown>[] = [];

  for (const row of rows) {
    const groupKey = String(row.group_key ?? DIRECT_GROUP);
    if (groupKey === DIRECT_GROUP || groupKey.toLowerCase() === slug) {
      directRows.push(row);
      continue;
    }
    out.push(row);
  }

  directRows
    .sort((a, b) => String(b.last_activity).localeCompare(String(a.last_activity)))
    .slice(0, perGroup)
    .forEach((row) => {
      if (directIds.has(String(row.id))) return;
      directIds.add(String(row.id));
      out.push(row);
    });

  out.sort((a, b) => String(b.last_activity).localeCompare(String(a.last_activity)));
  return out.map(rowToSession);
}

export function listSessionsForGroup(
  group: string,
  limit: number,
  offset: number,
  portalSlug?: string | null,
): Session[] {
  const db = initDb();
  const slug = portalSlug ? portalEmployeeSlug(portalSlug) : null;
  let query = 'SELECT * FROM sessions WHERE group_key = ? ORDER BY last_activity DESC LIMIT ? OFFSET ?';
  let params: unknown[] = [group, limit, offset];
  if (group === DIRECT_GROUP && slug) {
    query = `SELECT * FROM sessions
      WHERE group_key = ? OR LOWER(group_key) = ?
      ORDER BY last_activity DESC LIMIT ? OFFSET ?`;
    params = [group, slug, limit, offset];
  } else if (group !== DIRECT_GROUP && group !== CRON_GROUP && slug && group.toLowerCase() === slug) {
    return [];
  }
  const rows = db.prepare(query).all(...params) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

export function searchSessions(query: string, limit = 100): Session[] {
  const db = initDb();
  const like = `%${query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  const rows = db
    .prepare(
      `SELECT * FROM sessions
       WHERE title LIKE ? ESCAPE '\\' OR employee LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\'
       ORDER BY last_activity DESC LIMIT ?`,
    )
    .all(like, like, like, limit) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

export function listSessionsBySource(source: string, limit: number): Session[] {
  const db = initDb();
  const rows = db.prepare(`SELECT * FROM sessions WHERE source = ? ORDER BY last_activity DESC LIMIT ?`)
    .all(source, limit) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

export function listChildSessions(parentSessionId: string): Session[] {
  const db = initDb();
  const rows = db.prepare(`SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY last_activity DESC`)
    .all(parentSessionId) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

export function getSessionGroupCounts(portalSlug?: string | null): Record<string, number> {
  const db = initDb();
  const rows = db.prepare('SELECT group_key AS grp, COUNT(*) AS n FROM sessions GROUP BY group_key')
    .all() as Array<{ grp: string; n: number }>;
  const out: Record<string, number> = {};
  const slug = portalSlug ? portalEmployeeSlug(portalSlug) : null;
  for (const r of rows) {
    const groupKey = String(r.grp ?? DIRECT_GROUP);
    if (slug && groupKey.toLowerCase() === slug) {
      out[DIRECT_GROUP] = (out[DIRECT_GROUP] ?? 0) + r.n;
      continue;
    }
    out[groupKey] = (out[groupKey] ?? 0) + r.n;
  }
  return out;
}

export function recoverStaleSessions(): number {
  const now = new Date().toISOString();
  const running = listSessions({ status: 'running' });
  let changed = 0;
  for (const session of running) {
    const updated = updateSession(session.id, {
      status: 'interrupted',
      lastActivity: now,
      lastError: 'Interrupted: gateway restarted while session was running',
    });
    if (updated) changed += 1;
  }
  return changed;
}

export function getInterruptedSessions(): Session[] {
  const db = initDb();
  const rows = db.prepare(
    "SELECT * FROM sessions WHERE status = 'interrupted' AND engine_session_id IS NOT NULL ORDER BY last_activity DESC",
  ).all() as Record<string, unknown>[];
  return rows.map(rowToSession);
}

export function accumulateSessionCost(id: string, cost: number, turns: number): void {
  const db = initDb();
  db.prepare('UPDATE sessions SET total_cost = total_cost + ?, total_turns = total_turns + ? WHERE id = ?')
    .run(cost, turns, id);
}

export function duplicateSession(sourceId: string, newTitle?: string): { session: Session; messageCount: number } {
  const db = initDb();
  const source = getSession(sourceId);
  if (!source) throw new Error(`Session ${sourceId} not found`);
  if (!source.engineSessionId) throw new Error(`Session ${sourceId} has no engine session ID — cannot duplicate`);

  const now = new Date().toISOString();
  const newId = uuidv4();
  const title = newTitle ?? `Copy of ${source.title || sourceId.slice(0, 8)}`;
  const newSessionKey = `web:${Date.now()}`;
  const replayOfRunId = sessionRunIdFromMeta(source.transportMeta, 'latestRunId')
    ?? sessionRunIdFromMeta(source.transportMeta, 'activeRunId');
  const messages = db.prepare(
    'SELECT role, content, timestamp, media, blocks FROM messages WHERE session_id = ? ORDER BY timestamp ASC',
  ).all(sourceId) as Array<{ role: string; content: string; timestamp: number; media: string | null; blocks: string | null }>;

  const txn = db.transaction(() => {
    const nextTransportMeta = {
      ...(source.transportMeta ?? {}),
      ...(replayOfRunId ? { replayOfRunId } : {}),
    } satisfies JsonObject;
    db.prepare(`
      INSERT INTO sessions (
        id, engine, engine_session_id, source, source_ref, connector, session_key,
        reply_context, message_id, transport_meta,
        employee, group_key, model, title, prompt_excerpt, parent_session_id, user_id, effort_level, cwd, status,
        total_cost, total_turns, created_at, last_activity
      )
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'idle', 0, 0, ?, ?)
    `).run(
      newId,
      source.engine,
      source.source,
      source.sourceRef,
      source.connector,
      newSessionKey,
      source.replyContext ? JSON.stringify(source.replyContext) : null,
      source.messageId,
      JSON.stringify(nextTransportMeta),
      source.employee,
      computeGroupKey(source.source, source.sourceRef, source.employee),
      source.model,
      title,
      source.promptExcerpt,
      source.userId ?? null,
      source.effortLevel,
      source.cwd ?? null,
      now,
      now,
    );
    const insertMsg = db.prepare(
      'INSERT INTO messages (id, session_id, role, content, timestamp, media, blocks) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const msg of messages) {
      insertMsg.run(uuidv4(), newId, msg.role, msg.content, msg.timestamp, msg.media ?? null, msg.blocks ?? null);
    }
  });
  txn();

  return { session: getSession(newId)!, messageCount: messages.length };
}

/**
 * Cached emails outlive the session that processed them: their session_id is a
 * soft annotation. Unlink (set NULL) instead of deleting so the email record is
 * preserved but no longer points at a removed session. Shared by deleteSession/
 * deleteSessions and any other path that removes session rows (e.g. archiving),
 * so email records never dangle regardless of which removal path is used.
 */
export function unlinkEmailReferencesForSessions(db: Database.Database, ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE email_messages SET session_id = NULL WHERE session_id IN (${placeholders})`).run(...ids);
  db.prepare(`UPDATE email_ingest_state SET session_id = NULL WHERE session_id IN (${placeholders})`).run(...ids);
}

export function deleteSession(id: string): boolean {
  const db = initDb();
  const session = getSession(id);
  if (!session) return false;
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM queue_items WHERE session_id = ?').run(id);
    if (session.sessionKey) db.prepare('DELETE FROM queue_pauses WHERE session_key = ?').run(session.sessionKey);
    // approvals are owned by the session (session_id NOT NULL) — delete them so a
    // removed session leaves no dangling approval rows.
    db.prepare('DELETE FROM approvals WHERE session_id = ?').run(id);
    unlinkEmailReferencesForSessions(db, [id]);
    const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return result.changes > 0;
  });
  return txn();
}

export function deleteSessions(ids: string[]): number {
  if (ids.length === 0) return 0;
  const db = initDb();
  const placeholders = ids.map(() => '?').join(',');
  const txn = db.transaction(() => {
    const sessionKeys = db.prepare(
      `SELECT session_key as sessionKey FROM sessions WHERE id IN (${placeholders})`,
    ).all(...ids) as Array<{ sessionKey: string }>;
    db.prepare(`DELETE FROM messages WHERE session_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM queue_items WHERE session_id IN (${placeholders})`).run(...ids);
    if (sessionKeys.length > 0) {
      const keyPlaceholders = sessionKeys.map(() => '?').join(',');
      db.prepare(`DELETE FROM queue_pauses WHERE session_key IN (${keyPlaceholders})`)
        .run(...sessionKeys.map((row) => row.sessionKey));
    }
    // See deleteSession: owned approvals are deleted; soft email links are unlinked.
    db.prepare(`DELETE FROM approvals WHERE session_id IN (${placeholders})`).run(...ids);
    unlinkEmailReferencesForSessions(db, ids);
    return db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...ids).changes;
  });
  return txn();
}

export function getEmployeeSpendSince(employee: string, sinceIsoDate: string): number {
  const row = initDb()
    .prepare("SELECT COALESCE(SUM(total_cost), 0) as spend FROM sessions WHERE employee = ? AND created_at >= ?")
    .get(employee, sinceIsoDate) as { spend: number };
  return Number(row.spend ?? 0);
}
