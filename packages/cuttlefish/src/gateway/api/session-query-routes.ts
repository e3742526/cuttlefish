import type { ServerResponse } from "node:http";
import {
  getInterruptedSessions,
  getMessages,
  getQueueItems,
  getSession,
  getSessionGroupCounts,
  listChildSessions,
  listRecentPerGroup,
  listSessions,
  listSessionsForGroup,
  searchSessions,
} from "../../sessions/registry.js";
import { scheduleOnLoadTailSync } from "../external-turns.js";
import { loadRawTranscript, scheduleTranscriptBackfill } from "../transcript-backfill.js";
import type { ApiContext } from "./context.js";
import { matchRoute } from "./match-route.js";
import { json, notFound } from "./responses.js";
import { buildSessionJobStateMap, serializeSession } from "./serialize-session.js";

export function sliceLastMessages<T>(messages: T[], lastParam: string | null): T[] {
  const lastN = parseInt(lastParam || "0", 10);
  if (lastN > 0 && messages.length > lastN) {
    return messages.slice(-lastN);
  }
  return messages;
}

export function loadSessionMessagesForApi(
  sessionId: string,
  context: ApiContext,
  lastParam: string | null = null,
): { session: ReturnType<typeof serializeSession>; messages: ReturnType<typeof getMessages> } | null {
  const session = getSession(sessionId);
  if (!session) return null;

  let messages = getMessages(sessionId);

  if (messages.length === 0 && session.engineSessionId) {
    scheduleTranscriptBackfill(sessionId, session.engineSessionId, context);
  } else if (session.engine === "claude") {
    scheduleOnLoadTailSync(sessionId, context.emit);
  }

  messages = sliceLastMessages(messages, lastParam);
  const jobStates = buildSessionJobStateMap(listSessions(), context);
  return { session: serializeSession(session, context, jobStates.get(session.id)), messages };
}

export async function handleSessionQueryRoutes(
  method: string,
  pathname: string,
  url: URL,
  res: ServerResponse,
  context: ApiContext,
  perGroup: number,
): Promise<boolean> {
  const serializeWithJobStates = (sessions: ReturnType<typeof listSessions>) => {
    const all = listSessions();
    const jobStates = buildSessionJobStateMap(all, context);
    return sessions.map((session) => serializeSession(session, context, jobStates.get(session.id)));
  };
  if (method === "GET" && pathname === "/api/sessions") {
    const query = url.searchParams.get("q");
    if (query && query.trim()) {
      const matches = searchSessions(query.trim());
      json(res, serializeWithJobStates(matches));
      return true;
    }

    const group = url.searchParams.get("group");
    const rawLimit = url.searchParams.get("limit");
    const portalSlug = context.getConfig().portal?.portalName;
    if (group) {
      const limit = Math.max(1, parseInt(rawLimit || "50", 10) || 50);
      const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
      const page = listSessionsForGroup(group, limit, offset, portalSlug);
      json(res, serializeWithJobStates(page));
      return true;
    }

    if (rawLimit === "0") {
      const all = listSessions();
      const jobStates = buildSessionJobStateMap(all, context);
      json(res, all.map((session) => serializeSession(session, context, jobStates.get(session.id))));
      return true;
    }

    const sessions = listRecentPerGroup(perGroup, portalSlug);
    json(res, {
      sessions: serializeWithJobStates(sessions),
      counts: getSessionGroupCounts(portalSlug),
      perGroup,
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/sessions/interrupted") {
    const interrupted = getInterruptedSessions();
    json(res, serializeWithJobStates(interrupted));
    return true;
  }

  const childrenParams = matchRoute("/api/sessions/:id/children", pathname);
  if (method === "GET" && childrenParams) {
    const children = listChildSessions(childrenParams.id);
    json(res, serializeWithJobStates(children));
    return true;
  }

  const transcriptParams = matchRoute("/api/sessions/:id/transcript", pathname);
  if (method === "GET" && transcriptParams) {
    const session = getSession(transcriptParams.id);
    if (!session) {
      notFound(res);
      return true;
    }
    if (!session.engineSessionId) {
      json(res, []);
      return true;
    }
    json(res, loadRawTranscript(session.engineSessionId));
    return true;
  }

  const sessionParams = matchRoute("/api/sessions/:id", pathname);
  const queueParams = matchRoute("/api/sessions/:id/queue", pathname);
  if (method === "GET" && queueParams) {
    const session = getSession(queueParams.id);
    if (!session) {
      notFound(res);
      return true;
    }
    json(res, getQueueItems(session.sessionKey || session.sourceRef || session.id));
    return true;
  }

  if (method === "GET" && sessionParams) {
    const detail = loadSessionMessagesForApi(sessionParams.id, context, url.searchParams.get("last"));
    if (!detail) {
      notFound(res);
      return true;
    }
    json(res, { ...detail.session, messages: detail.messages });
    return true;
  }

  return false;
}
