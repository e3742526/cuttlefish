/**
 * Mid-pair execution orchestrator (V1).
 *
 * `employee-execution.ts` defines the mid_pair (implementer -> reviewer) building
 * blocks — prompt builders, verdict parsing, loss-policy resolution — but nothing
 * previously called them: the chat dispatch path only tagged a session's
 * transportMeta as `executionTier:"mid_pair"` and left it there forever, and the
 * kanban dispatch path didn't even do that. No reviewer session was ever spawned.
 *
 * This module is the actual loop: spawn a depth-1 reviewer child session, parse
 * its structured verdict, loop revision passes up to `maxInternalPasses`, and
 * apply `reviewerLossPolicy` when the reviewer is unavailable or unparseable.
 *
 * `dispatchEmployeeSessionRun` is a drop-in wrapper around `dispatchWebSessionRun`
 * — both the chat path (api/routes/session-write.ts, new top-level message) and
 * the kanban path (ticket-dispatch.ts) call it instead, so the same gate and loop
 * apply to both. For solo employees (or mid_pair disabled, or already inside a
 * role child session) it passes straight through with no behavior change.
 *
 * Role child sessions (reviewer / revision-implementer) are deliberately created
 * WITHOUT `employee` set — employee-execution.ts's own contract says internal
 * roles are "runtime-only — never org members" — which also keeps them invisible
 * to board-sync.ts (which only ticket-syncs employee-bound sessions), so a review
 * pass never appears as a phantom new card on the kanban board.
 *
 * Known gap: follow-up messages on an existing session
 * (POST /api/sessions/:id/message), queue-replay after a gateway restart
 * (resumePendingWebQueueItems / dispatchPendingQueueItem), and notification
 * dispatch (dispatchSessionNotification) still call dispatchWebSessionRun
 * directly and bypass mid_pair. Only the two *new-dispatch* entry points (chat's
 * first message, board dispatch) are wired through this orchestrator.
 */
import { randomUUID } from "node:crypto";
import { dispatchWebSessionRun } from "./api/session-dispatch.js";
import type { ApiContext } from "./api/context.js";
import {
  applyReviewerLossPolicy,
  buildReviewPacketPrompt,
  buildReviewerSystemPrompt,
  buildRevisionPrompt,
  buildRoleTransportMeta,
  generateEmployeeRunId,
  logExecutionBlocked,
  logExecutionDegraded,
  parseReviewResult,
  resolveEffectiveExecution,
  shouldUseMidPairExecution,
  type ExecutionPhase,
  type InternalRole,
  type ReviewerLossOutcome,
} from "./employee-execution.js";
import { createSession, getMessages, getSession, insertMessage, updateSession } from "../sessions/registry.js";
import { logger } from "../shared/logger.js";
import type {
  CuttlefishConfig,
  Employee,
  EmployeeExecutionConfig,
  Engine,
  JsonObject,
  ReviewResult,
  ReviewVerdict,
  Session,
} from "../shared/types.js";

export interface DispatchEmployeeSessionRunOpts {
  delayMs?: number;
  queueItemId?: string;
  attachments?: string[];
  resourceContext?: string | null;
}

/** Drop-in replacement for `dispatchWebSessionRun` that adds the mid_pair loop when applicable. */
export async function dispatchEmployeeSessionRun(
  session: Session,
  prompt: string,
  engine: Engine,
  config: CuttlefishConfig,
  context: ApiContext,
  employee: Employee | null | undefined,
  opts?: DispatchEmployeeSessionRunOpts,
): Promise<void> {
  if (!shouldUseMidPairExecution(config, employee, session.transportMeta as Record<string, unknown> | null)) {
    return dispatchWebSessionRun(session, prompt, engine, config, context, opts);
  }

  const exec = resolveEffectiveExecution(employee!);
  const employeeRunId = generateEmployeeRunId();
  const tagged = updateSession(session.id, {
    transportMeta: {
      ...((session.transportMeta as Record<string, unknown> | null) ?? {}),
      employeeRunId,
      executionTier: "mid_pair",
      executionPhase: "implementing" satisfies ExecutionPhase,
      executionDepth: 0,
      executionPass: 1,
      executionMaxPasses: exec.maxInternalPasses,
      executionChildCount: 0,
    } as JsonObject,
  }) ?? session;

  await dispatchWebSessionRun(tagged, prompt, engine, config, context, opts);

  const settled = getSession(tagged.id);
  if (!settled) return; // session deleted mid-flight

  if (settled.status === "error" || settled.status === "interrupted") {
    // Nothing to review — the implementer turn itself didn't produce a result.
    finalizeExecutionState(settled.id, context, { executionPhase: "failed" });
    return;
  }

  await runReviewLoop({ topSession: settled, employee: employee!, exec, task: prompt, employeeRunId, config, context });
}

