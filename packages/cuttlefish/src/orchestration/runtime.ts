import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ORCH_CONFIG_DIR, ORCH_DB, ORCH_RECOVERY_DIR, ORCH_WORKTREE_ROOT } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import type { CuttlefishConfig } from "../shared/types.js";
import { loadOrchestrationConfig } from "./config.js";
import { appendOrchestrationAudit } from "./audit.js";
import { buildCoordinatorTaskBrief, type CoordinatorMode } from "./coordinator.js";
import { resolveCrossFamilyReviewPolicy, type CrossFamilyReviewPolicy } from "./cross-family.js";
import { listProtectedDualLaneTaskIds } from "./dual-lane-state.js";
import type { LiveRunContinuationRecord } from "./live-run.js";
import { PersistentMatrixScheduler } from "./persistent-scheduler.js";
import { queueTaskKey } from "./scheduler.js";
import { filterWorkersWithHeadroom, type HeadroomFilterResult } from "./routing-headroom.js";
import { OrchestrationStore, type HoldRecord, type QueuePauseState, type TaskPauseRecord } from "./store.js";
import { DEFAULT_MAX_LIVE_CONTINUATION_RETRIES } from "./store-continuations.js";
import { pruneRecoveryNotices } from "./store-recovery.js";
import { computeWorkerScores, pruneOrchestrationTelemetry, readOrchestrationTelemetry } from "./telemetry.js";
import {
  DEFAULT_LEASE_DURATION_MS,
  type Allocation,
  type AllocationRequest,
  type AllocationResult,
  type Lease,
  type LeaseValidationResult,
  type OrchestrationConfig,
  type QueueItem,
  type ReviewPolicySummary,
} from "./types.js";
import { DEFAULT_MAX_WORKTREES, reapExpiredReviewBundles, reapOrphanedWorktrees, type WorktreeHandle, type WorktreeOptions } from "./worktree.js";
import { interruptOrchestrationRun, recoverOrchestrationRun, sweepOrphanedOrchestrationRuns } from "./run-ledger-integration.js";

// Reaper ticks are a backstop: lease expiry is also forced on demand at
// schedule time, and worktree/telemetry pruning only has to catch strays.
// 30s keeps the daemon quiet at idle (each tick costs directory scans plus a
// SQLite write) without letting garbage linger meaningfully longer.
const DEFAULT_REAPER_INTERVAL_MS = 30_000;
const DEFAULT_STALE_DISPATCHING_CONTINUATION_MS = 10 * 60 * 1_000;
const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;
const EMPIRICAL_ROUTING_MAX_BYTES = 1_000_000;
const EMPIRICAL_ROUTING_MAX_RECORDS = 5_000;
// Bounds the `git rev-parse HEAD` calls used for enqueue/dispatch HEAD-drift
// detection so a wedged git process can never hang enqueue or dispatch.
const GIT_HEAD_SHA_TIMEOUT_MS = 5_000;

type HeadroomFilter = (workers: OrchestrationConfig["workers"], config: CuttlefishConfig) => Promise<HeadroomFilterResult>;
export interface ExpiredLeaseHandlingResult {
  leaseId: string;
  sessionId: string | null;
  status: "interrupted" | "unmapped" | "not_running" | "not_interruptible";
  interruptible: boolean;
}

type ExpiredLeaseHandler = (leases: Lease[]) => ExpiredLeaseHandlingResult[] | void;

export interface OrchestrationRuntimeOptions {
  config?: OrchestrationConfig;
  configDir?: string;
  dbPath?: string;
  now?: () => Date;
  reaperIntervalMs?: number;
  startReaper?: boolean;
  worktreeRoot?: string;
  maxWorktrees?: number;
  reviewPolicy?: Partial<CrossFamilyReviewPolicy>;
  workerScores?: Record<string, number>;
  cuttlefishConfig?: CuttlefishConfig;
  headroomFilter?: HeadroomFilter;
  staleDispatchingContinuationMs?: number;
  onLeasesExpired?: ExpiredLeaseHandler;
}

export interface ResumeQueuedRun {
  continuation: LiveRunContinuationRecord;
  allocation: Allocation;
  reviewPolicy: ReviewPolicySummary;
}

