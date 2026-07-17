import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ApiContext } from "../gateway/api/context.js";
import { logger } from "../shared/logger.js";
import type { LiveRunContinuationRecord, LiveRunTaskPayload } from "./live-run.js";
import {
  type OrchestrationRunSession,
  type OrchestrationLeaseWorkspace,
  orchestrationSessionFailed,
  runOrchestrationLeaseTurn,
} from "./run-mode.js";
import {
  dualLaneArchiveDir,
  readDualLaneManifest,
  updateDualLaneManifest,
  writeDualLaneManifest,
  type DualLaneArchiveRecord,
  type DualLaneComparisonReport,
  type DualLaneManifestLane,
} from "./dual-lane-state.js";
import type { Allocation, AllocationRequest, QueueItem, ReviewPolicySummary, Worker } from "./types.js";
import {
  appendOrchestrationTelemetry,
  telemetryCountsFromDiff,
  type OrchestrationRunTelemetryRecord,
  type TelemetryDiffCounts,
} from "./telemetry.js";
import {
  cleanupWorktree,
  createImplementationWorktree,
  diffWorktree,
  resolveTaskBaseCwd,
  type WorktreeHandle,
} from "./worktree.js";
import { persistDualLaneArtifacts } from "./artifacts.js";
import {
  beginOrchestrationRun,
  createBlockedOrchestrationRun,
  finalizeOrchestrationRunCompleted,
  finalizeOrchestrationRunFailed,
} from "./run-ledger-integration.js";

const LANE_DEFS = [
  { id: "openai", family: "openai" },
  { id: "anthropic", family: "anthropic" },
] as const;

export type DualLaneId = typeof LANE_DEFS[number]["id"];

export type DualLaneRunResult =
  | {
    ok: false;
    state: "blocked_resource";
    mode: "dual_lane";
    queueItem: QueueItem;
    reviewPolicy: ReviewPolicySummary;
    lanes: DualLaneRunLane[];
  }
  | {
    ok: false;
    state: "failed";
    mode: "dual_lane";
    sessions: OrchestrationRunSession[];
    reviewPolicy: ReviewPolicySummary;
    errorSummary: string;
    lanes: DualLaneRunLane[];
  }
  | {
    ok: true;
    state: "selection_required";
    mode: "dual_lane";
    taskId: string;
    coordinatorId: string;
    sessions: OrchestrationRunSession[];
    reviewPolicy: ReviewPolicySummary;
    lanes: DualLaneRunLane[];
    comparisonReport: DualLaneComparisonReport;
    selection: { required: true; default: "human"; options: DualLaneId[] };
  };

export interface DualLaneRunLane {
  id: DualLaneId;
  family: "openai" | "anthropic";
  role: string;
  allocationId?: string;
  leaseId?: string;
  workerId?: string;
  session?: OrchestrationRunSession;
  worktree?: WorktreeHandle;
  worktreePath?: string;
  state: "prepared" | "allocated" | "completed" | "blocked" | "failed";
  error?: string;
}

export type DualLaneSelectionResult =
  | { ok: false; reason: "not_found" | "invalid_state" | "invalid_lane"; message: string }
  | {
    ok: true;
    state: "selected";
    taskId: string;
    selectedLane: DualLaneId;
    archivedLane: DualLaneId;
    winnerWorktreePath: string;
    archive: DualLaneArchiveRecord;
  };

export async function runDualLaneTask(opts: {
  context: ApiContext;
  task: LiveRunTaskPayload;
}): Promise<DualLaneRunResult> {
  const runtime = opts.context.orchestration?.runtime;
  if (!runtime) throw new Error("orchestration runtime is not enabled");
  const allocationResult = await runtime.requestAllocationWithLiveHeadroom(buildDualLaneAllocationRequest(opts.task));
  if (!allocationResult.ok) {
    const blockedRunId = createBlockedOrchestrationRun(opts.task.taskId, opts.task.coordinatorId, "dual_lane", opts.task.title);
    const continuationRecord = buildDualLaneContinuation(runtime.getLiveContinuation(opts.task.taskId, opts.task.coordinatorId), opts.task);
    continuationRecord.runId = blockedRunId;
    runtime.queueLiveContinuation(continuationRecord);
    return {
      ok: false,
      state: "blocked_resource",
      mode: "dual_lane",
      queueItem: allocationResult.queueItem,
      reviewPolicy: allocationResult.reviewPolicy,
      lanes: initialLanes(opts.task).map((lane) => ({ ...lane, state: "blocked" })),
    };
  }

  runtime.deleteLiveContinuation(opts.task.taskId, opts.task.coordinatorId);
  return runAllocatedDualLaneTask({
    context: opts.context,
    task: opts.task,
    allocation: allocationResult.allocation,
    reviewPolicy: allocationResult.reviewPolicy,
  });
}

