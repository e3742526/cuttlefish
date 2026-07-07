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
  resolveRoleFailoverTargets,
  shouldUseMidPairExecution,
  type ExecutionPhase,
  type InternalRole,
  type ResolvedRoleTarget,
  type ReviewerLossOutcome,
} from "./employee-execution.js";
import { scanOrg } from "./org.js";
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
  RoleExecutionPolicy,
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
      remainingChildBudget: maxChildren - childCount, deadline,
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
    const revision = await runRevisionPass({
      employee, exec, task, priorSummary: implementerSummary, review: verdict,
      employeeRunId, pass, parentSession: topSession, config, context,
      remainingChildBudget: maxChildren - childCount, deadline,
    });
    childCount += revision.childSessionsSpawned;
    if (!revision.sessionId) {
      // Every implementer target failed (or budget/deadline ran out mid-walk).
      // Re-reviewing the identical unrevised output would only burn budget on a
      // repeat rejection — stop here and surface the degraded state instead.
      finalizeExecutionState(topSession.id, context, {
        executionPhase: "degraded",
        executionDegraded: true,
        executionDegradedReason: `revision pass ${pass} failed on all available implementer targets`,
        executionPass: pass,
        executionChildCount: childCount,
      });
      return;
    }
    implementerSessionId = revision.sessionId;
    // loop continues -> next pass reviews the revision
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
// Reviewer pass (walks the role's full failover chain, bounded by budget/deadline)
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
  /** Child sessions this pass may still spawn (loop budget minus spawns so far). */
  remainingChildBudget: number;
  /** Wall-clock deadline shared with the review loop. */
  deadline: number;
}

/** Resolve a role's failover chain against the live org + engine registry.
 *  External-agent (`employee`) targets resolve through scanOrg(). */
function resolveFailoverTargets(
  role: RoleExecutionPolicy | undefined,
  employee: Employee,
  primary: { engine: string; model: string },
  context: ApiContext,
): ResolvedRoleTarget[] {
  // scanOrg() reads every org YAML from disk — memoize so the chain walk costs
  // at most one scan, and none when no target defers to an external employee.
  let org: Map<string, Employee> | undefined;
  return resolveRoleFailoverTargets({
    role,
    primary,
    currentEmployeeName: employee.name,
    lookupEmployee: (name) => (org ??= scanOrg()).get(name),
    isEngineAvailable: (engine) => Boolean(context.sessionManager.getEngine(engine)),
  });
}

async function runReviewerPass(params: ReviewerPassParams): Promise<ReviewerPassOutcome> {
  const { employee, exec, task, implementerSummary, employeeRunId, pass, parentSession, config, context, priorVerdict, remainingChildBudget, deadline } = params;
  const reviewerRole = exec.roles?.reviewer;
  let spawned = 0;

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
    spawned += 1;
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
  if (primaryVerdict) return { kind: "verdict", verdict: primaryVerdict, childSessionsSpawned: spawned };

  // Primary reviewer lost. Resolve the deterministic failover plan up front:
  // ordered, deduped, self/primary/unavailable targets already filtered out.
  const targets = resolveFailoverTargets(reviewerRole, employee, { engine: primaryEngine, model: primaryModel }, context);
  const policy = exec.reviewerLossPolicy ?? "replace_then_degrade";
  const outcome = applyReviewerLossPolicy(policy, priorVerdict, targets.length > 0);

  if (outcome.action === "replace") {
    for (const target of targets) {
      if (spawned >= remainingChildBudget) {
        logExecutionDegraded(parentSession.id, `reviewer failover halted: child-session budget exhausted after ${spawned} attempt(s)`, employeeRunId);
        break;
      }
      if (Date.now() >= deadline) {
        logExecutionDegraded(parentSession.id, "reviewer failover halted: wall-clock budget exceeded", employeeRunId);
        break;
      }
      const label = target.viaEmployee
        ? `external agent "${target.viaEmployee}" (${target.engine}/${target.model})`
        : `${target.engine}/${target.model}`;
      const fallbackVerdict = await attemptReview(target.engine, target.model, target.effortLevel);
      if (fallbackVerdict) {
        logExecutionDegraded(parentSession.id, `reviewer replaced with fallback ${label}`, employeeRunId);
        return { kind: "verdict", verdict: fallbackVerdict, childSessionsSpawned: spawned };
      }
      logger.warn(`[mid_pair] reviewer fallback ${label} did not produce a verdict for ${employee.name}`);
    }
    // Chain exhausted — re-resolve with hasFallback=false so the bounded retry
    // terminates (the policy can then only return "block" or "degrade").
    const finalOutcome = applyReviewerLossPolicy(policy, priorVerdict, false);
    if (finalOutcome.action === "block") {
      logExecutionBlocked(parentSession.id, finalOutcome.reason, employeeRunId);
    } else if (finalOutcome.action === "degrade") {
      logExecutionDegraded(parentSession.id, finalOutcome.reason, employeeRunId);
    }
    return { kind: "unavailable", childSessionsSpawned: spawned, finalOutcome };
  }

  if (outcome.action === "block") logExecutionBlocked(parentSession.id, outcome.reason, employeeRunId);
  else logExecutionDegraded(parentSession.id, outcome.reason, employeeRunId);
  return { kind: "unavailable", childSessionsSpawned: spawned, finalOutcome: outcome };
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
  /** Child sessions this pass may still spawn (loop budget minus spawns so far). */
  remainingChildBudget: number;
  /** Wall-clock deadline shared with the review loop. */
  deadline: number;
}

