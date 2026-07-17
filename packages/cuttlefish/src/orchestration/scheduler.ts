import type {
  Allocation,
  AllocationRequest,
  AllocationResult,
  Lease,
  LeaseValidationResult,
  OrchestrationConfig,
  QueueItem,
  ReviewPolicyExplanation,
  RoleDefinition,
  SchedulerSnapshot,
  SimulationStepResult,
  TelemetryEvent,
  Worker,
} from "./types.js";
import {
  DEFAULT_CROSS_FAMILY_REVIEW_POLICY,
  explainReviewPolicy,
  isImplementerRole,
  resolveCrossFamilyReviewPolicy,
  selectedImplementerFamilies,
  type CrossFamilyReviewPolicy,
} from "./cross-family.js";
import {
  pruneSchedulerTelemetry,
  pruneTerminalAllocations,
  pruneTerminalLeases,
  refreshAllocationLifecycle,
  resolveSchedulerRetentionOptions,
  type SchedulerRetentionOptions,
  type ResolvedSchedulerRetentionOptions,
} from "./scheduler-retention.js";

const COST_RANK: Record<string, number> = {
  near_zero: 0,
  low: 1,
  medium: 2,
  high: 3,
};

const PRIORITY_RANK: Record<string, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

export interface SchedulerOptions {
  now?: () => Date;
  snapshot?: SchedulerSnapshot;
  reviewPolicy?: Partial<CrossFamilyReviewPolicy>;
  workerScores?: Record<string, number>;
  retention?: SchedulerRetentionOptions;
}

export interface AllocationRequestOptions {
  queueOnBlock?: boolean;
  allowedWorkerIds?: Iterable<string>;
  skipQueuedTaskKeys?: Iterable<string>;
  onlyQueuedTaskKeys?: Iterable<string>;
}

interface CandidateState {
  workerLeaseCounts: Map<string, number>;
  providerCounts: Map<string, number>;
  familyCounts: Map<string, number>;
}

interface WorkerSelection {
  worker: Worker | null;
  explanation?: ReviewPolicyExplanation;
}

export class MatrixScheduler {
  private readonly workers: Worker[];
  private readonly roles: Map<string, RoleDefinition>;
  private readonly now: () => Date;
  private readonly allocations = new Map<string, Allocation>();
  private readonly leases = new Map<string, Lease>();
  private readonly queue: QueueItem[] = [];
  private readonly telemetry: TelemetryEvent[] = [];
  private readonly reviewPolicy: CrossFamilyReviewPolicy;
  private readonly workerScores: Record<string, number>;
  private readonly retention: ResolvedSchedulerRetentionOptions;
  private nextSeq = 1;

  constructor(private readonly config: OrchestrationConfig, opts: SchedulerOptions = {}) {
    this.workers = [...config.workers].sort((a, b) => a.id.localeCompare(b.id));
    this.roles = new Map(config.roles.map((role) => [role.id, role]));
    this.now = opts.now ?? (() => new Date());
    this.reviewPolicy = opts.reviewPolicy
      ? resolveCrossFamilyReviewPolicy(opts.reviewPolicy)
      : DEFAULT_CROSS_FAMILY_REVIEW_POLICY;
    this.workerScores = opts.workerScores ?? {};
    this.retention = resolveSchedulerRetentionOptions(opts.retention);
    if (opts.snapshot) this.hydrate(opts.snapshot);
  }

