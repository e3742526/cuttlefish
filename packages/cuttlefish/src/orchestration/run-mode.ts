import { z } from "zod";
import { createSession, getSession, insertMessage, updateSession } from "../sessions/registry.js";
import { logger } from "../shared/logger.js";
import type { Engine, JsonObject } from "../shared/types.js";
import type { ApiContext } from "../gateway/api/context.js";
import { type WebSessionDispatcher, resolveDefaultWebSessionDispatcher } from "./execution-port.js";
import { buildCoordinatorTaskBrief, type CoordinatorMode } from "./coordinator.js";
import { isReviewerRole } from "./cross-family.js";
import { toLeaseTransportMeta } from "./lease-meta.js";
import { LIVE_RUN_MODES, type LiveRunContinuationRecord, type LiveRunMode, type LiveRunTaskPayload } from "./live-run.js";
import { resolveLiveLeaseDurationMs } from "./runtime.js";
import type { Allocation, Lease, QueueItem, ReviewPolicyExplanation, ReviewPolicySummary, RoleDefinition, Worker } from "./types.js";
import {
  cleanupReviewBundle,
  cleanupWorktree,
  createImplementationWorktree,
  createReviewBundle,
  diffWorktree,
  resolveTaskBaseCwd,
  type ReviewBundleHandle,
  type WorktreeHandle,
  type WorktreeOptions,
} from "./worktree.js";
import {
  appendOrchestrationTelemetry,
  telemetryCountsFromDiff,
  type OrchestrationRunTelemetryRecord,
} from "./telemetry.js";
import {
  beginOrchestrationRun,
  createBlockedOrchestrationRun,
  finalizeOrchestrationRunCompleted,
  finalizeOrchestrationRunFailed,
} from "./run-ledger-integration.js";

export const liveRunModeSchema = z.enum(LIVE_RUN_MODES);

const liveRunTaskSchema = z.object({
  taskId: z.string().min(1),
  coordinatorId: z.string().min(1),
  coordinatorTemplate: z.string().min(1).optional(),
  template: z.string().min(1).optional(),
  requiredRoles: z.array(z.string().min(1)).optional(),
  optionalRoles: z.array(z.string().min(1)).optional(),
  allowedWorkerIds: z.array(z.string().min(1)).optional(),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
  leaseDurationMs: z.number().int().positive().optional(),
  mode: liveRunModeSchema.default("single_worker"),
  prompt: z.string().min(1),
  cwd: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  effortLevel: z.string().min(1).optional(),
  openaiRole: z.string().min(1).optional(),
  anthropicRole: z.string().min(1).optional(),
}).strict();

export interface RunOrchestrationTaskOptions {
  context: ApiContext;
  task: unknown;
  mode?: LiveRunMode;
}

export interface RunAllocatedOrchestrationTaskOptions {
  context: ApiContext;
  mode: LiveRunMode;
  task: LiveRunTaskPayload;
  allocation: Allocation;
  reviewPolicy: ReviewPolicySummary;
}

export type OrchestrationRunTaskResult =
  | { ok: false; state: "blocked_resource"; mode: LiveRunMode; queueItem: QueueItem; reviewPolicy: ReviewPolicySummary }
  | { ok: false; state: "failed"; mode: LiveRunMode; allocation: Allocation; sessions: OrchestrationRunSession[]; reviewPolicy: ReviewPolicySummary; errorSummary: string }
  | { ok: true; state: "completed"; mode: LiveRunMode; allocation: Allocation; sessions: OrchestrationRunSession[]; reviewPolicy: ReviewPolicySummary }
  | import("./dual-lane.js").DualLaneRunResult;

export interface OrchestrationRunSession {
  sessionId: string;
  leaseId: string;
  workerId: string;
  provider: string;
  family: string;
  model: string | null;
  role: string;
  status: string;
  error: string | null;
  cwd: string;
  workspaceMode: OrchestrationLeaseWorkspace["mode"];
  worktreePath?: string;
  reviewBundlePath?: string;
  reviewPolicy?: ReviewPolicyExplanation;
}

