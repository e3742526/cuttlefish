import { describe, expect, it } from "vitest";
import { parseWorkers } from "../schemas.js";
import { MatrixScheduler, type SchedulerOptions } from "../scheduler.js";
import type { AllocationRequest, OrchestrationConfig, RoleDefinition, Worker } from "../types.js";

const fixedNow = new Date("2026-06-23T12:00:00.000Z");

function worker(overrides: Partial<Worker> & Pick<Worker, "id" | "provider" | "family">): Worker {
  return {
    tier: "frontier",
    capabilities: ["repo_edit", "coding", "code_review", "validation"],
    tools: ["git", "filesystem", "shell"],
    maxConcurrentTasks: 1,
    costClass: "medium",
    workspacePolicy: "isolated_worktree",
    ...overrides,
  };
}

const roles: RoleDefinition[] = [
  {
    id: "seniorImplementer",
    requiredCapabilities: ["repo_edit", "coding"],
    requiredTools: ["git", "filesystem"],
    preferredTiers: ["frontier"],
  },
  {
    id: "independentReviewer",
    requiredCapabilities: ["code_review"],
    requiredTools: ["filesystem"],
    familyConstraint: "opposite_of_implementer",
    preferredCostClasses: ["low", "medium"],
  },
  {
    id: "qaGate",
    requiredCapabilities: ["validation"],
    requiredTools: ["shell"],
    preferredCostClasses: ["near_zero", "low"],
  },
  {
    id: "missingSpecialist",
    requiredCapabilities: ["rare_capability"],
    requiredTools: [],
  },
];

function config(workers: Worker[], extra: Partial<OrchestrationConfig> = {}): OrchestrationConfig {
  return {
    workers,
    roles,
    coordinatorTemplates: [
      {
        id: "standardImplementation",
        purpose: "feature work",
        requiredRoles: ["seniorImplementer", "independentReviewer", "qaGate"],
        optionalRoles: [],
      },
    ],
    quotas: { providers: {}, families: {} },
    ...extra,
  };
}

function request(overrides: Partial<AllocationRequest> = {}): AllocationRequest {
  return {
    taskId: "task-1",
    coordinatorId: "coord-1",
    requiredRoles: ["seniorImplementer"],
    optionalRoles: [],
    priority: "normal",
    leaseDurationMs: 60 * 60 * 1000,
    ...overrides,
  };
}

function scheduler(cfg: OrchestrationConfig, opts: SchedulerOptions = {}): MatrixScheduler {
  return new MatrixScheduler(cfg, { now: () => fixedNow, ...opts });
}

describe("orchestration schemas", () => {
  it("validates worker config and reports malformed workers", () => {
    expect(parseWorkers({
      workers: {
        localQa: {
          provider: "ollama",
          family: "local",
          tier: "local",
          capabilities: ["validation"],
        },
      },
    })[0]).toMatchObject({
      id: "localQa",
      tools: [],
      maxConcurrentTasks: 1,
      costClass: "medium",
      workspacePolicy: "shared",
    });

    expect(() => parseWorkers({ workers: { bad: { family: "openai" } } })).toThrow();
  });
});