  requestAllocation(request: AllocationRequest, opts: AllocationRequestOptions = {}): AllocationResult {
    const queueOnBlock = opts.queueOnBlock !== false;
    const allowedWorkerIds = mergeAllowedWorkerIds(request.allowedWorkerIds, opts.allowedWorkerIds);
    this.expireLeases(this.now());
    const activeState = this.activeState();
    const selected: Array<{ role: string; worker: Worker }> = [];
    const missingRoles: string[] = [];
    const explanations: ReviewPolicyExplanation[] = [];

    for (const roleId of request.requiredRoles) {
      const role = this.requireRole(roleId);
      const selection = this.selectWorker(role, selected, activeState, allowedWorkerIds);
      if (selection.explanation) explanations.push(selection.explanation);
      const worker = selection.worker;
      if (!worker) {
        missingRoles.push(roleId);
        continue;
      }
      selected.push({ role: roleId, worker });
      this.reserve(worker, activeState);
    }

    if (missingRoles.length > 0) {
      const queueItem = queueOnBlock
        ? this.queueBlocked(request, missingRoles)
        : this.buildBlockedQueueItem(request, missingRoles, this.isoNow());
      if (queueOnBlock) {
        this.record("task_blocked_resource", {
          taskId: request.taskId,
          timestamp: queueItem.blockedSince,
          detail: { missingRoles },
        });
      }
      return { ok: false, queueItem, reviewPolicy: { explanations } };
    }

    const optionalRolesSkipped: string[] = [];
    for (const roleId of request.optionalRoles) {
      const role = this.requireRole(roleId);
      const selection = this.selectWorker(role, selected, activeState, allowedWorkerIds);
      if (selection.explanation) explanations.push(selection.explanation);
      const worker = selection.worker;
      if (!worker) {
        optionalRolesSkipped.push(roleId);
        continue;
      }
      selected.push({ role: roleId, worker });
      this.reserve(worker, activeState);
    }

    const createdAt = this.isoNow();
    const leases = selected.map(({ role, worker }) => this.createLease(request, role, worker, createdAt));
    for (const lease of leases) this.leases.set(lease.leaseId, lease);
    const allocation: Allocation = {
      allocationId: `alloc_${sanitizeId(request.taskId)}_${this.nextSeq++}`,
      taskId: request.taskId,
      coordinatorId: request.coordinatorId,
      state: "allocated",
      leases,
      optionalRolesSkipped,
      createdAt,
      updatedAt: createdAt,
    };
    this.allocations.set(allocation.allocationId, allocation);
    this.record("allocation_created", {
      taskId: request.taskId,
      timestamp: createdAt,
      detail: {
        coordinatorId: request.coordinatorId,
        roles: leases.map((lease) => lease.role),
      },
    });
    return { ok: true, allocation, reviewPolicy: { explanations } };
  }

  heartbeatLease(leaseId: string, coordinatorId?: string): Lease {
    const lease = this.getLiveLease(leaseId);
    if (coordinatorId && lease.coordinatorId !== coordinatorId) {
      throw new Error(`lease ${leaseId} belongs to coordinator ${lease.coordinatorId}`);
    }
    const heartbeatAt = this.isoNow();
    lease.heartbeatAt = heartbeatAt;
    lease.leaseExpiresAt = new Date(Date.parse(heartbeatAt) + lease.leaseDurationMs).toISOString();
    this.record("lease_heartbeat", {
      taskId: lease.taskId,
      workerId: lease.workerId,
      role: lease.role,
      timestamp: lease.heartbeatAt,
    });
    return { ...lease };
  }

  releaseLease(leaseId: string, coordinatorId?: string): Lease {
    const lease = this.getLiveLease(leaseId);
    if (coordinatorId && lease.coordinatorId !== coordinatorId) {
      throw new Error(`lease ${leaseId} belongs to coordinator ${lease.coordinatorId}`);
    }
    lease.state = "released";
    const releasedAt = this.isoNow();
    this.record("lease_released", {
      taskId: lease.taskId,
      workerId: lease.workerId,
      role: lease.role,
      timestamp: releasedAt,
    });
    this.refreshAllocationStates(releasedAt);
    this.pruneRetainedState(new Date(releasedAt));
    return { ...lease };
  }

  expireLeases(now: Date = this.now()): Lease[] {
    const expired: Lease[] = [];
    for (const lease of this.leases.values()) {
      if (lease.state !== "running") continue;
      if (Date.parse(lease.leaseExpiresAt) > now.getTime()) continue;
      lease.state = "expired";
      expired.push({ ...lease });
      this.record("lease_expired", {
        taskId: lease.taskId,
        workerId: lease.workerId,
        role: lease.role,
        timestamp: now.toISOString(),
      });
    }
    if (expired.length > 0) {
      this.refreshAllocationStates(now.toISOString());
      this.pruneRetainedState(now);
    }
    return expired;
  }