export type RetryLiveContinuationResult =
  | { ok: false; reason: "not_found" | "invalid_state"; message: string }
  | { ok: true; state: "paused"; continuation: LiveRunContinuationRecord; controlState: QueuePauseState }
  | {
    ok: true;
    state: "blocked_resource";
    continuation: LiveRunContinuationRecord;
    queueItem: QueueItem;
    reviewPolicy: ReviewPolicySummary;
  }
  | {
    ok: true;
    state: "dispatching";
    continuation: LiveRunContinuationRecord;
    allocation: Allocation;
    reviewPolicy: ReviewPolicySummary;
  };

export interface HoldCreateInput {
  managerName: string;
  roles?: string[];
  workerIds?: string[];
  taskId?: string;
  coordinatorId?: string;
  reason?: string;
  ttlMs: number;
}

type ResumeQueuedRunHandler = (run: ResumeQueuedRun) => Promise<void>;

export class OrchestrationRuntime {
  readonly config: OrchestrationConfig;
  readonly dbPath: string;
  private readonly store: OrchestrationStore;
  private readonly scheduler: PersistentMatrixScheduler;
  private readonly recoveryDir: string;
  private readonly reaperIntervalMs: number;
  private readonly worktrees: WorktreeOptions;
  private readonly cuttlefishConfig?: CuttlefishConfig;
  private readonly headroomFilter: HeadroomFilter;
  private readonly staleDispatchingContinuationMs: number;
  private expiredLeaseHandler?: ExpiredLeaseHandler;
  private lastExpiredLeaseHandling: ExpiredLeaseHandlingResult[] = [];
  private readonly resumeDispatches = new Set<Promise<void>>();
  private resumeQueuedRunHandler?: ResumeQueuedRunHandler;
  private reaper: ReturnType<typeof setInterval> | null = null;
  private closing = false;

  constructor(opts: OrchestrationRuntimeOptions) {
    this.config = opts.config ?? loadOrchestrationConfig(opts.configDir ?? ORCH_CONFIG_DIR);
    this.dbPath = opts.dbPath ?? ORCH_DB;
    this.recoveryDir = resolveRecoveryDir(this.dbPath);
    this.store = OrchestrationStore.open(this.dbPath);
    this.scheduler = PersistentMatrixScheduler.open(this.config, {
      store: this.store,
      now: opts.now,
      reviewPolicy: opts.reviewPolicy,
      workerScores: opts.workerScores,
    });
    this.reaperIntervalMs = Math.max(1, Math.floor(opts.reaperIntervalMs ?? DEFAULT_REAPER_INTERVAL_MS));
    this.cuttlefishConfig = opts.cuttlefishConfig;
    this.headroomFilter = opts.headroomFilter ?? filterWorkersWithHeadroom;
    this.staleDispatchingContinuationMs = Math.max(
      0,
      Math.floor(opts.staleDispatchingContinuationMs ?? DEFAULT_STALE_DISPATCHING_CONTINUATION_MS),
    );
    this.expiredLeaseHandler = opts.onLeasesExpired;
    this.worktrees = {
      root: opts.worktreeRoot ?? ORCH_WORKTREE_ROOT,
      maxWorktrees: typeof opts.maxWorktrees === "number" && Number.isFinite(opts.maxWorktrees) && opts.maxWorktrees > 0
        ? Math.floor(opts.maxWorktrees)
        : DEFAULT_MAX_WORKTREES,
    };
    this.pruneRetainedFiles();
    this.recoverStaleDispatchingContinuations();
    if (opts.startReaper !== false) this.startReaper();
  }

  setResumeQueuedRunHandler(handler: ResumeQueuedRunHandler | undefined): void {
    this.resumeQueuedRunHandler = handler;
    if (handler && !this.closing && !this.getControlState().queuePaused) void this.retryQueuedWithLiveHeadroom();
  }

  requestAllocation(request: AllocationRequest): AllocationResult {
    return this.scheduler.requestAllocation(request);
  }

  async requestAllocationWithLiveHeadroom(request: AllocationRequest): Promise<AllocationResult> {
    return this.scheduler.requestAllocation(request, {
      allowedWorkerIds: await this.resolveLiveHeadroomWorkerIds(),
    });
  }

