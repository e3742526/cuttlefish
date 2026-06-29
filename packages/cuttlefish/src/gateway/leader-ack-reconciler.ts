import { getSession, insertMessage, listSessions } from "../sessions/registry.js";
import { HR_EMPLOYEE_NAME } from "./org-policy.js";
import { resolveOrgHierarchy, withPortalExecutive } from "./org-hierarchy.js";
import { scanOrg } from "./org.js";
import { logger } from "../shared/logger.js";
import type { CuttlefishConfig, Employee, Session } from "../shared/types.js";
import { markLeaderAckEscalated, readLeaderAckMeta } from "../sessions/leader-ack.js";

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export interface LeaderAckEscalationDispatch {
  childSession: Session;
  recipient: Employee;
  ackLeaderName: string | null;
  timeoutMs: number;
}

export interface LeaderAckReconcilerDeps {
  emit: (event: string, payload: unknown) => void;
  getConfig: () => CuttlefishConfig;
  intervalMs?: number;
  now?: () => number;
  dispatchEscalation?: (input: LeaderAckEscalationDispatch) => Promise<void>;
}

export function resolveLeaderAckTimeoutMs(config: CuttlefishConfig): number {
  const raw = config.gateway?.leaderAckTimeoutMs;
  return typeof raw === "number" && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function formatDurationMinutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

function escalationRecipientFor(child: Session, config: CuttlefishConfig): Employee | null {
  const registry = withPortalExecutive(scanOrg(), config.portal?.portalName);
  const hierarchy = resolveOrgHierarchy(registry);
  const hr = registry.get(HR_EMPLOYEE_NAME) ?? null;
  const currentLeader = child.parentSessionId ? getSession(child.parentSessionId)?.employee ?? null : null;
  if (hr && currentLeader !== HR_EMPLOYEE_NAME) return hr;
  if (!hierarchy.root) return null;
  const executive = registry.get(hierarchy.root) ?? null;
  if (!executive) return null;
  if (currentLeader && executive.name === currentLeader && hr) return hr;
  return executive.name === currentLeader ? null : executive;
}

function escalationTargetLabel(recipient: Employee | null): string {
  return recipient?.displayName || recipient?.name || "HR/COO";
}

function buildChildEscalationMessage(child: Session, timeoutMs: number, recipient: Employee | null, ackLeaderName: string | null): string {
  const minutes = formatDurationMinutes(timeoutMs);
  const leader = ackLeaderName || "the assigned leader";
  return `🧭 Leader acknowledgement timeout: ${leader} did not acknowledge this report within ${minutes} minute${minutes === 1 ? "" : "s"}. Escalated to ${escalationTargetLabel(recipient)} for reassignment or backlog guidance.`;
}

export function buildLeaderAckEscalationPrompt(input: LeaderAckEscalationDispatch): string {
  const minutes = formatDurationMinutes(input.timeoutMs);
  const ackLeader = input.ackLeaderName || "the assigned leader";
  const ack = readLeaderAckMeta(input.childSession);
  const ticketText = ack?.boardTicketId ? `Related board ticket: ${ack.boardTicketId}.` : "No linked board ticket was recorded.";
  return [
    `A delegated worker reported back, but ${ackLeader} did not acknowledge the report within ${minutes} minutes.`,
    `Please triage this stalled management handoff for session ${input.childSession.id}.`,
    `Worker: ${input.childSession.employee || "unknown"}.`,
    `Session title: ${input.childSession.title || "(untitled)"}.`,
    ticketText,
    `Choose one of these actions and carry it through:`,
    `1. Reassign the remaining work to a different leader or specialist.`,
    `2. Put the remaining work back into backlog and explain what is blocked.`,
    `3. If the current leader should continue, send a clear acknowledgement/follow-up to the worker chat.`,
    `Reply with the concrete next action, then perform it if you have the authority.`,
  ].join("\n");
}

export function sweepLeaderAcknowledgements(deps: LeaderAckReconcilerDeps): number {
  const now = deps.now?.() ?? Date.now();
  const timeoutMs = resolveLeaderAckTimeoutMs(deps.getConfig());
  let escalated = 0;

  for (const session of listSessions()) {
    const ack = readLeaderAckMeta(session);
    if (!ack || ack.state !== "pending") continue;
    const reportedAt = Date.parse(ack.reportedAt);
    if (!Number.isFinite(reportedAt) || now - reportedAt < timeoutMs) continue;

    const recipient = escalationRecipientFor(session, deps.getConfig());
    const recipientName = recipient?.name ?? "manual-review";
    if (!markLeaderAckEscalated(session.id, session, {
      escalatedTo: recipientName,
      now: new Date(now).toISOString(),
    })) {
      continue;
    }

    const childMessage = buildChildEscalationMessage(session, timeoutMs, recipient, ack.leaderName);
    insertMessage(session.id, "notification", childMessage);
    deps.emit("session:updated", { sessionId: session.id });

    const parent = getSession(ack.parentSessionId);
    if (parent) {
      insertMessage(
        parent.id,
        "notification",
        `⏱️ A report from ${session.employee || "a report"} went unacknowledged and was escalated to ${escalationTargetLabel(recipient)}.`,
      );
      deps.emit("session:updated", { sessionId: parent.id });
    }

    if (recipient && deps.dispatchEscalation) {
      void deps.dispatchEscalation({
        childSession: getSession(session.id) ?? session,
        recipient,
        ackLeaderName: ack.leaderName,
        timeoutMs,
      }).catch((err) => {
        logger.warn(`[leader-ack] failed to dispatch escalation for ${session.id}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    logger.warn(
      `[leader-ack] session ${session.id} escalated after ${formatDurationMinutes(timeoutMs)}m without leader acknowledgement` +
      (recipient ? ` -> ${recipient.name}` : " -> manual review"),
    );
    escalated++;
  }

  return escalated;
}

export function startLeaderAckReconciler(deps: LeaderAckReconcilerDeps): () => void {
  const timer = setInterval(() => {
    try {
      sweepLeaderAcknowledgements(deps);
    } catch (err) {
      logger.warn(`[leader-ack] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
