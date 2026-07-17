import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiContext } from "../../gateway/api.js";
import type { Engine, EngineRunOpts, EngineResult, CuttlefishConfig } from "../../shared/types.js";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import type { OrchestrationConfig, Worker } from "../types.js";
import type { DualLaneRunLane } from "../dual-lane.js";

let tmpHome: string;
const testHome = withTempCuttlefishHome("cuttlefish-dual-lane-");

beforeEach(() => {
  tmpHome = testHome.home();
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
});

describe("dual-lane orchestration", () => {
  it("runs identical prompts in isolated worktrees and requires explicit selection", async () => {
    const {
      OrchestrationRuntime,
      applyDualLaneWinner,
      runOrchestrationTask,
      selectDualLaneWinner,
      readDualLaneManifest,
      readOrchestrationTelemetry,
      ORCHESTRATION_TELEMETRY_LOG,
    } = await loadModules();
    const repo = path.join(tmpHome, "repo");
    initGitRepo(repo);
    const engine = new LaneWritingEngine();
    const runtime = new OrchestrationRuntime({
      config: dualLaneConfig(),
      dbPath: ":memory:",
      startReaper: false,
      worktreeRoot: path.join(tmpHome, "worktrees"),
      maxWorktrees: 4,
    });
    const ctx = makeContext(runtime, engine);

    const result = await runOrchestrationTask({
      context: ctx,
      mode: "dual_lane",
      task: {
        taskId: "task-dual",
        coordinatorId: "coord-dual",
        mode: "dual_lane",
        cwd: repo,
        prompt: "Implement the same capability in both lanes",
      },
    });

    expect(result.ok).toBe(true);
    expect(result.state).toBe("selection_required");
    if (!result.ok || result.state !== "selection_required") return;
    expect(engine.prompts).toEqual([
      "Implement the same capability in both lanes",
      "Implement the same capability in both lanes",
    ]);
    expect(new Set(result.lanes.map((lane) => lane.worktreePath)).size).toBe(2);
    expect(result.comparisonReport.uniqueFiles.openai).toEqual(["openai.txt"]);
    expect(result.comparisonReport.uniqueFiles.anthropic).toEqual(["anthropic.txt"]);
    expect(result.comparisonReport.majorDifferences.join("\n")).toContain("OpenAI-only files");
    expect(result.selection).toEqual({ required: true, default: "human", options: ["openai", "anthropic"] });

    const worktreePaths = result.lanes.map((lane) => lane.worktreePath ?? "");
    expect(worktreePaths.every((worktreePath) => fs.existsSync(worktreePath))).toBe(true);
    expect(runtime.reapWorktrees()).toEqual([]);
    expect(worktreePaths.every((worktreePath) => fs.existsSync(worktreePath))).toBe(true);

    const selection = selectDualLaneWinner({ taskId: "task-dual", coordinatorId: "coord-dual", winnerLane: "openai" });
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    expect(selection.selectedLane).toBe("openai");
    expect(selection.archivedLane).toBe("anthropic");
    expect(fs.existsSync(selection.winnerWorktreePath)).toBe(true);
    expect(fs.existsSync(selection.archive.diffPath)).toBe(true);
    expect(fs.readFileSync(selection.archive.diffPath, "utf-8")).toContain("anthropic.txt");
    expect(fs.existsSync(worktreePaths.find((worktreePath) => worktreePath.includes("-anthropic")) ?? "")).toBe(false);
    expect(readDualLaneManifest("task-dual", "coord-dual")?.state).toBe("selected");
    const apply = applyDualLaneWinner({ taskId: "task-dual", coordinatorId: "coord-dual", winnerLane: "openai", store: runtime.getStore() });
    expect(apply.ok).toBe(true);
    if (!apply.ok) return;
    expect(fs.readFileSync(path.join(repo, "openai.txt"), "utf-8")).toContain("Implement the same capability");
    expect(git(["status", "--porcelain"], repo)).toContain("?? openai.txt");
    expect(runtime.getStore().listArtifactRecords("task-dual", "diff")).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "diff", lane: "openai" }),
      expect.objectContaining({ kind: "diff", lane: "anthropic" }),
    ]));
    expect(runtime.getStore().listPatchApplyAttempts("task-dual")).toMatchObject([{ state: "applied" }]);
    const telemetry = readOrchestrationTelemetry(ORCHESTRATION_TELEMETRY_LOG).records;
    expect(telemetry).toHaveLength(4);
    expect(telemetry.filter((record) => record.mode === "dual_lane" && record.disposition === "completed")).toHaveLength(2);
    expect(telemetry.find((record) => record.worker_id === "mockOpenAI" && record.disposition === "selected")).toMatchObject({
      files_changed: 1,
      tests_added: 0,
    });
    expect(telemetry.find((record) => record.worker_id === "mockAnthropic" && record.disposition === "discarded")).toMatchObject({
      files_changed: 1,
      tests_added: 0,
    });
    runtime.close();
  });

  it("blocks atomically and persists a dual-lane continuation without creating worktrees", async () => {
    const { OrchestrationRuntime, runOrchestrationTask } = await loadModules();
    const repo = path.join(tmpHome, "repo");
    initGitRepo(repo);
    const runtime = new OrchestrationRuntime({
      config: dualLaneConfig({ omitAnthropicWorker: true }),
      dbPath: ":memory:",
      startReaper: false,
      worktreeRoot: path.join(tmpHome, "worktrees"),
      maxWorktrees: 4,
    });
    const ctx = makeContext(runtime, new LaneWritingEngine());

    const result = await runOrchestrationTask({
      context: ctx,
      mode: "dual_lane",
      task: {
        taskId: "task-dual-blocked",
        coordinatorId: "coord-dual-blocked",
        mode: "dual_lane",
        cwd: repo,
        prompt: "This should wait for an Anthropic lane",
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok || result.state !== "blocked_resource") return;
    expect(result.queueItem.missingRoles).toEqual(["anthropicImplementer"]);
    expect(runtime.listLiveContinuations()).toMatchObject([
      { taskId: "task-dual-blocked", coordinatorId: "coord-dual-blocked", mode: "dual_lane", state: "queued" },
    ]);
    expect(fs.existsSync(path.join(tmpHome, "worktrees"))).toBe(false);
    runtime.close();
  });

  it("releases sibling leases and removes worktrees when a lane fails", async () => {
    const { OrchestrationRuntime, runOrchestrationTask } = await loadModules();
    const repo = path.join(tmpHome, "repo");
    initGitRepo(repo);
    const runtime = new OrchestrationRuntime({
      config: dualLaneConfig(),
      dbPath: ":memory:",
      startReaper: false,
      worktreeRoot: path.join(tmpHome, "worktrees"),
      maxWorktrees: 4,
    });
    const engine = new LaneWritingEngine({ failLane: "openai" });
    const ctx = makeContext(runtime, engine);

    const result = await runOrchestrationTask({
      context: ctx,
      mode: "dual_lane",
      task: {
        taskId: "task-dual-failed",
        coordinatorId: "coord-dual-failed",
        mode: "dual_lane",
        cwd: repo,
        prompt: "The OpenAI lane should fail before Anthropic runs",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.state).toBe("failed");
    expect(runtime.listLeases().every((lease) => lease.state === "released")).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, "worktrees", "cuttlefish-task-dual-failed-openai"))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, "worktrees", "cuttlefish-task-dual-failed-anthropic"))).toBe(false);
    // CAS-CF-002: the openai lane failing must not deny the anthropic lane its
    // own attempt — both engine invocations should have happened, and the
    // failed result should carry a session for each lane, not just the one
    // that happened to fail first.
    expect(engine.prompts).toHaveLength(2);
    if (!result.ok && result.state === "failed" && "lanes" in result) {
      expect(result.sessions).toHaveLength(2);
      const anthropicLane = result.lanes.find((lane: DualLaneRunLane) => lane.id === "anthropic");
      expect(anthropicLane?.state).toBe("completed");
    }
    runtime.close();
  });

  it("keeps dual-lane artifacts isolated by task and coordinator", async () => {
    const { OrchestrationStore, writeDualLanePromptArtifact } = await loadModules();
    const store = OrchestrationStore.open(":memory:");

    const first = writeDualLanePromptArtifact("shared-task", "coord-a", "prompt A", store, {
      now: () => new Date("2026-06-25T12:00:00.000Z"),
    });
    const second = writeDualLanePromptArtifact("shared-task", "coord-b", "prompt B", store);
    fs.utimesSync(first.path, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"));

    expect(first.artifactId).toBe("shared-task:coord-a:prompt:base");
    expect(first.createdAt).toBe("2026-06-25T12:00:00.000Z");
    expect(second.artifactId).toBe("shared-task:coord-b:prompt:base");
    expect(first.path).not.toBe(second.path);
    expect(store.listArtifactRecords("shared-task", "prompt", "coord-a")).toMatchObject([{ coordinatorId: "coord-a", path: first.path }]);
    expect(store.listArtifactRecords("shared-task", "prompt", "coord-b")).toMatchObject([{ coordinatorId: "coord-b", path: second.path }]);
    store.close();
  });
});