  tryAllocationNow(request: AllocationRequest): AllocationResult {
    return this.scheduler.tryAllocationNow(request);
  }

  async tryAllocationNowWithLiveHeadroom(request: AllocationRequest): Promise<AllocationResult> {
    return this.scheduler.tryAllocationNow(request, {
      allowedWorkerIds: await this.resolveLiveHeadroomWorkerIds(),
    });
  }

  heartbeatLease(leaseId: string, coordinatorId?: string): Lease {
    return this.scheduler.heartbeatLease(leaseId, coordinatorId);
  }

  releaseLease(leaseId: string, coordinatorId?: string): Lease {
    const lease = this.scheduler.releaseLease(leaseId, coordinatorId);
    if (!this.getControlState().queuePaused) void this.retryQueuedWithLiveHeadroom();
    return lease;
  }

  expireLeases(now?: Date): Lease[] {
    const expired = this.scheduler.expireLeases(now);
    if (expired.length > 0) this.handleExpiredLeases(expired);
    if (expired.length > 0 && !this.getControlState().queuePaused) void this.retryQueuedWithLiveHeadroom();
    return expired;
  }

  setExpiredLeaseHandler(handler: ExpiredLeaseHandler | undefined): void {
    this.expiredLeaseHandler = handler;
  }

  listExpiredLeaseHandling(): ExpiredLeaseHandlingResult[] {
    return this.lastExpiredLeaseHandling.map((entry) => ({ ...entry }));
  }

  retryQueued(): AllocationResult[] {
    if (this.getControlState().queuePaused) return [];
    const results = this.scheduler.retryQueued({
      skipQueuedTaskKeys: this.pausedTaskKeys(),
    });
    this.dispatchRetryResults(results);
    return results;
  }

  async retryQueuedWithLiveHeadroom(): Promise<AllocationResult[]> {
    if (this.closing) return [];
    if (this.getControlState().queuePaused) return [];
    const allowedWorkerIds = await this.resolveLiveHeadroomWorkerIds();
    if (this.closing) return [];
    if (this.getControlState().queuePaused) return [];
    const results = this.scheduler.retryQueued({
      allowedWorkerIds,
      skipQueuedTaskKeys: this.pausedTaskKeys(),
    });
    this.dispatchRetryResults(results);
    return results;
  }

  validateLeaseForWorker(workerId: string, leaseId: string, taskId: string, coordinatorId: string): LeaseValidationResult {
    return this.scheduler.validateLeaseForWorker(workerId, leaseId, taskId, coordinatorId);
  }

  queueLiveContinuation(record: LiveRunContinuationRecord): void {
    // Capture the enqueue-time HEAD SHA once, if not already set by the
    // caller. This snapshot is never re-derived or refreshed afterward; see
    // resumeQueuedAllocation for the stale-HEAD detection that compares
    // against it at dispatch time.
    if (record.task.cwd && record.task.enqueueHeadSha === undefined) {
      record.task.enqueueHeadSha = resolveGitHeadSha(record.task.cwd);
    }
    this.store.upsertLiveContinuation(record);
    if (record.runId) {
      this.store.stampContinuationRunId(record.taskId, record.coordinatorId, record.runId);
    }
  }

  getLiveContinuation(taskId: string, coordinatorId: string): LiveRunContinuationRecord | undefined {
    return this.store.getLiveContinuation(taskId, coordinatorId);
  }

  deleteLiveContinuation(taskId: string, coordinatorId: string): void {
    this.store.deleteLiveContinuation(taskId, coordinatorId);
  }

  markLiveContinuationCompleted(taskId: string, coordinatorId: string, allocationId?: string): void {
    this.store.markLiveContinuationState(taskId, coordinatorId, "completed", { allocationId: allocationId ?? null });
  }

  markLiveContinuationFailed(taskId: string, coordinatorId: string, error: string, allocationId?: string): void {
    this.store.markLiveContinuationState(taskId, coordinatorId, "failed", {
      allocationId: allocationId ?? null,
      lastError: error,
    });
  }

  listWorkers() {
    return this.config.workers.map((worker) => ({ ...worker }));
  }

  listLeases() {
    return this.scheduler.listLeases();
  }