export type ImplementationWorkspace =
  | { mode: "shared"; cwd: string; downgradeReason?: string }
  | { mode: "implementation_worktree"; cwd: string; handle: WorktreeHandle };

export type OrchestrationLeaseWorkspace =
  | ImplementationWorkspace
  | { mode: "review_bundle"; cwd: string; bundle: ReviewBundleHandle; worktreePath?: string };

interface CapturedCompletion {
  cost?: number;
  durationMs?: number;
  error?: unknown;
}

export async function runOrchestrationTask(opts: RunOrchestrationTaskOptions): Promise<OrchestrationRunTaskResult> {
  if (opts.context.getConfig().orchestration?.enabled !== true) {
    throw new Error("orchestration runtime is disabled in config");
  }
  const runtime = opts.context.orchestration?.runtime;
  if (!runtime) throw new Error("orchestration runtime is not enabled");

  const parsed = liveRunTaskSchema.parse(opts.task);
  const mode = opts.mode ?? liveRunModeSchema.parse(parsed.mode);
  const task = normalizeTaskPayload(parsed, opts.context);
  if (mode === "dual_lane") {
    const { runDualLaneTask } = await import("./dual-lane.js");
    return runDualLaneTask({ context: opts.context, task });
  }
  const brief = buildCoordinatorTaskBrief({
    taskId: task.taskId,
    coordinatorId: task.coordinatorId,
    coordinatorTemplate: task.coordinatorTemplate,
    requiredRoles: task.requiredRoles,
    optionalRoles: task.optionalRoles,
    allowedWorkerIds: task.allowedWorkerIds,
    priority: task.priority,
    leaseDurationMs: task.leaseDurationMs,
    mode: mode as CoordinatorMode,
  }, runtime.config);
  const allocationResult = await runtime.requestAllocationWithLiveHeadroom(brief.request);
  if (!allocationResult.ok) {
    const blockedRunId = createBlockedOrchestrationRun(task.taskId, task.coordinatorId, mode, task.title);
    const continuationRecord = buildContinuationRecord(runtime.getLiveContinuation(task.taskId, task.coordinatorId), task, mode);
    continuationRecord.runId = blockedRunId;
    runtime.queueLiveContinuation(continuationRecord);
    return { ok: false, state: "blocked_resource", mode, queueItem: allocationResult.queueItem, reviewPolicy: allocationResult.reviewPolicy };
  }

  runtime.deleteLiveContinuation(task.taskId, task.coordinatorId);
  return runAllocatedOrchestrationTask({
    context: opts.context,
    mode,
    task,
    allocation: allocationResult.allocation,
    reviewPolicy: allocationResult.reviewPolicy,
  });
}

