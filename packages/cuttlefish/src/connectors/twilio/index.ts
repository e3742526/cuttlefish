import type http from "node:http";
import Twilio from "twilio";
import type {
  Connector,
  ConnectorCapabilities,
  ConnectorHealth,
  IncomingMessage,
  ReplyContext,
  Target,
  TwilioConnectorConfig,
} from "../../shared/types.js";
import { logger } from "../../shared/logger.js";
import { BodyTooLargeError, readBody } from "../../gateway/http-helpers.js";
import { claimConnectorWebhookReplay, releaseConnectorWebhookReplay } from "../../sessions/registry.js";
import { formatAndChunk } from "../shared/format.js";

const TWILIO_WEBHOOK_MAX_BYTES = 64 * 1024;
const TWILIO_SMS_MAX_LENGTH = 1600;
export const TWILIO_WEBHOOK_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

interface TwilioMessageClient {
  messages: {
    create(input: {
      body: string;
      to: string;
      from?: string;
      messagingServiceSid?: string;
    }): Promise<{ sid: string }>;
  };
}

export interface TwilioConnectorDeps {
  env?: NodeJS.ProcessEnv;
  client?: TwilioMessageClient;
  replayStore?: TwilioWebhookReplayStore;
  now?: () => number;
}

export interface TwilioWebhookReplayStore {
  claim(input: { keys: string[]; now: number; ttlMs: number }): string | null;
  release(input: { keys: string[]; claimId: string }): void;
}

interface TwilioCredentials {
  accountSid: string;
  authToken: string;
}

function resolveCredentials(env: NodeJS.ProcessEnv): TwilioCredentials | null {
  const accountSid = (env.TWILIO_ACCOUNT_SID ?? env.TWILIO_SID ?? "").trim();
  const authToken = (env.TWILIO_AUTH_TOKEN ?? env.TWILIO_CLIENT_SECRET ?? "").trim();
  return accountSid && authToken ? { accountSid, authToken } : null;
}

function parseWebhookForm(raw: string): Record<string, string> | null {
  const values: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(raw)) {
    // Twilio's inbound SMS webhook has one value for each field. Rejecting
    // duplicate names avoids parameter-smuggling between validation and use.
    if (Object.hasOwn(values, key)) return null;
    values[key] = value;
  }
  return values;
}

