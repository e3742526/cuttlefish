import type { Session } from "../shared/types.js";
import type { BoardTicket } from "./board-service.js";

const TICKET_CHANNEL_KEYS = ["channel", "thread", "ticketId"] as const;
const STALLED_ERROR_PREFIX = "Stalled:";

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boardMeta(session: Session): Record<string, unknown> | null {
  return asObject(session.transportMeta);
}

function replyMeta(session: Session): Record<string, unknown> | null {
  return asObject(session.replyContext);
}

export interface ResolvedTicketSessionFallbackState {
  active: boolean;
  fromEngine: string | null;
  toEngine: string | null;
  toModel: string | null;
}

function modelFallbackMeta(session: Pick<Session, "transportMeta">): Record<string, unknown> | null {
  return asObject(asObject(session.transportMeta)?.modelFallback);
}

function fallbackEndpoint(value: unknown): Record<string, unknown> | null {
  return asObject(value);
}

export function resolveTicketSessionFailureReason(session: Pick<Session, "transportMeta" | "lastError">): string | null {
  const fallback = modelFallbackMeta(session);
  if (typeof fallback?.reason === "string" && fallback.reason.trim()) return fallback.reason;
  if (typeof session.lastError === "string" && session.lastError.startsWith(STALLED_ERROR_PREFIX)) return "timeout";
  return null;
}

export function resolveTicketSessionStalled(session: Pick<Session, "lastError">): boolean {
  return typeof session.lastError === "string" && session.lastError.startsWith(STALLED_ERROR_PREFIX);
}

export function resolveTicketSessionFallbackState(
  session: Pick<Session, "transportMeta">,
): ResolvedTicketSessionFallbackState | null {
  const fallback = modelFallbackMeta(session);
  if (!fallback) return null;
  const from = fallbackEndpoint(fallback.from);
  const to = fallbackEndpoint(fallback.to);
  const status = typeof fallback.status === "string" ? fallback.status : null;
  return {
    active: status === "running_on_fallback",
    fromEngine: typeof from?.engine === "string" ? from.engine : null,
    toEngine: typeof to?.engine === "string" ? to.engine : null,
    toModel: typeof to?.model === "string" ? to.model : null,
  };
}

function sessionChannelCandidates(session: Session): string[] {
  const values = new Set<string>();
  const transport = boardMeta(session);
  const reply = replyMeta(session);
  for (const key of TICKET_CHANNEL_KEYS) {
    const transportValue = transport?.[key];
    if (typeof transportValue === "string" && transportValue.trim()) values.add(transportValue);
    const replyValue = reply?.[key];
    if (typeof replyValue === "string" && replyValue.trim()) values.add(replyValue);
  }
  if (session.sessionKey?.trim()) values.add(session.sessionKey);
  if (session.sourceRef?.trim()) values.add(session.sourceRef);
  return [...values];
}

export function sessionMatchesTicket(ticket: Pick<BoardTicket, "id" | "sessionId">, session: Session): boolean {
  const transport = boardMeta(session);
  if (transport?.boardTicketId === ticket.id) return true;

  const persistedSessionId = typeof ticket.sessionId === "string" ? ticket.sessionId.trim() : "";
  if (persistedSessionId) {
    if (session.id === persistedSessionId) return true;
    if (session.engineSessionId === persistedSessionId) return true;
  }

  return sessionChannelCandidates(session).some((candidate) => candidate.includes(ticket.id));
}

export function resolveBestSessionForTicket<T extends Pick<BoardTicket, "id" | "sessionId">>(
  ticket: T,
  sessions: Session[],
): Session | undefined {
  return sessions
    .filter((session) => sessionMatchesTicket(ticket, session))
    .sort((a, b) => Date.parse(b.lastActivity || "") - Date.parse(a.lastActivity || ""))[0];
}

export function shouldExposeSessionForTicket(
  ticket: Pick<BoardTicket, "status">,
  session: Pick<Session, "status" | "transportMeta" | "lastError">,
): boolean {
  if (session.status === "running" || session.status === "waiting") return true;
  if (ticket.status === "in_progress") return true;
  if (ticket.status !== "blocked") return false;
  return (
    session.status === "error" ||
    session.status === "interrupted" ||
    resolveTicketSessionStalled(session) ||
    resolveTicketSessionFailureReason(session) !== null
  );
}

export function findBoardTicketForSession(
  tickets: BoardTicket[],
  session: Session,
  fallbackTicketId: string,
): BoardTicket | undefined {
  const transport = boardMeta(session);
  const boardTicketId = typeof transport?.boardTicketId === "string" ? transport.boardTicketId : null;
  return tickets.find((ticket) =>
    ticket &&
    (
      (boardTicketId !== null && ticket.id === boardTicketId) ||
      ticket.sessionId === session.id ||
      ticket.id === fallbackTicketId
    ),
  );
}