  validateLeaseForWorker(
    workerId: string,
    leaseId: string,
    taskId: string,
    coordinatorId: string,
  ): LeaseValidationResult {
    const lease = this.leases.get(leaseId);
    if (!lease) return { ok: false, reason: "lease_not_found" };
    if (lease.state !== "running") return { ok: false, reason: `lease_${lease.state}` };
    if (lease.workerId !== workerId) return { ok: false, reason: "worker_mismatch" };
    if (lease.taskId !== taskId) return { ok: false, reason: "task_mismatch" };
    if (lease.coordinatorId !== coordinatorId) return { ok: false, reason: "coordinator_mismatch" };
    if (Date.parse(lease.leaseExpiresAt) <= this.now().getTime()) return { ok: false, reason: "lease_expired" };
    return { ok: true };
  }

  retryQueued(opts: AllocationRequestOptions = {}): AllocationResult[] {
    const ordered = [...this.queue].sort(compareQueueItems);
    const skipped = opts.skipQueuedTaskKeys ? new Set(opts.skipQueuedTaskKeys) : undefined;
    const only = opts.onlyQueuedTaskKeys ? new Set(opts.onlyQueuedTaskKeys) : undefined;
    const results: AllocationResult[] = [];
    for (const item of ordered) {
      const key = queueTaskKey(item.taskId, item.coordinatorId);
      if (skipped?.has(key)) continue;
      if (only && !only.has(key)) continue;
      const result = this.requestAllocation(item.request, {
        allowedWorkerIds: opts.allowedWorkerIds,
      });
      if (result.ok) {
        const index = this.queue.indexOf(item);
        if (index >= 0) this.queue.splice(index, 1);
        results.push(result);
      }
    }
    return results;
  }

  listLeases(): Lease[] {
    return [...this.leases.values()].map((lease) => ({ ...lease }));
  }

  listAllocations(): Allocation[] {
    return [...this.allocations.values()].map((allocation) => ({
      ...allocation,
      leases: allocation.leases.map((lease) => ({ ...lease })),
      optionalRolesSkipped: [...allocation.optionalRolesSkipped],
    }));
  }

  listQueue(): QueueItem[] {
    return this.queue.map((item) => ({
      ...item,
      missingRoles: [...item.missingRoles],
      lastBlockedAt: item.lastBlockedAt ?? item.blockedSince,
      blockedAttempts: item.blockedAttempts ?? 1,
      resumeOn: [...item.resumeOn],
      request: {
        ...item.request,
        requiredRoles: [...item.request.requiredRoles],
        optionalRoles: [...item.request.optionalRoles],
      },
    }));
  }

  listTelemetry(): TelemetryEvent[] {
    return this.telemetry.map((event) => ({
      ...event,
      detail: event.detail ? { ...event.detail } : undefined,
    }));
  }

  createSnapshot(): SchedulerSnapshot {
    return {
      allocations: this.listAllocations(),
      leases: this.listLeases(),
      queue: this.listQueue(),
      telemetry: this.listTelemetry(),
      nextSeq: this.nextSeq,
    };
  }

  resolveLease(selector: { leaseId?: string; taskId?: string; role?: string; workerId?: string }): Lease {
    if (selector.leaseId) return this.getLiveLease(selector.leaseId);
    const matches = this.listLeases().filter((lease) => {
      if (!this.isLeaseLive(lease)) return false;
      if (selector.taskId && lease.taskId !== selector.taskId) return false;
      if (selector.role && lease.role !== selector.role) return false;
      if (selector.workerId && lease.workerId !== selector.workerId) return false;
      return true;
    });
    if (matches.length !== 1) {
      throw new Error(`release selector matched ${matches.length} running leases`);
    }
    return matches[0];
  }

  private requireRole(roleId: string): RoleDefinition {
    const role = this.roles.get(roleId);
    if (!role) throw new Error(`unknown role: ${roleId}`);
    return role;
  }

  private selectWorker(
    role: RoleDefinition,
    selected: Array<{ role: string; worker: Worker }>,
    state: CandidateState,
    allowedWorkerIds: Set<string> | undefined,
  ): WorkerSelection {
    if (role.familyConstraint === "opposite_of_implementer") {
      return this.selectOppositeFamilyReviewer(role, selected, state, allowedWorkerIds);
    }
    return { worker: this.sortedCandidates(role, selected, state, "normal", allowedWorkerIds)[0] ?? null };
  }

