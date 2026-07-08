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
import type { dispatchWebSessionRun as DispatchWebSessionRunFn } from "./api/session-dispatch.js";
import type { ApiContext } from "./api/context.js";
import {
  applyReviewerLossPolicy,
  buildReviewPacketPrompt,
  buildReviewRepairPrompt,
  buildReviewerSystemPrompt,
  buildRevisionPrompt,
  buildRoleTransportMeta,
  generateEmployeeRunId,
  logExecutionBlocked,
  logExecutionDegraded,
  resolveEffectiveExecution,
  resolveRoleFailoverTargets,
  shouldUseMidPairExecution,
  validateReviewResult,
  type ExecutionPhase,
  type InternalRole,
  type ResolvedRoleTarget,
  type ReviewerLossOutcome,
} from "./employee-execution.js";
import { buildReviewContext } from "./review-context.js";
import { scanOrg } from "./org.js";
import { createSession, getMessages, getSession, insertMessage, updateSession } from "../sessions/registry.js";
import { notifyAttachedTalkSessions } from "../sessions/callbacks.js";
import { maybeEmitTalkGraph } from "../talk/graph.js";
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

// `session-dispatch.ts` now also needs `dispatchEmployeeSessionRun` (for the
// mid_pair bypass fix on queue-replay and notification dispatch) and reaches
// it via a dynamic import to avoid a static cycle with this file's own
// dependency on `dispatchWebSessionRun`. Importing `dispatchWebSessionRun`
// dynamically here too keeps this module free of ANY static edge to
// session-dispatch.ts, so there is no circular module-graph edge in either
// direction for a bundler/test-transform to trip over.
let cachedDispatchWebSessionRun: typeof DispatchWebSessionRunFn | undefined;
async function getDispatchWebSessionRun(): Promise<typeof DispatchWebSessionRunFn> {
  if (!cachedDispatchWebSessionRun) {
    ({ dispatchWebSessionRun: cachedDispatchWebSessionRun } = await import("./api/session-dispatch.js"));
  }
  return cachedDispatchWebSessionRun;
}

/**
 * Drop-in replacement for `dispatchWebSessionRun` that adds the mid_pair loop
 * when applicable.
 *
 * Like `dispatchWebSessionRun`, this never rejects: every existing and new
 * call site (session-write.ts, ticket-dispatch.ts, and — as of the mid_pair
 * bypass fix — queue-replay and notification dispatch too) calls this
 * fire-and-forget with no `.catch()`, so an exception anywhere past the
 * implementer turn (the review loop, a session lookup, a DB write) would
 * otherwise surface as an unhandled rejection instead of a visible session
 * error.
 */
export async function dispatchEmployeeSessionRun(
  session: Session,
  prompt: string,
  engine: Engine,
  config: CuttlefishConfig,
  context: ApiContext,
  employee: Employee | null | undefined,
  opts?: DispatchEmployeeSessionRunOpts,
): Promise<void> {
  try {
    await dispatchEmployeeSessionRunInner(session, prompt, engine, config, context, employee, opts);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error(`Employee session run ${session.id} dispatch error: ${errMsg}`);
    const erroredOnDispatch = updateSession(session.id, {
      status: "error",
      lastActivity: new Date().toISOString(),
      lastError: errMsg,
    });
    context.emit("session:completed", { sessionId: session.id, result: null, error: errMsg });
    if (erroredOnDispatch) notifyAttachedTalkSessions(erroredOnDispatch, { error: errMsg }, { sink: context.notificationSink });
    maybeEmitTalkGraph(session.id, "completed", { getSession, emit: context.emit });
  }
}