  listQueue() {
    return this.scheduler.listQueue();
  }

  listAllocations() {
    return this.scheduler.listAllocations();
  }

  listLiveContinuations() {
    return this.store.listLiveContinuations();
  }

  getControlState(): QueuePauseState {
    return this.store.getQueuePauseState();
  }

  listTaskPauses(): TaskPauseRecord[] {
    return this.store.listTaskPauses();
  }

  pauseQueue(reason?: string): QueuePauseState {
    const state = {
      queuePaused: true,
      pausedAt: new Date().toISOString(),
      pauseReason: sanitizePauseReason(reason),
    };
    this.store.setQueuePauseState(state);
    appendOrchestrationAudit("orchestration.queue.pause", state, this.dbPath);
    return state;
  }

  async resumeQueue(): Promise<{ controlState: QueuePauseState; retryResults: AllocationResult[] }> {
    const controlState = { queuePaused: false, pausedAt: null, pauseReason: null };
    this.store.setQueuePauseState(controlState);
    appendOrchestrationAudit("orchestration.queue.resume", controlState, this.dbPath);
    const retryResults = await this.retryQueuedWithLiveHeadroom();
    return { controlState, retryResults };
  }

  pauseTask(taskId: string, coordinatorId: string, opts: { reason?: string; managerName?: string } = {}): TaskPauseRecord {
    const record: TaskPauseRecord = {
      taskId,
      coordinatorId,
      pausedAt: new Date().toISOString(),
      pauseReason: sanitizePauseReason(opts.reason),
      managerName: sanitizeOptional(opts.managerName),
    };
    this.store.setTaskPause(record);
    appendOrchestrationAudit("orchestration.queue.pause_task", record, this.dbPath);
    return record;
  }

  async resumeTask(taskId: string, coordinatorId: string): Promise<{ paused: boolean; retryResults: AllocationResult[] }> {
    const paused = this.store.deleteTaskPause(taskId, coordinatorId);
    appendOrchestrationAudit("orchestration.queue.resume_task", { taskId, coordinatorId, paused }, this.dbPath);
    if (this.getControlState().queuePaused) return { paused, retryResults: [] };
    const allowedWorkerIds = await this.resolveLiveHeadroomWorkerIds();
    const results = this.scheduler.retryQueued({
      allowedWorkerIds,
      skipQueuedTaskKeys: this.pausedTaskKeys(),
      onlyQueuedTaskKeys: [queueTaskKey(taskId, coordinatorId)],
    });
    this.dispatchRetryResults(results);
    return { paused, retryResults: results };
  }

  listHolds(opts: { includeInactive?: boolean } = {}): HoldRecord[] {
    this.store.expireHolds();
    return this.store.listHolds(opts);
  }

  createHold(input: HoldCreateInput): HoldRecord {
    const now = new Date();
    const ttlMs = Math.max(1, Math.floor(input.ttlMs));
    const record: HoldRecord = {
      holdId: `hold_${randomUUID()}`,
      managerName: input.managerName,
      state: "active",
      roles: uniqueNonEmpty(input.roles ?? []),
      workerIds: uniqueNonEmpty(input.workerIds ?? []),
      taskId: sanitizeOptional(input.taskId),
      coordinatorId: sanitizeOptional(input.coordinatorId),
      reason: sanitizePauseReason(input.reason),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    this.store.upsertHold(record);
    appendOrchestrationAudit("orchestration.hold.create", record, this.dbPath);
    return record;
  }

  extendHold(holdId: string, ttlMs: number): HoldRecord | undefined {
    this.store.expireHolds();
    const current = this.store.getHold(holdId);
    if (!current || current.state !== "active") return current;
    const now = new Date();
    const updated = {
      ...current,
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + Math.max(1, Math.floor(ttlMs))).toISOString(),
    };
    this.store.upsertHold(updated);
    appendOrchestrationAudit("orchestration.hold.extend", updated, this.dbPath);
    return updated;
  }

  cancelHold(holdId: string): HoldRecord | undefined {
    const hold = this.store.cancelHold(holdId);
    appendOrchestrationAudit("orchestration.hold.cancel", { holdId, state: hold?.state ?? "not_found" }, this.dbPath);
    return hold;
  }

