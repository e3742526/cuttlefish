import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CUTTLEFISH_HOME, ORCH_WORKTREE_ROOT } from "../shared/paths.js";
import { safeRmSync } from "../shared/safe-delete.js";
import type { CuttlefishConfig } from "../shared/types.js";

export const WORKTREE_MARKER = ".cuttlefish-worktree.json";
export const DEFAULT_MAX_WORKTREES = 8;
export const DEFAULT_REVIEW_BUNDLE_RETENTION_MS = 24 * 60 * 60 * 1_000;

export type WorktreeMode = "implementation_worktree" | "shared";
export type WorktreeDowngradeReason = "non_git_cwd";

export interface WorktreeOptions {
  root: string;
  maxWorktrees: number;
}

export interface WorktreeHandle {
  taskId: string;
  lane: string;
  path: string;
  baseCwd: string;
  gitRoot: string;
  branch: string;
  createdAt: string;
}

export interface ReviewBundleHandle {
  path: string;
  patchPath: string;
  metadataPath: string;
  sourceCwd: string;
  sourceWorktreePath?: string;
  createdAt: string;
}

export type WorktreePreparation =
  | { mode: "implementation_worktree"; cwd: string; handle: WorktreeHandle }
  | { mode: "shared"; cwd: string; downgradeReason: WorktreeDowngradeReason };

export interface WorktreeCleanupResult {
  path: string;
  removed: boolean;
}

export interface ReviewBundleReapOptions {
  root?: string;
  now?: Date;
  maxAgeMs?: number;
}

export function resolveWorktreeOptions(config: CuttlefishConfig): WorktreeOptions {
  const configuredMax = config.orchestration?.maxWorktrees;
  return {
    root: path.resolve(config.orchestration?.worktreeRoot ?? ORCH_WORKTREE_ROOT),
    maxWorktrees: typeof configuredMax === "number" && Number.isFinite(configuredMax) && configuredMax > 0
      ? Math.floor(configuredMax)
      : DEFAULT_MAX_WORKTREES,
  };
}

export function resolveTaskBaseCwd(cwd: string | undefined, config: CuttlefishConfig): string {
  const candidate = cwd ?? config.workspaces?.defaultCwd ?? CUTTLEFISH_HOME;
  const resolved = fs.realpathSync(candidate);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error(`orchestration cwd is not a directory: ${candidate}`);

  const roots = config.workspaces?.roots ?? [];
  if (roots.length > 0) {
    const allowedRoots = roots.map((root) => fs.realpathSync(root));
    if (!allowedRoots.some((root) => isSameOrInside(root, resolved))) {
      throw new Error(`orchestration cwd is outside allowed workspace roots: ${candidate}`);
    }
  }
  return resolved;
}