async function loadModules() {
  const [runtime, runMode, dualLane, state, registry, telemetry, artifacts, store] = await Promise.all([
    import("../runtime.js"),
    import("../run-mode.js"),
    import("../dual-lane.js"),
    import("../dual-lane-state.js"),
    import("../../sessions/registry.js"),
    import("../telemetry.js"),
    import("../artifacts.js"),
    import("../store.js"),
  ]);
  registry.initDb();
  return {
    OrchestrationRuntime: runtime.OrchestrationRuntime,
    applyDualLaneWinner: artifacts.applyDualLaneWinner,
    runOrchestrationTask: runMode.runOrchestrationTask,
    selectDualLaneWinner: dualLane.selectDualLaneWinner,
    readDualLaneManifest: state.readDualLaneManifest,
    readOrchestrationTelemetry: telemetry.readOrchestrationTelemetry,
    ORCHESTRATION_TELEMETRY_LOG: telemetry.ORCHESTRATION_TELEMETRY_LOG,
    OrchestrationStore: store.OrchestrationStore,
    writeDualLanePromptArtifact: artifacts.writeDualLanePromptArtifact,
  };
}

class LaneWritingEngine implements Engine {
  name = "mock";
  prompts: string[] = [];

  constructor(private readonly opts: { failLane?: "openai" | "anthropic" } = {}) {}

