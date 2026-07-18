import { App } from "@slack/bolt";
import type {
  Connector,
  ConnectorCapabilities,
  ConnectorHealth,
  IncomingMessage,
  ReplyContext,
  SlackConnectorConfig,
  Target,
} from "../../shared/types.js";
import { buildReplyContext, deriveSessionKey, isOldSlackMessage } from "./threads.js";
import { formatResponse, downloadAttachment } from "./format.js";
import { TMP_DIR } from "../../shared/paths.js";
import { logger } from "../../shared/logger.js";

/** Cap on how many attachments a single Slack message may pull down (AR-08). */
const SLACK_MAX_ATTACHMENTS = 10;

export class SlackConnector implements Connector {
  name = "slack";
  private app: App;
  private handler: ((msg: IncomingMessage) => void) | null = null;
  private readonly allowedUsers: Set<string>;
  private readonly ignoreOldMessagesOnBoot: boolean;
  private readonly bootTimeMs = Date.now();
  private started = false;
  private lastError: string | null = null;
  // TMP-CUT-017: true only while our own stop() is tearing the connection
  // down, so the deliberate disconnect it triggers isn't reported as an
  // error by the connection monitor below.
  private stopping = false;
  private channelNameCache = new Map<string, { name: string; cachedAt: number }>();
  private botUserId: string | null = null;
  private static CHANNEL_CACHE_TTL_MS = 3600_000; // 1 hour
  private static CHANNEL_CACHE_MAX_ENTRIES = 1000;

  private readonly capabilities: ConnectorCapabilities = {
    threading: true,
    messageEdits: true,
    reactions: true,
    attachments: true,
  };

  /**
   * Set the AI assistant typing status in a thread.
   * Uses Slack's assistant.threads.setStatus API for native animated indicator.
   */
  async setTypingStatus(channelId: string, threadTs: string | undefined, status: string): Promise<void> {
    if (!threadTs) return;
    const payload = {
      channel_id: channelId,
      thread_ts: threadTs,
      status,
    };
    try {
      const client = this.app.client as any;
      if (client.assistant?.threads?.setStatus) {
        await client.assistant.threads.setStatus(payload);
      } else if (typeof client.apiCall === "function") {
        await client.apiCall("assistant.threads.setStatus", payload);
      }
    } catch (err) {
      logger.debug(`Slack typing status failed: ${err}`);
    }
  }