interface RevisionPassResult {
  /** Session id of the successful revision, or null if every attempt failed. */
  sessionId: string | null;
  childSessionsSpawned: number;
}

async function runRevisionPass(params: RevisionPassParams): Promise<RevisionPassResult> {
  const { employee, exec, task, priorSummary, review, employeeRunId, pass, parentSession, config, context, remainingChildBudget, deadline } = params;
  const implRole = exec.roles?.implementer;
  const primary: ResolvedRoleTarget = {
    engine: implRole?.override?.engine ?? employee.engine,
    model: implRole?.override?.model ?? employee.model,
    effortLevel: implRole?.override?.effortLevel ?? employee.effortLevel,
  };
  // Primary first, then the implementer's deterministic failover chain.
  const targets: ResolvedRoleTarget[] = [
    primary,
    ...resolveFailoverTargets(implRole, employee, { engine: primary.engine, model: primary.model }, context),
  ];

  let spawned = 0;
  for (const target of targets) {
    if (spawned >= remainingChildBudget || Date.now() >= deadline) break;
    const revisionEngine = context.sessionManager.getEngine(target.engine);
    if (!revisionEngine) {
      logger.warn(`[mid_pair] revision engine "${target.engine}" not available for ${employee.name}`);
      continue;
    }
    const revisionSession = spawnRoleSession({
      employee, role: "implementer", employeeRunId, parentSession,
      engineName: target.engine, model: target.model, effortLevel: target.effortLevel,
      label: `Revision pass ${pass}`, context,
    });
    spawned += 1;
    const revisionPrompt = buildRevisionPrompt(task, priorSummary, review);
    insertMessage(revisionSession.id, "user", revisionPrompt);
    await dispatchWebSessionRun(revisionSession, revisionPrompt, revisionEngine, config, context);
    const settled = getSession(revisionSession.id);
    if (settled && settled.status !== "error" && settled.status !== "interrupted") {
      if (target !== primary) {
        const label = target.viaEmployee
          ? `external agent "${target.viaEmployee}" (${target.engine}/${target.model})`
          : `${target.engine}/${target.model}`;
        logExecutionDegraded(parentSession.id, `implementer replaced with fallback ${label} for revision pass ${pass}`, employeeRunId);
      }
      return { sessionId: revisionSession.id, childSessionsSpawned: spawned };
    }
    logger.warn(`[mid_pair] revision attempt on ${target.engine}/${target.model} failed for ${employee.name}`);
  }
  return { sessionId: null, childSessionsSpawned: spawned };
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