// ---------------------------------------------------------------------------
// Review loop
// ---------------------------------------------------------------------------

interface ReviewLoopParams {
  topSession: Session;
  employee: Employee;
  exec: EmployeeExecutionConfig;
  task: string;
  employeeRunId: string;
  config: CuttlefishConfig;
  context: ApiContext;
}

async function runReviewLoop(params: ReviewLoopParams): Promise<void> {
  const { topSession, employee, exec, task, employeeRunId, config, context } = params;
  const maxPasses = Math.max(1, exec.maxInternalPasses ?? 1);
  const maxChildren = Math.max(1, exec.maxChildSessions ?? 3);
  const deadline = Date.now() + Math.max(1000, exec.maxWallClockMs ?? 300_000);

  let implementerSessionId = topSession.id;
  let childCount = 0;
  let priorVerdict: ReviewVerdict | null = null;

  for (let pass = 1; pass <= maxPasses; pass++) {
    if (childCount >= maxChildren || Date.now() >= deadline) {
      finalizeExecutionState(topSession.id, context, {
        executionPhase: "degraded",
        executionDegraded: true,
        executionDegradedReason: childCount >= maxChildren
          ? `mid_pair child-session budget (${maxChildren}) exhausted`
          : "mid_pair wall-clock budget exceeded",
        executionPass: pass,
        executionChildCount: childCount,
      });
      return;
    }

    const implementerSummary = readLastAssistantMessage(implementerSessionId) ?? "";
    updateExecutionState(topSession.id, context, { executionPhase: "reviewing", executionPass: pass, executionChildCount: childCount });

    const outcome = await runReviewerPass({
      employee, exec, task, implementerSummary, employeeRunId, pass,
      parentSession: topSession, config, context, priorVerdict,
    });
    childCount += outcome.childSessionsSpawned;

    if (outcome.kind === "unavailable") {
      finalizeExecutionState(topSession.id, context, { ...lossOutcomeToPatch(outcome.finalOutcome), executionPass: pass, executionChildCount: childCount });
      return;
    }

    const verdict = outcome.verdict;
    priorVerdict = verdict.verdict;

    if (verdict.verdict === "approved") {
      finalizeExecutionState(topSession.id, context, { executionPhase: "done", executionPass: pass, executionChildCount: childCount });
      return;
    }
    if (verdict.verdict === "blocked") {
      finalizeExecutionState(topSession.id, context, {
        executionPhase: "failed",
        executionPass: pass,
        executionChildCount: childCount,
        lastError: `Review blocked: ${verdict.summary || "no summary provided"}`,
      });
      return;
    }
    if (verdict.verdict === "needs_human_review") {
      finalizeExecutionState(topSession.id, context, {
        executionPhase: "failed",
        executionDegraded: true,
        executionDegradedReason: `reviewer requested human review: ${verdict.summary || "no summary provided"}`,
        executionPass: pass,
        executionChildCount: childCount,
      });
      return;
    }

    // verdict.verdict === "changes_requested"
    if (pass >= maxPasses) {
      finalizeExecutionState(topSession.id, context, {
        executionPhase: "degraded",
        executionDegraded: true,
        executionDegradedReason: `reviewer requested changes after ${pass} pass(es); max internal passes exhausted`,
        executionPass: pass,
        executionChildCount: childCount,
      });
      return;
    }
    if (childCount >= maxChildren) {
      finalizeExecutionState(topSession.id, context, {
        executionPhase: "degraded",
        executionDegraded: true,
        executionDegradedReason: `mid_pair child-session budget (${maxChildren}) exhausted before revision`,
        executionPass: pass,
        executionChildCount: childCount,
      });
      return;
    }

    updateExecutionState(topSession.id, context, { executionPhase: "revising", executionPass: pass, executionChildCount: childCount });
    const revisionSessionId = await runRevisionPass({
      employee, exec, task, priorSummary: implementerSummary, review: verdict,
      employeeRunId, pass, parentSession: topSession, config, context,
    });
    childCount += 1;
    if (revisionSessionId) implementerSessionId = revisionSessionId;
    // loop continues -> next pass reviews the revision (or the unrevised output, if the revision itself failed)
  }
}