async function dispatchEmployeeSessionRunInner(
  session: Session,
  prompt: string,
  engine: Engine,
  config: CuttlefishConfig,
  context: ApiContext,
  employee: Employee | null | undefined,
  opts?: DispatchEmployeeSessionRunOpts,
): Promise<void> {
  if (!shouldUseMidPairExecution(config, employee, session.transportMeta as Record<string, unknown> | null)) {
    const dispatchWebSessionRun = await getDispatchWebSessionRun();
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
      // A session can be redispatched onto (board-ticket recovery/retry) — reset
      // every observability field a prior run may have left behind so a clean
      // new run can't inherit a stale degraded/fallback/review-context report.
      executionDegraded: false,
      executionDegradedReason: null,
      executionFallbackActive: false,
      executionReviewContext: null,
      executionReviewContextReason: null,
    } as JsonObject,
  }) ?? session;

  const dispatchWebSessionRun = await getDispatchWebSessionRun();
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
    const reviewContext = buildReviewContext({ cwd: topSession.cwd, config });
    updateExecutionState(topSession.id, context, {
      executionPhase: "reviewing",
      executionPass: pass,
      executionChildCount: childCount,
      executionReviewContext: reviewContext.mode,
      executionReviewContextReason: reviewContext.reason,
    });

    const outcome = await runReviewerPass({
      employee, exec, task, implementerSummary, diffContext: reviewContext.diffText, employeeRunId, pass,
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
    if (outcome.fallbackUsed) {
      // Sticky run-level flag: at least one reviewer fallback occurred this run.
      updateExecutionState(topSession.id, context, { executionFallbackActive: true });
    }

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
  | { kind: "verdict"; verdict: ReviewResult; childSessionsSpawned: number; fallbackUsed: boolean }
  | { kind: "unavailable"; childSessionsSpawned: number; finalOutcome: ReviewerLossOutcome };

/** Result of a single reviewer session attempt (one engine/model), after an
 *  in-place JSON repair retry when the session completed but its output was
 *  unparseable. */
type ReviewAttempt =
  | { kind: "verdict"; verdict: ReviewResult }
  | { kind: "engine_lost" }
  | { kind: "unparseable"; detail: string };

interface ReviewerPassParams {
  employee: Employee;
  exec: EmployeeExecutionConfig;
  task: string;
  implementerSummary: string;
  /** Deterministic changed-file/diff context for the reviewer packet, when available. */
  diffContext?: string;
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
  const { employee, exec, task, implementerSummary, diffContext, employeeRunId, pass, parentSession, config, context, priorVerdict, remainingChildBudget, deadline } = params;
  const reviewerRole = exec.roles?.reviewer;
  let spawned = 0;

  // Attempt one reviewer engine/model. Distinguishes an engine loss (missing
  // engine / errored session) from unparseable-but-alive output, and gives the
  // latter exactly one in-place JSON repair retry on the SAME session (no new
  // child spawn) before giving up.
  const attemptReview = async (engineName: string, model: string, effortLevel: string | undefined): Promise<ReviewAttempt> => {
    const reviewerEngine = context.sessionManager.getEngine(engineName);
    if (!reviewerEngine) {
      logger.warn(`[mid_pair] reviewer engine "${engineName}" not available for ${employee.name}`);
      return { kind: "engine_lost" };
    }
    const reviewerSession = spawnRoleSession({
      employee, role: "reviewer", employeeRunId, parentSession, engineName, model, effortLevel,
      label: `Review pass ${pass}`, context,
    });
    spawned += 1;
    const reviewerPrompt = `${buildReviewerSystemPrompt(exec.reviewerToolProfile ?? "read_only")}\n\n${buildReviewPacketPrompt(task, implementerSummary, diffContext)}`;
    insertMessage(reviewerSession.id, "user", reviewerPrompt);
    const dispatchWebSessionRun = await getDispatchWebSessionRun();
    await dispatchWebSessionRun(reviewerSession, reviewerPrompt, reviewerEngine, config, context);
    let settled = getSession(reviewerSession.id);
    if (!settled || settled.status === "error" || settled.status === "interrupted") return { kind: "engine_lost" };

    const first = validateReviewResult(readLastAssistantMessage(reviewerSession.id) ?? "");
    if (first.ok) return { kind: "verdict", verdict: first.value };

    // Session completed but the verdict didn't validate. Ask once for JSON-only
    // output, including the concrete validation error — bounded by the deadline.
    if (Date.now() >= deadline) return { kind: "unparseable", detail: first.error };
    logExecutionDegraded(parentSession.id, `reviewer verdict unparseable (${first.error}); requesting one JSON repair`, employeeRunId);
    const repairPrompt = buildReviewRepairPrompt(first.error);
    insertMessage(reviewerSession.id, "user", repairPrompt);
    await dispatchWebSessionRun(reviewerSession, repairPrompt, reviewerEngine, config, context);
    settled = getSession(reviewerSession.id);
    if (!settled || settled.status === "error" || settled.status === "interrupted") {
      return { kind: "unparseable", detail: `reviewer session failed during repair retry (${first.error})` };
    }
    const repaired = validateReviewResult(readLastAssistantMessage(reviewerSession.id) ?? "");
    if (repaired.ok) return { kind: "verdict", verdict: repaired.value };
    return { kind: "unparseable", detail: repaired.error };
  };

  const primaryEngine = reviewerRole?.override?.engine ?? employee.engine;
  const primaryModel = reviewerRole?.override?.model ?? employee.model;
  const primaryEffort = reviewerRole?.override?.effortLevel ?? employee.effortLevel;

  const primary = await attemptReview(primaryEngine, primaryModel, primaryEffort);
  if (primary.kind === "verdict") return { kind: "verdict", verdict: primary.verdict, childSessionsSpawned: spawned, fallbackUsed: false };
  // Tracks the cause of the MOST RECENT attempt (primary or the last fallback
  // tried), not just the primary's — a fallback rung can fail for a different
  // reason than the primary did, and the final reason should reflect whichever
  // attempt actually determined the outcome.
  let lastCause: LossCause = primary.kind === "unparseable" ? "unparseable" : "unavailable";

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
      const fallbackAttempt = await attemptReview(target.engine, target.model, target.effortLevel);
      if (fallbackAttempt.kind === "verdict") {
        logExecutionDegraded(parentSession.id, `reviewer replaced with fallback ${label}`, employeeRunId);
        return { kind: "verdict", verdict: fallbackAttempt.verdict, childSessionsSpawned: spawned, fallbackUsed: true };
      }
      lastCause = fallbackAttempt.kind === "unparseable" ? "unparseable" : "unavailable";
      const detailSuffix = fallbackAttempt.kind === "unparseable" ? `: ${fallbackAttempt.detail}` : "";
      logger.warn(`[mid_pair] reviewer fallback ${label} did not produce a verdict for ${employee.name}${detailSuffix}`);
    }
    // Chain exhausted — re-resolve with hasFallback=false so the bounded retry
    // terminates (the policy can then only return "block" or "degrade").
    const finalOutcome = withLossCause(lastCause, applyReviewerLossPolicy(policy, priorVerdict, false));
    if (finalOutcome.action === "block") {
      logExecutionBlocked(parentSession.id, finalOutcome.reason, employeeRunId);
    } else if (finalOutcome.action === "degrade") {
      logExecutionDegraded(parentSession.id, finalOutcome.reason, employeeRunId);
    }
    return { kind: "unavailable", childSessionsSpawned: spawned, finalOutcome };
  }

  const finalOutcome = withLossCause(lastCause, outcome);
  if (finalOutcome.action === "block") logExecutionBlocked(parentSession.id, finalOutcome.reason, employeeRunId);
  else if (finalOutcome.action === "degrade") logExecutionDegraded(parentSession.id, finalOutcome.reason, employeeRunId);
  return { kind: "unavailable", childSessionsSpawned: spawned, finalOutcome };
}