  private selectOppositeFamilyReviewer(
    role: RoleDefinition,
    selected: Array<{ role: string; worker: Worker }>,
    state: CandidateState,
    allowedWorkerIds: Set<string> | undefined,
  ): WorkerSelection {
    const implementerFamilies = selectedImplementerFamilies(selected, (roleId) => this.roles.get(roleId));
    if (implementerFamilies.length === 0) {
      return { worker: this.sortedCandidates(role, selected, state, "normal", allowedWorkerIds)[0] ?? null };
    }

    const oppositeCandidates = this.sortedCandidates(role, selected, state, "normal", allowedWorkerIds);
    const sameFamilyCandidates = this.sortedCandidates(role, selected, state, "ignore_opposite_constraint", allowedWorkerIds)
      .filter((worker) => implementerFamilies.includes(worker.family) && !selected.some((entry) => entry.worker.id === worker.id));
    const opposite = oppositeCandidates[0];
    if (opposite) {
      return {
        worker: opposite,
        explanation: explainReviewPolicy({
          role: role.id,
          policy: this.reviewPolicy,
          implementerFamilies,
          oppositeCandidates,
          sameFamilyCandidates,
          selectedWorker: opposite,
          decision: "opposite_family_selected",
        }),
      };
    }

    const fallback = sameFamilyCandidates[0];
    if (fallback && this.reviewPolicy.sameFamilyReviewerFallback) {
      return {
        worker: fallback,
        explanation: explainReviewPolicy({
          role: role.id,
          policy: this.reviewPolicy,
          implementerFamilies,
          oppositeCandidates,
          sameFamilyCandidates,
          selectedWorker: fallback,
          decision: "same_family_fallback_used",
        }),
      };
    }

    return {
      worker: null,
      explanation: explainReviewPolicy({
        role: role.id,
        policy: this.reviewPolicy,
        implementerFamilies,
        oppositeCandidates,
        sameFamilyCandidates,
        decision: sameFamilyCandidates.length > 0 ? "same_family_fallback_forbidden" : "no_qualified_reviewer",
      }),
    };
  }

  private sortedCandidates(
    role: RoleDefinition,
    selected: Array<{ role: string; worker: Worker }>,
    state: CandidateState,
    familyMode: "normal" | "ignore_opposite_constraint",
    allowedWorkerIds: Set<string> | undefined,
  ): Worker[] {
    return this.workers
      .filter((worker) => this.workerQualifies(worker, role, selected, state, familyMode, allowedWorkerIds))
      .sort((a, b) => compareWorkers(a, b, role, this.workerScores));
  }

  private workerQualifies(
    worker: Worker,
    role: RoleDefinition,
    selected: Array<{ role: string; worker: Worker }>,
    state: CandidateState,
    familyMode: "normal" | "ignore_opposite_constraint",
    allowedWorkerIds: Set<string> | undefined,
  ): boolean {
    if (allowedWorkerIds && !allowedWorkerIds.has(worker.id)) return false;
    if (role.allowedFamilies && !role.allowedFamilies.includes(worker.family)) return false;
    if (!role.requiredCapabilities.every((capability) => worker.capabilities.includes(capability))) return false;
    if (!role.requiredTools.every((tool) => worker.tools.includes(tool))) return false;
    if ((state.workerLeaseCounts.get(worker.id) ?? 0) >= worker.maxConcurrentTasks) return false;
    if (!this.quotaAllows("providers", worker.provider, state.providerCounts)) return false;
    if (!this.quotaAllows("families", worker.family, state.familyCounts)) return false;
    if (familyMode === "ignore_opposite_constraint" && role.familyConstraint === "opposite_of_implementer") return true;
    return this.familyConstraintAllows(worker, role, selected);
  }

  private familyConstraintAllows(
    worker: Worker,
    role: RoleDefinition,
    selected: Array<{ role: string; worker: Worker }>,
  ): boolean {
    if (!role.familyConstraint) return true;
    const implementerFamilies = selected
      .filter((entry) => isImplementerRole(entry.role, this.roles.get(entry.role)))
      .map((entry) => entry.worker.family);
    if (implementerFamilies.length === 0) return true;
    if (role.familyConstraint === "opposite_of_implementer") {
      return !implementerFamilies.includes(worker.family);
    }
    return implementerFamilies.includes(worker.family);
  }

