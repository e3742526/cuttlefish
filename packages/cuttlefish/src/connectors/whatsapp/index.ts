import makeWASocketImport, {
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  useMultiFileAuthState,
  downloadMediaMessage,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
// Handle ESM/CJS interop — Baileys may export as .default in some environments
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeWASocket = ((makeWASocketImport as any).default ?? makeWASocketImport) as typeof makeWASocketImport;
import type {
  Connector,
  ConnectorCapabilities,
  ConnectorHealth,
  IncomingMessage,
  Target,
} from "../../shared/types.js";
import { logger } from "../../shared/logger.js";
import { CUTTLEFISH_HOME } from "../../shared/paths.js";
import { formatResponse } from "./format.js";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { safeWriteFile } from "../../shared/safe-write.js";

export interface WhatsAppConnectorConfig {
  /** Where to store session credentials (default: CUTTLEFISH_HOME/.whatsapp-auth) */
  authDir?: string;
  /** Allowed phone numbers in JID format (e.g. "447700900000@s.whatsapp.net") — empty = allow only self-chat (fail-closed) */
  allowFrom?: string[];
  ignoreOldMessagesOnBoot?: boolean;
}

// Minimal ILogger implementation that routes Baileys noise to silence
const silentLogger = {
  level: "silent",
  child: () => silentLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Hard cap on a single downloaded WhatsApp media attachment (AR-08). */
const WHATSAPP_MAX_MEDIA_BYTES = 25 * 1024 * 1024;

export class WhatsAppConnector implements Connector {
  name = "whatsapp";
  private sock: WASocket | null = null;
  private config: WhatsAppConnectorConfig;
  private handler: ((msg: IncomingMessage) => void) | null = null;
  private bootTimeMs = Date.now();
  private allowedJids: Set<string>;
  private connectionStatus: "starting" | "running" | "stopped" | "error" | "qr_pending" = "starting";
  private lastError: string | null = null;
  private authDir: string;
  private latestQr: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  private readonly capabilities: ConnectorCapabilities = {
    threading: false,
    messageEdits: false,
    reactions: false,
    attachments: true,
  };

  constructor(config: WhatsAppConnectorConfig) {
    this.config = config;
    this.authDir = config.authDir ?? path.join(CUTTLEFISH_HOME, ".whatsapp-auth");
    this.allowedJids = new Set(config.allowFrom ?? []);
    fs.mkdirSync(this.authDir, { recursive: true });
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    try {
      await this.connect();
    } catch (err) {
      // FSR-SIG-001: a start failure (auth state, socket construction) must
      // leave the connector in "error" with a reason so getHealth() and the
      // /api/status connectors check reflect it instead of a stale "starting".
      this.connectionStatus = "error";
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  private scheduleReconnect(): void {
    if (this.connectionStatus === "stopped") return;
    // Exponential backoff: 5s, 10s, 20s, 40s, 60s max
    const delay = Math.min(5000 * Math.pow(2, this.reconnectAttempts), 60000);
    this.reconnectAttempts++;
    logger.info(`WhatsApp reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => {
      void this.connect().catch((err) => {
        logger.error(`WhatsApp reconnect failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, delay);
  }

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

    // Fetch latest WA Web version to avoid 405 rejections from outdated version
    const { version } = await fetchLatestWaWebVersion().catch(() => ({ version: undefined }));

    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: silentLogger as never,
      browser: Browsers.macOS("Chrome"),
      ...(version ? { version } : {}),
    });

    this.sock.ev.on("creds.update", saveCreds);

    this.sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        this.latestQr = qr;
        this.connectionStatus = "qr_pending";
        logger.info("WhatsApp QR code generated — scan with your WhatsApp app to connect");
      }
      if (connection === "open") {
        this.latestQr = null;
        this.connectionStatus = "running";
        this.lastError = null;
        this.reconnectAttempts = 0;
        logger.info("WhatsApp connector connected");
      }
      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        logger.info(`WhatsApp connection closed (${statusCode}), reconnecting: ${!isLoggedOut}`);
        // Typing refreshers are useless on a dead socket — without this they
        // keep firing every 20s until the next reply or stop().
        for (const interval of this.typingIntervals.values()) {
          clearInterval(interval);
        }
        this.typingIntervals.clear();
        if (!isLoggedOut && this.connectionStatus !== "stopped") {
          this.scheduleReconnect();
        } else {
          this.connectionStatus = "stopped";
        }
      }
    });

    this.sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const message of messages) {
        try {
          await this.handleMessage(message);
        } catch (err) {
          logger.error(`WhatsApp message handler error: ${err instanceof Error ? err.message : err}`);
        }
      }
    });
  }

  async stop(): Promise<void> {
    this.connectionStatus = "stopped";
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();
    await this.sock?.end(undefined);
    logger.info("WhatsApp connector stopped");
  }

  getCapabilities(): ConnectorCapabilities {
    return this.capabilities;
  }

  getQrCode(): string | null {
    return this.latestQr;
  }

  getHealth(): ConnectorHealth {
    let status: ConnectorHealth["status"] = "stopped";
    if (this.connectionStatus === "running") status = "running";
    else if (this.connectionStatus === "qr_pending") status = "qr_pending";
    // FSR-SIG-001: surface a start/connection failure as "error" so the
    // /api/status connectors check turns non-ok instead of green-while-broken.
    else if (this.connectionStatus === "error") status = "error";
    return {
      status,
      detail: this.connectionStatus === "qr_pending"
        ? "Scan QR code in settings to connect"
        : (this.lastError ?? undefined),
      capabilities: this.capabilities,
    };
  }

  reconstructTarget(replyContext: Record<string, unknown> | null | undefined): Target {
    const ctx = (replyContext ?? {}) as Record<string, string | null>;
    return {
      channel: (typeof ctx.channel === "string" ? ctx.channel : "") ?? "",
      thread: undefined,
      messageTs: typeof ctx.messageTs === "string" ? ctx.messageTs : undefined,
    };
  }

  async sendMessage(target: Target, text: string): Promise<string | undefined> {
    return this.replyMessage(target, text);
  }

  async replyMessage(target: Target, text: string): Promise<string | undefined> {
    if (!this.sock || this.connectionStatus !== "running") return;
    try {
      const chunks = formatResponse(text);
      let lastId: string | undefined;
      for (const chunk of chunks) {
        const result = await this.sock.sendMessage(target.channel, { text: chunk });
        if (result?.key?.id) lastId = result.key.id;
      }
      return lastId;
    } catch (err) {
      logger.error(`WhatsApp replyMessage error: ${err instanceof Error ? err.message : err}`);
    }
    return undefined;
  }

  async editMessage(_target: Target, _text: string): Promise<void> {
    // WhatsApp doesn't support editing via Baileys reliably — no-op
  }

  async addReaction(_target: Target, _emoji: string): Promise<void> {
    // No-op: reactions are supported in WA but complex to map from Slack emoji names
  }

  async removeReaction(_target: Target, _emoji: string): Promise<void> {
    // No-op
  }

  async setTypingStatus(channelId: string, _threadTs: string | undefined, status: string): Promise<void> {
    if (!this.sock || this.connectionStatus !== "running") return;
    const existing = this.typingIntervals.get(channelId);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(channelId);
    }
    if (status) {
      // Show "typing..." and refresh every 20s (WhatsApp composing expires ~25s)
      await this.sock.sendPresenceUpdate("composing", channelId).catch(() => {});
      const interval = setInterval(() => {
        this.sock?.sendPresenceUpdate("composing", channelId).catch(() => {});
      }, 20_000);
      interval.unref?.();
      this.typingIntervals.set(channelId, interval);
    } else {
      await this.sock.sendPresenceUpdate("paused", channelId).catch(() => {});
    }
  }

  private async handleMessage(message: WAMessage): Promise<void> {
    const jid = message.key.remoteJid;
    const ownJid = this.sock?.user?.id ?? "";
    const ownJidBare = ownJid.split(":")[0] + "@s.whatsapp.net";
    // WhatsApp now uses LID (Linked ID) format — extract from sock.user.lid
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ownLid = (this.sock?.user as any)?.lid ?? "";
    const ownLidBare = ownLid ? ownLid.split(":")[0] + "@lid" : "";

    if (!jid) return;
    if (jid.endsWith("@g.us")) return;
    if (jid.endsWith("@newsletter")) return;
    if (jid.endsWith("@broadcast")) return;

    // Allow "note to self" — matches own phone JID or own LID
    const isSelfChat = message.key.fromMe && (
      jid === ownJidBare || jid === ownJid ||
      jid === ownLidBare || jid === ownLid
    );

    if (message.key.fromMe && !isSelfChat) return;

    const msgTimestampMs = Number(message.messageTimestamp ?? 0) * 1000;
    if (
      this.config.ignoreOldMessagesOnBoot !== false &&
      msgTimestampMs < this.bootTimeMs
    ) return;

    // If no allowFrom configured, only self-chat is allowed.
    // If allowFrom is set, also allow those specific JIDs.
    if (!isSelfChat && (this.allowedJids.size === 0 || !this.allowedJids.has(jid))) return;
    if (!this.handler) return;

    const text =
      message.message?.conversation ||
      message.message?.extendedTextMessage?.text ||
      message.message?.imageMessage?.caption ||
      message.message?.documentMessage?.caption ||
      "";

    if (!text.trim()) return;
    logger.info(`WhatsApp message received from ${jid}`);

    // Download media attachment if present
    const attachments: Array<{ name: string; localPath: string; mimeType: string; url: string }> = [];
    const hasMedia = message.message?.imageMessage || message.message?.documentMessage || message.message?.audioMessage;
    if (hasMedia && this.sock) {
      try {
        // Skip up front when the declared media size exceeds the cap, and reject
        // afterward if the buffered bytes still exceed it — a compromised peer
        // must not be able to exhaust memory/temp disk with huge media (AR-08).
        const media = message.message?.imageMessage ?? message.message?.documentMessage ?? message.message?.audioMessage;
        const declaredLen = Number((media as { fileLength?: unknown } | undefined)?.fileLength?.toString?.() ?? 0);
        if (Number.isFinite(declaredLen) && declaredLen > WHATSAPP_MAX_MEDIA_BYTES) {
          throw new Error(`WhatsApp media exceeds ${WHATSAPP_MAX_MEDIA_BYTES} byte limit (declared ${declaredLen})`);
        }
        // Stream chunk-by-chunk and enforce the cap dynamically: a peer that lies
        // about fileLength (declares small, sends large) is aborted mid-transfer
        // rather than being fully buffered into memory first (AR-08).
        const stream = await downloadMediaMessage(message, "stream", {}, {
          logger: silentLogger as never,
          reuploadRequest: this.sock.updateMediaMessage,
        }) as import("node:stream").Readable;
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        for await (const chunk of stream) {
          totalBytes += (chunk as Buffer).length;
          if (totalBytes > WHATSAPP_MAX_MEDIA_BYTES) {
            stream.destroy();
            throw new Error(`WhatsApp media exceeds ${WHATSAPP_MAX_MEDIA_BYTES} byte limit`);
          }
          chunks.push(chunk as Buffer);
        }
        const buffer = Buffer.concat(chunks);
        const ext = message.message?.imageMessage ? "jpg"
          : message.message?.audioMessage ? "ogg"
          : "bin";
        // Use a random disk filename so the saved path never trusts the
        // attacker-influenced message.key.id (IOP-CTF-001) — mirrors the
        // Slack connector's downloadAttachment (connectors/slack/format.ts).
        const filename = `wa-attachment-${randomUUID()}.${ext}`;
        const tmpDir = path.join(CUTTLEFISH_HOME, "tmp");
        const localPath = path.join(tmpDir, filename);
        // Belt-and-suspenders: assert the resolved path is still contained
        // within tmpDir before writing.
        const resolvedTmpDir = path.resolve(tmpDir) + path.sep;
        const resolvedLocalPath = path.resolve(localPath);
        if (!resolvedLocalPath.startsWith(resolvedTmpDir)) {
          throw new Error("WhatsApp attachment path escapes tmp directory");
        }
        fs.mkdirSync(tmpDir, { recursive: true });
        safeWriteFile(localPath, buffer as Buffer, { fsync: false }); // atomic media write; durability unneeded
        const mimeType = ext === "jpg" ? "image/jpeg"
          : ext === "ogg" ? "audio/ogg"
          : "application/octet-stream";
        attachments.push({ name: filename, localPath, mimeType, url: localPath });
      } catch {
        // Non-fatal: continue without attachment
      }
    }

    const sessionKey = `whatsapp:${jid}`;
    const replyContext = { channel: jid, thread: null, messageTs: message.key.id ?? null };

    const incomingMessage: IncomingMessage = {
      connector: "whatsapp",
      source: "whatsapp",
      sessionKey,
      channel: jid,
      thread: undefined,
      user: jid.replace("@s.whatsapp.net", ""),
      userId: jid,
      text,
      attachments,
      replyContext,
      messageId: message.key.id ?? undefined,
      transportMeta: { jid },
      raw: message,
    };

    this.handler(incomingMessage);
  }
}