  run = vi.fn(async (opts: EngineRunOpts): Promise<EngineResult> => {
    this.prompts.push(opts.prompt);
    const lane = opts.cwd.includes("-openai") ? "openai" : "anthropic";
    if (this.opts.failLane === lane) throw new Error(`${lane} forced failure`);
    fs.writeFileSync(path.join(opts.cwd, `${lane}.txt`), `${opts.prompt}\n`);
    opts.onStream?.({ type: "text", content: `${lane} complete` });
    return { sessionId: opts.sessionId ?? `${lane}-session`, result: `${lane} complete` };
  });
}

function makeContext(runtime: unknown, engine: Engine): ApiContext {
  const cfg = cuttlefishConfig();
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
    capabilities: ["repo_edit", "coding"],
    tools: ["git", "filesystem"],
    maxConcurrentTasks: 1,
    costClass: "low",
    workspacePolicy: "isolated_worktree",
    ...overrides,
  };
}

function dualLaneConfig(opts: { omitAnthropicWorker?: boolean } = {}): OrchestrationConfig {
  const workers = [
    worker({ id: "mockOpenAI", provider: "mock", family: "openai" }),
    ...(opts.omitAnthropicWorker ? [] : [worker({ id: "mockAnthropic", provider: "mock", family: "anthropic" })]),
  ];
  return {
    workers,
    roles: [
      { id: "openaiImplementer", requiredCapabilities: ["repo_edit", "coding"], requiredTools: ["git", "filesystem"], allowedFamilies: ["openai"] },
      { id: "anthropicImplementer", requiredCapabilities: ["repo_edit", "coding"], requiredTools: ["git", "filesystem"], allowedFamilies: ["anthropic"] },
    ],
    coordinatorTemplates: [],
    quotas: { providers: {}, families: {} },
  };
}

function cuttlefishConfig(): CuttlefishConfig {
  return {
    gateway: { port: 8888, host: "127.0.0.1" },
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt" },
    },
    connectors: {},
    logging: { file: false, stdout: false, level: "error" },
    orchestration: { enabled: true },
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