  private quotaAllows(section: "providers" | "families", key: string, counts: Map<string, number>): boolean {
    const limit = this.config.quotas[section][key]?.maxActiveLeases;
    return limit === undefined || (counts.get(key) ?? 0) < limit;
  }

  private activeState(): CandidateState {
    const state: CandidateState = {
      workerLeaseCounts: new Map(),
      providerCounts: new Map(),
      familyCounts: new Map(),
    };
    for (const lease of this.leases.values()) {
      if (!this.isLeaseLive(lease)) continue;
      const worker = this.workers.find((candidate) => candidate.id === lease.workerId);
      if (!worker) continue;
      this.reserve(worker, state);
    }
    return state;
  }

  private reserve(worker: Worker, state: CandidateState): void {
    increment(state.workerLeaseCounts, worker.id);
    increment(state.providerCounts, worker.provider);
    increment(state.familyCounts, worker.family);
  }

  private createLease(request: AllocationRequest, role: string, worker: Worker, startedAt: string): Lease {
    const expires = new Date(Date.parse(startedAt) + request.leaseDurationMs).toISOString();
    return {
      leaseId: `lease_${sanitizeId(request.taskId)}_${sanitizeId(role)}_${sanitizeId(worker.id)}_${this.nextSeq++}`,
      workerId: worker.id,
      taskId: request.taskId,
      coordinatorId: request.coordinatorId,
      role,
      state: "running",
      startedAt,
      leaseExpiresAt: expires,
      leaseDurationMs: request.leaseDurationMs,
      heartbeatAt: startedAt,
    };
  }

  private queueBlocked(request: AllocationRequest, missingRoles: string[]): QueueItem {
    const existing = this.queue.find((item) => item.taskId === request.taskId && item.coordinatorId === request.coordinatorId);
    if (existing) {
      existing.missingRoles = missingRoles;
      existing.priority = request.priority;
      existing.request = request;
      existing.lastBlockedAt = this.isoNow();
      existing.blockedAttempts += 1;
      return { ...existing, request: { ...existing.request } };
    }
    const item = this.buildBlockedQueueItem(request, missingRoles, this.isoNow());
    this.queue.push(item);
    return { ...item, request: { ...item.request } };
  }

  private buildBlockedQueueItem(request: AllocationRequest, missingRoles: string[], blockedSince: string): QueueItem {
    return {
      taskId: request.taskId,
      coordinatorId: request.coordinatorId,
      state: "blocked_resource",
      missingRoles,
      priority: request.priority,
      blockedSince,
      lastBlockedAt: blockedSince,
      blockedAttempts: 1,
      resumeOn: ["worker_released", "quota_available", "lease_expired"],
      request,
    };
  }

  private getLiveLease(leaseId: string): Lease {
    const lease = this.leases.get(leaseId);
    if (!lease) throw new Error(`unknown lease: ${leaseId}`);
    if (lease.state !== "running") throw new Error(`lease ${leaseId} is ${lease.state}`);
    if (!this.isLeaseLive(lease)) throw new Error(`lease ${leaseId} is expired`);
    return lease;
  }

  private isLeaseLive(lease: Lease): boolean {
    return lease.state === "running" && Date.parse(lease.leaseExpiresAt) > this.now().getTime();
  }

  private isoNow(): string {
    return this.now().toISOString();
  }

  private hydrate(snapshot: SchedulerSnapshot): void {
    this.nextSeq = Math.max(1, snapshot.nextSeq);
    for (const lease of snapshot.leases) {
      this.leases.set(lease.leaseId, { ...lease });
    }
    const leasesById = new Map(this.leases);
    for (const allocation of snapshot.allocations) {
      this.allocations.set(allocation.allocationId, {
        ...allocation,
        leases: allocation.leases.map((lease) => leasesById.get(lease.leaseId) ?? { ...lease }),
        optionalRolesSkipped: [...allocation.optionalRolesSkipped],
        updatedAt: allocation.updatedAt ?? allocation.createdAt,
      });
    }
    this.queue.push(...snapshot.queue.map((item) => ({
      ...item,
      missingRoles: [...item.missingRoles],
      lastBlockedAt: item.lastBlockedAt ?? item.blockedSince,
      blockedAttempts: item.blockedAttempts ?? 1,
      resumeOn: [...item.resumeOn],
      request: {
        ...item.request,
        requiredRoles: [...item.request.requiredRoles],
        optionalRoles: [...item.request.optionalRoles],
      },
    })));
    this.telemetry.push(...snapshot.telemetry.map((event) => ({
      ...event,
      detail: event.detail ? { ...event.detail } : undefined,
    })));
    this.refreshAllocationStates(this.isoNow());
    this.pruneRetainedState(this.now());
  }

