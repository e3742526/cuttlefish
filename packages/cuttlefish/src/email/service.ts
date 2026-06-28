import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EmailAttachmentRecord, EmailConfig, EmailInboxConfig, EmailInboxHealth, EmailMessageRecord } from "../shared/types.js";
import { FILES_DIR } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { sanitizeUploadFilename } from "../gateway/files/storage.js";
import { getEmailIngestState, getEmailMessage, listEmailInboxHealth, listEmailMessages, setEmailInboxHealth, upsertEmailIngestState, upsertEmailMessage } from "./store.js";
import type { EmailMailboxClient } from "./client.js";
import { normalizeEmail } from "./normalize.js";
import { getFile, insertFile } from "../sessions/registry.js";

export interface EmailServiceDeps {
  client: EmailMailboxClient;
  onAutoIngest?: (message: EmailMessageRecord) => Promise<string | null>;
}

export interface EmailCheckResult {
  inboxId: string;
  checked: number;
  messages: EmailMessageRecord[];
}

async function persistAttachment(messageId: string, attachment: {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  content: Buffer;
  contentId?: string | null;
}): Promise<EmailAttachmentRecord> {
  const artifactId = crypto.randomUUID();
  const existing = getFile(artifactId);
  if (existing) {
    return {
      id: attachment.id,
      filename: existing.filename,
      contentType: existing.mimetype ?? attachment.contentType,
      size: existing.size,
      artifactId: existing.id,
      contentId: attachment.contentId ?? null,
    };
  }
  const filename = sanitizeUploadFilename(attachment.filename);
  const dir = path.join(FILES_DIR, artifactId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, attachment.content);
  insertFile({
    id: artifactId,
    filename,
    size: attachment.size,
    mimetype: attachment.contentType,
    path: filePath,
    sha256: crypto.createHash("sha256").update(attachment.content).digest("hex"),
    artifactKind: "downloaded",
    sourcePath: `email:${messageId}:${attachment.id}`,
  });
  return {
    id: attachment.id,
    filename,
    contentType: attachment.contentType,
    size: attachment.size,
    artifactId,
    contentId: attachment.contentId ?? null,
  };
}

export class EmailService {
  private config: EmailConfig;
  private readonly client: EmailMailboxClient;
  private readonly onAutoIngest?: (message: EmailMessageRecord) => Promise<string | null>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly inFlight = new Set<string>();

  constructor(config: EmailConfig | undefined, deps: EmailServiceDeps) {
    this.config = config ?? {};
    this.client = deps.client;
    this.onAutoIngest = deps.onAutoIngest;
  }

  setConfig(config: EmailConfig | undefined): void {
    this.config = config ?? {};
  }

  start(): void {
    this.stop();
    if (this.config.enabled !== true || !this.config.inboxes?.length) return;
    const intervalMs = Math.max(15, this.config.pollIntervalSeconds ?? 60) * 1000;
    this.timer = setInterval(() => {
      void this.checkAll().catch((err) => logger.error(`Email poll loop failed: ${err instanceof Error ? err.message : String(err)}`));
    }, intervalMs);
    this.timer.unref?.();
    void this.checkAll().catch((err) => logger.error(`Email startup poll failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  listInboxes(): Array<EmailInboxConfig & { health?: EmailInboxHealth }> {
    const healthByInbox = new Map(listEmailInboxHealth().map((entry) => [entry.inboxId, entry]));
    return (this.config.inboxes ?? []).map((inbox) => ({ ...inbox, health: healthByInbox.get(inbox.id) }));
  }

  listMessages(inboxId: string, limit = 20): EmailMessageRecord[] {
    return listEmailMessages(inboxId, limit);
  }

  getMessage(messageId: string): EmailMessageRecord | undefined {
    return getEmailMessage(messageId);
  }

  async checkAll(): Promise<EmailCheckResult[]> {
    const results: EmailCheckResult[] = [];
    for (const inbox of this.config.inboxes ?? []) {
      results.push(await this.checkInbox(inbox.id));
    }
    return results;
  }

  async checkInbox(inboxId: string): Promise<EmailCheckResult> {
    const inbox = (this.config.inboxes ?? []).find((entry) => entry.id === inboxId);
    if (!inbox) throw new Error(`Unknown inbox ${inboxId}`);
    if (this.inFlight.has(inbox.id)) {
      return { inboxId: inbox.id, checked: 0, messages: this.listMessages(inbox.id, inbox.maxMessagesPerPoll ?? 10) };
    }
    this.inFlight.add(inbox.id);
    const checkedAt = new Date().toISOString();
    try {
      const fetched = await this.client.fetchUnread(inbox);
      const results: EmailMessageRecord[] = [];
      for (const message of fetched) {
        const existing = getEmailIngestState(inbox.id, message.providerMessageId);
        const existingMessage = existing?.emailMessageId ? getEmailMessage(existing.emailMessageId) : undefined;
        const normalized = await normalizeEmail(inbox, message.providerMessageId, message.raw);
        const persistedAttachments: EmailAttachmentRecord[] = existingMessage?.attachments?.length
          ? existingMessage.attachments
          : await Promise.all(normalized.attachments.map((attachment) => persistAttachment(normalized.record.id, attachment)));
        const persisted = upsertEmailMessage({
          ...normalized.record,
          attachments: persistedAttachments,
          status: existing?.status === "ingested" ? "ingested" : normalized.record.status,
          sessionId: existing?.sessionId ?? null,
          error: existing?.error ?? null,
        });
        upsertEmailIngestState({
          inboxId: inbox.id,
          providerMessageId: message.providerMessageId,
          emailMessageId: persisted.id,
          status: existing?.status ?? "cached",
          sessionId: existing?.sessionId ?? null,
          error: existing?.error ?? null,
        });
        if (inbox.autoIngest !== false && existing?.status !== "ingested" && this.onAutoIngest) {
          try {
            const sessionId = await this.onAutoIngest(persisted);
            upsertEmailMessage({ ...persisted, status: "ingested", sessionId, error: null });
            upsertEmailIngestState({
              inboxId: inbox.id,
              providerMessageId: message.providerMessageId,
              emailMessageId: persisted.id,
              status: "ingested",
              sessionId,
              error: null,
            });
            results.push(getEmailMessage(persisted.id) ?? persisted);
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            upsertEmailMessage({ ...persisted, status: "error", error });
            upsertEmailIngestState({
              inboxId: inbox.id,
              providerMessageId: message.providerMessageId,
              emailMessageId: persisted.id,
              status: "error",
              sessionId: null,
              error,
            });
            results.push(getEmailMessage(persisted.id) ?? persisted);
          }
        } else {
          results.push(persisted);
        }
      }
      setEmailInboxHealth({
        inboxId: inbox.id,
        status: "ok",
        detail: null,
        lastCheckedAt: checkedAt,
        lastSuccessAt: checkedAt,
        lastErrorAt: null,
      });
      return { inboxId: inbox.id, checked: fetched.length, messages: results };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setEmailInboxHealth({
        inboxId: inbox.id,
        status: "error",
        detail,
        lastCheckedAt: checkedAt,
        lastSuccessAt: null,
        lastErrorAt: checkedAt,
      });
      return { inboxId: inbox.id, checked: 0, messages: [] };
    } finally {
      this.inFlight.delete(inbox.id);
    }
  }
}