  async retryFailedLiveContinuation(taskId: string, coordinatorId: string): Promise<RetryLiveContinuationResult> {
    const current = this.store.getLiveContinuation(taskId, coordinatorId);
    if (!current) {
      return {
        ok: false,
        reason: "not_found",
        message: `no live continuation found for ${taskId}/${coordinatorId}`,
      };
    }
    if (current.state !== "failed") {
      return {
        ok: false,
        reason: "invalid_state",
        message: `live continuation ${taskId}/${coordinatorId} is ${current.state}; only failed continuations can be retried manually`,
      };
    }
    if (current.retryCount >= DEFAULT_MAX_LIVE_CONTINUATION_RETRIES) {
      return {
        ok: false,
        reason: "invalid_state",
        message: `live continuation ${taskId}/${coordinatorId} reached retry limit (${current.retryCount})`,
      };
    }

    const queued = this.store.markLiveContinuationState(taskId, coordinatorId, "queued", {
      allocationId: null,
      lastError: null,
    });
    if (!queued) {
      return {
        ok: false,
        reason: "not_found",
        message: `live continuation ${taskId}/${coordinatorId} disappeared before retry`,
      };
    }
    if (this.getControlState().queuePaused) {
      return { ok: true, state: "paused", continuation: queued, controlState: this.getControlState() };
    }

    const result = this.scheduler.requestAllocation(buildContinuationRequest(queued, this.config), {
      allowedWorkerIds: await this.resolveLiveHeadroomWorkerIds(),
    });
    if (!result.ok) {
      const blocked = this.store.getLiveContinuation(taskId, coordinatorId) ?? queued;
      return {
        ok: true,
        state: "blocked_resource",
        continuation: blocked,
        queueItem: result.queueItem,
        reviewPolicy: result.reviewPolicy,
      };
    }

    this.dispatchRetryResults([result]);
    return {
      ok: true,
      state: "dispatching",
      continuation: this.store.getLiveContinuation(taskId, coordinatorId) ?? queued,
      allocation: result.allocation,
      reviewPolicy: result.reviewPolicy,
    };
  }

  hasActiveWork(): boolean {
    return this.scheduler.listLeases().some((lease) => lease.state === "running")
      || this.scheduler.listQueue().length > 0
      || this.store.listLiveContinuations(["queued", "dispatching"]).length > 0
      || this.resumeDispatches.size > 0;
  }

  getWorktreeOptions(): WorktreeOptions {
    return { ...this.worktrees };
  }

  getStore(): OrchestrationStore {
    return this.store;
  }

  reapWorktrees(): WorktreeHandle[] {
    const activeTaskIds = new Set(
      this.scheduler.listLeases()
        .filter((lease) => lease.state === "running")
        .map((lease) => lease.taskId),
    );
    for (const taskId of listProtectedDualLaneTaskIds()) activeTaskIds.add(taskId);
    return reapOrphanedWorktrees(this.worktrees.root, activeTaskIds);
  }

  close(): void {
    this.closing = true;
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
    this.scheduler.close();
    this.store.close();
  }