  private record(type: TelemetryEvent["type"], event: Omit<TelemetryEvent, "eventId" | "type">): void {
    this.telemetry.push({
      eventId: `evt_${this.nextSeq++}`,
      type,
      ...event,
    });
    this.pruneRetainedState(new Date(event.timestamp));
  }

  private refreshAllocationStates(updatedAt: string): void {
    const leasesById = new Map(this.leases);
    for (const allocation of this.allocations.values()) {
      refreshAllocationLifecycle(allocation, leasesById, updatedAt);
    }
  }

  private pruneRetainedState(now: Date): void {
    this.refreshAllocationStates(now.toISOString());
    pruneTerminalAllocations(this.allocations, now, this.retention);
    pruneTerminalLeases(this.leases, this.allocations, now, this.retention);
    pruneSchedulerTelemetry(this.telemetry, now, this.retention);
  }
}

export function queueTaskKey(taskId: string, coordinatorId: string): string {
  return `${taskId}\u0000${coordinatorId}`;
}

export function runSimulation(
  scheduler: MatrixScheduler,
  steps: Array<
    | { allocate: AllocationRequest }
    | { release: { leaseId?: string; taskId?: string; role?: string; workerId?: string } }
    | { heartbeat: { leaseId: string } }
    | { expire: { now: string } }
  >,
): SimulationStepResult[] {
  return steps.map((step, index) => {
    if ("allocate" in step) {
      return { step: index + 1, action: "allocate", result: scheduler.requestAllocation(step.allocate) };
    }
    if ("release" in step) {
      const lease = scheduler.resolveLease(step.release);
      return { step: index + 1, action: "release", result: scheduler.releaseLease(lease.leaseId) };
    }
    if ("heartbeat" in step) {
      return { step: index + 1, action: "heartbeat", result: scheduler.heartbeatLease(step.heartbeat.leaseId) };
    }
    const expired = scheduler.expireLeases(new Date(step.expire.now));
    const retried = scheduler.retryQueued();
    return { step: index + 1, action: "expire", result: { expired, retried } };
  });
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function compareWorkers(a: Worker, b: Worker, role: RoleDefinition, workerScores: Record<string, number> = {}): number {
  const tier = preferenceRank(a.tier, role.preferredTiers) - preferenceRank(b.tier, role.preferredTiers);
  if (tier !== 0) return tier;
  const cost = preferenceRank(a.costClass, role.preferredCostClasses) - preferenceRank(b.costClass, role.preferredCostClasses);
  if (cost !== 0) return cost;
  const baseCost = (COST_RANK[a.costClass] ?? 99) - (COST_RANK[b.costClass] ?? 99);
  if (baseCost !== 0) return baseCost;
  const score = (workerScores[b.id] ?? 0) - (workerScores[a.id] ?? 0);
  if (score !== 0) return score;
  return a.id.localeCompare(b.id);
}

function preferenceRank(value: string, preferred: readonly string[] | undefined): number {
  if (!preferred || preferred.length === 0) return 0;
  const index = preferred.indexOf(value);
  return index === -1 ? preferred.length + 1 : index;
}

function compareQueueItems(a: QueueItem, b: QueueItem): number {
  const priority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (priority !== 0) return priority;
  const time = Date.parse(a.blockedSince) - Date.parse(b.blockedSince);
  if (time !== 0) return time;
  return a.taskId.localeCompare(b.taskId);
}

function mergeAllowedWorkerIds(
  requestAllowed: readonly string[] | undefined,
  optsAllowed: Iterable<string> | undefined,
): Set<string> | undefined {
  const requestSet = requestAllowed ? new Set(requestAllowed) : undefined;
  if (!optsAllowed) return requestSet;
  const optsSet = new Set(optsAllowed);
  if (!requestSet) return optsSet;
  return new Set([...requestSet].filter((workerId) => optsSet.has(workerId)));
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "id";
}