function writeTwiML(res: http.ServerResponse, status = 200): void {
  res.writeHead(status, {
    "Content-Type": "text/xml; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(EMPTY_TWIML);
}

function isFormEncoded(contentType: string | undefined): boolean {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/x-www-form-urlencoded";
}

function oneHeaderValue(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function replayKeys(req: http.IncomingMessage, messageSid: string | undefined): { keys: string[]; source: string } | null {
  const idempotencyToken = oneHeaderValue(req.headers["i-twilio-idempotency-token"]);
  const keys = [
    ...(messageSid ? [`message_sid:${messageSid}`] : []),
    ...(idempotencyToken ? [`idempotency_token:${idempotencyToken}`] : []),
  ];
  if (keys.length === 0) return null;
  const source = messageSid && idempotencyToken
    ? "message_sid+idempotency_token"
    : messageSid ? "message_sid" : "idempotency_token";
  return { keys, source };
}

const durableReplayStore: TwilioWebhookReplayStore = {
  claim: ({ keys, now, ttlMs }) => claimConnectorWebhookReplay({ connector: "twilio", keys, now, ttlMs }),
  release: ({ keys, claimId }) => releaseConnectorWebhookReplay({ connector: "twilio", keys, claimId }),
};

/**
 * Twilio Programmable Messaging connector. Inbound requests are validated by
 * Twilio's official helper before they can create or continue a session.
 */
export class TwilioConnector implements Connector {
  name = "twilio";
  private readonly config: TwilioConnectorConfig;
  private readonly credentials: TwilioCredentials | null;
  private readonly client: TwilioMessageClient | null;
  private readonly allowedSenders: Set<string>;
  private readonly replayStore: TwilioWebhookReplayStore;
  private readonly now: () => number;
  private handler: ((msg: IncomingMessage) => void) | null = null;
  private status: ConnectorHealth["status"] = "stopped";
  private lastError: string | undefined;

  private readonly capabilities: ConnectorCapabilities = {
    threading: false,
    messageEdits: false,
    reactions: false,
    attachments: false,
  };

  constructor(config: TwilioConnectorConfig, deps: TwilioConnectorDeps = {}) {
    this.config = config;
    this.credentials = resolveCredentials(deps.env ?? process.env);
    this.client = deps.client ?? (this.credentials
      ? Twilio(this.credentials.accountSid, this.credentials.authToken) as unknown as TwilioMessageClient
      : null);
    this.replayStore = deps.replayStore ?? durableReplayStore;
    this.now = deps.now ?? Date.now;
    const allowFrom = config.allowFrom === undefined
      ? []
      : Array.isArray(config.allowFrom) ? config.allowFrom : [config.allowFrom];
    this.allowedSenders = new Set(allowFrom.map((value) => value.trim()).filter(Boolean));
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (!this.credentials || !this.client) {
      this.status = "error";
      this.lastError = "Twilio credentials are missing. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.";
      throw new Error(this.lastError);
    }
    this.status = "running";
    this.lastError = undefined;
    if (this.allowedSenders.size === 0) {
      logger.warn("Twilio SMS connector has no allowFrom entries; inbound SMS is denied until a sender is allowlisted");
    }
    logger.info("Twilio SMS connector started");
  }

  async stop(): Promise<void> {
    this.status = "stopped";
    this.lastError = undefined;
    logger.info("Twilio SMS connector stopped");
  }

  getCapabilities(): ConnectorCapabilities {
    return this.capabilities;
  }

  getHealth(): ConnectorHealth {
    return {
      status: this.status,
      detail: this.lastError,
      capabilities: this.capabilities,
    };
  }

  reconstructTarget(replyContext: ReplyContext): Target {
    const context = replyContext as Record<string, unknown>;
    return {
      channel: typeof context.channel === "string" ? context.channel : "",
      messageTs: typeof context.messageSid === "string" ? context.messageSid : undefined,
      replyContext,
    };
  }

  async sendMessage(target: Target, text: string): Promise<string | undefined> {
    if (!this.client || !text.trim() || !target.channel.trim()) return undefined;

    const replyContext = target.replyContext as Record<string, unknown> | undefined;
    const replyFrom = typeof replyContext?.from === "string" ? replyContext.from : undefined;
    const from = replyFrom || this.config.fromNumber;
    if (!from && !this.config.messagingServiceSid) {
      logger.error("Twilio SMS send skipped: configure fromNumber or messagingServiceSid");
      return undefined;
    }

    try {
      let lastSid: string | undefined;
      let sentChunks = 0;
      for (const chunk of formatAndChunk(text, TWILIO_SMS_MAX_LENGTH)) {
        if (!chunk.trim()) continue;
        const message = await this.client.messages.create({
          body: chunk,
          to: target.channel,
          ...(from ? { from } : { messagingServiceSid: this.config.messagingServiceSid! }),
        });
        lastSid = message.sid;
        sentChunks += 1;
      }
      logger.info(`twilio_sms outcome=sent chunks=${sentChunks}`);
      return lastSid;
    } catch {
      logger.error("twilio_sms outcome=send_failed");
      return undefined;
    }
  }

  async replyMessage(target: Target, text: string): Promise<string | undefined> {
    return this.sendMessage(target, text);
  }

  async editMessage(_target: Target, _text: string): Promise<void> {}
  async addReaction(_target: Target, _emoji: string): Promise<void> {}
  async removeReaction(_target: Target, _emoji: string): Promise<void> {}

  async handleInboundWebhook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.status !== "running" || !this.credentials) {
      logger.warn("twilio_webhook outcome=rejected reason=connector_not_running");
      writeTwiML(res, 503);
      return;
    }
    if (!isFormEncoded(req.headers["content-type"])) {
      logger.warn("twilio_webhook outcome=rejected reason=unsupported_content_type");
      writeTwiML(res, 415);
      return;
    }

    let raw: string;
    try {
      raw = await readBody(req, { maxBytes: TWILIO_WEBHOOK_MAX_BYTES });
    } catch (err) {
      logger.warn(`twilio_webhook outcome=rejected reason=${err instanceof BodyTooLargeError ? "body_too_large" : "body_read_failed"}`);
      writeTwiML(res, err instanceof BodyTooLargeError ? 413 : 400);
      return;
    }
    const params = parseWebhookForm(raw);
    const signature = req.headers["x-twilio-signature"];
    let validSignature = false;
    try {
      validSignature = !!params && typeof signature === "string" && !!signature
        && Twilio.validateRequest(this.credentials.authToken, signature, this.config.webhookUrl, params);
    } catch {
      validSignature = false;
    }
    if (!validSignature || !params) {
      logger.warn("twilio_webhook outcome=rejected reason=invalid_signature_or_payload");
      writeTwiML(res, 403);
      return;
    }

    const from = params.From?.trim();
    const to = params.To?.trim();
    const text = params.Body?.trim();
    const messageSid = params.MessageSid?.trim();
    const handler = this.handler;
    if (!from || !to || !text || !handler) {
      logger.warn(`twilio_webhook outcome=rejected reason=${handler ? "missing_message_fields" : "no_handler"}`);
      writeTwiML(res);
      return;
    }
    if (this.config.fromNumber && to !== this.config.fromNumber) {
      logger.warn("twilio_webhook outcome=rejected reason=destination_mismatch");
      writeTwiML(res);
      return;
    }
    if (!this.allowedSenders.has(from)) {
      logger.warn("twilio_webhook outcome=rejected reason=sender_not_allowlisted");
      writeTwiML(res);
      return;
    }
    const replay = replayKeys(req, messageSid);
    let claimId: string | null | undefined;
    if (replay) {
      try {
        claimId = this.replayStore.claim({
          keys: replay.keys,
          now: this.now(),
          ttlMs: TWILIO_WEBHOOK_REPLAY_TTL_MS,
        });
      } catch {
        logger.error("twilio_webhook outcome=replay_store_failed");
        writeTwiML(res, 503);
        return;
      }
    }
    if (replay && !claimId) {
      logger.info(`twilio_webhook outcome=duplicate_suppressed replay_key=${replay.source}`);
      writeTwiML(res);
      return;
    }

    try {
      handler({
        connector: "twilio",
        source: "twilio",
        sessionKey: `twilio:${from}`,
        replyContext: { channel: from, from: to, messageSid: messageSid ?? null },
        messageId: messageSid || undefined,
        channel: from,
        user: from,
        userId: from,
        text,
        attachments: [],
        raw: params,
        transportMeta: { from, to, messageSid: messageSid ?? null },
      });
    } catch {
      if (replay && claimId) {
        try {
          this.replayStore.release({ keys: replay.keys, claimId });
        } catch {
          logger.error("twilio_webhook outcome=replay_release_failed");
        }
      }
      logger.error("twilio_webhook outcome=dispatch_failed");
      writeTwiML(res, 500);
      return;
    }
    logger.info(`twilio_webhook outcome=accepted replay_key=${replay?.source ?? "none"}`);
    writeTwiML(res);
  }
}
