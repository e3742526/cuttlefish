import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiContext } from "../../gateway/api.js";
import type { Engine, EngineRunOpts, EngineResult, CuttlefishConfig } from "../../shared/types.js";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import type { OrchestrationConfig, Worker } from "../types.js";

let tmpHome: string;
const testHome = withTempCuttlefishHome("cuttlefish-orch-run-mode-");

// Lets one test force the run-ledger's transitionRun to throw exactly once,
// to exercise the lease-release-on-ledger-failure path in run-mode.ts.
let forceLedgerTransitionFailureOnce = false;

vi.mock("../../run-ledger/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../run-ledger/index.js")>();
  return {
    ...actual,
    getRunLedger: (...args: Parameters<typeof actual.getRunLedger>) => {
      const store = actual.getRunLedger(...args);
      return new Proxy(store, {
        get(target, prop, receiver) {
          if (prop === "transitionRun" && forceLedgerTransitionFailureOnce) {
            forceLedgerTransitionFailureOnce = false;
            return () => {
              throw new Error("simulated ledger failure");
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    },
  };
});

beforeEach(() => {
  tmpHome = testHome.home();
  forceLedgerTransitionFailureOnce = false;
  vi.resetModules();
});

afterEach(() => {
  forceLedgerTransitionFailureOnce = false;
  vi.resetModules();
});

describe("runOrchestrationTask", () => {
  it("runs five low-risk single-worker tasks and releases every lease", async () => {
    const { runOrchestrationTask, OrchestrationRuntime, getSession } = await loadModules();
    const engine = new RecordingEngine();
    const runtime = new OrchestrationRuntime({ config: config(), dbPath: ":memory:", startReaper: false });
    const ctx = makeContext(runtime, engine);

    for (let i = 0; i < 5; i++) {
      const result = await runOrchestrationTask({
        context: ctx,
        task: {
          taskId: `task-${i}`,
          coordinatorId: `coord-${i}`,
          requiredRoles: ["seniorImplementer"],
          mode: "single_worker",
          prompt: `Implement low-risk task ${i}`,
          leaseDurationMs: 60_000,
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.sessions[0]).toMatchObject({ role: "seniorImplementer", status: "idle", error: null });
      expect(getSession(result.sessions[0].sessionId)?.transportMeta).toMatchObject({
        orchestrationLease: {
          leaseId: result.sessions[0].leaseId,
          workerId: "mockImplementer",
          mode: "single_worker",
        },
      });
    }

    expect(engine.run).toHaveBeenCalledTimes(5);
    expect(runtime.listLeases().every((lease) => lease.state === "released")).toBe(true);
    expect(runtime.listQueue()).toEqual([]);
    runtime.close();
  }, 15_000);

  it("releases already-granted leases when the run-ledger write fails before any lease turn starts", async () => {
    const { runOrchestrationTask, OrchestrationRuntime } = await loadModules();
    const engine = new RecordingEngine();
    const runtime = new OrchestrationRuntime({ config: config(), dbPath: ":memory:", startReaper: false });
    const ctx = makeContext(runtime, engine);

    forceLedgerTransitionFailureOnce = true;
    await expect(
      runOrchestrationTask({
        context: ctx,
        task: {
          taskId: "task-ledger-fail",
          coordinatorId: "coord-ledger-fail",
          requiredRoles: ["seniorImplementer"],
          mode: "single_worker",
          prompt: "Task whose ledger write fails before any lease turn",
        },
      }),
    ).rejects.toThrow("simulated ledger failure");

    expect(engine.run).not.toHaveBeenCalled();
    expect(runtime.listLeases().every((lease) => lease.state === "released")).toBe(true);
    runtime.close();
  });

  it("runs implementer and reviewer leases sequentially in review mode", async () => {
    const { runOrchestrationTask, OrchestrationRuntime } = await loadModules();
    const engine = new RecordingEngine();
    const runtime = new OrchestrationRuntime({ config: reviewConfig(), dbPath: ":memory:", startReaper: false });
    const ctx = makeContext(runtime, engine);

    const result = await runOrchestrationTask({
      context: ctx,
      task: {
        taskId: "task-review",
        coordinatorId: "coord-review",
        coordinatorTemplate: "withReview",
        mode: "single_worker_with_review",
        prompt: "Implement and review a small task",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessions.map((session) => session.role)).toEqual(["seniorImplementer", "independentReviewer"]);
    expect(engine.prompts[1]).toContain("Review-only pass");
    expect(result.reviewPolicy.explanations[0]).toMatchObject({
      decision: "opposite_family_selected",
      selectedWorkerId: "mockReviewer",
    });
    expect(runtime.listLeases().map((lease) => lease.state)).toEqual(["released", "released"]);
    runtime.close();
  });

  it("emits one durable telemetry record for a successful single-worker run", async () => {
    const { runOrchestrationTask, OrchestrationRuntime, readOrchestrationTelemetry, ORCHESTRATION_TELEMETRY_LOG } = await loadModules();
    const engine = new RecordingEngine();
    const runtime = new OrchestrationRuntime({ config: config(), dbPath: ":memory:", startReaper: false });
    const ctx = makeContext(runtime, engine);

    const result = await runOrchestrationTask({
      context: ctx,
      task: {
        taskId: "task-telemetry",
        coordinatorId: "coord-telemetry",
        requiredRoles: ["seniorImplementer"],
        mode: "single_worker",
        prompt: "Implement telemetry-covered task",
      },
    });

    expect(result.ok).toBe(true);
    const read = readOrchestrationTelemetry(ORCHESTRATION_TELEMETRY_LOG);
    expect(read.skippedLines).toBe(0);
    expect(read.records).toHaveLength(1);
    expect(read.records[0]).toMatchObject({
      task_id: "task-telemetry",
      coordinator_id: "coord-telemetry",
      worker_id: "mockImplementer",
      provider: "mock",
      family: "local",
      role: "seniorImplementer",
      mode: "single_worker",
      source: "orchestration",
      cost: 0.001,
      latency_ms: 123,
      tokens: 456,
      disposition: "completed",
    });
    expect(fs.readFileSync(ORCHESTRATION_TELEMETRY_LOG, "utf-8")).not.toContain("Implement telemetry-covered task");
    runtime.close();
  });

  it("blocks live review runs when only same-family reviewers qualify and fallback is disabled", async () => {
    const { runOrchestrationTask, OrchestrationRuntime } = await loadModules();
    const engine = new RecordingEngine();
    const runtime = new OrchestrationRuntime({ config: sameFamilyReviewConfig(), dbPath: ":memory:", startReaper: false });
    const ctx = makeContext(runtime, engine);

    const result = await runOrchestrationTask({
      context: ctx,
      task: {
        taskId: "task-same-family-blocked",
        coordinatorId: "coord-same-family-blocked",
        coordinatorTemplate: "withReview",
        mode: "single_worker_with_review",
        prompt: "Implement and review a same-family-only task",
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.state !== "blocked_resource") return;
    expect(result.queueItem.missingRoles).toEqual(["independentReviewer"]);
    expect(result.reviewPolicy.explanations[0]).toMatchObject({
      decision: "same_family_fallback_forbidden",
      sameFamilyCandidateIds: ["mockReviewer"],
    });
    expect(runtime.listLiveContinuations()).toMatchObject([{ taskId: "task-same-family-blocked", state: "queued" }]);
    expect(engine.run).not.toHaveBeenCalled();
    runtime.close();
  });

  it("blocks before leasing when live headroom rejects every worker", async () => {
    const { runOrchestrationTask, OrchestrationRuntime } = await loadModules();
    const engine = new RecordingEngine();
    const cfg = cuttlefishConfig();
    const runtime = new OrchestrationRuntime({
      config: config(),
      dbPath: ":memory:",
      startReaper: false,
      cuttlefishConfig: cfg,
      headroomFilter: async (workers) => ({
        allowed: [],
        rejected: workers.map((worker) => ({
          worker,
          headroom: { ok: false, provider: worker.provider, reason: "usage_exhausted" },
        })),
      }),
    });
    const ctx = makeContext(runtime, engine, cfg);

    const result = await runOrchestrationTask({
      context: ctx,
      task: {
        taskId: "task-no-headroom",
        coordinatorId: "coord-no-headroom",
        requiredRoles: ["seniorImplementer"],
        mode: "single_worker",
        prompt: "Do not lease an exhausted worker",
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.state !== "blocked_resource") return;
    expect(runtime.listLeases()).toEqual([]);
    expect(runtime.listLiveContinuations()).toMatchObject([{ taskId: "task-no-headroom", state: "queued" }]);
    expect(engine.run).not.toHaveBeenCalled();
    runtime.close();
  });

  it("releases an allocated lease when session setup cannot resolve the engine", async () => {
    const { runOrchestrationTask, OrchestrationRuntime } = await loadModules();
    const missingEngineConfig = {
      ...config(),
      workers: config().workers.map((entry) => ({ ...entry, provider: "missing-engine" })),
    };
    const runtime = new OrchestrationRuntime({ config: missingEngineConfig, dbPath: ":memory:", startReaper: false });
    const ctx = makeContext(runtime, new RecordingEngine());

    await expect(runOrchestrationTask({
      context: ctx,
      task: {
        taskId: "task-missing-engine",
        coordinatorId: "coord-missing-engine",
        requiredRoles: ["seniorImplementer"],
        mode: "single_worker",
        prompt: "This should release on setup failure",
      },
    })).rejects.toThrow("engine for worker provider missing-engine is not available");

    expect(runtime.listLeases()).toMatchObject([{ taskId: "task-missing-engine", state: "released" }]);
    runtime.close();
  });

  it("runs same-family reviewer fallback only when explicitly configured and records session metadata", async () => {
    const { runOrchestrationTask, OrchestrationRuntime, getSession } = await loadModules();
    const engine = new RecordingEngine();
    const runtime = new OrchestrationRuntime({
      config: sameFamilyReviewConfig(),
      dbPath: ":memory:",
      startReaper: false,
      reviewPolicy: { sameFamilyReviewerFallback: true },
    });
    const cfg = cuttlefishConfig({ sameFamilyReviewerFallback: true });
    const ctx = makeContext(runtime, engine, cfg);

    const result = await runOrchestrationTask({
      context: ctx,
      task: {
        taskId: "task-same-family-fallback",
        coordinatorId: "coord-same-family-fallback",
        coordinatorTemplate: "withReview",
        mode: "single_worker_with_review",
        prompt: "Implement and review with explicit fallback",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reviewPolicy.explanations[0]).toMatchObject({
      decision: "same_family_fallback_used",
      selectedWorkerId: "mockReviewer",
      sameFamilyReviewerFallback: true,
    });
    const reviewerSession = result.sessions.find((session) => session.role === "independentReviewer");
    expect(reviewerSession?.reviewPolicy?.decision).toBe("same_family_fallback_used");
    expect(getSession(reviewerSession?.sessionId ?? "")?.transportMeta).toMatchObject({
      orchestrationReviewPolicy: {
        decision: "same_family_fallback_used",
        selectedWorkerId: "mockReviewer",
      },
    });
    expect(engine.run).toHaveBeenCalledTimes(2);
    runtime.close();
  });

  it("returns a failed top-level result when any role session errors", async () => {
    const { runOrchestrationTask, OrchestrationRuntime } = await loadModules();
    const engine = new RecordingEngine({ throwOnPromptSubstring: "Review-only pass" });
    const runtime = new OrchestrationRuntime({ config: reviewConfig(), dbPath: ":memory:", startReaper: false });
    const ctx = makeContext(runtime, engine);

    const result = await runOrchestrationTask({
      context: ctx,
      task: {
        taskId: "task-review-failure",
        coordinatorId: "coord-review-failure",
        coordinatorTemplate: "withReview",
        mode: "single_worker_with_review",
        prompt: "Implement and review a task with a reviewer failure",
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.state !== "failed") return;
    expect(result.errorSummary).toContain("independentReviewer failed");
    expect(result.sessions.map((session) => session.role)).toEqual(["seniorImplementer", "independentReviewer"]);
    expect(result.sessions[1]).toMatchObject({ status: "error" });
    runtime.close();
  });

  it("routes reviewer to a diff-only bundle, records diff counts, and cleans up the implementation worktree", async () => {
    const { runOrchestrationTask, OrchestrationRuntime, readOrchestrationTelemetry, ORCHESTRATION_TELEMETRY_LOG } = await loadModules();
    const repo = path.join(tmpHome, "repo");
    initGitRepo(repo);
    const engine = new RecordingEngine();
    const runtime = new OrchestrationRuntime({
      config: reviewWorktreeConfig(),
      dbPath: ":memory:",
      startReaper: false,
      worktreeRoot: path.join(tmpHome, "worktrees"),
      maxWorktrees: 2,
    });
    const ctx = makeContext(runtime, engine);

    const result = await runOrchestrationTask({
      context: ctx,
      task: {
        taskId: "task-review-worktree",
        coordinatorId: "coord-review-worktree",
        coordinatorTemplate: "withReview",
        mode: "single_worker_with_review",
        cwd: repo,
        prompt: "Implement in an isolated worktree and review the patch",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessions.map((session) => session.workspaceMode)).toEqual([
      "implementation_worktree",
      "review_bundle",
    ]);
    expect(result.sessions[1].cwd).not.toBe(result.sessions[0].cwd);
    expect(result.sessions[1].reviewBundlePath).toBeDefined();
    expect(engine.reviewerSawPatchDiff).toBe(true);
    expect(engine.reviewerSawMetadata).toBe(true);
    expect(engine.reviewerSawImplementationFile).toBe(false);
    expect(fs.existsSync(result.sessions[0].cwd)).toBe(false);
    expect(fs.existsSync(result.sessions[1].cwd)).toBe(false);
    const records = readOrchestrationTelemetry(ORCHESTRATION_TELEMETRY_LOG).records;
    const implementerTelemetry = records.find((record) => record.role === "seniorImplementer");
    const reviewerTelemetry = records.find((record) => record.role === "independentReviewer");
    expect(implementerTelemetry).toMatchObject({ files_changed: 1, tests_added: 0 });
    expect(reviewerTelemetry).toMatchObject({ files_changed: null, tests_added: null });
    expect(runtime.listLeases().map((lease) => lease.state)).toEqual(["released", "released"]);
    runtime.close();
  });

  it("persists blocked continuations and auto-resumes them on lease release", async () => {
    const { runOrchestrationTask, runAllocatedOrchestrationTask, OrchestrationRuntime } = await loadModules();
    const engine = new RecordingEngine({ blockRuns: 1 });
    const runtime = new OrchestrationRuntime({ config: config(), dbPath: ":memory:", startReaper: false });
    const ctx = makeContext(runtime, engine);
    runtime.setResumeQueuedRunHandler(async ({ continuation, allocation, reviewPolicy }) => {
      const result = await runAllocatedOrchestrationTask({
        context: ctx,
        mode: continuation.mode,
        task: continuation.task,
        allocation,
        reviewPolicy,
      });
      if (!result.ok) throw new Error(result.state === "failed" ? result.errorSummary : result.state);
    });

    const firstRun = runOrchestrationTask({
      context: ctx,
      task: {
        taskId: "task-1",
        coordinatorId: "coord-1",
        requiredRoles: ["seniorImplementer"],
        mode: "single_worker",
        prompt: "Long-running implementer task",
      },
    });
    await waitFor(() => engine.blockedWaiterCount() === 1);

    const blocked = await runOrchestrationTask({
      context: ctx,
      task: {
        taskId: "task-2",
        coordinatorId: "coord-2",
        requiredRoles: ["seniorImplementer"],
        mode: "single_worker",
        prompt: "Blocked task that should resume",
      },
    });

    expect(blocked.ok).toBe(false);
    if (blocked.ok || blocked.state !== "blocked_resource") return;
    expect(runtime.listLiveContinuations()).toMatchObject([{ taskId: "task-2", state: "queued" }]);
    engine.unblockNext();
    const completed = await firstRun;
    expect(completed.ok).toBe(true);

    await waitFor(() => engine.run.mock.calls.length === 2);
    await waitFor(() => runtime.listLiveContinuations().find((entry) => entry.taskId === "task-2")?.state === "completed");
    expect(runtime.listQueue()).toEqual([]);
    expect(runtime.listLeases().every((lease) => lease.state === "released")).toBe(true);
    runtime.close();
  });
});

async function loadModules() {
  const [runMode, runtime, registry, telemetry] = await Promise.all([
    import("../run-mode.js"),
    import("../runtime.js"),
    import("../../sessions/registry.js"),
    import("../telemetry.js"),
  ]);
  registry.initDb();
  return {
    runOrchestrationTask: runMode.runOrchestrationTask,
    runAllocatedOrchestrationTask: runMode.runAllocatedOrchestrationTask,
    OrchestrationRuntime: runtime.OrchestrationRuntime,
    getSession: registry.getSession,
    readOrchestrationTelemetry: telemetry.readOrchestrationTelemetry,
    ORCHESTRATION_TELEMETRY_LOG: telemetry.ORCHESTRATION_TELEMETRY_LOG,
  };
}

class RecordingEngine implements Engine {
  name = "mock";
  prompts: string[] = [];
  cwds: string[] = [];
  reviewerSawPatchDiff = false;
  reviewerSawMetadata = false;
  reviewerSawImplementationFile = false;
  private readonly releaseWaiters: Array<() => void> = [];
  private remainingBlocks: number;
  private readonly throwOnPromptSubstring?: string;

  constructor(opts: { blockRuns?: number; throwOnPromptSubstring?: string } = {}) {
    this.remainingBlocks = opts.blockRuns ?? 0;
    this.throwOnPromptSubstring = opts.throwOnPromptSubstring;
  }

  blockedWaiterCount(): number {
    return this.releaseWaiters.length;
  }

  unblockNext(): void {
    this.releaseWaiters.shift()?.();
  }

  run = vi.fn(async (opts: EngineRunOpts): Promise<EngineResult> => {
    this.prompts.push(opts.prompt);
    this.cwds.push(opts.cwd);
    if (this.throwOnPromptSubstring && opts.prompt.includes(this.throwOnPromptSubstring)) {
      throw new Error("forced engine failure");
    }
    if (this.remainingBlocks > 0) {
      this.remainingBlocks -= 1;
      await new Promise<void>((resolve) => this.releaseWaiters.push(resolve));
    }

    if (opts.prompt.includes("Review-only pass")) {
      this.reviewerSawPatchDiff = fs.existsSync(path.join(opts.cwd, "patch.diff"));
      this.reviewerSawMetadata = fs.existsSync(path.join(opts.cwd, "metadata.json"));
      this.reviewerSawImplementationFile = fs.existsSync(path.join(opts.cwd, "implemented.txt"));
    } else {
      fs.writeFileSync(path.join(opts.cwd, "implemented.txt"), "implemented\n");
    }
    opts.onStream?.({ type: "text", content: "mock complete" });
    return { sessionId: opts.sessionId ?? "mock-session", result: "mock complete", cost: 0.001, durationMs: 123, contextTokens: 456 };
  });
}

function makeContext(runtime: unknown, engine: Engine, cfg: CuttlefishConfig = cuttlefishConfig()): ApiContext {
  return {
    config: cfg,
    getConfig: () => cfg,
    startTime: Date.now(),
    emit: vi.fn(),
    connectors: new Map(),
    sessionManager: {
      getEngine: (name: string) => name === "mock" ? engine : undefined,
      getEngines: () => new Map([["mock", engine]]),
      getQueue: () => ({
        enqueue: async (_key: string, run: () => Promise<void>) => run(),
        getTransportState: (_key: string, status: string) => status,
        getPendingCount: () => 0,
      }),
    },
    orchestration: { runtime },
  } as unknown as ApiContext;
}

function worker(overrides: Partial<Worker> & Pick<Worker, "id" | "provider" | "family">): Worker {
  return {
    tier: "frontier",
    capabilities: ["repo_edit", "coding", "code_review"],
    tools: ["git", "filesystem"],
    maxConcurrentTasks: 1,
    costClass: "low",
    workspacePolicy: "shared",
    ...overrides,
  };
}

function config(): OrchestrationConfig {
  return {
    workers: [worker({ id: "mockImplementer", provider: "mock", family: "local" })],
    roles: [
      { id: "seniorImplementer", requiredCapabilities: ["repo_edit", "coding"], requiredTools: ["git", "filesystem"] },
    ],
    coordinatorTemplates: [],
    quotas: { providers: {}, families: {} },
  };
}

function reviewConfig(): OrchestrationConfig {
  return {
    workers: [
      worker({ id: "mockImplementer", provider: "mock", family: "local" }),
      worker({ id: "mockReviewer", provider: "mock", family: "review" }),
    ],
    roles: [
      { id: "seniorImplementer", requiredCapabilities: ["repo_edit", "coding"], requiredTools: ["git", "filesystem"] },
      { id: "independentReviewer", requiredCapabilities: ["code_review"], requiredTools: ["filesystem"], familyConstraint: "opposite_of_implementer" },
    ],
    coordinatorTemplates: [
      { id: "withReview", purpose: "implementation with review", requiredRoles: ["seniorImplementer", "independentReviewer"], optionalRoles: [] },
    ],
    quotas: { providers: {}, families: {} },
  };
}

function sameFamilyReviewConfig(): OrchestrationConfig {
  const cfg = reviewConfig();
  return {
    ...cfg,
    workers: cfg.workers.map((entry) => ({ ...entry, family: "local" })),
  };
}

function reviewWorktreeConfig(): OrchestrationConfig {
  const cfg = reviewConfig();
  return {
    ...cfg,
    workers: cfg.workers.map((entry) =>
      entry.id === "mockImplementer"
        ? { ...entry, workspacePolicy: "isolated_worktree" }
        : { ...entry, workspacePolicy: "read_only" }),
  };
}

function cuttlefishConfig(orchestration: Partial<NonNullable<CuttlefishConfig["orchestration"]>> = {}): CuttlefishConfig {
  return {
    gateway: { port: 8888, host: "127.0.0.1" },
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt" },
    },
    connectors: {},
    logging: { file: false, stdout: false, level: "error" },
    orchestration: { enabled: true, ...orchestration },
  } as CuttlefishConfig;
}

function initGitRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(["init"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test User"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "base\n");
  git(["add", "README.md"], dir);
  git(["commit", "-m", "initial"], dir);
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
