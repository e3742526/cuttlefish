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
import { formatAndChunk } from "../shared/format.js";

const TWILIO_WEBHOOK_MAX_BYTES = 64 * 1024;
const TWILIO_SMS_MAX_LENGTH = 1600;
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
  private readonly seenMessageSids = new Set<string>();
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
    this.seenMessageSids.clear();
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
      for (const chunk of formatAndChunk(text, TWILIO_SMS_MAX_LENGTH)) {
        if (!chunk.trim()) continue;
        const message = await this.client.messages.create({
          body: chunk,
          to: target.channel,
          ...(from ? { from } : { messagingServiceSid: this.config.messagingServiceSid! }),
        });
        lastSid = message.sid;
      }
      return lastSid;
    } catch (err) {
      logger.error(`Twilio SMS send failed: ${err instanceof Error ? err.message : String(err)}`);
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
      writeTwiML(res, 503);
      return;
    }
    if (!isFormEncoded(req.headers["content-type"])) {
      writeTwiML(res, 415);
      return;
    }

    let raw: string;
    try {
      raw = await readBody(req, { maxBytes: TWILIO_WEBHOOK_MAX_BYTES });
    } catch (err) {
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
      logger.warn("Rejected an invalid Twilio SMS webhook signature or payload");
      writeTwiML(res, 403);
      return;
    }

    const from = params.From?.trim();
    const to = params.To?.trim();
    const text = params.Body?.trim();
    const messageSid = params.MessageSid?.trim();
    if (!from || !to || !text || !this.handler) {
      writeTwiML(res);
      return;
    }
    if (this.config.fromNumber && to !== this.config.fromNumber) {
      logger.warn("Ignored Twilio SMS webhook for an unconfigured destination number");
      writeTwiML(res);
      return;
    }
    if (!this.allowedSenders.has(from)) {
      logger.warn("Ignored Twilio SMS webhook from a sender outside allowFrom");
      writeTwiML(res);
      return;
    }
    if (messageSid && this.seenMessageSids.has(messageSid)) {
      writeTwiML(res);
      return;
    }
    if (messageSid) {
      this.seenMessageSids.add(messageSid);
      if (this.seenMessageSids.size > 1_000) this.seenMessageSids.delete(this.seenMessageSids.values().next().value!);
    }

    this.handler({
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
    writeTwiML(res);
  }
}