export function createImplementationWorktree(opts: {
  taskId: string;
  lane: string;
  baseCwd: string;
  worktrees: WorktreeOptions;
  now?: () => Date;
}): WorktreePreparation {
  const gitRoot = findGitRoot(opts.baseCwd);
  if (!gitRoot) return { mode: "shared", cwd: opts.baseCwd, downgradeReason: "non_git_cwd" };

  const root = path.resolve(opts.worktrees.root);
  fs.mkdirSync(root, { recursive: true });
  const existing = listManagedWorktrees(root);
  if (existing.length >= opts.worktrees.maxWorktrees) {
    throw new Error(`orchestration worktree limit reached: ${existing.length}/${opts.worktrees.maxWorktrees}`);
  }

  const lane = safeSegment(opts.lane);
  const taskId = safeSegment(opts.taskId);
  const worktreePath = path.join(root, `cuttlefish-${taskId}-${lane}`);
  assertInsideRoot(root, worktreePath);
  if (fs.existsSync(worktreePath)) throw new Error(`orchestration worktree already exists: ${worktreePath}`);

  const createdAt = (opts.now?.() ?? new Date()).toISOString();
  const branch = `cuttlefish/${taskId}/${lane}/${Date.now()}`;
  const handle: WorktreeHandle = {
    taskId: opts.taskId,
    lane: opts.lane,
    path: worktreePath,
    baseCwd: opts.baseCwd,
    gitRoot,
    branch,
    createdAt,
  };

  try {
    runGit(["worktree", "add", "-b", branch, worktreePath, "HEAD"], gitRoot);
    fs.writeFileSync(path.join(worktreePath, WORKTREE_MARKER), JSON.stringify(handle, null, 2));
    return { mode: "implementation_worktree", cwd: worktreePath, handle };
  } catch (err) {
    safeRmSync(worktreePath, { within: root, label: "orchestration worktree" });
    throw new Error(`failed to create orchestration worktree: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function diffWorktree(handle: WorktreeHandle): string {
  return diffGitWorkspace(handle.path, [WORKTREE_MARKER]);
}

export function patchWorktree(handle: WorktreeHandle): string {
  const untracked = listUntrackedGitFiles(handle.path, [WORKTREE_MARKER]);
  if (untracked.length > 0) runGit(["add", "-N", "--", ...untracked], handle.path);
  try {
    return runGit(["diff", "--binary", "HEAD", "--"], handle.path);
  } finally {
    if (untracked.length > 0) {
      try {
        runGit(["reset", "--", ...untracked], handle.path);
      } catch {
        // Leave the winner worktree inspectable if index cleanup fails.
      }
    }
  }
}

export function isGitWorkspaceDirty(cwd: string): boolean {
  return runGit(["status", "--porcelain"], cwd).trim().length > 0;
}

export function applyPatchToGitWorkspace(cwd: string, patch: string): void {
  execFileSync("git", ["apply", "--check"], {
    cwd,
    input: patch,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  execFileSync("git", ["apply"], {
    cwd,
    input: patch,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function diffWorktreeByTaskLane(root: string, taskId: string, lane: string): string {
  return diffWorktree(requireManagedWorktree(root, taskId, lane));
}

export function cleanupWorktree(handle: WorktreeHandle): WorktreeCleanupResult {
  if (!fs.existsSync(handle.path)) return { path: handle.path, removed: false };
  makeWritable(handle.path);
  // AR-03: the marker lives inside an agent-writable worktree, so its self-reported
  // `gitRoot`/`branch` are untrusted. Derive the owning repository and the branch
  // from the worktree's *real* git linkage instead — a tampered marker must never
  // be able to aim `git worktree remove` / `git branch -D` at another repository or
  // an arbitrary branch (e.g. `main`).
  const gitRoot = resolveWorktreeGitRoot(handle.path);
  // Read the branch from the worktree's own HEAD *before* removing it.
  const branch = gitRoot ? resolveWorktreeBranch(handle.path) : null;
  if (!gitRoot) {
    // No resolvable owning repo (broken linkage / never a worktree) — remove the
    // directory contained to itself; never fall back to the marker's gitRoot.
    safeRmSync(handle.path, { label: "orchestration worktree" });
    return { path: handle.path, removed: true };
  }
  try {
    runGit(["worktree", "remove", "--force", "--", handle.path], gitRoot);
  } catch {
    safeRmSync(handle.path, { label: "orchestration worktree" });
  }
  // Only delete a branch that matches the strict generated-name pattern, and pass
  // `--` so a crafted value can never be parsed as a git option. A branch named
  // `main`/`master`/etc. simply does not match and is left untouched.
  if (branch && isGeneratedWorktreeBranch(branch)) {
    try {
      runGit(["branch", "-D", "--", branch], gitRoot);
    } catch {
      // The branch may already be gone or may not have been created.
    }
  }
  return { path: handle.path, removed: true };
}

export function cleanupWorktreeByTaskLane(root: string, taskId: string, lane: string): WorktreeCleanupResult {
  const worktreePath = worktreePathForTaskLane(root, taskId, lane);
  if (!fs.existsSync(worktreePath)) return { path: worktreePath, removed: false };
  return cleanupWorktree(readManagedWorktree(worktreePath));
}

export function createReviewBundle(opts: {
  taskId: string;
  role: string;
  workerId: string;
  sourceCwd: string;
  sourceWorktree?: WorktreeHandle;
  now?: () => Date;
}): ReviewBundleHandle {
  const bundleRoot = reviewBundleRoot();
  fs.mkdirSync(bundleRoot, { recursive: true });
  const bundlePath = fs.mkdtempSync(path.join(bundleRoot, `review-${safeSegment(opts.taskId)}-${safeSegment(opts.role)}-`));
  const createdAt = (opts.now?.() ?? new Date()).toISOString();
  const patchPath = path.join(bundlePath, "patch.diff");
  const metadataPath = path.join(bundlePath, "metadata.json");
  const patch = opts.sourceWorktree
    ? diffWorktree(opts.sourceWorktree)
    : diffGitWorkspace(opts.sourceCwd);
  fs.writeFileSync(patchPath, patch);
  fs.writeFileSync(metadataPath, JSON.stringify({
    taskId: opts.taskId,
    role: opts.role,
    workerId: opts.workerId,
    createdAt,
    sourceCwd: opts.sourceCwd,
    sourceWorktreePath: opts.sourceWorktree?.path ?? null,
  }, null, 2));
  return {
    path: bundlePath,
    patchPath,
    metadataPath,
    sourceCwd: opts.sourceCwd,
    sourceWorktreePath: opts.sourceWorktree?.path,
    createdAt,
  };
}

export function cleanupReviewBundle(handle: ReviewBundleHandle): void {
  // Contain against the bundle's own parent (always the root it was created or
  // reaped from) so a custom reap root still cleans up while catastrophic and
  // symlinked targets are still rejected.
  safeRmSync(handle.path, { within: path.dirname(path.resolve(handle.path)), label: "review bundle" });
}

export function reapExpiredReviewBundles(opts: ReviewBundleReapOptions = {}): ReviewBundleHandle[] {
  const root = path.resolve(opts.root ?? reviewBundleRoot());
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const nowMs = (opts.now ?? new Date()).getTime();
  const maxAgeMs = typeof opts.maxAgeMs === "number" && Number.isFinite(opts.maxAgeMs) && opts.maxAgeMs >= 0
    ? opts.maxAgeMs
    : DEFAULT_REVIEW_BUNDLE_RETENTION_MS;
  const removed: ReviewBundleHandle[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("review-")) continue;
    const bundlePath = path.join(root, entry.name);
    const handle = readReviewBundle(bundlePath);
    if (!handle) continue;
    const createdAtMs = Date.parse(handle.createdAt);
    if (!Number.isFinite(createdAtMs) || nowMs - createdAtMs < maxAgeMs) continue;
    cleanupReviewBundle(handle);
    removed.push(handle);
  }
  return removed;
}

export function reapOrphanedWorktrees(root: string, activeTaskIds: Set<string>): WorktreeHandle[] {
  const removed: WorktreeHandle[] = [];
  for (const handle of listManagedWorktrees(root)) {
    if (activeTaskIds.has(handle.taskId)) continue;
    cleanupWorktree(handle);
    removed.push(handle);
  }
  return removed;
}

function reviewBundleRoot(): string {
  return path.join(CUTTLEFISH_HOME, "tmp", "orchestration-review");
}

function readReviewBundle(bundlePath: string): ReviewBundleHandle | null {
  const metadataPath = path.join(bundlePath, "metadata.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as Partial<{
      createdAt: unknown;
      sourceCwd: unknown;
      sourceWorktreePath: unknown;
    }>;
    if (typeof parsed.createdAt !== "string" || typeof parsed.sourceCwd !== "string") return null;
    return {
      path: bundlePath,
      patchPath: path.join(bundlePath, "patch.diff"),
      metadataPath,
      sourceCwd: parsed.sourceCwd,
      sourceWorktreePath: typeof parsed.sourceWorktreePath === "string" ? parsed.sourceWorktreePath : undefined,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

export function listManagedWorktrees(root: string): WorktreeHandle[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const worktreePath = path.join(root, entry.name);
      const markerPath = path.join(worktreePath, WORKTREE_MARKER);
      if (!fs.existsSync(markerPath)) return [];
      try {
        return [parseWorktreeMarker(fs.readFileSync(markerPath, "utf-8"), worktreePath)];
      } catch {
        return [];
      }
    });
}

export function worktreePathForTaskLane(root: string, taskId: string, lane: string): string {
  const resolvedRoot = path.resolve(root);
  const worktreePath = path.join(resolvedRoot, `cuttlefish-${safeSegment(taskId)}-${safeSegment(lane)}`);
  assertInsideRoot(resolvedRoot, worktreePath);
  return worktreePath;
}

function requireManagedWorktree(root: string, taskId: string, lane: string): WorktreeHandle {
  const worktreePath = worktreePathForTaskLane(root, taskId, lane);
  if (!fs.existsSync(worktreePath)) throw new Error(`orchestration worktree not found: ${worktreePath}`);
  return readManagedWorktree(worktreePath);
}

function readManagedWorktree(worktreePath: string): WorktreeHandle {
  const markerPath = path.join(worktreePath, WORKTREE_MARKER);
  if (!fs.existsSync(markerPath)) throw new Error(`not a managed orchestration worktree: ${worktreePath}`);
  return parseWorktreeMarker(fs.readFileSync(markerPath, "utf-8"), worktreePath);
}

function parseWorktreeMarker(raw: string, fallbackPath: string): WorktreeHandle {
  const parsed = JSON.parse(raw) as Partial<WorktreeHandle>;
  if (!parsed.taskId || !parsed.lane || !parsed.path || !parsed.baseCwd || !parsed.gitRoot || !parsed.branch || !parsed.createdAt) {
    throw new Error(`invalid orchestration worktree marker: ${fallbackPath}`);
  }
  return {
    taskId: parsed.taskId,
    lane: parsed.lane,
    // The worktree's path is authoritatively where its marker lives (a validated
    // child of the managed root), never the marker's self-reported `path` — a
    // tampered marker must not be able to point cleanup/git at an arbitrary dir.
    path: fallbackPath,
    baseCwd: parsed.baseCwd,
    gitRoot: parsed.gitRoot,
    branch: parsed.branch,
    createdAt: parsed.createdAt,
  };
}

// A managed worktree branch is always generated as
// `cuttlefish/<taskId>/<lane>/<timestamp>` with safeSegment'd parts. Recovery only
// ever deletes a branch matching this shape, so it can never remove a real branch
// even if asked to (AR-03).
const GENERATED_WORKTREE_BRANCH_RE = /^cuttlefish\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/\d+$/;

function isGeneratedWorktreeBranch(branch: string): boolean {
  return GENERATED_WORKTREE_BRANCH_RE.test(branch);
}

/**
 * The main repository that owns a linked worktree, derived from the worktree's
 * real git linkage (`--git-common-dir`), never from the agent-writable marker.
 * Returns null when the path is not a resolvable git worktree.
 */
function resolveWorktreeGitRoot(worktreePath: string): string | null {
  try {
    const commonDir = runGit(["rev-parse", "--git-common-dir"], worktreePath).trim();
    if (!commonDir) return null;
    const absCommon = path.isAbsolute(commonDir) ? commonDir : path.resolve(worktreePath, commonDir);
    return path.basename(absCommon) === ".git" ? path.dirname(absCommon) : absCommon;
  } catch {
    return null;
  }
}

/**
 * The branch checked out in a worktree, read from its real HEAD (never the
 * marker). Returns null for a detached HEAD or when git cannot be queried.
 */
function resolveWorktreeBranch(worktreePath: string): string | null {
  try {
    const ref = runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], worktreePath).trim();
    return ref || null;
  } catch {
    return null;
  }
}

function findGitRoot(cwd: string, timeoutMs?: number): string | null {
  try {
    return runGit(["rev-parse", "--show-toplevel"], cwd, timeoutMs).trim();
  } catch {
    return null;
  }
}

function runGit(args: string[], cwd: string, timeoutMs?: number): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
  });
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) throw new Error(`invalid orchestration worktree path segment: ${value}`);
  return safe.slice(0, 80);
}

function assertInsideRoot(root: string, candidate: string): void {
  if (!isSameOrInside(root, candidate)) throw new Error(`orchestration worktree path escapes root: ${candidate}`);
}

function isSameOrInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function makeWritable(target: string): void {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) return;
  fs.chmodSync(target, stat.mode | 0o700);
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(target)) {
    makeWritable(path.join(target, entry));
  }
}

/**
 * `timeoutMs` bounds the underlying git subprocess calls (SIGTERM if exceeded).
 * Optional and undefined by default — omitting it preserves the historical
 * unbounded behavior for existing callers (createReviewBundle, patchWorktree).
 * Callers on a request-serving hot path (e.g. gateway/review-context.ts) should
 * pass a bound so a pathological diff can't block the process indefinitely.
 */
export function diffGitWorkspace(cwd: string, excludedUntracked: string[] = [], timeoutMs?: number): string {
  const gitRoot = findGitRoot(cwd, timeoutMs);
  if (!gitRoot) return "";
  const diff = runGit(["diff", "HEAD", "--"], cwd, timeoutMs);
  const untracked = listUntrackedGitFiles(cwd, excludedUntracked, timeoutMs);
  if (untracked.length === 0) return diff;
  return [
    diff.trimEnd(),
    "Untracked files:",
    ...untracked.map((file) => `  ${file}`),
    "",
  ].filter((line, index) => index !== 0 || line.length > 0).join("\n");
}

function listUntrackedGitFiles(cwd: string, excludedUntracked: string[] = [], timeoutMs?: number): string[] {
  const ignored = new Set(excludedUntracked);
  return runGit(["ls-files", "--others", "--exclude-standard"], cwd, timeoutMs)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !ignored.has(line));
}