export async function runAllocatedDualLaneTask(opts: {
  context: ApiContext;
  task: LiveRunTaskPayload;
  allocation: Allocation;
  reviewPolicy: ReviewPolicySummary;
}): Promise<DualLaneRunResult> {
  const runtime = opts.context.orchestration?.runtime;
  if (!runtime) throw new Error("orchestration runtime is not enabled");

  const baseCwd = resolveTaskBaseCwd(opts.task.cwd, opts.context.getConfig());
  const lanes = initialLanes(opts.task);
  const sessions: OrchestrationRunSession[] = [];

  // DAT-BUS-002: the run-ledger's `engine` column stays the literal "orchestration"
  // marker (consumers such as run-recovery.ts and sweepOrphanedOrchestrationRuns
  // filter on that exact value), but the real worker/provider identity for each
  // lane is resolvable from the allocation's leases up front. Thread it through
  // as a distinct providerEngine field on the run's initial transition payload
  // so provenance for this orchestration run isn't lost.
  const providerEngine = resolveDualLaneProviderEngine(runtime, opts.allocation, lanes);
  const runId = beginOrchestrationRun(opts.allocation, "dual_lane", opts.task.title, undefined, providerEngine);
  opts.allocation.runId = runId;

  try {
    for (const lane of lanes) {
      const prepared = createImplementationWorktree({
        taskId: opts.task.taskId,
        lane: lane.id,
        baseCwd,
        worktrees: runtime.getWorktreeOptions(),
      });
      if (prepared.mode !== "implementation_worktree") {
        throw new Error(`dual_lane requires git worktrees; ${lane.id} lane downgraded: ${prepared.downgradeReason}`);
      }
      lane.state = "prepared";
      lane.worktree = prepared.handle;
      lane.worktreePath = prepared.handle.path;
    }

    // CAS-CF-002: lanes are attempted independently — a session-level failure
    // in one lane must not deny the other lane its own attempt. Continue past
    // a failed lane so a partial result is still produced for both, and only
    // fail the overall run once every lane has had its turn.
    let firstFailure: { lane: DualLaneRunLane; errorSummary: string } | undefined;
    for (const lane of lanes) {
      const lease = opts.allocation.leases.find((candidate) => candidate.role === lane.role);
      if (!lease) throw new Error(`dual_lane allocation ${opts.allocation.allocationId} did not produce a lease for role ${lane.role}`);
      lane.allocationId = opts.allocation.allocationId;
      lane.leaseId = lease.leaseId;
      lane.workerId = lease.workerId;
      lane.state = "allocated";

      const worker = requireWorker(runtime.listWorkers(), lease.workerId);
      const workspace: OrchestrationLeaseWorkspace = {
        mode: "implementation_worktree",
        cwd: lane.worktreePath ?? lane.worktree?.path ?? baseCwd,
        handle: requireLaneWorktree(lane),
      };
      const session = await runOrchestrationLeaseTurn({
        context: opts.context,
        mode: "dual_lane",
        lease,
        worker,
        workspace,
        prompt: opts.task.prompt,
        title: opts.task.title ?? `${opts.task.taskId} ${lane.id} lane`,
        model: opts.task.model,
        effortLevel: opts.task.effortLevel,
      });
      lane.session = session;
      lane.state = orchestrationSessionFailed(session) ? "failed" : "completed";
      sessions.push(session);
      if (orchestrationSessionFailed(session)) {
        lane.error = session.error ?? session.status;
        if (!firstFailure) {
          firstFailure = { lane, errorSummary: `${lane.id} lane failed: ${lane.error}` };
        }
      }
    }

    if (firstFailure) {
      finalizeOrchestrationRunFailed(runId, firstFailure.errorSummary);
      const failed: DualLaneRunResult = {
        ok: false,
        state: "failed",
        mode: "dual_lane",
        sessions,
        reviewPolicy: opts.reviewPolicy,
        errorSummary: firstFailure.errorSummary,
        lanes: lanes.map(stripLaneWorktreeHandle),
      };
      releaseRunningAllocationLeases(runtime, opts.allocation);
      cleanupPreparedLanes(lanes);
      return failed;
    }

    const report = buildComparisonReport(opts.task.taskId, lanes);
    const manifestLanes = lanes.map(toManifestLane);
    writeDualLaneManifest({
      taskId: opts.task.taskId,
      coordinatorId: opts.task.coordinatorId,
      state: "selection_required",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      baseCwd,
      promptHash: hashPrompt(opts.task.prompt),
      lanes: manifestLanes,
      comparisonReport: report,
    });
    persistDualLaneArtifacts({
      taskId: opts.task.taskId,
      coordinatorId: opts.task.coordinatorId,
      prompt: opts.task.prompt,
      lanes: manifestLanes,
      store: runtime.getStore(),
    });

    finalizeOrchestrationRunCompleted(runId);
    return {
      ok: true,
      state: "selection_required",
      mode: "dual_lane",
      taskId: opts.task.taskId,
      coordinatorId: opts.task.coordinatorId,
      sessions,
      reviewPolicy: opts.reviewPolicy,
      lanes: lanes.map(stripLaneWorktreeHandle),
      comparisonReport: report,
      selection: { required: true, default: "human", options: ["openai", "anthropic"] },
    };
  } catch (err) {
    finalizeOrchestrationRunFailed(runId, err instanceof Error ? err.message : String(err));
    releaseRunningAllocationLeases(runtime, opts.allocation);
    // CAS-CF-001: this catch also covers unrelated downstream I/O failures that
    // happen AFTER both lanes have already completed (e.g. writing the manifest
    // or persisting artifacts). Destroying a completed lane's worktree here would
    // discard real, already-produced work over a failure that has nothing to do
    // with the lane itself. Only clean up lanes that never finished; leave
    // completed lanes' worktrees in place so their results remain recoverable
    // (and the write can be retried) rather than being unrecoverably lost.
    cleanupPreparedLanes(lanes, { skipCompleted: true });
    throw err;
  }
}