/** Callers only ever pass a "block" | "degrade" outcome here — any "replace" must
 *  already have been resolved to a verdict or re-resolved without a fallback. */
function lossOutcomeToPatch(outcome: ReviewerLossOutcome): { executionPhase: ExecutionPhase; executionDegraded?: boolean; executionDegradedReason?: string; lastError?: string } {
  if (outcome.action === "block") {
    return { executionPhase: "failed", lastError: `Reviewer unavailable: ${outcome.reason}` };
  }
  if (outcome.action === "degrade") {
    return { executionPhase: "degraded", executionDegraded: true, executionDegradedReason: outcome.reason };
  }
  // Unreachable in practice (see callers), but keep the state machine total.
  return { executionPhase: "degraded", executionDegraded: true, executionDegradedReason: "reviewer loss policy resolved to an unexpected replace outcome" };
}

// ---------------------------------------------------------------------------
// Reviewer pass (with one bounded fallback retry on loss)
// ---------------------------------------------------------------------------

type ReviewerPassOutcome =
  | { kind: "verdict"; verdict: ReviewResult; childSessionsSpawned: number }
  | { kind: "unavailable"; childSessionsSpawned: number; finalOutcome: ReviewerLossOutcome };

interface ReviewerPassParams {
  employee: Employee;
  exec: EmployeeExecutionConfig;
  task: string;
  implementerSummary: string;
  employeeRunId: string;
  pass: number;
  parentSession: Session;
  config: CuttlefishConfig;
  context: ApiContext;
  priorVerdict: ReviewVerdict | null;
}

