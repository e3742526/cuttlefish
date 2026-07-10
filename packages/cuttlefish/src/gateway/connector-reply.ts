import { logger } from "../shared/logger.js";
import type { Session, Connector } from "../shared/types.js";
import { recordDroppedNotification } from "../shared/process-health.js";

/**
 * Connector identity + reply relay helpers.
 *
 * Extracted from `api.ts` (audit AS-001) without behavior change.
 */

/**
 * Sources that are NOT backed by an external chat connector. Anything else
 * (slack, whatsapp, …) is connector-sourced and its turn
 * results must be relayed back to the originating channel.
 */
const NON_CONNECTOR_SOURCES = new Set(["web", "talk", "cron"]);
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 250;

/**
 * Resolve the forwarded SSO identity from request headers, given the configured
 * `gateway.userHeader` (a single header name or a priority-ordered list). Node
 * lowercases incoming header keys, so we look up case-insensitively. Returns the
 * first present, non-empty, trimmed value; `undefined` when the config is unset
 * or no configured header is present. Unset config = single-user no-op: the
 * header is never read and the caller falls back to "web-user".
 */
export function resolveUserHeader(
  headers: Record<string, string | string[] | undefined>,
  userHeaderConfig: string | string[] | undefined,
): string | undefined {
  if (!userHeaderConfig) return undefined;
  const names = Array.isArray(userHeaderConfig) ? userHeaderConfig : [userHeaderConfig];
  for (const name of names) {
    if (!name) continue;
    const raw = headers[name.toLowerCase()];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

export interface ConnectorReplyDeliveryOptions {
  emit?: (event: string, payload: unknown) => void;
  maxAttempts?: number;
  retryDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Relay a completed turn's assistant text back to the connector channel that
 * originated the session. Inbound connector messages reply via `manager.route`,
 * but turns completed through `runWebSession` (parent callbacks, cron
 * follow-ups, rate-limit resumes) otherwise never reach the channel. No-ops for
 * web/talk/cron sources, empty text, or a missing connector/replyContext; errors
 * are logged and swallowed so delivery failure never breaks completion.
 */
export async function deliverConnectorReply(
  session: Pick<Session, "source" | "connector" | "replyContext"> & { id?: string },
  text: string,
  connectors: Map<string, Connector>,
  options: ConnectorReplyDeliveryOptions = {},
): Promise<void> {
  if (!text || NON_CONNECTOR_SOURCES.has(session.source)) return;
  if (!session.connector || !session.replyContext) return;
  const connector = connectors.get(session.connector);
  if (!connector) return;
  const attempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS));

  let lastError = "connector returned no message id (delivery not confirmed)";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const target = connector.reconstructTarget(session.replyContext);
      // Audit H3: Slack/WhatsApp replyMessage() swallow send errors and return
      // `undefined` instead of throwing, so a swallowed failure previously looked
      // like success here. Treat a missing message id as a delivery failure so
      // the retry engages and — if all attempts fail — the drop is SURFACED, not
      // silently reported as answered.
      const messageId = await connector.replyMessage(target, text);
      if (messageId !== undefined) return; // delivery confirmed
      throw new Error(lastError);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastError = message;
      options.emit?.("connector:reply_failed", {
        sessionId: session.id ?? null,
        connector: session.connector,
        source: session.source,
        attempt,
        maxAttempts: attempts,
        error: message,
      });
      logger.warn(
        `Connector reply delivery failed for session ${session.id ?? "?"} ` +
        `(attempt ${attempt}/${attempts}): ${message}`,
      );
      if (attempt < attempts && retryDelayMs > 0) await sleep(retryDelayMs);
    }
  }
  // All attempts exhausted — the operator's reply never reached the channel.
  // Emit a terminal signal and record the drop so it is observable in health.
  options.emit?.("connector:reply_dropped", {
    sessionId: session.id ?? null,
    connector: session.connector,
    source: session.source,
    attempts,
    error: lastError,
  });
  logger.error(
    `Connector reply for session ${session.id ?? "?"} was NOT delivered after ${attempts} attempt(s): ${lastError}`,
  );
  recordDroppedNotification(`connector "${session.connector}" reply undeliverable after ${attempts} attempt(s)`);
}