type LossCause = "unavailable" | "unparseable";

/** Enrich a block/degrade loss reason with its specific cause so operators can
 *  tell "reviewer output unparseable" apart from "reviewer engine unavailable".
 *  Only the reason string is touched — the block-vs-degrade decision (and the
 *  "prior non-approval must block" invariant) stays with applyReviewerLossPolicy. */
function withLossCause(cause: LossCause, outcome: ReviewerLossOutcome): ReviewerLossOutcome {
  if (outcome.action === "replace" || cause !== "unparseable") return outcome;
  return { action: outcome.action, reason: `reviewer output could not be parsed after one repair retry — ${outcome.reason}` };
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
    const dispatchWebSessionRun = await getDispatchWebSessionRun();
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
    // Inherit the task workspace so a revision-implementer's edits land in the
    // real project (not CUTTLEFISH_HOME) and the reviewer's diff context stays
    // meaningful across passes.
    cwd: parentSession.cwd,
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
    executionFallbackActive?: boolean;
    executionReviewContext?: "diff" | "summary_only";
    executionReviewContextReason?: string;
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
  if (patch.executionFallbackActive !== undefined) meta.executionFallbackActive = patch.executionFallbackActive;
  // Written as a pair, not independently: reviewContextReason only has meaning
  // relative to the mode it was recorded under. If we only wrote the reason
  // when it's defined, a stale reason from an earlier "summary_only" pass would
  // survive into a later "diff" pass (reason undefined), producing a
  // self-contradictory reviewContext:"diff" + a leftover "no diff" reason.
  // Setting meta.executionReviewContextReason = undefined here is intentional —
  // JSON.stringify drops undefined values on persist, correctly clearing it.
  if (patch.executionReviewContext !== undefined) {
    meta.executionReviewContext = patch.executionReviewContext;
    meta.executionReviewContextReason = patch.executionReviewContextReason;
  }

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