async function runReviewerPass(params: ReviewerPassParams): Promise<ReviewerPassOutcome> {
  const { employee, exec, task, implementerSummary, employeeRunId, pass, parentSession, config, context, priorVerdict } = params;
  const reviewerRole = exec.roles?.reviewer;
  const fallback = reviewerRole?.fallbackChain?.[0];
  const hasFallback = Boolean(fallback?.engine && fallback?.model);

  const attemptReview = async (engineName: string, model: string, effortLevel: string | undefined): Promise<ReviewResult | null> => {
    const reviewerEngine = context.sessionManager.getEngine(engineName);
    if (!reviewerEngine) {
      logger.warn(`[mid_pair] reviewer engine "${engineName}" not available for ${employee.name}`);
      return null;
    }
    const reviewerSession = spawnRoleSession({
      employee, role: "reviewer", employeeRunId, parentSession, engineName, model, effortLevel,
      label: `Review pass ${pass}`, context,
    });
    const reviewerPrompt = `${buildReviewerSystemPrompt(exec.reviewerToolProfile ?? "read_only")}\n\n${buildReviewPacketPrompt(task, implementerSummary)}`;
    insertMessage(reviewerSession.id, "user", reviewerPrompt);
    await dispatchWebSessionRun(reviewerSession, reviewerPrompt, reviewerEngine, config, context);
    const settled = getSession(reviewerSession.id);
    if (!settled || settled.status === "error" || settled.status === "interrupted") return null;
    const raw = readLastAssistantMessage(reviewerSession.id);
    return raw ? parseReviewResult(raw) : null;
  };

  const primaryEngine = reviewerRole?.override?.engine ?? employee.engine;
  const primaryModel = reviewerRole?.override?.model ?? employee.model;
  const primaryEffort = reviewerRole?.override?.effortLevel ?? employee.effortLevel;

  const primaryVerdict = await attemptReview(primaryEngine, primaryModel, primaryEffort);
  if (primaryVerdict) return { kind: "verdict", verdict: primaryVerdict, childSessionsSpawned: 1 };

  const policy = exec.reviewerLossPolicy ?? "replace_then_degrade";
  const outcome = applyReviewerLossPolicy(policy, priorVerdict, hasFallback, fallback?.engine, fallback?.model);

  if (outcome.action === "replace") {
    const fallbackVerdict = await attemptReview(outcome.fallbackEngine, outcome.fallbackModel, fallback?.effortLevel);
    if (fallbackVerdict) {
      logExecutionDegraded(parentSession.id, `reviewer replaced with fallback ${outcome.fallbackEngine}/${outcome.fallbackModel}`, employeeRunId);
      return { kind: "verdict", verdict: fallbackVerdict, childSessionsSpawned: 2 };
    }
    // Fallback also unavailable — resolve again with hasFallback=false so the
    // bounded retry terminates (never loops trying further fallbacks; with
    // hasFallback=false the function can only return "block" or "degrade").
    const finalOutcome = applyReviewerLossPolicy(policy, priorVerdict, false);
    if (finalOutcome.action === "block") {
      logExecutionBlocked(parentSession.id, finalOutcome.reason, employeeRunId);
    } else if (finalOutcome.action === "degrade") {
      logExecutionDegraded(parentSession.id, finalOutcome.reason, employeeRunId);
    }
    return { kind: "unavailable", childSessionsSpawned: 2, finalOutcome };
  }

  if (outcome.action === "block") logExecutionBlocked(parentSession.id, outcome.reason, employeeRunId);
  else logExecutionDegraded(parentSession.id, outcome.reason, employeeRunId);
  return { kind: "unavailable", childSessionsSpawned: 1, finalOutcome: outcome };
}

// ---------------------------------------------------------------------------
// Revision pass
// ---------------------------------------------------------------------------

interface RevisionPassParams {
  employee: Employee;
  exec: EmployeeExecutionConfig;
  task: string;
  priorSummary: string;
  review: ReviewResult;
  employeeRunId: string;
  pass: number;
  parentSession: Session;
  config: CuttlefishConfig;
  context: ApiContext;
}

