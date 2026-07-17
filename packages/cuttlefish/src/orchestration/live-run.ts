export const LIVE_RUN_MODES = ["single_worker", "single_worker_with_review", "dual_lane", "architecture", "local_heavy"] as const;

export type LiveRunMode = typeof LIVE_RUN_MODES[number];
export type LiveRunContinuationState = "queued" | "dispatching" | "completed" | "failed";

export interface LiveRunTaskPayload {
  taskId: string;
  coordinatorId: string;
  coordinatorTemplate?: string;
  template?: string;
  requiredRoles?: string[];
  optionalRoles?: string[];
  allowedWorkerIds?: string[];
  priority: "low" | "normal" | "high";
  leaseDurationMs: number;
  prompt: string;
  cwd?: string;
  /**
   * Git HEAD SHA of `cwd` captured when this task was enqueued (including
   * while blocked waiting for a slot). Used only for stale-HEAD detection
   * at dispatch time (see runtime.ts); never re-derived or refreshed once
   * set, so it always reflects the repo state at enqueue time.
   */
  enqueueHeadSha?: string;
  title?: string;
  model?: string;
  effortLevel?: string;
  openaiRole?: string;
  anthropicRole?: string;
}

export interface LiveRunContinuationRecord {
  taskId: string;
  coordinatorId: string;
  mode: LiveRunMode;
  state: LiveRunContinuationState;
  task: LiveRunTaskPayload;
  enqueuedAt: string;
  updatedAt: string;
  retryCount: number;
  lastDispatchedAt?: string;
  allocationId?: string;
  lastError?: string;
  runId?: string;
}