export function selectDualLaneWinner(opts: {
  taskId: string;
  coordinatorId: string;
  winnerLane: string;
}): DualLaneSelectionResult {
  const winnerLane = parseLane(opts.winnerLane);
  if (!winnerLane) {
    return { ok: false, reason: "invalid_lane", message: `invalid dual-lane winner: ${opts.winnerLane}` };
  }
  const manifest = readDualLaneManifest(opts.taskId, opts.coordinatorId);
  if (!manifest) {
    return { ok: false, reason: "not_found", message: `no dual-lane run found for task ${opts.taskId}` };
  }
  if (manifest.state !== "selection_required") {
    return {
      ok: false,
      reason: "invalid_state",
      message: `dual-lane run ${opts.taskId} is ${manifest.state}; selection requires selection_required`,
    };
  }
  const winner = manifest.lanes.find((lane) => lane.id === winnerLane);
  const loser = manifest.lanes.find((lane) => lane.id !== winnerLane);
  if (!winner || !loser) {
    return { ok: false, reason: "invalid_lane", message: `dual-lane run ${opts.taskId} does not contain winner ${winnerLane}` };
  }

  const winnerCounts = laneTelemetryCounts(winner);
  const loserCounts = laneTelemetryCounts(loser);
  const archive = archiveLane(manifest.taskId, manifest.coordinatorId, loser);
  cleanupWorktree(loser.worktree);
  loser.archive = archive;
  const updated = updateDualLaneManifest({
    ...manifest,
    state: "selected",
    selectedLane: winner.id,
    archivedLane: loser.id,
    lanes: manifest.lanes.map((lane) => lane.id === loser.id ? loser : lane),
  });
  appendDualLaneSelectionTelemetrySafely(updated, winner, loser, winnerCounts, loserCounts);

  return {
    ok: true,
    state: "selected",
    taskId: updated.taskId,
    selectedLane: winner.id,
    archivedLane: loser.id,
    winnerWorktreePath: winner.worktree.path,
    archive,
  };
}

