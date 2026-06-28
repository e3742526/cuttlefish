import crypto from "node:crypto";
import type { EmailAttachmentRecord, EmailInboxHealth, EmailMessageRecord } from "../shared/types.js";
import { initDb } from "../sessions/registry/core.js";

type EmailMessageRow = Record<string, unknown>;

function nowIso(): string {
  return new Date().toISOString();
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function parseHeaders(value: unknown): Record<string, string> {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(([, entry]) => typeof entry === "string") as Array<[string, string]>,
    );
  } catch {
    return {};
  }
}

function parseAttachments(value: unknown): EmailAttachmentRecord[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is EmailAttachmentRecord => !!entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).id === "string")
      : [];
  } catch {
    return [];
  }
}

function rowToEmailMessage(row: EmailMessageRow): EmailMessageRecord {
  return {
    id: row.id as string,
    inboxId: row.inbox_id as string,
    providerMessageId: row.provider_message_id as string,
    messageIdHeader: (row.message_id_header as string) ?? null,
    threadKey: row.thread_key as string,
    fromAddress: (row.from_address as string) ?? null,
    toAddresses: parseStringArray(row.to_addresses),
    ccAddresses: parseStringArray(row.cc_addresses),
    subject: (row.subject as string) ?? null,
    receivedAt: (row.received_at as string) ?? null,
    textBody: (row.text_body as string) ?? "",
    htmlBody: (row.html_body as string) ?? null,
    headers: parseHeaders(row.headers_json),
    authResults: (row.auth_results as string) ?? null,
    attachments: parseAttachments(row.attachments_json),
    status: (row.status as EmailMessageRecord["status"]) ?? "cached",
    sessionId: (row.session_id as string) ?? null,
    error: (row.error as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function emailMessageId(inboxId: string, providerMessageId: string): string {
  return `email-${crypto.createHash("sha256").update(`${inboxId}:${providerMessageId}`).digest("hex").slice(0, 20)}`;
}

export function upsertEmailMessage(input: Omit<EmailMessageRecord, "createdAt" | "updatedAt">): EmailMessageRecord {
  const db = initDb();
  const createdAt = nowIso();
  const updatedAt = createdAt;
  const receivedAt = input.receivedAt ?? createdAt;
  db.prepare(`
    INSERT INTO email_messages (
      id, inbox_id, provider_message_id, message_id_header, thread_key, from_address,
      to_addresses, cc_addresses, subject, received_at, text_body, html_body,
      headers_json, auth_results, attachments_json, status, session_id, error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      message_id_header = excluded.message_id_header,
      thread_key = excluded.thread_key,
      from_address = excluded.from_address,
      to_addresses = excluded.to_addresses,
      cc_addresses = excluded.cc_addresses,
      subject = excluded.subject,
      received_at = excluded.received_at,
      text_body = excluded.text_body,
      html_body = excluded.html_body,
      headers_json = excluded.headers_json,
      auth_results = excluded.auth_results,
      attachments_json = excluded.attachments_json,
      status = excluded.status,
      session_id = excluded.session_id,
      error = excluded.error,
      updated_at = excluded.updated_at
  `).run(
    input.id,
    input.inboxId,
    input.providerMessageId,
    input.messageIdHeader,
    input.threadKey,
    input.fromAddress,
    JSON.stringify(input.toAddresses),
    JSON.stringify(input.ccAddresses),
    input.subject,
    receivedAt,
    input.textBody,
    input.htmlBody,
    JSON.stringify(input.headers),
    input.authResults,
    JSON.stringify(input.attachments),
    input.status,
    input.sessionId,
    input.error,
    createdAt,
    updatedAt,
  );
  return getEmailMessage(input.id)!;
}

export function getEmailMessage(id: string): EmailMessageRecord | undefined {
  const db = initDb();
  const row = db.prepare("SELECT * FROM email_messages WHERE id = ?").get(id) as EmailMessageRow | undefined;
  return row ? rowToEmailMessage(row) : undefined;
}

export function listEmailMessages(inboxId: string, limit = 20): EmailMessageRecord[] {
  const db = initDb();
  const rows = db.prepare(
    `SELECT * FROM email_messages WHERE inbox_id = ? ORDER BY received_at DESC, created_at DESC LIMIT ?`,
  ).all(inboxId, limit) as EmailMessageRow[];
  return rows.map(rowToEmailMessage);
}

export function upsertEmailIngestState(input: {
  inboxId: string;
  providerMessageId: string;
  emailMessageId: string;
  status: "cached" | "dispatching" | "ingested" | "error";
  sessionId?: string | null;
  error?: string | null;
}): void {
  const db = initDb();
  const timestamp = nowIso();
  db.prepare(`
    INSERT INTO email_ingest_state (
      inbox_id, provider_message_id, email_message_id, status, session_id, error, first_seen_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(inbox_id, provider_message_id) DO UPDATE SET
      email_message_id = excluded.email_message_id,
      status = excluded.status,
      session_id = excluded.session_id,
      error = excluded.error,
      updated_at = excluded.updated_at
  `).run(
    input.inboxId,
    input.providerMessageId,
    input.emailMessageId,
    input.status,
    input.sessionId ?? null,
    input.error ?? null,
    timestamp,
    timestamp,
  );
}

/**
 * Persist an email message and its dedup/ingest state as a single atomic unit.
 * The message status and the ingest-state status are written in one transaction
 * so the two tables can never diverge (the gate trusts `email_ingest_state` while
 * the UI reads `email_messages`). Returns the stored message.
 */
export function persistEmailMessageWithState(
  message: Omit<EmailMessageRecord, "createdAt" | "updatedAt">,
  ingest: { status: "cached" | "dispatching" | "ingested" | "error"; sessionId?: string | null; error?: string | null },
): EmailMessageRecord {
  const db = initDb();
  const apply = db.transaction(() => {
    upsertEmailMessage(message);
    upsertEmailIngestState({
      inboxId: message.inboxId,
      providerMessageId: message.providerMessageId,
      emailMessageId: message.id,
      status: ingest.status,
      sessionId: ingest.sessionId ?? null,
      error: ingest.error ?? null,
    });
  });
  apply();
  return getEmailMessage(message.id)!;
}

export function getEmailIngestState(inboxId: string, providerMessageId: string): {
  inboxId: string;
  providerMessageId: string;
  emailMessageId: string;
  status: "cached" | "dispatching" | "ingested" | "error";
  sessionId: string | null;
  error: string | null;
} | undefined {
  const db = initDb();
  const row = db.prepare(
    "SELECT * FROM email_ingest_state WHERE inbox_id = ? AND provider_message_id = ?",
  ).get(inboxId, providerMessageId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    inboxId: row.inbox_id as string,
    providerMessageId: row.provider_message_id as string,
    emailMessageId: row.email_message_id as string,
    status: (row.status as "cached" | "dispatching" | "ingested" | "error") ?? "cached",
    sessionId: (row.session_id as string) ?? null,
    error: (row.error as string) ?? null,
  };
}

/**
 * Resolve dedup/ingest state for a fetched message, with a one-time fallback to the
 * legacy bare-UID key. Before the UIDVALIDITY-namespaced identity shipped, the dedup
 * key was the bare UID; afterwards keys are `<uidvalidity>:<uid>`. Without this
 * fallback the very deploy that carries the new identity would re-ingest the entire
 * backlog (every already-handled message keyed by its old bare UID). The fallback is
 * deterministic (keyed on the client-controlled UID, not a spoofable header) and only
 * fires when no new-format row exists yet.
 */
export function resolveEmailIngestState(inboxId: string, providerMessageId: string): ReturnType<typeof getEmailIngestState> {
  const exact = getEmailIngestState(inboxId, providerMessageId);
  if (exact) return exact;
  const colon = providerMessageId.indexOf(":");
  if (colon < 0) return undefined; // already legacy-shaped; nothing to fall back to
  const legacyKey = providerMessageId.slice(colon + 1);
  return getEmailIngestState(inboxId, legacyKey);
}

/**
 * Reflect an asynchronous agent-run failure back onto the email record. The run is
 * dispatched fire-and-forget, so a run that fails after `ingested` was written would
 * otherwise leave the email as a silent false-success. Only downgrades `ingested` ->
 * `error` (compare-and-set) so it cannot race a later poll or clobber another state.
 */
export function markEmailMessageRunFailed(emailMessageId: string, error: string): void {
  const db = initDb();
  const timestamp = nowIso();
  const apply = db.transaction(() => {
    const changed = db.prepare(
      "UPDATE email_messages SET status = 'error', error = ?, updated_at = ? WHERE id = ? AND status = 'ingested'",
    ).run(error, timestamp, emailMessageId).changes;
    if (changed > 0) {
      db.prepare(
        "UPDATE email_ingest_state SET status = 'error', error = ?, updated_at = ? WHERE email_message_id = ? AND status = 'ingested'",
      ).run(error, timestamp, emailMessageId);
    }
  });
  apply();
}

export function setEmailInboxHealth(input: Omit<EmailInboxHealth, "cachedCount">): void {
  const db = initDb();
  db.prepare(`
    INSERT INTO email_inbox_health (
      inbox_id, status, detail, last_checked_at, last_success_at, last_error_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(inbox_id) DO UPDATE SET
      status = excluded.status,
      detail = excluded.detail,
      last_checked_at = excluded.last_checked_at,
      last_success_at = excluded.last_success_at,
      last_error_at = excluded.last_error_at
  `).run(
    input.inboxId,
    input.status,
    input.detail,
    input.lastCheckedAt,
    input.lastSuccessAt,
    input.lastErrorAt,
  );
}

export function listEmailInboxHealth(): EmailInboxHealth[] {
  const db = initDb();
  const rows = db.prepare(
    `SELECT h.*, (
      SELECT COUNT(*) FROM email_messages m WHERE m.inbox_id = h.inbox_id
    ) AS cached_count FROM email_inbox_health h ORDER BY h.inbox_id ASC`,
  ).all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    inboxId: row.inbox_id as string,
    status: (row.status as EmailInboxHealth["status"]) ?? "idle",
    detail: (row.detail as string) ?? null,
    lastCheckedAt: (row.last_checked_at as string) ?? null,
    lastSuccessAt: (row.last_success_at as string) ?? null,
    lastErrorAt: (row.last_error_at as string) ?? null,
    cachedCount: Number(row.cached_count ?? 0),
  }));
}
