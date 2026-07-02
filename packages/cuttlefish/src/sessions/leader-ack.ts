import type { Session } from "../shared/types.js";
import { patchSessionTransportMeta } from "./registry.js";

const META_KEY = "leaderAck";

export interface LeaderAckMeta {
  state: "pending" | "acknowledged" | "escalated";
  parentSessionId: string;
  leaderSessionId: string;
  leaderName: string | null;
  reportKind: "result" | "error";
  reportedAt: string;
  acknowledgedAt?: string | null;
  acknowledgedBy?: string | null;
  escalatedAt?: string | null;
  escalatedTo?: string | null;
  /** Count of automatic escalations already dispatched for this session lineage. Carried forward across re-arms so repeat timeouts can be capped instead of re-paging HR indefinitely. */
  escalationCount?: number;
  boardTicketId?: string | null;
  boardDepartment?: string | null;
}

const SIMPLE_NO_OP_ACK_RE = /^(?:acknowledged|noted|understood|ok|okay|thanks|thank you)(?:[.!])?$/i;
const STALE_NO_OP_RE = /\b(?:stale|no[- ]?op|no remaining work|no further action|no action required|no response required|no response needed|ignore further|ignoring|already recorded|already accepted|closure acknowledged|audit closed|task is closed|task remains done|review is closed)\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isLeaderAckNoOpResult(result: string | null | undefined): boolean {
  const text = result?.replace(/\s+/g, " ").trim();
  if (!text) return true;
  return SIMPLE_NO_OP_ACK_RE.test(text) || STALE_NO_OP_RE.test(text);
}

export function shouldSuppressLeaderAckCallback(
  session: Pick<Session, "transportMeta"> | null | undefined,
  result: { result?: string | null; error?: string | null },
): boolean {
  if (result.error) return false;
  const current = readLeaderAckMeta(session);
  if (!current || current.state === "pending") return false;
  return isLeaderAckNoOpResult(result.result);
}

export function readLeaderAckMeta(session: Pick<Session, "transportMeta"> | null | undefined): LeaderAckMeta | null {
  const meta = session?.transportMeta;
  if (!isRecord(meta)) return null;
  const raw = meta[META_KEY];
  if (!isRecord(raw)) return null;
  if (raw.state !== "pending" && raw.state !== "acknowledged" && raw.state !== "escalated") return null;
  if (typeof raw.parentSessionId !== "string" || !raw.parentSessionId.trim()) return null;
  if (typeof raw.leaderSessionId !== "string" || !raw.leaderSessionId.trim()) return null;
  if (raw.reportKind !== "result" && raw.reportKind !== "error") return null;
  if (typeof raw.reportedAt !== "string" || !raw.reportedAt.trim()) return null;
  return {
    state: raw.state,
    parentSessionId: raw.parentSessionId,
    leaderSessionId: raw.leaderSessionId,
    leaderName: typeof raw.leaderName === "string" && raw.leaderName.trim() ? raw.leaderName : null,
    reportKind: raw.reportKind,
    reportedAt: raw.reportedAt,
    acknowledgedAt: typeof raw.acknowledgedAt === "string" ? raw.acknowledgedAt : null,
    acknowledgedBy: typeof raw.acknowledgedBy === "string" ? raw.acknowledgedBy : null,
    escalatedAt: typeof raw.escalatedAt === "string" ? raw.escalatedAt : null,
    escalatedTo: typeof raw.escalatedTo === "string" ? raw.escalatedTo : null,
    escalationCount: typeof raw.escalationCount === "number" && raw.escalationCount >= 0 ? raw.escalationCount : 0,
    boardTicketId: typeof raw.boardTicketId === "string" ? raw.boardTicketId : null,
    boardDepartment: typeof raw.boardDepartment === "string" ? raw.boardDepartment : null,
  };
}

export function markLeaderAckPending(
  session: Pick<Session, "id" | "parentSessionId" | "transportMeta">,
  input: {
    leaderSessionId?: string | null;
    leaderName?: string | null;
    reportKind: "result" | "error";
    now?: string;
  },
): void {
  if (!session.parentSessionId) return;
  const transport = isRecord(session.transportMeta) ? session.transportMeta : {};
  // Carry escalationCount forward across re-arms (a fresh report on this same
  // session lineage does not reset the cap — see hasEscalationsRemaining in
  // the reconciler, which relies on this to stop the repeat-escalation loop).
  const existing = readLeaderAckMeta(session);
  patchSessionTransportMeta(session.id, {
    [META_KEY]: {
      state: "pending",
      parentSessionId: session.parentSessionId,
      leaderSessionId: input.leaderSessionId?.trim() || session.parentSessionId,
      leaderName: input.leaderName?.trim() || null,
      reportKind: input.reportKind,
      reportedAt: input.now ?? new Date().toISOString(),
      acknowledgedAt: null,
      acknowledgedBy: null,
      escalatedAt: null,
      escalatedTo: null,
      escalationCount: existing?.escalationCount ?? 0,
      boardTicketId: typeof transport.boardTicketId === "string" ? transport.boardTicketId : null,
      boardDepartment: typeof transport.boardDepartment === "string" ? transport.boardDepartment : null,
    },
  });
}

export function acknowledgeLeaderAck(sessionId: string, existing: Pick<Session, "transportMeta"> | null | undefined, input?: {
  acknowledgedBy?: string | null;
  now?: string;
}): boolean {
  const current = readLeaderAckMeta(existing);
  if (!current || current.state !== "pending") return false;
  patchSessionTransportMeta(sessionId, {
    [META_KEY]: {
      ...current,
      state: "acknowledged",
      acknowledgedAt: input?.now ?? new Date().toISOString(),
      acknowledgedBy: input?.acknowledgedBy?.trim() || current.leaderName || current.leaderSessionId,
    },
  });
  return true;
}

export function markLeaderAckEscalated(sessionId: string, existing: Pick<Session, "transportMeta"> | null | undefined, input: {
  escalatedTo: string;
  now?: string;
}): boolean {
  const current = readLeaderAckMeta(existing);
  if (!current || current.state !== "pending") return false;
  patchSessionTransportMeta(sessionId, {
    [META_KEY]: {
      ...current,
      state: "escalated",
      escalatedAt: input.now ?? new Date().toISOString(),
      escalatedTo: input.escalatedTo,
      escalationCount: (current.escalationCount ?? 0) + 1,
    },
  });
  return true;
}
