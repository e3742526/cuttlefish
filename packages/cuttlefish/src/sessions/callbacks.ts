import { getSession, listSessionsBySource, patchSessionTransportMeta } from "./registry.js";
import { loadConfig } from "../shared/config.js";
import { assertFetchOk, jsonApiHeaders } from "../gateway/internal-auth.js";
import { logger } from "../shared/logger.js";
import type { Session } from "../shared/types.js";
import { GATEWAY_INFO_FILE } from "../shared/paths.js";
import { gatewayBaseUrl, readGatewayInfo } from "../gateway/gateway-info.js";
import { hydrateAllAttachments, talkSessionsAttachedTo } from "../talk/attachments.js";
import type { SessionNotificationOptions, SessionNotificationSink } from "./notification-sink.js";
import { markLeaderAckPending, shouldSuppressLeaderAckCallback } from "./leader-ack.js";
import { recordManagerDelegationChildCompletion } from "./manager-delegation.js";

/**
 * Notify the parent session that a child session has replied.
 * Sends an internal message to the parent via the local HTTP API.
 * Fire-and-forget — errors are logged but never rethrown.
 */
export function notifyParentSession(
  childSession: Session,
  result: { result?: string | null; error?: string | null; cost?: number; durationMs?: number },
  options?: { alwaysNotify?: boolean } & SessionNotificationOptions,
): void {
  // Attachment wakes are a SEPARATE relationship from parent ownership: a talk
  // session can soft-link any session and must be woken when it finishes, even if
  // that session has no parent (or its parent is elsewhere). So this runs before
  // the parent early-returns and is independent of alwaysNotify.
  notifyAttachedTalkSessions(childSession, result, { sink: options?.sink });

  if (!childSession.parentSessionId) return;
  if (options?.alwaysNotify === false) return;
  if (shouldSuppressLeaderAckCallback(childSession, result)) {
    logger.info(`[leader-ack] suppressing no-op callback for already-settled child report ${childSession.id}`);
    return;
  }

  const parent = getSession(childSession.parentSessionId);
  if (parent) {
    // Atomic read-modify-write against the freshest DB state (not this
    // possibly-stale `parent` snapshot) so two children completing near-
    // simultaneously can't clobber each other's completedChildSessionIds entry.
    patchSessionTransportMeta(parent.id, (current) => recordManagerDelegationChildCompletion(current, childSession.id));
  }
  markLeaderAckPending(childSession, {
    leaderSessionId: childSession.parentSessionId,
    leaderName: parent?.employee ?? parent?.title ?? null,
    reportKind: result.error ? "error" : "result",
  });

  // Run asynchronously — do not await in the caller
  _sendNotification(childSession, result, options?.sink).catch((err) => {
    logger.warn(`[callbacks] Failed to notify parent session ${childSession.parentSessionId}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/** Label for a talk wake: title → employee → "a thread". */
function talkLabel(s: Session): string {
  return s.title || s.employee || "a thread";
}

/**
 * Talk-tailored wake (voice-friendly): no UUIDs/URLs in the engine `message`, a
 * clean banner in `displayMessage`. Shared by owned-thread callbacks and
 * attached-session wakes so both speak in the same voice.
 */
export function buildTalkWake(
  label: string,
  result: { result?: string | null; error?: string | null },
): { message: string; displayMessage: string } {
  if (result.error) {
    const raw = result.error.trim();
    const errPreview = raw.length > 500 ? raw.slice(0, 500) + "…" : raw;
    return {
      message:
        `⚠️ Thread "${label}" hit an error.\n\n` +
        `${errPreview}\n\n` +
        `Tell the operator plainly in one short sentence — no IDs, no URLs — and offer a next step.`,
      displayMessage: `⚠️ Thread "${label}" hit an error\n${_clean(raw, 220)}`,
    };
  }
  const raw = (result.result || "").trim() || "(no output)";
  const llmPreview = raw.length > 500 ? raw.slice(0, 500) + "…" : raw;
  return {
    message:
      `📩 Thread "${label}" reported back.\n\n` +
      `Reply preview:\n${llmPreview}\n\n` +
      `Narrate the outcome aloud in 1–2 short sentences — no IDs, no URLs, no markdown. ` +
      `If there is a link or detail worth seeing, push a card. ` +
      `To follow up, delegate to this thread via /api/talk/delegate (its id is in your roster).`,
    displayMessage: `📩 Thread "${label}" reported back\n${_clean(raw, 220)}`,
  };
}

/**
 * Wake every talk session that has ATTACHED the just-finished session. Fire-and-
 * forget. De-dup: an owned child (parent IS the talk session) is already woken by
 * the parent-callback path, so it's skipped here to avoid a double notification.
 */
export function notifyAttachedTalkSessions(
  completedSession: Session,
  result: { result?: string | null; error?: string | null },
  options?: SessionNotificationOptions,
): void {
  _notifyAttached(completedSession, result, options?.sink).catch((err) => {
    logger.warn(`[callbacks] Failed to wake attached talk sessions: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function _notifyAttached(
  completedSession: Session,
  result: { result?: string | null; error?: string | null },
  sink?: SessionNotificationSink,
): Promise<void> {
  // Lazy one-time scan so attachments persisted before a restart are visible
  // (this is the first/primary talkSessionsAttachedTo consumer on the wake path).
  hydrateAllAttachments({
    getSession,
    listTalkSessions: () => listSessionsBySource("talk", 50),
  });
  const talkIds = talkSessionsAttachedTo(completedSession.id);
  if (talkIds.length === 0) return;

  const { message, displayMessage } = buildTalkWake(talkLabel(completedSession), result);
  for (const talkId of talkIds) {
    if (talkId === completedSession.parentSessionId) continue; // owned child — already notified
    const talk = getSession(talkId);
    if (!talk || talk.source !== "talk") continue;
    if (talk.status === "error") continue;
    await _sendRaw(talkId, message, displayMessage, sink);
  }
}

/**
 * Notify the parent session that a child session has been rate-limited and will auto-resume.
 * Fire-and-forget — errors are logged but never rethrown.
 */
export function notifyRateLimited(
  childSession: Session,
  estimatedResumeTime?: string, // ISO timestamp or human-readable
  options?: SessionNotificationOptions,
): void {
  if (!childSession.parentSessionId) return;

  _sendNotification(childSession, {
    error: null,
    result: `⏳ Session is rate-limited and will auto-resume${estimatedResumeTime ? ` around ${estimatedResumeTime}` : ' when the limit resets'}. No action needed.`,
  }, options?.sink).catch((err) => {
    logger.warn(`[callbacks] Failed to send rate-limit notification: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/**
 * Notify the parent session that a rate-limited child session has successfully resumed.
 * Fire-and-forget — errors are logged but never rethrown.
 */
export function notifyRateLimitResumed(
  childSession: Session,
  options?: SessionNotificationOptions,
): void {
  if (!childSession.parentSessionId) return;

  const parent = getSession(childSession.parentSessionId);
  const isTalkParent = parent?.source === "talk";

  let message: string;
  if (isTalkParent) {
    const label = talkLabel(childSession);
    message = `🔄 Thread "${label}" has resumed after rate limit cleared.`;
  } else {
    const employeeName = childSession.employee || "Unknown";
    message = `🔄 Employee "${employeeName}" (session ${childSession.id}) has resumed after rate limit cleared.`;
  }

  _sendRaw(childSession.parentSessionId, message, undefined, options?.sink).catch((err) => {
    logger.warn(`[callbacks] Failed to send resume notification: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function _sendNotification(
  childSession: Session,
  result: { result?: string | null; error?: string | null; cost?: number; durationMs?: number },
  sink?: SessionNotificationSink,
): Promise<void> {
  const parent = getSession(childSession.parentSessionId!);
  if (!parent) return; // Parent gone or expired
  if (parent.status === "error") return; // Parent already in error — skip

  const employeeName = childSession.employee || "Unknown";
  const childId = childSession.id;

  // Dual audience: `message` is what the parent ENGINE (e.g. the COO) reads —
  // it carries full context and the API hints it needs to follow up.
  // `displayMessage` is the clean, human-facing version shown in the web UI
  // notification banner.
  //
  // For /talk parents (source:"talk") the engine is the voice orchestrator: UUIDs
  // and raw API endpoints must NOT appear (they'd be read aloud). Use a label-based
  // wake message with a narration instruction instead.
  const isTalkParent = parent.source === "talk";

  let message: string;
  let displayMessage: string;
  if (isTalkParent) {
    ({ message, displayMessage } = buildTalkWake(talkLabel(childSession), result));
  } else if (result.error) {
    message = `⚠️ Employee "${employeeName}" (child session ${childId}) hit an error and could not finish: ${result.error}`;
    displayMessage = `⚠️ ${employeeName} couldn't finish`;
  } else {
    const raw = (result.result || "").trim() || "(no output)";
    const llmPreview = raw.length > 500 ? raw.slice(0, 500) + "…" : raw;
    message =
      `📩 Employee "${employeeName}" replied in child session ${childId}.\n\n` +
      `Reply preview:\n${llmPreview}\n\n` +
      `To read the full reply: GET /api/sessions/${childId}?last=N · ` +
      `to follow up: POST /api/sessions/${childId}/message`;
    displayMessage = `📩 ${employeeName} replied\n${_clean(raw, 220)}`;
  }

  await _sendRaw(childSession.parentSessionId!, message, displayMessage, sink);
}

/** Trim to a word boundary for a tidy human-facing preview. */
function _clean(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  const cut = oneLine.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

/**
 * Send a hardcoded notification to the configured notifications connector.
 * Used for rate-limit alerts that must not depend on the LLM.
 * Fire-and-forget — errors are logged but never rethrown.
 */
export function notifyConnectorNotification(message: string, options?: SessionNotificationOptions): void {
  _sendConnectorNotification(message, options?.sink).catch((err) => {
    logger.warn(`[callbacks] Failed to send connector notification: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function _sendConnectorNotification(message: string, sink?: SessionNotificationSink): Promise<void> {
  if (sink) {
    await sink.sendConnectorNotification(message);
    return;
  }
  let connector = "slack";
  let channel: string | undefined;
  const gateway = internalGatewayConnection();

  try {
    const config = loadConfig();
    connector = config.notifications?.connector || "slack";
    channel = config.notifications?.channel;
  } catch {
    // Use defaults if config is unavailable
  }

  if (!channel) {
    logger.debug("[callbacks] No notifications.channel configured — skipping connector notification");
    return;
  }

  const response = await fetch(`${gateway.baseUrl}/api/connectors/${connector}/send`, {
    method: "POST",
    headers: internalGatewayHeaders(gateway),
    body: JSON.stringify({ channel, text: message }),
  });
  await assertFetchOk(response, "connector notification");
}

async function _sendRaw(
  parentSessionId: string,
  message: string,
  displayMessage?: string,
  sink?: SessionNotificationSink,
): Promise<void> {
  if (sink) {
    await sink.sendSessionNotification(parentSessionId, message, displayMessage);
    return;
  }
  const gateway = internalGatewayConnection();

  const response = await fetch(`${gateway.baseUrl}/api/sessions/${parentSessionId}/message`, {
    method: "POST",
    headers: internalGatewayHeaders(gateway),
    body: JSON.stringify({
      message,
      role: "notification",
      ...(displayMessage ? { displayMessage } : {}),
    }),
  });
  await assertFetchOk(response, "parent notification");
}

function internalGatewayConnection(): { baseUrl: string; token?: string } {
  const info = readGatewayInfo(GATEWAY_INFO_FILE);
  const token = info?.token ?? (info as { apiToken?: string } | null)?.apiToken;
  let fallbackHost: string | undefined;
  let fallbackPort = 8888;
  try {
    const config = loadConfig();
    fallbackHost = config.gateway?.host;
    fallbackPort = config.gateway?.port || 8888;
  } catch {
    // Use gateway.json/defaults if config is unavailable.
  }
  const port = info?.port ?? fallbackPort;
  return {
    baseUrl: gatewayBaseUrl({ port, host: info?.host }, fallbackHost),
    token,
  };
}

function internalGatewayHeaders(gateway: { token?: string }): Record<string, string> {
  return jsonApiHeaders(gateway.token);
}