async function runRevisionPass(params: RevisionPassParams): Promise<string | null> {
  const { employee, exec, task, priorSummary, review, employeeRunId, pass, parentSession, config, context } = params;
  const implRole = exec.roles?.implementer;
  const engineName = implRole?.override?.engine ?? employee.engine;
  const model = implRole?.override?.model ?? employee.model;
  const effortLevel = implRole?.override?.effortLevel ?? employee.effortLevel;

  const revisionEngine = context.sessionManager.getEngine(engineName);
  if (!revisionEngine) {
    logger.warn(`[mid_pair] revision engine "${engineName}" not available for ${employee.name}`);
    return null;
  }
  const revisionSession = spawnRoleSession({
    employee, role: "implementer", employeeRunId, parentSession, engineName, model, effortLevel,
    label: `Revision pass ${pass}`, context,
  });
  const revisionPrompt = buildRevisionPrompt(task, priorSummary, review);
  insertMessage(revisionSession.id, "user", revisionPrompt);
  await dispatchWebSessionRun(revisionSession, revisionPrompt, revisionEngine, config, context);
  const settled = getSession(revisionSession.id);
  if (!settled || settled.status === "error" || settled.status === "interrupted") return null;
  return revisionSession.id;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function spawnRoleSession(params: {
  employee: Employee;
  role: InternalRole;
  employeeRunId: string;
  parentSession: Session;
  engineName: string;
  model: string;
  effortLevel?: string;
  label: string;
  context: ApiContext;
}): Session {
  const { employee, role, employeeRunId, parentSession, engineName, model, effortLevel, label, context } = params;
  // Deliberately no `employee:` — role sessions are runtime-only, never org
  // members (see module docblock), which also keeps board-sync.ts from
  // ticketing them as new work.
  return createSession({
    engine: engineName,
    source: parentSession.source,
    sourceRef: `mid-pair:${employeeRunId}:${role}:${randomUUID()}`,
    connector: parentSession.connector ?? parentSession.source,
    parentSessionId: parentSession.id,
    model,
    effortLevel,
    title: `${label}: ${parentSession.title ?? employee.displayName}`,
    transportMeta: buildRoleTransportMeta(employeeRunId, role, "mid_pair") as unknown as JsonObject,
    portalName: context.getConfig().portal?.portalName,
  });
}

function readLastAssistantMessage(sessionId: string): string | null {
  const assistant = getMessages(sessionId).filter((m) => m.role === "assistant" && !m.partial);
  const last = assistant[assistant.length - 1];
  return last ? last.content : null;
}

function updateExecutionState(
  sessionId: string,
  context: ApiContext,
  patch: {
    executionPhase?: ExecutionPhase;
    executionDegraded?: boolean;
    executionDegradedReason?: string;
    executionPass?: number;
    executionChildCount?: number;
    lastError?: string;
  },
): void {
  const session = getSession(sessionId);
  if (!session) return;
  const meta: Record<string, unknown> = { ...((session.transportMeta as Record<string, unknown> | null) ?? {}) };
  if (patch.executionPhase !== undefined) meta.executionPhase = patch.executionPhase;
  if (patch.executionDegraded !== undefined) meta.executionDegraded = patch.executionDegraded;
  if (patch.executionDegradedReason !== undefined) meta.executionDegradedReason = patch.executionDegradedReason;
  if (patch.executionPass !== undefined) meta.executionPass = patch.executionPass;
  if (patch.executionChildCount !== undefined) meta.executionChildCount = patch.executionChildCount;

  const updates: Record<string, unknown> = { transportMeta: meta as JsonObject };
  if (patch.lastError !== undefined) updates.lastError = patch.lastError;
  updateSession(sessionId, updates as Parameters<typeof updateSession>[1]);
  context.emit("session:updated", { sessionId });
}

/**
 * Terminal state update (done / failed / degraded). In addition to the plain
 * transportMeta patch + "session:updated", this ALSO re-emits "session:completed"
 * for the top-level session.
 *
 * Why: the implementer's own turn already fired "session:completed" the moment
 * it finished (inside the awaited dispatchWebSessionRun call, before the review
 * loop even started) — board-sync.ts already wrote the kanban card as "done" off
 * that first event. If the review then blocks the work, the board would keep
 * lying "done" forever unless something re-syncs it. Re-emitting
 * "session:completed" with `error` set only for executionPhase:"failed" reuses
 * board-sync's existing (untouched) status logic to correct the card — same
 * "re-announce completion as new information arrives" pattern already used by
 * the late-recovery path (run-web-session.ts) and the stall reconciler
 * (status-reconciler.ts) for the same session id.
 */
function finalizeExecutionState(
  sessionId: string,
  context: ApiContext,
  patch: {
    executionPhase: ExecutionPhase;
    executionDegraded?: boolean;
    executionDegradedReason?: string;
    executionPass?: number;
    executionChildCount?: number;
    lastError?: string;
  },
): void {
  updateExecutionState(sessionId, context, patch);
  const session = getSession(sessionId);
  const failed = patch.executionPhase === "failed";
  context.emit("session:completed", {
    sessionId,
    employee: session?.employee ?? undefined,
    title: session?.title ?? undefined,
    result: failed ? null : "mid_pair execution finished",
    error: failed ? (patch.lastError ?? patch.executionDegradedReason ?? "blocked by reviewer") : null,
  });
}