describe("MatrixScheduler", () => {
  it("allocates one task to one qualified worker", () => {
    const s = scheduler(config([worker({ id: "codexSenior", provider: "openai", family: "openai" })]));
    const result = s.requestAllocation(request());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.allocation.leases).toHaveLength(1);
    expect(result.allocation.leases[0]).toMatchObject({
      workerId: "codexSenior",
      taskId: "task-1",
      role: "seniorImplementer",
      state: "running",
    });
    expect(s.validateLeaseForWorker("codexSenior", result.allocation.leases[0].leaseId, "task-1", "coord-1")).toEqual({ ok: true });
  });

  it("uses empirical worker scores only as a deterministic tie-break", () => {
    const cfg = config([
      worker({ id: "alphaSenior", provider: "openai", family: "openai", costClass: "low" }),
      worker({ id: "betaSenior", provider: "openai", family: "openai", costClass: "low" }),
    ]);

    const defaultResult = scheduler(cfg).requestAllocation(request());
    expect(defaultResult.ok).toBe(true);
    if (!defaultResult.ok) return;
    expect(defaultResult.allocation.leases[0].workerId).toBe("alphaSenior");

    const scoredResult = scheduler(cfg, { workerScores: { betaSenior: 10 } }).requestAllocation(request());
    expect(scoredResult.ok).toBe(true);
    if (!scoredResult.ok) return;
    expect(scoredResult.allocation.leases[0].workerId).toBe("betaSenior");

    const costPreferred = scheduler(config([
      worker({ id: "cheapSenior", provider: "openai", family: "openai", costClass: "near_zero" }),
      worker({ id: "expensiveSenior", provider: "openai", family: "openai", costClass: "high" }),
    ]), { workerScores: { expensiveSenior: 100 } }).requestAllocation(request());
    expect(costPreferred.ok).toBe(true);
    if (!costPreferred.ok) return;
    expect(costPreferred.allocation.leases[0].workerId).toBe("cheapSenior");
  });

  it("queues the second task when one max-concurrency worker is busy", () => {
    const s = scheduler(config([worker({ id: "codexSenior", provider: "openai", family: "openai" })]));
    expect(s.requestAllocation(request({ taskId: "task-1" })).ok).toBe(true);

    const second = s.requestAllocation(request({ taskId: "task-2", coordinatorId: "coord-2" }));

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.queueItem).toMatchObject({
      taskId: "task-2",
      state: "blocked_resource",
      missingRoles: ["seniorImplementer"],
      resumeOn: ["worker_released", "quota_available", "lease_expired"],
    });
  });


  it("tracks repeated blocked attempts without duplicating queue items", () => {
    let now = new Date("2026-06-23T12:00:00.000Z");
    const s = scheduler(
      config([worker({ id: "codexSenior", provider: "openai", family: "openai" })]),
      { now: () => now },
    );
    expect(s.requestAllocation(request({ taskId: "running" })).ok).toBe(true);

    const first = s.requestAllocation(request({ taskId: "blocked", coordinatorId: "coord-blocked" }));
    now = new Date("2026-06-23T12:01:00.000Z");
    const second = s.requestAllocation(request({ taskId: "blocked", coordinatorId: "coord-blocked", priority: "high" }));

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(s.listQueue()).toEqual([
      expect.objectContaining({
        taskId: "blocked",
        priority: "high",
        blockedSince: "2026-06-23T12:00:00.000Z",
        lastBlockedAt: "2026-06-23T12:01:00.000Z",
        blockedAttempts: 2,
      }),
    ]);
  });

  it("uses maxConcurrentTasks before blocking", () => {
    const s = scheduler(config([
      worker({ id: "localQa", provider: "ollama", family: "local", maxConcurrentTasks: 2 }),
    ]));

    expect(s.requestAllocation(request({ taskId: "a" })).ok).toBe(true);
    expect(s.requestAllocation(request({ taskId: "b", coordinatorId: "coord-b" })).ok).toBe(true);
    expect(s.requestAllocation(request({ taskId: "c", coordinatorId: "coord-c" })).ok).toBe(false);
  });

  it("does not allocate partial required teams when a role is unavailable", () => {
    const s = scheduler(config([worker({ id: "codexSenior", provider: "openai", family: "openai" })]));
    const result = s.requestAllocation(request({ requiredRoles: ["seniorImplementer", "missingSpecialist"] }));

    expect(result.ok).toBe(false);
    expect(s.listLeases()).toHaveLength(0);
  });

  it("selects an opposite-family reviewer after an implementer", () => {
    const s = scheduler(config([
      worker({ id: "codexSenior", provider: "openai", family: "openai", costClass: "high" }),
      worker({ id: "codexReviewer", provider: "openai", family: "openai", costClass: "low" }),
      worker({ id: "haikuReviewer", provider: "anthropic", family: "anthropic", costClass: "low" }),
      worker({ id: "localQa", provider: "ollama", family: "local", tier: "local", costClass: "near_zero" }),
    ]));
    const result = s.requestAllocation(request({
      requiredRoles: ["seniorImplementer", "independentReviewer", "qaGate"],
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.allocation.leases.find((lease) => lease.role === "independentReviewer")?.workerId).toBe("haikuReviewer");
    expect(result.reviewPolicy.explanations[0]).toMatchObject({
      role: "independentReviewer",
      decision: "opposite_family_selected",
      selectedWorkerId: "haikuReviewer",
      sameFamilyReviewerFallback: false,
    });
  });

  it("blocks same-family-only reviewers when fallback is forbidden", () => {
    const s = scheduler(config([
      worker({
        id: "openaiImplementer",
        provider: "openai",
        family: "openai",
        capabilities: ["repo_edit", "coding"],
        tools: ["git", "filesystem"],
      }),
      worker({
        id: "openaiReviewer",
        provider: "openai",
        family: "openai",
        capabilities: ["code_review"],
        tools: ["filesystem"],
      }),
    ]));
    const result = s.requestAllocation(request({
      requiredRoles: ["seniorImplementer", "independentReviewer"],
    }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.queueItem.missingRoles).toEqual(["independentReviewer"]);
    expect(result.reviewPolicy.explanations[0]).toMatchObject({
      role: "independentReviewer",
      decision: "same_family_fallback_forbidden",
      sameFamilyReviewerFallback: false,
      implementerFamilies: ["openai"],
      sameFamilyCandidateIds: ["openaiReviewer"],
    });
    expect(s.listLeases()).toHaveLength(0);
  });

  it("uses explicit same-family reviewer fallback when no opposite-family reviewer is qualified", () => {
    const s = scheduler(config([
      worker({
        id: "openaiImplementer",
        provider: "openai",
        family: "openai",
        capabilities: ["repo_edit", "coding"],
        tools: ["git", "filesystem"],
      }),
      worker({
        id: "openaiReviewer",
        provider: "openai",
        family: "openai",
        capabilities: ["code_review"],
        tools: ["filesystem"],
      }),
    ]), { reviewPolicy: { sameFamilyReviewerFallback: true } });
    const result = s.requestAllocation(request({
      requiredRoles: ["seniorImplementer", "independentReviewer"],
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.allocation.leases.find((lease) => lease.role === "independentReviewer")?.workerId).toBe("openaiReviewer");
    expect(result.reviewPolicy.explanations[0]).toMatchObject({
      role: "independentReviewer",
      decision: "same_family_fallback_used",
      sameFamilyReviewerFallback: true,
      selectedWorkerId: "openaiReviewer",
    });
  });

  it("prefers an opposite-family reviewer even when same-family fallback is enabled", () => {
    const s = scheduler(config([
      worker({
        id: "openaiImplementer",
        provider: "openai",
        family: "openai",
        capabilities: ["repo_edit", "coding"],
        tools: ["git", "filesystem"],
      }),
      worker({
        id: "openaiReviewer",
        provider: "openai",
        family: "openai",
        capabilities: ["code_review"],
        tools: ["filesystem"],
        costClass: "near_zero",
      }),
      worker({
        id: "anthropicReviewer",
        provider: "anthropic",
        family: "anthropic",
        capabilities: ["code_review"],
        tools: ["filesystem"],
        costClass: "medium",
      }),
    ]), { reviewPolicy: { sameFamilyReviewerFallback: true } });
    const result = s.requestAllocation(request({
      requiredRoles: ["seniorImplementer", "independentReviewer"],
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.allocation.leases.find((lease) => lease.role === "independentReviewer")?.workerId).toBe("anthropicReviewer");
    expect(result.reviewPolicy.explanations[0]).toMatchObject({
      decision: "opposite_family_selected",
      oppositeFamilyCandidateIds: ["anthropicReviewer"],
      sameFamilyCandidateIds: ["openaiReviewer"],
    });
  });

  it("blocks atomically when provider quota is exhausted by the required team", () => {
    const s = scheduler(config([
      worker({ id: "openaiOne", provider: "openai", family: "openai" }),
      worker({ id: "openaiTwo", provider: "openai", family: "openai" }),
    ], {
      quotas: { providers: { openai: { maxActiveLeases: 1 } }, families: {} },
    }));
    const result = s.requestAllocation(request({ requiredRoles: ["seniorImplementer", "qaGate"] }));

    expect(result.ok).toBe(false);
    expect(s.listLeases()).toHaveLength(0);
  });

  it("releases and retries queued work without a live waiting model", () => {
    const s = scheduler(config([worker({ id: "codexSenior", provider: "openai", family: "openai" })]));
    const first = s.requestAllocation(request({ taskId: "task-1" }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    s.requestAllocation(request({ taskId: "task-2", coordinatorId: "coord-2" }));

    s.releaseLease(first.allocation.leases[0].leaseId, "coord-1");
    const retried = s.retryQueued();

    expect(retried).toHaveLength(1);
    expect(retried[0].ok).toBe(true);
    if (!retried[0].ok) return;
    expect(retried[0].allocation.taskId).toBe("task-2");
  });

  it("marks allocations completed after all leases are released", () => {
    const s = scheduler(config([worker({ id: "codexSenior", provider: "openai", family: "openai" })]));
    const result = s.requestAllocation(request());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    s.releaseLease(result.allocation.leases[0].leaseId, "coord-1");

    expect(s.listAllocations()).toMatchObject([{
      allocationId: result.allocation.allocationId,
      state: "completed",
      updatedAt: fixedNow.toISOString(),
    }]);
  });

  it("expires leases deterministically and rejects expired lease validation", () => {
    const s = new MatrixScheduler(config([worker({ id: "codexSenior", provider: "openai", family: "openai" })]), {
      now: () => fixedNow,
    });
    const result = s.requestAllocation(request({ leaseDurationMs: 1000 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const leaseId = result.allocation.leases[0].leaseId;

    const expired = s.expireLeases(new Date("2026-06-23T12:00:01.000Z"));

    expect(expired.map((lease) => lease.leaseId)).toEqual([leaseId]);
    expect(s.validateLeaseForWorker("codexSenior", leaseId, "task-1", "coord-1")).toEqual({ ok: false, reason: "lease_expired" });
    expect(s.listAllocations()).toMatchObject([{ state: "expired" }]);
  });

  it("prunes old terminal allocations without pruning running allocations", () => {
    let now = fixedNow;
    const s = new MatrixScheduler(config([worker({ id: "codexSenior", provider: "openai", family: "openai" })]), {
      now: () => now,
      retention: {
        terminalAllocationRetentionMs: 500,
        terminalAllocationLimit: 10,
      },
    });
    const first = s.requestAllocation(request({ taskId: "terminal" }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    s.releaseLease(first.allocation.leases[0].leaseId, "coord-1");

    now = new Date(fixedNow.getTime() + 1_000);
    const second = s.requestAllocation(request({ taskId: "running", coordinatorId: "coord-running" }));
    expect(second.ok).toBe(true);

    expect(s.listAllocations().map((allocation) => allocation.taskId)).toEqual(["running"]);
  });

  it("caps retained terminal allocations by newest updatedAt", () => {
    let now = fixedNow;
    const s = new MatrixScheduler(config([worker({ id: "codexSenior", provider: "openai", family: "openai" })]), {
      now: () => now,
      retention: {
        terminalAllocationRetentionMs: 60_000,
        terminalAllocationLimit: 1,
      },
    });
    for (const taskId of ["old-terminal", "new-terminal"]) {
      const result = s.requestAllocation(request({ taskId, coordinatorId: `coord-${taskId}` }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      s.releaseLease(result.allocation.leases[0].leaseId, `coord-${taskId}`);
      now = new Date(now.getTime() + 1);
    }

    expect(s.listAllocations().map((allocation) => allocation.taskId)).toEqual(["new-terminal"]);
  });

  it("prunes terminal leases with no owning allocation, but keeps leases still referenced by a live allocation", () => {
    let now = fixedNow;
    const workers = [
      worker({ id: "codexSenior", provider: "openai", family: "openai" }),
      worker({ id: "claudeReviewer", provider: "anthropic", family: "anthropic" }),
    ];
    const cfg = config(workers, {
      coordinatorTemplates: [
        {
          id: "twoRole",
          purpose: "feature work",
          requiredRoles: ["seniorImplementer", "independentReviewer"],
          optionalRoles: [],
        },
      ],
    });
    const s = new MatrixScheduler(cfg, {
      now: () => now,
      retention: { terminalAllocationRetentionMs: 500, terminalAllocationLimit: 10 },
    });

    const result = s.requestAllocation(request({
      taskId: "task-1",
      coordinatorId: "coord-1",
      coordinatorTemplate: "twoRole",
      requiredRoles: ["seniorImplementer", "independentReviewer"],
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const implLease = result.allocation.leases.find((lease) => lease.role === "seniorImplementer")!;
    const reviewLease = result.allocation.leases.find((lease) => lease.role === "independentReviewer")!;

    // Releasing only one of two leases leaves the allocation live ("allocated"); the
    // released lease is still referenced by that allocation and must not be pruned.
    s.releaseLease(implLease.leaseId, "coord-1");
    expect(s.listLeases().map((lease) => lease.leaseId)).toContain(implLease.leaseId);
    expect(s.listAllocations()).toHaveLength(1);

    // Releasing the remaining lease completes the allocation, but it is still fresh
    // (within the retention window), so neither the allocation nor its leases are pruned yet.
    s.releaseLease(reviewLease.leaseId, "coord-1");
    expect(s.listAllocations()).toHaveLength(1);
    expect(s.listLeases().map((lease) => lease.leaseId).sort()).toEqual([implLease.leaseId, reviewLease.leaseId].sort());

    // Age the completed allocation past the retention window, then trigger another
    // mutation so a prune pass runs: the allocation is pruned, orphaning its leases,
    // which must then be pruned from memory as well.
    now = new Date(now.getTime() + 1_000);
    const unrelated = s.requestAllocation(request({ taskId: "unrelated", coordinatorId: "coord-unrelated" }));
    expect(unrelated.ok).toBe(true);

    expect(s.listAllocations().map((allocation) => allocation.taskId)).toEqual(["unrelated"]);
    expect(s.listLeases().map((lease) => lease.taskId)).toEqual(["unrelated"]);
  });

  it("bounds scheduler internal telemetry while preserving allocation behavior", () => {
    let now = fixedNow;
    const s = new MatrixScheduler(config([worker({ id: "codexSenior", provider: "openai", family: "openai" })]), {
      now: () => now,
      retention: { telemetryRetentionMs: 60_000, telemetryEventLimit: 2 },
    });
    for (const taskId of ["one", "two", "three"]) {
      const result = s.requestAllocation(request({ taskId, coordinatorId: `coord-${taskId}` }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      s.releaseLease(result.allocation.leases[0].leaseId, `coord-${taskId}`);
      now = new Date(now.getTime() + 1);
    }

    expect(s.listTelemetry()).toHaveLength(2);
    expect(s.listTelemetry().map((event) => event.type)).toEqual(["allocation_created", "lease_released"]);
  });

  it("renews lease expiry on heartbeat with the original lease duration", () => {
    let now = fixedNow;
    const s = new MatrixScheduler(config([worker({ id: "codexSenior", provider: "openai", family: "openai" })]), {
      now: () => now,
    });
    const result = s.requestAllocation(request({ leaseDurationMs: 1_000 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const leaseId = result.allocation.leases[0].leaseId;

    now = new Date("2026-06-23T12:00:00.750Z");
    const renewed = s.heartbeatLease(leaseId, "coord-1");
    expect(renewed.leaseExpiresAt).toBe("2026-06-23T12:00:01.750Z");

    expect(s.expireLeases(new Date("2026-06-23T12:00:01.000Z"))).toEqual([]);
    expect(s.validateLeaseForWorker("codexSenior", leaseId, "task-1", "coord-1")).toEqual({ ok: true });
  });

  it("rejects heartbeat for expired but unswept leases", () => {
    let now = fixedNow;
    const s = new MatrixScheduler(config([worker({ id: "codexSenior", provider: "openai", family: "openai" })]), {
      now: () => now,
    });
    const result = s.requestAllocation(request({ leaseDurationMs: 1_000 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const leaseId = result.allocation.leases[0].leaseId;

    now = new Date("2026-06-23T12:00:01.001Z");

    expect(() => s.heartbeatLease(leaseId, "coord-1")).toThrow(/expired/);
    expect(s.validateLeaseForWorker("codexSenior", leaseId, "task-1", "coord-1")).toEqual({ ok: false, reason: "lease_expired" });
  });

  it("retries queued work by priority", () => {
    const s = scheduler(config([worker({ id: "codexSenior", provider: "openai", family: "openai" })]));
    const first = s.requestAllocation(request({ taskId: "running" }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    s.requestAllocation(request({ taskId: "low", coordinatorId: "coord-low", priority: "low" }));
    s.requestAllocation(request({ taskId: "high", coordinatorId: "coord-high", priority: "high" }));

    s.releaseLease(first.allocation.leases[0].leaseId);
    const retried = s.retryQueued();

    expect(retried[0].ok).toBe(true);
    if (!retried[0].ok) return;
    expect(retried[0].allocation.taskId).toBe("high");
  });

  it("validateLeaseForWorker returns each failure code for the appropriate mismatch", () => {
    const s = scheduler(config([
      worker({ id: "codexSenior", provider: "openai", family: "openai" }),
      worker({ id: "haikuReviewer", provider: "anthropic", family: "anthropic" }),
    ]));
    const result = s.requestAllocation(request({ taskId: "task-1", coordinatorId: "coord-1" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const leaseId = result.allocation.leases[0].leaseId;

    // lease_not_found: bogus leaseId
    expect(s.validateLeaseForWorker("codexSenior", "nonexistent-lease", "task-1", "coord-1"))
      .toEqual({ ok: false, reason: "lease_not_found" });

    // worker_mismatch: wrong workerId
    expect(s.validateLeaseForWorker("haikuReviewer", leaseId, "task-1", "coord-1"))
      .toEqual({ ok: false, reason: "worker_mismatch" });

    // task_mismatch: wrong taskId
    expect(s.validateLeaseForWorker("codexSenior", leaseId, "task-other", "coord-1"))
      .toEqual({ ok: false, reason: "task_mismatch" });

    // coordinator_mismatch: wrong coordinatorId
    expect(s.validateLeaseForWorker("codexSenior", leaseId, "task-1", "coord-other"))
      .toEqual({ ok: false, reason: "coordinator_mismatch" });

    // lease_expired: explicitly expire via expireLeases (short duration)
    const shortResult = s.requestAllocation(request({ taskId: "task-short", coordinatorId: "coord-short", leaseDurationMs: 1 }));
    expect(shortResult.ok).toBe(true);
    if (!shortResult.ok) return;
    const shortLeaseId = shortResult.allocation.leases[0].leaseId;
    const expired = s.expireLeases(new Date(fixedNow.getTime() + 100));
    expect(expired.some((l) => l.leaseId === shortLeaseId)).toBe(true);
    expect(s.validateLeaseForWorker("codexSenior", shortLeaseId, "task-short", "coord-short"))
      .toEqual({ ok: false, reason: "lease_expired" });

    // lease_released: release and check
    s.releaseLease(leaseId, "coord-1");
    expect(s.validateLeaseForWorker("codexSenior", leaseId, "task-1", "coord-1"))
      .toEqual({ ok: false, reason: "lease_released" });
  });

  it("allowedWorkerIds headroom gate blocks excluded workers from allocation", () => {
    const s = scheduler(config([
      worker({ id: "allowed", provider: "openai", family: "openai" }),
      worker({ id: "blocked", provider: "openai", family: "openai" }),
    ]));

    // Only "allowed" is in the allowed set
    const result = s.requestAllocation(request(), { allowedWorkerIds: new Set(["allowed"]) });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.allocation.leases[0].workerId).toBe("allowed");

    // Now block the only remaining worker by passing an empty allowed set
    const empty = s.requestAllocation(request({ taskId: "task-2", coordinatorId: "coord-2" }), {
      allowedWorkerIds: new Set<string>(),
    });
    expect(empty.ok).toBe(false);
    expect(s.listLeases().filter((l) => l.taskId === "task-2")).toHaveLength(0);
  });
});
