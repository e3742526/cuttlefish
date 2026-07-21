import { isInterruptibleEngine, type Session } from "../../shared/types.js";
import type { PublicSession, SessionJobState } from "@cuttlefish/contracts";
import type { ApiContext } from "./context.js";
import { enrichRunAttachmentsForSession } from "../run-attachments.js";
import { type ExecutionRunState } from "../employee-execution.js";

const BACKGROUND_ACTIVITY_STALE_MS = 5 * 60 * 1000;

function extractExecutionRunState(session: Session): ExecutionRunState | null {
  const meta = session.transportMeta as Record<string, unknown> | undefined;
  if (!meta) return null;
  const employeeRunId = meta["employeeRunId"];
  const tier = meta["executionTier"];
  if (typeof employeeRunId !== "string" || typeof tier !== "string") return null;
  return {
    employeeRunId,
    tier: tier as ExecutionRunState["tier"],
    phase: (typeof meta["executionPhase"] === "string" ? meta["executionPhase"] : "implementing") as ExecutionRunState["phase"],
    childSessionCount: typeof meta["executionChildCount"] === "number" ? meta["executionChildCount"] : 0,
    degraded: meta["executionDegraded"] === true,
    degradedReason: typeof meta["executionDegradedReason"] === "string" ? meta["executionDegradedReason"] : undefined,
    fallbackActive: meta["executionFallbackActive"] === true,
    pass: typeof meta["executionPass"] === "number" ? meta["executionPass"] : 1,
    maxPasses: typeof meta["executionMaxPasses"] === "number" ? meta["executionMaxPasses"] : 1,
    reviewContext: meta["executionReviewContext"] === "diff" || meta["executionReviewContext"] === "summary_only"
      ? meta["executionReviewContext"]
      : undefined,
    reviewContextReason: typeof meta["executionReviewContextReason"] === "string" ? meta["executionReviewContextReason"] : undefined,
  };
}

function localJobState(session: Session, context: ApiContext): SessionJobState {
  if (session.status === "waiting") return "needs_attention";
  const queue = context.sessionManager.getQueue();
  const transportState = queue.getTransportState(session.sessionKey || session.sourceRef, session.status);
  const bg = context.backgroundActivity?.get(session.id);
  const backgroundActive = Boolean(bg && Date.now() - bg.lastActivityAt <= BACKGROUND_ACTIVITY_STALE_MS && bg.activeStreams > 0);
  if (session.status === "running" || transportState === "queued" || transportState === "running" || backgroundActive) return "working";
  if (session.status === "error" || session.status === "interrupted") return "failed";
  return session.parentSessionId ? "finished" : "idle";
}

/**
 * Aggregate direct and nested child activity into one operator-facing state.
 * This is computed from durable session edges plus live queue/background state;
 * it does not mutate the reusable chat session's underlying `idle` status.
 */
export function buildSessionJobStateMap(sessions: readonly Session[], context: ApiContext): Map<string, SessionJobState> {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const children = new Map<string, Session[]>();
  for (const session of sessions) {
    if (!session.parentSessionId || !byId.has(session.parentSessionId)) continue;
    const group = children.get(session.parentSessionId) ?? [];
    group.push(session);
    children.set(session.parentSessionId, group);
  }
  const result = new Map<string, SessionJobState>();
  const visiting = new Set<string>();
  const resolve = (session: Session): SessionJobState => {
    const cached = result.get(session.id);
    if (cached) return cached;
    if (visiting.has(session.id)) return localJobState(session, context);
    visiting.add(session.id);
    const own = localJobState(session, context);
    const childStates = (children.get(session.id) ?? []).map(resolve);
    let state = own;
    if (own === "needs_attention" || childStates.includes("needs_attention")) state = "needs_attention";
    else if (own === "working" || childStates.includes("working")) state = "working";
    else if (own === "failed") state = "failed";
    else if (childStates.length > 0) state = "finished";
    visiting.delete(session.id);
    result.set(session.id, state);
    return state;
  };
  for (const session of sessions) resolve(session);
  return result;
}

export function serializeSession(session: Session, context: ApiContext, jobState = localJobState(session, context)): Session & PublicSession & { executionRunState?: ExecutionRunState | null } {
  const queue = context.sessionManager.getQueue();
  const queueDepth = queue.getPendingCount(session.sessionKey || session.sourceRef);
  const transportState = queue.getTransportState(session.sessionKey || session.sourceRef, session.status);
  const bg = context.backgroundActivity?.get(session.id);
  const bgIsStale = bg && Date.now() - bg.lastActivityAt > BACKGROUND_ACTIVITY_STALE_MS;
  if (bgIsStale) context.backgroundActivity?.delete(session.id);
  const executionRunState = extractExecutionRunState(session);
  // Explicit field-by-field allowlist (not `...session`) so the API surface is
  // gated by PublicSession: a new internal-only field added to Session later
  // does not automatically leak into API responses — it has to be deliberately
  // added here. This list intentionally mirrors PublicSession's field set.
  const publicSession: Session & PublicSession = {
    id: session.id,
    engine: session.engine,
    engineSessionId: session.engineSessionId,
    source: session.source,
    sourceRef: session.sourceRef,
    connector: session.connector,
    sessionKey: session.sessionKey,
    replyContext: session.replyContext,
    messageId: session.messageId,
    transportMeta: session.transportMeta,
    employee: session.employee,
    model: session.model,
    title: session.title,
    promptExcerpt: session.promptExcerpt,
    parentSessionId: session.parentSessionId,
    userId: session.userId,
    status: session.status,
    effortLevel: session.effortLevel,
    cwd: session.cwd,
    totalCost: session.totalCost,
    totalTurns: session.totalTurns,
    lastContextTokens: session.lastContextTokens,
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
    lastError: session.lastError,
    attachments: enrichRunAttachmentsForSession(session),
    queueDepth,
    transportState,
    jobState,
    backgroundActivity: bg && !bgIsStale
      ? { activeStreams: bg.activeStreams, lastActivityAt: new Date(bg.lastActivityAt).toISOString() }
      : null,
  };
  return {
    ...publicSession,
    ...(executionRunState ? { executionRunState } : {}),
  };
}

export function isSessionLiveRunning(session: Session, context: ApiContext): boolean {
  if (session.status !== "running") return false;
  const engine = context.sessionManager.getEngine(session.engine);
  if (!engine || !isInterruptibleEngine(engine)) return true;
  if ("isTurnRunning" in engine) return Boolean((engine as any).isTurnRunning(session.id));
  return engine.isAlive(session.id);
}