export async function runAllocatedOrchestrationTask(opts: RunAllocatedOrchestrationTaskOptions): Promise<OrchestrationRunTaskResult> {
  const runtime = opts.context.orchestration?.runtime;
  if (!runtime) throw new Error("orchestration runtime is not enabled");

  let runId: string;
  try {
    runId = beginOrchestrationRun(opts.allocation, opts.mode, opts.task.title);
  } catch (err) {
    // Ledger write failed before any lease turn started: release the leases
    // this allocation already holds instead of leaving them dangling until
    // the boot-time orphan sweep reclaims them.
    for (const lease of opts.allocation.leases) {
      releaseLeaseSafely(runtime, lease);
    }
    throw err;
  }
  opts.allocation.runId = runId;

  const sessions: OrchestrationRunSession[] = [];
  const baseCwd = resolveTaskBaseCwd(opts.task.cwd, opts.context.getConfig());
  const laneWorktrees = new Map<string, WorktreeHandle>();
  const reviewBundles: ReviewBundleHandle[] = [];
  const roleDefinitions = new Map(runtime.config.roles.map((role) => [role.id, role]));
  const reviewPolicyByRole = new Map(opts.reviewPolicy.explanations.map((explanation) => [explanation.role, explanation]));
  let implementationWorkspace: ImplementationWorkspace | undefined;

  try {
    for (const lease of opts.allocation.leases) {
      const worker = requireWorker(runtime.listWorkers(), lease.workerId);
      const role = roleDefinitions.get(lease.role);
      try {
        const workspace = prepareLeaseWorkspace({
          baseCwd,
          lease,
          role,
          worker,
          worktrees: laneWorktrees,
          reviewBundles,
          runtime: { getWorktreeOptions: () => runtime.getWorktreeOptions() },
          implementationWorkspace,
        });
        if (!isReviewerRole(lease.role, role) && (workspace.mode === "shared" || workspace.mode === "implementation_worktree")) {
          implementationWorkspace = workspace;
        }
        const session = await runOrchestrationLeaseTurn({
          context: opts.context,
          mode: opts.mode,
          lease,
          worker,
          workspace,
          reviewPolicy: reviewPolicyByRole.get(lease.role),
          prompt: promptForRole(opts.task.prompt, lease.role, role),
          title: opts.task.title,
          model: opts.task.model,
          effortLevel: opts.task.effortLevel,
        });
        sessions.push(session);
        if (orchestrationSessionFailed(session)) {
          const errorSummary = `${lease.role} failed: ${session.error ?? session.status}`;
          finalizeOrchestrationRunFailed(runId, errorSummary);
          return {
            ok: false,
            state: "failed",
            mode: opts.mode,
            allocation: opts.allocation,
            sessions,
            reviewPolicy: opts.reviewPolicy,
            errorSummary,
          };
        }
      } catch (err) {
        releaseLeaseSafely(runtime, lease);
        throw err;
      }
    }
  } finally {
    for (const bundle of reviewBundles) {
      try {
        cleanupReviewBundle(bundle);
      } catch (err) {
        logger.warn(`Orchestration review bundle cleanup failed for ${bundle.path}: ${err instanceof Error ? err.message : err}`);
      }
    }
    for (const handle of laneWorktrees.values()) {
      try {
        cleanupWorktree(handle);
      } catch (err) {
        logger.warn(`Orchestration worktree cleanup failed for ${handle.path}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  finalizeOrchestrationRunCompleted(runId);
  return {
    ok: true,
    state: "completed",
    mode: opts.mode,
    allocation: opts.allocation,
    sessions,
    reviewPolicy: opts.reviewPolicy,
  };
}

export async function runOrchestrationLeaseTurn(opts: {
  context: ApiContext;
  mode: LiveRunMode;
  lease: Lease;
  worker: Worker;
  workspace: OrchestrationLeaseWorkspace;
  reviewPolicy?: ReviewPolicyExplanation;
  prompt: string;
  title?: string;
  model?: string;
  effortLevel?: string;
  /**
   * Narrow execution port (ARC-CUT-001). Defaults to the gateway web-session
   * dispatcher, resolved lazily so orchestration never statically imports the
   * gateway API aggregate.
   */
  dispatch?: WebSessionDispatcher;
}): Promise<OrchestrationRunSession> {
  const runtime = opts.context.orchestration?.runtime;
  if (!runtime) throw new Error("orchestration runtime is not enabled");
  const validation = runtime.validateLeaseForWorker(opts.worker.id, opts.lease.leaseId, opts.lease.taskId, opts.lease.coordinatorId);
  if (!validation.ok) throw new Error(`lease ${opts.lease.leaseId} is not valid for worker ${opts.worker.id}: ${validation.reason ?? "unknown"}`);

  const engine = resolveWorkerEngine(opts.context, opts.worker);
  if (!engine) throw new Error(`engine for worker provider ${opts.worker.provider} is not available`);

  const sessionKey = `orchestration:${opts.lease.taskId}:${opts.lease.role}:${opts.lease.leaseId}`;
  const transportMeta = toLeaseTransportMeta({
    leaseId: opts.lease.leaseId,
    taskId: opts.lease.taskId,
    coordinatorId: opts.lease.coordinatorId,
    workerId: opts.worker.id,
    role: opts.lease.role,
    mode: opts.mode,
  });
  transportMeta["orchestrationWorkspace"] = {
    mode: opts.workspace.mode,
    cwd: opts.workspace.cwd,
    worktreePath: "handle" in opts.workspace
      ? opts.workspace.handle.path
      : (opts.workspace.mode === "review_bundle" ? opts.workspace.worktreePath ?? null : null),
    reviewBundlePath: "bundle" in opts.workspace ? opts.workspace.bundle.path : null,
    downgradeReason: opts.workspace.mode === "shared" ? opts.workspace.downgradeReason ?? null : null,
  };
  if (opts.reviewPolicy) {
    transportMeta["orchestrationReviewPolicy"] = opts.reviewPolicy as unknown as JsonObject;
  }
  const session = createSession({
    engine: opts.worker.provider,
    source: "web",
    sourceRef: sessionKey,
    connector: "web",
    sessionKey,
    replyContext: { source: "web" },
    transportMeta,
    model: opts.model,
    effortLevel: opts.effortLevel,
    cwd: opts.workspace.cwd,
    title: opts.title ?? `${opts.lease.taskId} ${opts.lease.role}`,
    prompt: opts.prompt,
  });

  insertMessage(session.id, "user", opts.prompt);
  updateSession(session.id, { status: "running", lastActivity: new Date().toISOString(), lastError: null });

  let completion: CapturedCompletion | undefined;
  const telemetryContext = contextWithCompletionCapture(opts.context, session.id, (payload) => {
    completion = payload;
  });
  let dispatchError: unknown;

  try {
    const dispatch = opts.dispatch ?? (await resolveDefaultWebSessionDispatcher());
    await dispatch(session, opts.prompt, engine, opts.context.getConfig(), telemetryContext);
  } catch (err) {
    dispatchError = err;
    throw err;
  } finally {
    try {
      runtime.releaseLease(opts.lease.leaseId, opts.lease.coordinatorId);
    } catch (err) {
      logger.warn(`Orchestration release failed for lease ${opts.lease.leaseId}: ${err instanceof Error ? err.message : err}`);
    }
    const completed = getSession(session.id);
    appendRunTelemetrySafely(buildRunTelemetry({
      lease: opts.lease,
      worker: opts.worker,
      workspace: opts.workspace,
      sessionId: session.id,
      model: completed?.model ?? opts.model ?? null,
      mode: opts.mode,
      source: "orchestration",
      status: completed?.status ?? "interrupted",
      error: completed?.lastError ?? completion?.error ?? dispatchError ?? null,
      completion,
      tokens: completed?.lastContextTokens ?? null,
    }));
  }

  const completed = getSession(session.id);
  return {
    sessionId: session.id,
    leaseId: opts.lease.leaseId,
    workerId: opts.worker.id,
    provider: opts.worker.provider,
    family: opts.worker.family,
    model: completed?.model ?? opts.model ?? null,
    role: opts.lease.role,
    status: completed?.status ?? "interrupted",
    error: completed?.lastError ?? null,
    cwd: opts.workspace.cwd,
    workspaceMode: opts.workspace.mode,
    worktreePath: "handle" in opts.workspace
      ? opts.workspace.handle.path
      : (opts.workspace.mode === "review_bundle" ? opts.workspace.worktreePath : undefined),
    reviewBundlePath: "bundle" in opts.workspace ? opts.workspace.bundle.path : undefined,
    reviewPolicy: opts.reviewPolicy,
  };
}

function contextWithCompletionCapture(
  context: ApiContext,
  sessionId: string,
  capture: (payload: CapturedCompletion) => void,
): ApiContext {
  return {
    ...context,
    emit: (event: string, payload: unknown) => {
      if (event === "session:completed" && payload && typeof payload === "object" && !Array.isArray(payload)) {
        const record = payload as Record<string, unknown>;
        if (record.sessionId === sessionId) {
          capture({
            cost: typeof record.cost === "number" ? record.cost : undefined,
            durationMs: typeof record.durationMs === "number" ? record.durationMs : undefined,
            error: record.error,
          });
        }
      }
      context.emit(event, payload);
    },
  };
}

function buildRunTelemetry(opts: {
  lease: Lease;
  worker: Worker;
  workspace: OrchestrationLeaseWorkspace;
  sessionId: string;
  model: string | null;
  mode: LiveRunMode;
  source: string;
  status: string;
  error: unknown;
  completion?: CapturedCompletion;
  tokens: number | null;
}): OrchestrationRunTelemetryRecord {
  const counts = workspaceTelemetryCounts(opts.workspace);
  return {
    task_id: opts.lease.taskId,
    coordinator_id: opts.lease.coordinatorId,
    session_id: opts.sessionId,
    lease_id: opts.lease.leaseId,
    worker_id: opts.worker.id,
    provider: opts.worker.provider,
    family: opts.worker.family,
    model: opts.model,
    role: opts.lease.role,
    mode: opts.mode,
    source: opts.source,
    cost: finiteNumber(opts.completion?.cost),
    latency_ms: finiteNumber(opts.completion?.durationMs),
    tokens: opts.tokens,
    files_changed: counts?.filesChanged ?? null,
    tests_added: counts?.testsAdded ?? null,
    tests_passed: null,
    review_blockers: null,
    human_edits: null,
    regressions: null,
    disposition: opts.status === "error" || opts.error ? "failed" : "completed",
    timestamp: new Date().toISOString(),
  };
}

function workspaceTelemetryCounts(workspace: OrchestrationLeaseWorkspace): { filesChanged: number; testsAdded: number } | null {
  if (workspace.mode !== "implementation_worktree") return null;
  try {
    return telemetryCountsFromDiff(diffWorktree(workspace.handle));
  } catch (err) {
    logger.warn(`Orchestration telemetry diff failed for task ${workspace.handle.taskId}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

function appendRunTelemetrySafely(record: OrchestrationRunTelemetryRecord): void {
  try {
    appendOrchestrationTelemetry(record, { fsync: false });
  } catch (err) {
    logger.warn(`Orchestration telemetry append failed for ${record.task_id}/${record.role}: ${err instanceof Error ? err.message : err}`);
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function prepareLeaseWorkspace(opts: {
  baseCwd: string;
  lease: Lease;
  role?: RoleDefinition;
  worker: Worker;
  worktrees: Map<string, WorktreeHandle>;
  reviewBundles: ReviewBundleHandle[];
  runtime: { getWorktreeOptions(): WorktreeOptions };
  implementationWorkspace?: ImplementationWorkspace;
}): OrchestrationLeaseWorkspace {
  if (isReviewerRole(opts.lease.role, opts.role)) {
    const source = opts.implementationWorkspace ?? { mode: "shared" as const, cwd: opts.baseCwd };
    const bundle = createReviewBundle({
      taskId: opts.lease.taskId,
      role: opts.lease.role,
      workerId: opts.worker.id,
      sourceCwd: source.cwd,
      sourceWorktree: "handle" in source ? source.handle : undefined,
    });
    opts.reviewBundles.push(bundle);
    return {
      mode: "review_bundle",
      cwd: bundle.path,
      bundle,
      worktreePath: "handle" in source ? source.handle.path : undefined,
    };
  }
  if (opts.worker.workspacePolicy !== "isolated_worktree") return { mode: "shared", cwd: opts.baseCwd };

  const lane = opts.lease.role;
  const existing = opts.worktrees.get(lane);
  if (existing) return { mode: "implementation_worktree", cwd: existing.path, handle: existing };

  const prepared = createImplementationWorktree({
    taskId: opts.lease.taskId,
    lane,
    baseCwd: opts.baseCwd,
    worktrees: opts.runtime.getWorktreeOptions(),
  });
  if (prepared.mode === "shared") {
    logger.warn(`Orchestration worktree downgraded for task ${opts.lease.taskId}: ${prepared.downgradeReason}`);
    return { mode: "shared", cwd: prepared.cwd, downgradeReason: prepared.downgradeReason };
  }
  opts.worktrees.set(lane, prepared.handle);
  return { mode: "implementation_worktree", cwd: prepared.cwd, handle: prepared.handle };
}

function buildContinuationRecord(
  existing: LiveRunContinuationRecord | undefined,
  task: LiveRunTaskPayload,
  mode: LiveRunMode,
): LiveRunContinuationRecord {
  const now = new Date().toISOString();
  return {
    taskId: task.taskId,
    coordinatorId: task.coordinatorId,
    mode,
    state: "queued",
    task,
    enqueuedAt: existing?.enqueuedAt ?? now,
    updatedAt: now,
    retryCount: existing?.retryCount ?? 0,
    lastDispatchedAt: existing?.lastDispatchedAt,
    allocationId: undefined,
    lastError: undefined,
  };
}

function normalizeTaskPayload(
  parsed: z.infer<typeof liveRunTaskSchema>,
  context: ApiContext,
): LiveRunTaskPayload {
  return {
    taskId: parsed.taskId,
    coordinatorId: parsed.coordinatorId,
    coordinatorTemplate: parsed.coordinatorTemplate,
    template: parsed.template,
    requiredRoles: parsed.requiredRoles,
    optionalRoles: parsed.optionalRoles,
    allowedWorkerIds: parsed.allowedWorkerIds,
    priority: parsed.priority,
    leaseDurationMs: parsed.leaseDurationMs ?? resolveLiveLeaseDurationMs(context.getConfig()),
    prompt: parsed.prompt,
    cwd: parsed.cwd,
    title: parsed.title,
    model: parsed.model,
    effortLevel: parsed.effortLevel,
    openaiRole: parsed.openaiRole,
    anthropicRole: parsed.anthropicRole,
  };
}

export function orchestrationSessionFailed(session: OrchestrationRunSession): boolean {
  return session.status === "error" || Boolean(session.error);
}

function releaseLeaseSafely(runtime: { listLeases(): Lease[]; releaseLease(leaseId: string, coordinatorId?: string): Lease }, lease: Lease): void {
  const current = runtime.listLeases().find((candidate) => candidate.leaseId === lease.leaseId);
  if (current && current.state !== "running") return;
  try {
    runtime.releaseLease(lease.leaseId, lease.coordinatorId);
  } catch (err) {
    logger.warn(`Orchestration release failed for lease ${lease.leaseId}: ${err instanceof Error ? err.message : err}`);
  }
}

function resolveWorkerEngine(context: ApiContext, worker: Worker): Engine | undefined {
  return context.ptyViewEngines?.[worker.provider] ?? context.sessionManager.getEngine(worker.provider);
}

function requireWorker(workers: Worker[], workerId: string): Worker {
  const worker = workers.find((candidate) => candidate.id === workerId);
  if (!worker) throw new Error(`allocated worker not found in runtime config: ${workerId}`);
  return worker;
}

function promptForRole(prompt: string, roleId: string, role: RoleDefinition | undefined): string {
  if (!isReviewerRole(roleId, role)) return prompt;
  return [
    "Review-only pass. Do not modify files.",
    "Your working directory is a generated review bundle, not the source repository.",
    "Inspect patch.diff and metadata.json, then report issues, risks, and missing validation.",
    "",
    prompt,
  ].join("\n");
}
