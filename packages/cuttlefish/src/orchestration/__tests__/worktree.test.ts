import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupReviewBundle,
  cleanupWorktree,
  createReviewBundle,
  createImplementationWorktree,
  diffGitWorkspace,
  diffWorktree,
  listManagedWorktrees,
  reapExpiredReviewBundles,
  reapOrphanedWorktrees,
} from "../worktree.js";
import { OrchestrationRuntime } from "../runtime.js";
import type { OrchestrationConfig } from "../types.js";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

let tmpDir: string;
let repoDir: string;
let worktreeRoot: string;

withTempCuttlefishHome("cuttlefish-worktree-home-");

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-worktree-"));
  repoDir = path.join(tmpDir, "repo");
  worktreeRoot = path.join(tmpDir, "worktrees");
  initGitRepo(repoDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("orchestration worktrees", () => {
  it("creates, diffs, and cleans up a managed implementation worktree", () => {
    const prepared = createImplementationWorktree({
      taskId: "task-one",
      lane: "seniorImplementer",
      baseCwd: repoDir,
      worktrees: { root: worktreeRoot, maxWorktrees: 4 },
      now: () => new Date("2026-06-23T12:00:00.000Z"),
    });

    expect(prepared.mode).toBe("implementation_worktree");
    if (prepared.mode !== "implementation_worktree") return;
    expect(fs.existsSync(path.join(prepared.cwd, ".cuttlefish-worktree.json"))).toBe(true);
    fs.writeFileSync(path.join(prepared.cwd, "feature.txt"), "hello\n");

    expect(diffWorktree(prepared.handle)).toContain("feature.txt");
    expect(listManagedWorktrees(worktreeRoot).map((item) => item.taskId)).toEqual(["task-one"]);
    expect(cleanupWorktree(prepared.handle)).toMatchObject({ removed: true });
    expect(fs.existsSync(prepared.cwd)).toBe(false);
  });

  it("diffGitWorkspace returns the same diff whether or not a timeoutMs bound is supplied", () => {
    fs.writeFileSync(path.join(repoDir, "changed.txt"), "hello\n");

    const unbounded = diffGitWorkspace(repoDir);
    const bounded = diffGitWorkspace(repoDir, [], 10_000);

    expect(unbounded).toContain("changed.txt");
    expect(bounded).toBe(unbounded); // a generous timeout doesn't change the result
  });

  it("downgrades non-git cwd to shared cwd without creating a worktree", () => {
    const nonGit = path.join(tmpDir, "non-git");
    fs.mkdirSync(nonGit);

    const prepared = createImplementationWorktree({
      taskId: "task-non-git",
      lane: "seniorImplementer",
      baseCwd: nonGit,
      worktrees: { root: worktreeRoot, maxWorktrees: 4 },
    });

    expect(prepared).toEqual({ mode: "shared", cwd: nonGit, downgradeReason: "non_git_cwd" });
    expect(listManagedWorktrees(worktreeRoot)).toEqual([]);
  });

  it("enforces max worktree count before creating another lane", () => {
    const first = createImplementationWorktree({
      taskId: "task-one",
      lane: "implementation",
      baseCwd: repoDir,
      worktrees: { root: worktreeRoot, maxWorktrees: 1 },
    });
    expect(first.mode).toBe("implementation_worktree");

    expect(() => createImplementationWorktree({
      taskId: "task-two",
      lane: "implementation",
      baseCwd: repoDir,
      worktrees: { root: worktreeRoot, maxWorktrees: 1 },
    })).toThrow("worktree limit reached");
  });

  it("reaps only managed worktrees whose task has no active lease", () => {
    const active = createImplementationWorktree({
      taskId: "task-active",
      lane: "implementation",
      baseCwd: repoDir,
      worktrees: { root: worktreeRoot, maxWorktrees: 4 },
    });
    const orphan = createImplementationWorktree({
      taskId: "task-orphan",
      lane: "implementation",
      baseCwd: repoDir,
      worktrees: { root: worktreeRoot, maxWorktrees: 4 },
    });
    expect(active.mode).toBe("implementation_worktree");
    expect(orphan.mode).toBe("implementation_worktree");
    if (active.mode !== "implementation_worktree" || orphan.mode !== "implementation_worktree") return;

    const removed = reapOrphanedWorktrees(worktreeRoot, new Set(["task-active"]));

    expect(removed.map((item) => item.taskId)).toEqual(["task-orphan"]);
    expect(fs.existsSync(active.cwd)).toBe(true);
    expect(fs.existsSync(orphan.cwd)).toBe(false);
  });

  it("ignores a tampered worktree marker when recovering (AR-03)", () => {
    const prepared = createImplementationWorktree({
      taskId: "task-evil",
      lane: "implementation",
      baseCwd: repoDir,
      worktrees: { root: worktreeRoot, maxWorktrees: 4 },
    });
    expect(prepared.mode).toBe("implementation_worktree");
    if (prepared.mode !== "implementation_worktree") return;

    // A second repository the agent must never be able to touch.
    const otherRepo = path.join(tmpDir, "other-repo");
    initGitRepo(otherRepo);
    git(["branch", "precious"], otherRepo);
    expect(listBranches(otherRepo)).toContain("precious");

    // The agent overwrites the in-worktree marker to aim recovery at
    // otherRepo/precious (deleting a branch elsewhere).
    const markerPath = path.join(prepared.cwd, ".cuttlefish-worktree.json");
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
    marker.gitRoot = otherRepo;
    marker.branch = "precious";
    fs.writeFileSync(markerPath, JSON.stringify(marker));

    const realBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], prepared.cwd).trim();

    const removed = reapOrphanedWorktrees(worktreeRoot, new Set());
    expect(removed.map((h) => h.taskId)).toContain("task-evil");

    // The other repo and its branch are untouched — the marker values were ignored.
    expect(fs.existsSync(otherRepo)).toBe(true);
    expect(listBranches(otherRepo)).toContain("precious");
    // The worktree's own generated branch was removed from its real owning repo.
    expect(listBranches(repoDir)).not.toContain(realBranch);
    expect(fs.existsSync(prepared.cwd)).toBe(false);
  });

  it("builds a diff-only review bundle outside the implementation worktree", () => {
    const prepared = createImplementationWorktree({
      taskId: "task-review",
      lane: "implementation",
      baseCwd: repoDir,
      worktrees: { root: worktreeRoot, maxWorktrees: 4 },
    });
    expect(prepared.mode).toBe("implementation_worktree");
    if (prepared.mode !== "implementation_worktree") return;
    fs.writeFileSync(path.join(prepared.cwd, "feature.txt"), "hello\n");

    const bundle = createReviewBundle({
      taskId: "task-review",
      role: "independentReviewer",
      workerId: "mockReviewer",
      sourceCwd: prepared.cwd,
      sourceWorktree: prepared.handle,
    });

    expect(bundle.path).not.toBe(prepared.cwd);
    expect(fs.existsSync(path.join(bundle.path, "patch.diff"))).toBe(true);
    expect(fs.existsSync(path.join(bundle.path, "metadata.json"))).toBe(true);
    expect(fs.readFileSync(path.join(bundle.path, "patch.diff"), "utf-8")).toContain("feature.txt");
    cleanupReviewBundle(bundle);
    cleanupWorktree(prepared.handle);
  });

  it("reaps only review bundles older than the grace window", () => {
    const prepared = createImplementationWorktree({
      taskId: "task-review-reap",
      lane: "implementation",
      baseCwd: repoDir,
      worktrees: { root: worktreeRoot, maxWorktrees: 4 },
    });
    expect(prepared.mode).toBe("implementation_worktree");
    if (prepared.mode !== "implementation_worktree") return;
    const oldBundle = createReviewBundle({
      taskId: "task-review-reap-old",
      role: "independentReviewer",
      workerId: "mockReviewer",
      sourceCwd: prepared.cwd,
      sourceWorktree: prepared.handle,
      now: () => new Date("2026-06-24T00:00:00.000Z"),
    });
    const freshBundle = createReviewBundle({
      taskId: "task-review-reap-fresh",
      role: "independentReviewer",
      workerId: "mockReviewer",
      sourceCwd: prepared.cwd,
      sourceWorktree: prepared.handle,
      now: () => new Date("2026-06-25T12:00:00.000Z"),
    });

    const removed = reapExpiredReviewBundles({
      now: new Date("2026-06-25T12:00:00.001Z"),
      maxAgeMs: 24 * 60 * 60 * 1_000,
    });

    expect(removed.map((bundle) => bundle.path)).toContain(oldBundle.path);
    expect(fs.existsSync(oldBundle.path)).toBe(false);
    expect(fs.existsSync(freshBundle.path)).toBe(true);
    cleanupReviewBundle(freshBundle);
    cleanupWorktree(prepared.handle);
  });

  it("runtime reaper preserves live task worktrees and removes them after lease release", () => {
    const runtime = new OrchestrationRuntime({
      config: schedulerConfig(),
      dbPath: ":memory:",
      startReaper: false,
      worktreeRoot,
      maxWorktrees: 4,
    });
    const allocation = runtime.requestAllocation({
      taskId: "task-active",
      coordinatorId: "coord-active",
      requiredRoles: ["seniorImplementer"],
      optionalRoles: [],
      priority: "normal",
      leaseDurationMs: 60_000,
    });
    expect(allocation.ok).toBe(true);
    if (!allocation.ok) return;
    const active = createImplementationWorktree({
      taskId: "task-active",
      lane: "implementation",
      baseCwd: repoDir,
      worktrees: { root: worktreeRoot, maxWorktrees: 4 },
    });
    const orphan = createImplementationWorktree({
      taskId: "task-orphan",
      lane: "implementation",
      baseCwd: repoDir,
      worktrees: { root: worktreeRoot, maxWorktrees: 4 },
    });
    expect(active.mode).toBe("implementation_worktree");
    expect(orphan.mode).toBe("implementation_worktree");
    if (active.mode !== "implementation_worktree" || orphan.mode !== "implementation_worktree") return;

    expect(runtime.reapWorktrees().map((item) => item.taskId)).toEqual(["task-orphan"]);
    expect(fs.existsSync(active.cwd)).toBe(true);
    runtime.releaseLease(allocation.allocation.leases[0].leaseId, "coord-active");

    expect(runtime.reapWorktrees().map((item) => item.taskId)).toEqual(["task-active"]);
    expect(fs.existsSync(active.cwd)).toBe(false);
    runtime.close();
  });
});

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

function listBranches(dir: string): string[] {
  return git(["branch", "--format=%(refname:short)"], dir)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function schedulerConfig(): OrchestrationConfig {
  return {
    workers: [{
      id: "mockImplementer",
      provider: "mock",
      family: "local",
      tier: "frontier",
      capabilities: ["repo_edit", "coding"],
      tools: ["git", "filesystem"],
      maxConcurrentTasks: 1,
      costClass: "low",
      workspacePolicy: "isolated_worktree",
    }],
    roles: [{ id: "seniorImplementer", requiredCapabilities: ["repo_edit", "coding"], requiredTools: ["git", "filesystem"] }],
    coordinatorTemplates: [],
    quotas: { providers: {}, families: {} },
  };
}