  constructor(config: SlackConnectorConfig) {
    this.app = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
    });
    this.ignoreOldMessagesOnBoot = config.ignoreOldMessagesOnBoot !== false;
    const allowFrom = Array.isArray(config.allowFrom)
      ? config.allowFrom
      : typeof config.allowFrom === "string"
        ? config.allowFrom.split(",").map((value) => value.trim()).filter(Boolean)
        : [];
    // Default-deny: without an allowFrom, the bot ignores everyone. Require the
    // operator to explicitly authorize users rather than allowing all workspace members.
    this.allowedUsers = new Set(allowFrom);
    if (this.allowedUsers.size === 0) {
      logger.warn("[slack] No allowFrom configured — ignoring ALL inbound messages. Set connectors.slack.allowFrom to authorize users.");
    }
    this.attachConnectionMonitor();
  }

  /**
   * TMP-CUT-017: getHealth() previously only reflected the outcome of the
   * initial start() call — a socket-mode connection that silently dropped
   * afterward left the connector reporting "running" forever. Port the
   * WhatsApp connector's disconnect-lifecycle pattern (listen on the
   * underlying transport's own connection events and update the health
   * flag as it actually changes) to Slack's socket-mode client.
   *
   * Bolt's `App` keeps the `@slack/socket-mode` client at `receiver.client`.
   * That field is typed private on `App`, but is a plain instance property
   * at runtime — the same kind of cast already used for `setTypingStatus`
   * above (`this.app.client as any`).
   */
  private attachConnectionMonitor(): void {
    const client = (this.app as unknown as {
      receiver?: { client?: { on(event: string, listener: (...args: unknown[]) => void): unknown } };
    }).receiver?.client;
    if (!client) return;
    client.on("connected", () => {
      this.lastError = null;
      logger.info("[slack] Socket Mode connection (re)established");
    });
    client.on("disconnected", (err: unknown) => {
      // A deliberate stop() also drives the client through "disconnected";
      // don't let that read back as an error.
      if (this.stopping) return;
      this.lastError = err instanceof Error ? err.message : "Slack Socket Mode connection disconnected";
      logger.warn(`[slack] Socket Mode disconnected: ${this.lastError}`);
    });
    client.on("error", (err: unknown) => {
      if (this.stopping) return;
      this.lastError = err instanceof Error ? err.message : String(err);
      logger.warn(`[slack] Socket Mode error: ${this.lastError}`);
    });
  }

  private async resolveChannelName(channelId: string): Promise<string | undefined> {
    const cached = this.channelNameCache.get(channelId);
    if (cached && Date.now() - cached.cachedAt < SlackConnector.CHANNEL_CACHE_TTL_MS) {
      return cached.name;
    }
    try {
      const result = await this.app.client.conversations.info({ channel: channelId });
      const name = result.channel?.name;
      if (name) {
        // Bound the cache: evict oldest entries (Map preserves insertion order)
        while (this.channelNameCache.size >= SlackConnector.CHANNEL_CACHE_MAX_ENTRIES) {
          const oldestKey = this.channelNameCache.keys().next().value;
          if (oldestKey === undefined) break;
          this.channelNameCache.delete(oldestKey);
        }
        this.channelNameCache.set(channelId, { name, cachedAt: Date.now() });
        return name;
      }
    } catch (err) {
      logger.debug(`Failed to resolve channel name for ${channelId}: ${err}`);
    }
    return undefined;
  }

  async start() {
    this.app.message(async ({ event }) => {
      logger.info(`[slack] Received message event: user=${(event as any).user} channel=${(event as any).channel} text="${((event as any).text || "").slice(0, 50)}"`);
      // Skip bot's own messages
      if ((event as any).bot_id) {
        logger.info(`[slack] Skipping bot message`);
        return;
      }
      // Skip ghost events from URL unfurls (user=undefined, text="")
      if (!(event as any).user) {
        logger.debug(`[slack] Skipping event with no user (likely URL unfurl)`);
        return;
      }
      if (!this.handler) {
        logger.info(`[slack] No handler registered, dropping message`);
        return;
      }
      if (this.ignoreOldMessagesOnBoot && isOldSlackMessage((event as any).ts, this.bootTimeMs)) {
        logger.debug(`Ignoring old Slack message ${(event as any).ts}`);
        return;
      }
      if (!this.allowedUsers.has((event as any).user)) {
        logger.debug(`Ignoring Slack message from unauthorized user ${(event as any).user}`);
        return;
      }

      // In channels, only process thread replies (continuing a conversation).
      // Root channel messages are handled by app_mention instead.
      if ((event as any).channel_type !== "im" && !(event as any).thread_ts) {
        logger.debug(`[slack] Skipping root channel message (use @mention instead)`);
        return;
      }

      const sessionKey = deriveSessionKey(event as any);
      const replyContext = buildReplyContext(event as any);

      // Fetch parent message for thread replies so the session has full context
      let parentContext = "";
      const threadTs = (event as any).thread_ts;
      if (threadTs && threadTs !== (event as any).ts) {
        try {
          const parentResult = await this.app.client.conversations.replies({
            channel: (event as any).channel,
            ts: threadTs,
            limit: 1,
            inclusive: true,
          });
          const parentMsg = parentResult.messages?.[0];
          if (parentMsg?.text) {
            parentContext = `[Thread context — parent message: "${parentMsg.text}"]\n\n`;
          }
        } catch (err) {
          logger.debug(`Failed to fetch parent message: ${err}`);
        }
      }

      // Download attachments if present, bounded by count (AR-08).
      const attachments = [];
      const files = ((event as any).files ?? []) as any[];
      if (files.length > 0) {
        if (files.length > SLACK_MAX_ATTACHMENTS) {
          logger.warn(`Slack message has ${files.length} attachments; processing only the first ${SLACK_MAX_ATTACHMENTS}`);
        }
        for (const file of files.slice(0, SLACK_MAX_ATTACHMENTS)) {
          try {
            const localPath = await downloadAttachment(
              file.url_private,
              this.app.client.token!,
              TMP_DIR,
            );
            attachments.push({
              name: file.name,
              url: file.url_private,
              mimeType: file.mimetype,
              localPath,
            });
          } catch (err) {
            logger.warn(`Failed to download attachment: ${err}`);
          }
        }
      }

      const channelName = await this.resolveChannelName((event as any).channel);

      const msg: IncomingMessage = {
        connector: this.name,
        source: "slack",
        sessionKey,
        replyContext,
        messageId: (event as any).ts,
        channel: (event as any).channel,
        thread: (event as any).thread_ts,
        user: (event as any).user,
        userId: (event as any).user,
        text: parentContext + ((event as any).text || ""),
        attachments,
        raw: event,
        transportMeta: {
          channelType: ((event as any).channel_type as string) || "channel",
          team: ((event as any).team as string) || null,
          channelName: channelName || null,
        },
      };

      try {
        this.handler(msg);
      } catch (err) {
        logger.error(`[slack] Uncaught handler error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    // Handle @mentions in channels
    this.app.event("app_mention", async ({ event }) => {
      const userId = event.user;
      if (!userId) {
        logger.debug(`[slack] app_mention without user id, ignoring`);
        return;
      }
      logger.info(`[slack] Received app_mention: user=${userId} channel=${event.channel} text="${(event.text || "").slice(0, 50)}"`);

      if (!this.handler) {
        logger.info(`[slack] No handler registered, dropping mention`);
        return;
      }
      if (this.ignoreOldMessagesOnBoot && isOldSlackMessage(event.ts, this.bootTimeMs)) {
        logger.debug(`Ignoring old Slack mention ${event.ts}`);
        return;
      }
      if (!this.allowedUsers.has(userId)) {
        logger.debug(`Ignoring Slack mention from unauthorized user ${userId}`);
        return;
      }

      // Strip the @mention from the text
      const mentionText = (event.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
      if (!mentionText) {
        logger.debug(`[slack] Empty mention text after stripping @, ignoring`);
        return;
      }

      const sessionKey = deriveSessionKey(event as any);
      const replyContext = buildReplyContext(event as any);
      const channelName = await this.resolveChannelName(event.channel);

      // Download attachments if present, bounded by count (AR-08).
      const attachments = [];
      const files = ((event as any).files ?? []) as any[];
      if (files.length > 0) {
        if (files.length > SLACK_MAX_ATTACHMENTS) {
          logger.warn(`Slack message has ${files.length} attachments; processing only the first ${SLACK_MAX_ATTACHMENTS}`);
        }
        for (const file of files.slice(0, SLACK_MAX_ATTACHMENTS)) {
          try {
            const localPath = await downloadAttachment(
              file.url_private,
              this.app.client.token!,
              TMP_DIR,
            );
            attachments.push({
              name: file.name,
              url: file.url_private,
              mimeType: file.mimetype,
              localPath,
            });
          } catch (err) {
            logger.warn(`Failed to download attachment: ${err}`);
          }
        }
      }

      const msg: IncomingMessage = {
        connector: this.name,
        source: "slack",
        sessionKey,
        replyContext,
        messageId: event.ts,
        channel: event.channel,
        thread: (event as any).thread_ts,
        user: userId,
        userId,
        text: mentionText,
        attachments,
        raw: event,
        transportMeta: {
          channelType: (event as any).channel_type || "channel",
          team: (event as any).team || null,
          channelName: channelName || null,
        },
      };

      try {
        this.handler(msg);
      } catch (err) {
        logger.error(`[slack] Uncaught handler error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    // In channels, only process thread replies (continuing a conversation).
    // Root channel messages are handled by app_mention instead.
    // This is added as a post-filter in the existing app.message() handler above.

    // Fetch bot's own user ID for filtering self-reactions
    try {
      const authResult = await this.app.client.auth.test();
      this.botUserId = authResult.user_id ?? null;
      logger.info(`[slack] Bot user ID: ${this.botUserId}`);
    } catch (err) {
      logger.warn(`[slack] Failed to get bot user ID: ${err}`);
    }

    this.app.event("reaction_added", async ({ event }) => {
      // Only handle reactions on messages (not files, etc.)
      if (event.item.type !== "message") return;

      // Skip bot's own reactions
      if (this.botUserId && event.user === this.botUserId) return;

      if (!this.handler) return;

      // Check allowed users
      if (!this.allowedUsers.has(event.user)) {
        logger.debug(`Ignoring reaction from unauthorized user ${event.user}`);
        return;
      }

      const channelId = event.item.channel;
      const messageTs = event.item.ts;
      const emoji = event.reaction;

      // Skip reactions that were replayed on boot. Gate on the REACTION's own event time
      // (event_ts), NOT the reacted-to message's age — a fresh reaction on an old message
      // (e.g. approving an approval card that has been waiting for hours) must still be honored.
      const reactionTs = (event as any).event_ts || messageTs;
      if (this.ignoreOldMessagesOnBoot && isOldSlackMessage(reactionTs, this.bootTimeMs)) {
        logger.debug(`Ignoring old (replayed-on-boot) Slack reaction event ${reactionTs}`);
        return;
      }

      logger.info(`[slack] Reaction :${emoji}: by ${event.user} on ${channelId}:${messageTs}`);

      // Instant ack so the user can see the gateway heard the reaction.
      try {
        await this.app.client.reactions.add({ channel: channelId, timestamp: messageTs, name: "eyes" });
      } catch (err) {
        logger.debug(`[slack] eyes ack skipped (likely already reacted): ${err}`);
      }

      // Fetch the reacted-to message text
      // Try conversations.history first (works for root messages),
      // fall back to conversations.replies (for threaded messages)
      let messageText = "";
      try {
        const histResult = await this.app.client.conversations.history({
          channel: channelId,
          latest: messageTs,
          oldest: messageTs,
          inclusive: true,
          limit: 1,
        });
        messageText = histResult.messages?.[0]?.text || "";

        // If not found in history, try as a threaded reply
        if (!messageText) {
          const replyResult = await this.app.client.conversations.replies({
            channel: channelId,
            ts: messageTs,
            limit: 1,
            inclusive: true,
          });
          messageText = replyResult.messages?.[0]?.text || "";
        }
      } catch (err) {
        logger.warn(`[slack] Failed to fetch reacted-to message: ${err}`);
        return;
      }

      if (!messageText) {
        logger.debug(`[slack] Reacted-to message has no text, skipping`);
        return;
      }

      // Resolve channel name
      const channelName = await this.resolveChannelName(channelId);
      const channelDisplay = channelName ? `#${channelName}` : channelId;

      // Build the prompt with reaction context
      const prompt = `[Reaction :${emoji}: on message in ${channelDisplay}]\n\nOriginal message:\n"${messageText}"\n\nThe user reacted with :${emoji}: to this message. Interpret and act on the reaction.`;

      const sessionKey = `slack:reaction:${channelId}:${messageTs}`;

      const msg: IncomingMessage = {
        connector: this.name,
        source: "slack",
        sessionKey,
        replyContext: {
          channel: channelId,
          thread: messageTs,
          messageTs,
        },
        messageId: messageTs,
        channel: channelId,
        thread: messageTs,
        user: event.user,
        userId: event.user,
        text: prompt,
        attachments: [],
        raw: event,
        transportMeta: {
          channelType: "channel",
          team: null,
          channelName: channelName || null,
        },
      };

      try {
        this.handler(msg);
      } catch (err) {
        logger.error(`[slack] Uncaught handler error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    try {
      await this.app.start();
    } catch (err) {
      // FSR-SIG-001: record the start failure so getHealth() reports "error"
      // (not "stopped") and the /api/status connectors check turns non-ok.
      // Rethrow so the caller's start().catch() log still fires.
      this.started = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
    this.started = true;
    this.lastError = null;
    logger.info("Slack connector started (socket mode)");
  }

  async stop() {
    this.stopping = true;
    try {
      await this.app.stop();
    } finally {
      this.stopping = false;
    }
    this.started = false;
    this.lastError = null;
    logger.info("Slack connector stopped");
  }

  getCapabilities(): ConnectorCapabilities {
    return this.capabilities;
  }

  getHealth(): ConnectorHealth {
    return {
      status: this.lastError ? "error" : this.started ? "running" : "stopped",
      detail: this.lastError ?? undefined,
      capabilities: this.capabilities,
    };
  }

  reconstructTarget(replyContext: ReplyContext): Target {
    return {
      channel: typeof replyContext.channel === "string" ? replyContext.channel : "",
      thread: typeof replyContext.thread === "string" ? replyContext.thread : undefined,
      messageTs: typeof replyContext.messageTs === "string" ? replyContext.messageTs : undefined,
      replyContext,
    };
  }

  async sendMessage(target: Target, text: string): Promise<string | undefined> {
    if (!text || !text.trim()) return undefined;
    try {
      const chunks = formatResponse(text);
      let lastTs: string | undefined;
      for (const chunk of chunks) {
        if (!chunk.trim()) continue;
        const res = await this.app.client.chat.postMessage({
          channel: target.channel,
          text: chunk,
        });
        lastTs = res.ts;
      }
      return lastTs;
    } catch (err) {
      logger.error(`Slack sendMessage error: ${err instanceof Error ? err.message : err}`);
      return undefined;
    }
  }

  async replyMessage(target: Target, text: string): Promise<string | undefined> {
    if (!text || !text.trim()) return undefined;
    try {
      const threadTs = target.thread || target.messageTs;
      const chunks = formatResponse(text);
      let lastTs: string | undefined;
      for (const chunk of chunks) {
        if (!chunk.trim()) continue;
        const res = await this.app.client.chat.postMessage({
          channel: target.channel,
          thread_ts: threadTs,
          text: chunk,
        });
        lastTs = res.ts;
      }
      return lastTs;
    } catch (err) {
      logger.error(`Slack replyMessage error: ${err instanceof Error ? err.message : err}`);
      return undefined;
    }
  }

  async addReaction(target: Target, emoji: string) {
    if (!target.messageTs) return;
    try {
      await this.app.client.reactions.add({
        channel: target.channel,
        timestamp: target.messageTs,
        name: emoji,
      });
    } catch (err) {
      logger.warn(`Failed to add reaction: ${err}`);
    }
  }

  async removeReaction(target: Target, emoji: string) {
    if (!target.messageTs) return;
    try {
      await this.app.client.reactions.remove({
        channel: target.channel,
        timestamp: target.messageTs,
        name: emoji,
      });
    } catch (err) {
      logger.warn(`Failed to remove reaction: ${err}`);
    }
  }

  async editMessage(target: Target, text: string) {
    if (!target.messageTs) return;
    if (!text || !text.trim()) return;
    // Apply the same mrkdwn conversion as sends; edits are single-message,
    // so keep only the first chunk (truncated to the platform limit).
    const [converted] = formatResponse(text);
    await this.app.client.chat.update({
      channel: target.channel,
      ts: target.messageTs,
      text: converted,
    });
  }

  onMessage(handler: (msg: IncomingMessage) => void) {
    this.handler = handler;
  }
}