  async prepareForShutdown(reason = "gateway shutting down gracefully", timeoutMs = DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS): Promise<void> {
    this.closing = true;
    const wait = this.waitForResumeDispatches(timeoutMs);
    if (wait) await wait;
    for (const continuation of this.store.listLiveContinuations(["dispatching"])) {
      interruptOrchestrationRun(continuation.runId, reason);
      this.markLiveContinuationFailed(continuation.taskId, continuation.coordinatorId, reason, continuation.allocationId);
    }
    for (const lease of this.scheduler.listLeases()) {
      if (lease.state !== "running") continue;
      try {
        this.scheduler.releaseLease(lease.leaseId, lease.coordinatorId);
      } catch (err) {
        logger.warn(`Orchestration shutdown release failed for lease ${lease.leaseId}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private dispatchRetryResults(results: AllocationResult[]): void {
    for (const result of results) {
      if (!result.ok) continue;
      if (this.closing) {
        this.releaseAllocationLeases(result.allocation, { retryQueued: false });
        continue;
      }
      const dispatch = this.resumeQueuedAllocation(result.allocation, result.reviewPolicy).catch((err) => {
        logger.error(`Queued orchestration resume crashed for ${result.allocation.taskId}/${result.allocation.coordinatorId}: ${err instanceof Error ? err.message : err}`);
      });
      this.resumeDispatches.add(dispatch);
      dispatch.finally(() => this.resumeDispatches.delete(dispatch));
    }
  }

  private handleExpiredLeases(leases: Lease[]): void {
    if (!this.expiredLeaseHandler) {
      this.lastExpiredLeaseHandling = leases.map((lease) => ({
        leaseId: lease.leaseId,
        sessionId: null,
        status: "unmapped",
        interruptible: false,
      }));
      return;
    }
    try {
      const handled = this.expiredLeaseHandler(leases);
      this.lastExpiredLeaseHandling = handled?.map((entry) => ({ ...entry })) ?? [];
    } catch (err) {
      logger.warn(`Orchestration expired-lease handler failed: ${err instanceof Error ? err.message : String(err)}`);
      this.lastExpiredLeaseHandling = leases.map((lease) => ({
        leaseId: lease.leaseId,
        sessionId: null,
        status: "not_interruptible",
        interruptible: false,
      }));
    }
  }

  private async resumeQueuedAllocation(allocation: Allocation, reviewPolicy: ReviewPolicySummary): Promise<void> {
    if (!this.resumeQueuedRunHandler) {
      logger.warn(
        `No orchestration resume handler is registered for ${allocation.taskId}/${allocation.coordinatorId}; leaving continuation queued.`,
      );
      this.releaseAllocationLeases(allocation, { retryQueued: false });
      return;
    }
    const claimed = this.store.claimQueuedLiveContinuation(allocation.taskId, allocation.coordinatorId, {
      allocationId: allocation.allocationId,
    });
    if (!claimed) {
      logger.warn(
        `Orchestration invariant violated: resumed allocation ${allocation.allocationId} for ${allocation.taskId}/${allocation.coordinatorId} had no queued continuation; releasing leases.`,
      );
      this.releaseAllocationLeases(allocation);
      return;
    }
    this.warnIfHeadDriftedSinceEnqueue(claimed);
    try {
      await this.resumeQueuedRunHandler({
        continuation: claimed,
        allocation,
        reviewPolicy,
      });
      this.markLiveContinuationCompleted(claimed.taskId, claimed.coordinatorId, allocation.allocationId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Queued orchestration resume failed for ${claimed.taskId}/${claimed.coordinatorId}: ${message}`);
      this.releaseAllocationLeases(allocation);
      this.markLiveContinuationFailed(claimed.taskId, claimed.coordinatorId, message, allocation.allocationId);
    }
  }

  // Detection-only: logs when the target repo's HEAD moved between enqueue
  // and dispatch. Does not block, delay, or otherwise alter dispatch — the
  // design question of what (if anything) to do about drift is out of scope
  // here and owned by a future change.
  private warnIfHeadDriftedSinceEnqueue(continuation: LiveRunContinuationRecord): void {
    const { cwd, enqueueHeadSha } = continuation.task;
    if (!cwd || !enqueueHeadSha) return;
    const currentHeadSha = resolveGitHeadSha(cwd);
    if (!currentHeadSha || currentHeadSha === enqueueHeadSha) return;
    logger.warn(
      `Orchestration task ${continuation.taskId}/${continuation.coordinatorId} is dispatching against a moved HEAD: `
      + `repo ${cwd} was at ${enqueueHeadSha} when enqueued but is now at ${currentHeadSha}.`,
    );
  }

  private releaseAllocationLeases(allocation: Allocation, opts: { retryQueued?: boolean } = {}): void {
    for (const lease of allocation.leases) {
      try {
        this.scheduler.releaseLease(lease.leaseId, lease.coordinatorId);
      } catch (err) {
        logger.warn(`Orchestration invariant cleanup failed for lease ${lease.leaseId}: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (opts.retryQueued !== false && !this.closing && !this.getControlState().queuePaused) void this.retryQueuedWithLiveHeadroom();
  }

  private recoverStaleDispatchingContinuations(): void {
    const cutoff = Date.now() - this.staleDispatchingContinuationMs;
    // TMP-CUT-013: the wall clock alone is vulnerable to skew/adjustment
    // (NTP jumps, manual clock changes), which can hide or fabricate
    // staleness. Cross-check it against the monotonic boot-generation
    // counter: a continuation stamped with a strictly older boot generation
    // than the current one was left dispatching by a prior process and is
    // stale regardless of what the wall clock says. Neither check replaces
    // the other; a continuation is recovered if either says it's stale.
    const currentBootGeneration = this.store.getBootGeneration();
    const liveAllocationIds = new Set(this.scheduler.listAllocations().map((a) => a.allocationId));
    for (const continuation of this.store.listLiveContinuationsWithGeneration(["dispatching"])) {
      const updatedAt = Date.parse(continuation.updatedAt);
      const staleByClock = !(Number.isFinite(updatedAt) && updatedAt > cutoff);
      const staleByGeneration = typeof continuation.bootGeneration === "number"
        && continuation.bootGeneration < currentBootGeneration;
      if (!staleByClock && !staleByGeneration) continue;
      const error = `Recovered stale dispatching continuation after runtime restart`;
      logger.warn(`Orchestration ${error}: ${continuation.taskId}/${continuation.coordinatorId}`);
      recoverOrchestrationRun(continuation, DEFAULT_MAX_LIVE_CONTINUATION_RETRIES, error);
      this.markLiveContinuationFailed(continuation.taskId, continuation.coordinatorId, error, continuation.allocationId);
      const allocation = continuation.allocationId
        ? this.scheduler.listAllocations().find((candidate) => candidate.allocationId === continuation.allocationId)
        : undefined;
      if (allocation) this.releaseAllocationLeases(allocation, { retryQueued: false });
    }
    const liveBlockedRunIds = new Set(
      this.store.listLiveContinuations(["queued"])
        .map((c) => c.runId)
        .filter((id): id is string => id !== undefined),
    );
    sweepOrphanedOrchestrationRuns(liveAllocationIds, liveBlockedRunIds);
  }

  private waitForResumeDispatches(timeoutMs: number): Promise<void> | undefined {
    if (this.resumeDispatches.size === 0) return undefined;
    const pending = Promise.allSettled([...this.resumeDispatches]).then(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        logger.warn(`Timed out waiting for ${this.resumeDispatches.size} orchestration resume dispatch(es) during shutdown`);
        resolve();
      }, Math.max(0, timeoutMs));
      timer.unref?.();
    });
    return Promise.race([pending, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  private async resolveLiveHeadroomWorkerIds(): Promise<Set<string> | undefined> {
    const heldWorkerIds = this.activeHeldWorkerIds();
    if (!this.cuttlefishConfig) {
      if (heldWorkerIds.size === 0) return undefined;
      return new Set(this.config.workers.map((worker) => worker.id).filter((workerId) => !heldWorkerIds.has(workerId)));
    }
    try {
      const result = await this.headroomFilter(this.config.workers, this.cuttlefishConfig);
      if (result.rejected.length > 0) {
        logger.debug(
          `Orchestration headroom filtered ${result.rejected.length} worker(s): ${
            result.rejected.map(({ worker, headroom }) => `${worker.id}:${headroom.reason}`).join(", ")
          }`,
        );
      }
      return new Set(result.allowed.map((worker) => worker.id).filter((workerId) => !heldWorkerIds.has(workerId)));
    } catch (err) {
      logger.warn(`Orchestration headroom filter failed closed: ${err instanceof Error ? err.message : String(err)}`);
      return new Set();
    }
  }

  private activeHeldWorkerIds(): Set<string> {
    this.store.expireHolds();
    return new Set(this.store.listHolds().flatMap((hold) => hold.workerIds));
  }

  private pausedTaskKeys(): Set<string> {
    return new Set(this.store.listTaskPauses().map((pause) => queueTaskKey(pause.taskId, pause.coordinatorId)));
  }

  private startReaper(): void {
    if (this.reaper) return;
    this.expireLeases();
    this.reapWorktrees();
    this.reaper = setInterval(() => {
      this.expireLeases();
      this.reapWorktrees();
      this.pruneRetainedFiles();
    }, this.reaperIntervalMs);
    this.reaper.unref?.();
  }

  private pruneRetainedFiles(): void {
    try {
      pruneOrchestrationTelemetry();
    } catch (err) {
      logger.warn(`Orchestration telemetry pruning failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      pruneRecoveryNotices(this.recoveryDir);
    } catch (err) {
      logger.warn(`Orchestration recovery notice pruning failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      reapExpiredReviewBundles();
    } catch (err) {
      logger.warn(`Orchestration review bundle pruning failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function createOrchestrationRuntimeFromConfig(
  config: CuttlefishConfig,
  opts: OrchestrationRuntimeOptions = {},
): OrchestrationRuntime | undefined {
  if (config.orchestration?.enabled !== true) return undefined;
  return new OrchestrationRuntime({
    configDir: config.orchestration.configDir,
    dbPath: config.orchestration.dbPath,
    reaperIntervalMs: config.orchestration.reaperIntervalMs,
    worktreeRoot: config.orchestration.worktreeRoot,
    maxWorktrees: config.orchestration.maxWorktrees,
    reviewPolicy: resolveCrossFamilyReviewPolicy(config.orchestration),
    cuttlefishConfig: config,
    workerScores: opts.workerScores ?? resolveEmpiricalWorkerScores(config),
    ...opts,
  });
}

export function resolveLiveLeaseDurationMs(config: CuttlefishConfig): number {
  const configured = config.orchestration?.leaseDurationMs;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_LEASE_DURATION_MS;
}

// Best-effort HEAD SHA lookup used only for stale-HEAD *detection* (logging).
// Never throws: a missing/non-git cwd, missing git binary, or timeout all
// resolve to `undefined`, which callers treat as "nothing to compare".
function resolveGitHeadSha(cwd: string): string | undefined {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_HEAD_SHA_TIMEOUT_MS,
    }).trim();
    return sha || undefined;
  } catch {
    return undefined;
  }
}

function buildContinuationRequest(record: LiveRunContinuationRecord, config: OrchestrationConfig): AllocationRequest {
  if (record.mode === "dual_lane") {
    return {
      taskId: record.task.taskId,
      coordinatorId: record.task.coordinatorId,
      requiredRoles: [record.task.openaiRole ?? "openaiImplementer", record.task.anthropicRole ?? "anthropicImplementer"],
      optionalRoles: [],
      allowedWorkerIds: record.task.allowedWorkerIds,
      priority: record.task.priority,
      leaseDurationMs: record.task.leaseDurationMs,
    };
  }
  const brief = buildCoordinatorTaskBrief({
    taskId: record.task.taskId,
    coordinatorId: record.task.coordinatorId,
    coordinatorTemplate: record.task.coordinatorTemplate ?? record.task.template,
    requiredRoles: record.task.requiredRoles,
    optionalRoles: record.task.optionalRoles,
    allowedWorkerIds: record.task.allowedWorkerIds,
    priority: record.task.priority,
    leaseDurationMs: record.task.leaseDurationMs,
    mode: record.mode as CoordinatorMode,
  }, config);
  return brief.request;
}

function resolveEmpiricalWorkerScores(config: CuttlefishConfig): Record<string, number> | undefined {
  if (config.orchestration?.empiricalRouting !== true) return undefined;
  try {
    const telemetry = readOrchestrationTelemetry(undefined, {
      maxBytes: EMPIRICAL_ROUTING_MAX_BYTES,
      maxRecords: EMPIRICAL_ROUTING_MAX_RECORDS,
    });
    if (telemetry.skippedLines > 0) {
      logger.warn(`Orchestration empirical routing skipped ${telemetry.skippedLines} malformed telemetry line(s)`);
    }
    return computeWorkerScores(telemetry.records, { now: new Date() });
  } catch (err) {
    logger.warn(`Orchestration empirical routing disabled for this boot: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function resolveRecoveryDir(dbPath: string): string {
  return dbPath === ORCH_DB ? ORCH_RECOVERY_DIR : path.join(path.dirname(dbPath), "orchestration-recovery");
}

function sanitizePauseReason(reason: string | undefined): string | null {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  return trimmed ? trimmed.slice(0, 500) : null;
}

function sanitizeOptional(value: string | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed.slice(0, 200) : null;
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
