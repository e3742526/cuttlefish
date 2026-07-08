/**
 * Deterministic reviewer context for the mid_pair execution loop.
 *
 * The general orchestration path hands its reviewer a real diff bundle
 * (createReviewBundle -> diffGitWorkspace). The mid_pair path historically gave
 * the reviewer only the implementer's last assistant summary. This focused helper
 * ports the diff-context concept: it produces a bounded `git diff HEAD` of the
 * implementer's workspace so the reviewer judges actual changes, not just a prose
 * summary. When no diff can be produced (no cwd, not a git repo, cwd outside the
 * allowed workspace roots, or a clean tree) it degrades to summary-only and
 * reports the reason — it never throws into the review loop.
 *
 * Diff/git mechanics live in orchestration/worktree.ts; this module only shapes a
 * review packet, keeping the orchestrator thin (AGENTS.md router/orchestrator
 * contract).
 */
import type { CuttlefishConfig } from "../shared/types.js";
import { diffGitWorkspace, resolveTaskBaseCwd } from "../orchestration/worktree.js";
import { telemetryCountsFromDiff } from "../orchestration/telemetry.js";
import { clampText } from "./content-screening.js";

/** Character budget for the diff embedded in a review packet. Bounds prompt size
 *  while still giving the reviewer the actual changes; larger diffs are truncated
 *  with a marker. */
export const REVIEW_DIFF_CHAR_BUDGET = 12_000;

/** Bounds the git subprocess calls this module makes on the reviewing hot path —
 *  a pathological repo/diff can't block the gateway indefinitely. Unlike
 *  diffGitWorkspace's other (unbounded) callers, this path runs on every
 *  reviewing pass of a live request, so it opts into a timeout. */
const REVIEW_DIFF_TIMEOUT_MS = 10_000;

export interface ReviewContext {
  mode: "diff" | "summary_only";
  /** Present only when mode === "diff": the (possibly truncated) diff text. */
  diffText?: string;
  /** Number of changed files parsed from the diff (0 when summary_only). */
  changedFiles: number;
  /** Present when mode === "summary_only": why no diff was produced. */
  reason?: string;
}

export interface BuildReviewContextOpts {
  cwd?: string | null;
  config: CuttlefishConfig;
  /** Injectable diff producer (defaults to the orchestration git diff). Tests
   *  pass a fake to avoid touching a real repo. */
  diffProducer?: (cwd: string) => string;
}

/**
 * Produce deterministic changed-file/diff context for a reviewer, or degrade to
 * summary-only with a recorded reason. Pure decision logic + one git call; never
 * throws.
 */
export function buildReviewContext(opts: BuildReviewContextOpts): ReviewContext {
  const { cwd, config } = opts;
  const diffProducer = opts.diffProducer ?? ((c: string) => diffGitWorkspace(c, [], REVIEW_DIFF_TIMEOUT_MS));

  if (!cwd || !cwd.trim()) {
    return { mode: "summary_only", changedFiles: 0, reason: "workspace cwd not set" };
  }

  try {
    // Validate the cwd is a real directory inside the configured workspace roots
    // before shelling out to git against it.
    const resolved = resolveTaskBaseCwd(cwd, config);
    const diff = diffProducer(resolved);
    if (!diff || !diff.trim()) {
      return { mode: "summary_only", changedFiles: 0, reason: "no changes detected in workspace" };
    }
    const { filesChanged } = telemetryCountsFromDiff(diff);
    const diffText = clampText(diff, REVIEW_DIFF_CHAR_BUDGET, "...[diff truncated]...");
    return { mode: "diff", diffText, changedFiles: filesChanged };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { mode: "summary_only", changedFiles: 0, reason: `diff unavailable: ${reason}` };
  }
}