function laneTelemetryCounts(lane: DualLaneManifestLane): TelemetryDiffCounts | null {
  try {
    return telemetryCountsFromDiff(diffWorktree(lane.worktree));
  } catch (err) {
    logger.warn(`Dual-lane telemetry diff failed for ${lane.id} lane ${lane.workerId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function appendDualLaneSelectionTelemetrySafely(
  manifest: ReturnType<typeof updateDualLaneManifest>,
  winner: DualLaneManifestLane,
  loser: DualLaneManifestLane,
  winnerCounts: TelemetryDiffCounts | null,
  loserCounts: TelemetryDiffCounts | null,
): void {
  const timestamp = manifest.updatedAt;
  const records: OrchestrationRunTelemetryRecord[] = [
    selectionTelemetryRecord(manifest, winner, "selected", winnerCounts, timestamp),
    selectionTelemetryRecord(manifest, loser, "discarded", loserCounts, timestamp),
  ];
  for (const record of records) {
    try {
      appendOrchestrationTelemetry(record, { fsync: false });
    } catch (err) {
      logger.warn(`Dual-lane telemetry append failed for ${record.task_id}/${record.worker_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function selectionTelemetryRecord(
  manifest: ReturnType<typeof updateDualLaneManifest>,
  lane: DualLaneManifestLane,
  disposition: "selected" | "discarded",
  counts: TelemetryDiffCounts | null,
  timestamp: string,
): OrchestrationRunTelemetryRecord {
  return {
    task_id: manifest.taskId,
    coordinator_id: manifest.coordinatorId,
    session_id: lane.session.sessionId,
    lease_id: lane.leaseId,
    worker_id: lane.workerId,
    provider: lane.session.provider,
    family: lane.family,
    model: lane.session.model,
    role: lane.role,
    mode: "dual_lane",
    source: "orchestration",
    cost: null,
    latency_ms: null,
    tokens: null,
    files_changed: counts?.filesChanged ?? null,
    tests_added: counts?.testsAdded ?? null,
    tests_passed: null,
    review_blockers: null,
    human_edits: null,
    regressions: null,
    disposition,
    timestamp,
  };
}

function buildComparisonReport(taskId: string, lanes: DualLaneRunLane[]): DualLaneComparisonReport {
  const generatedAt = new Date().toISOString();
  const summaries = lanes.map((lane) => {
    const diff = diffWorktree(requireLaneWorktree(lane));
    const changedFiles = changedFilesFromDiff(diff);
    return {
      laneId: lane.id,
      changedFiles,
      addedLines: countLines(diff, "+"),
      removedLines: countLines(diff, "-"),
      status: lane.session?.status ?? lane.state,
      error: lane.session?.error ?? lane.error ?? null,
    };
  });
  const openaiFiles = new Set(summaries.find((lane) => lane.laneId === "openai")?.changedFiles ?? []);
  const anthropicFiles = new Set(summaries.find((lane) => lane.laneId === "anthropic")?.changedFiles ?? []);
  const commonFiles = [...openaiFiles].filter((file) => anthropicFiles.has(file)).sort();
  const uniqueFiles = {
    openai: [...openaiFiles].filter((file) => !anthropicFiles.has(file)).sort(),
    anthropic: [...anthropicFiles].filter((file) => !openaiFiles.has(file)).sort(),
  };
  const majorDifferences = [
    uniqueFiles.openai.length > 0 ? `OpenAI-only files: ${uniqueFiles.openai.join(", ")}` : "",
    uniqueFiles.anthropic.length > 0 ? `Anthropic-only files: ${uniqueFiles.anthropic.join(", ")}` : "",
    commonFiles.length > 0 ? `Common files changed: ${commonFiles.join(", ")}` : "",
  ].filter(Boolean);
  if (majorDifferences.length === 0) {
    majorDifferences.push("Both lanes changed the same file set.");
  }
  return {
    taskId,
    generatedAt,
    laneSummaries: summaries,
    commonFiles,
    uniqueFiles,
    majorDifferences,
  };
}

function archiveLane(taskId: string, coordinatorId: string, lane: DualLaneManifestLane): DualLaneArchiveRecord {
  const archiveRoot = dualLaneArchiveDir(taskId, coordinatorId);
  fs.mkdirSync(archiveRoot, { recursive: true });
  const archivedAt = new Date().toISOString();
  const diffPath = path.join(archiveRoot, `${lane.id}.patch.diff`);
  const metadataPath = path.join(archiveRoot, `${lane.id}.metadata.json`);
  fs.writeFileSync(diffPath, diffWorktree(lane.worktree));
  fs.writeFileSync(metadataPath, `${JSON.stringify({
    taskId,
    coordinatorId,
    archivedAt,
    lane: lane.id,
    role: lane.role,
    workerId: lane.workerId,
    sessionId: lane.session.sessionId,
    worktreePath: lane.worktree.path,
  }, null, 2)}\n`);
  return { diffPath, metadataPath, archivedAt };
}

function changedFilesFromDiff(diff: string): string[] {
  const files = new Set<string>();
  let inUntracked = false;
  for (const line of diff.split(/\r?\n/)) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match?.[2]) files.add(match[2]);
    if (line === "Untracked files:") {
      inUntracked = true;
      continue;
    }
    if (inUntracked && line.startsWith("  ") && line.trim()) files.add(line.trim());
  }
  return [...files].sort();
}

function countLines(diff: string, prefix: "+" | "-"): number {
  return diff.split(/\r?\n/)
    .filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`))
    .length;
}

function toManifestLane(lane: DualLaneRunLane): DualLaneManifestLane {
  const worktree = requireLaneWorktree(lane);
  if (!lane.workerId || !lane.leaseId || !lane.session) throw new Error(`dual-lane ${lane.id} did not complete`);
  return {
    id: lane.id,
    family: lane.family,
    role: lane.role,
    workerId: lane.workerId,
    leaseId: lane.leaseId,
    session: lane.session,
    worktree,
  };
}

function requireLaneWorktree(lane: Pick<DualLaneRunLane, "id" | "worktree">): WorktreeHandle {
  if (!lane.worktree) throw new Error(`dual-lane ${lane.id} worktree is missing`);
  return lane.worktree;
}

function stripLaneWorktreeHandle(lane: DualLaneRunLane): DualLaneRunLane {
  return {
    ...lane,
    worktreePath: lane.worktreePath ?? lane.worktree?.path,
    worktree: undefined,
  };
}

function cleanupPreparedLanes(lanes: DualLaneRunLane[], opts: { skipCompleted?: boolean } = {}): void {
  for (const lane of lanes) {
    if (!lane.worktree) continue;
    // CAS-CF-001: a "completed" lane already produced real work. Callers that
    // hit an unrelated failure after both lanes finished pass skipCompleted so
    // that work isn't destroyed alongside genuinely unfinished lanes.
    if (opts.skipCompleted && lane.state === "completed") continue;
    try {
      cleanupWorktree(lane.worktree);
    } catch (err) {
      logger.warn(`Dual-lane cleanup failed for ${lane.id} worktree ${lane.worktree.path}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

function resolveDualLaneProviderEngine(
  runtime: { listWorkers(): Worker[] },
  allocation: Allocation,
  lanes: DualLaneRunLane[],
): string | undefined {
  const workers = runtime.listWorkers();
  const parts: string[] = [];
  for (const lane of lanes) {
    const lease = allocation.leases.find((candidate) => candidate.role === lane.role);
    const worker = lease ? workers.find((candidate) => candidate.id === lease.workerId) : undefined;
    if (worker) parts.push(`${lane.id}:${worker.provider}`);
  }
  return parts.length > 0 ? parts.join(",") : undefined;
}

function releaseRunningAllocationLeases(
  runtime: { listLeases(): Array<{ leaseId: string; state: string }>; releaseLease(leaseId: string, coordinatorId?: string): unknown },
  allocation: Allocation,
): void {
  const runningLeaseIds = new Set(runtime.listLeases()
    .filter((lease) => lease.state === "running")
    .map((lease) => lease.leaseId));
  for (const lease of allocation.leases) {
    if (!runningLeaseIds.has(lease.leaseId)) continue;
    try {
      runtime.releaseLease(lease.leaseId, lease.coordinatorId);
    } catch (err) {
      logger.warn(`Dual-lane lease cleanup failed for ${lease.leaseId}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

function parseLane(value: string): DualLaneId | null {
  return value === "openai" || value === "anthropic" ? value : null;
}

function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

function requireWorker(workers: Worker[], workerId: string): Worker {
  const worker = workers.find((candidate) => candidate.id === workerId);
  if (!worker) throw new Error(`allocated worker not found in runtime config: ${workerId}`);
  return worker;
}

export function buildDualLaneAllocationRequest(task: LiveRunTaskPayload): AllocationRequest {
  return {
    taskId: task.taskId,
    coordinatorId: task.coordinatorId,
    requiredRoles: [task.openaiRole ?? "openaiImplementer", task.anthropicRole ?? "anthropicImplementer"],
    optionalRoles: [],
    allowedWorkerIds: task.allowedWorkerIds,
    priority: task.priority,
    leaseDurationMs: task.leaseDurationMs,
  };
}

function initialLanes(task: LiveRunTaskPayload): DualLaneRunLane[] {
  const laneRoles = {
    openai: task.openaiRole ?? "openaiImplementer",
    anthropic: task.anthropicRole ?? "anthropicImplementer",
  };
  return LANE_DEFS.map((lane) => ({
    id: lane.id,
    family: lane.family,
    role: laneRoles[lane.id],
    state: "prepared",
  }));
}

function buildDualLaneContinuation(
  existing: LiveRunContinuationRecord | undefined,
  task: LiveRunTaskPayload,
): LiveRunContinuationRecord {
  const now = new Date().toISOString();
  return {
    taskId: task.taskId,
    coordinatorId: task.coordinatorId,
    mode: "dual_lane",
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
