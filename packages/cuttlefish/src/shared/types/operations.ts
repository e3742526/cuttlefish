import type { JsonObject } from "./json.js";
import type { AgentModelPolicy } from "./engine.js";

export type ApprovalDecision = "approved" | "rejected" | "deferred" | "revised";
export type ApprovalState = "pending" | ApprovalDecision;
export type CheckpointResultingAction =
  | "resume_session"
  | "stay_paused"
  | "stop_session"
  | "record_only";
export type CheckpointOption = ApprovalDecision;

export type CheckpointPayload = JsonObject & {
  decisionNeeded: string;
  why: string;
  affectedFiles?: string[];
  affectedArtifacts?: string[];
  affectedActions?: string[];
  options?: CheckpointOption[];
  resumePrompt?: string | null;
  revisePrompt?: string | null;
};

/**
 * A human approval gate. Generic from day one so future producers (tool-use,
 * custom gates) need no schema change — only `fallback` is wired as a producer
 * today (model fallback that requires operator sign-off before switching engine).
 */
export interface Approval {
  id: string;
  sessionId: string;
  type: "fallback" | "tool" | "custom" | "checkpoint" | "org-change";
  /** Producer-specific. For `fallback`: { from, to, handoffPath, reason }.
   *  For `org-change`: { changeRequestId, changeType, employeeName, riskLevel }. */
  payload: JsonObject;
  state: ApprovalState;
  createdAt: string;
  resolvedAt?: string | null;
  /** Who resolved it (SSO identity / "web-user"). */
  actor?: string | null;
  decisionNotes?: string | null;
  resultingAction?: string | null;
}

export type ListableApprovalType = Exclude<Approval["type"], "checkpoint">;

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: string;
  timezone?: string;
  engine?: string;
  model?: string;
  employee?: string;
  prompt: string;
  delivery?: CronDelivery;
}

export type CronRunStatus = "queued" | "running" | "success" | "error" | "skipped_overlap";

export interface CronRunEntry {
  runId: string;
  timestamp: string;
  startedAt?: string;
  finishedAt?: string;
  sessionKey?: string;
  sessionId?: string | null;
  status: CronRunStatus;
  trigger: "scheduled" | "manual";
  durationMs?: number;
  error?: string | null;
  resultPreview?: string | null;
}

export interface CronDelivery {
  connector: string;
  channel: string;
}

export interface Employee {
  name: string;
  displayName: string;
  department: string;
  rank: "executive" | "manager" | "senior" | "employee";
  engine: string;
  model: string;
  persona: string;
  /** Emoji icon for this employee (shown in sidebar, org chart, etc.) */
  emoji?: string;
  /** Ocean avatar id for this employee, e.g. "aquatic:cuttlefish". Takes precedence
   *  over `emoji` when the frontend resolves the display avatar. */
  avatar?: string;
  /** Extra CLI flags passed to the engine (e.g. ["--chrome"]) */
  cliFlags?: string[];
  /** MCP servers this employee needs. true = all global, false = none, string[] = specific servers */
  mcp?: boolean | string[];
  /** Max cost in USD for a single session. Overrides global config. */
  maxCostUsd?: number;
  /** Default effort level for sessions assigned to this employee */
  effortLevel?: string;
  /** Whether to notify the parent session when this employee's child session completes. Default: true */
  alwaysNotify?: boolean;
  /** Who this employee reports to. String = single parent. Array = primary + dotted-line (future). */
  reportsTo?: string | string[];
  /** Optional policy-driven model fallback/backup chain for this employee. */
  modelPolicy?: AgentModelPolicy;
  /** Services this employee provides to the org */
  provides?: ServiceDeclaration[];
  /**
   * Policy for risky tool actions intercepted by the gateway. `none` disables
   * the extra review layer; `notify` allows matching Bash actions but records a
   * session notification; `checkpoint` requires a human checkpoint before the
   * action may proceed. When omitted, runtime defaults to `notify`.
   */
  approvalPolicy?: EmployeeApprovalPolicy;
  /** Risk categories that should trigger the hard security gate. */
  reviewTriggers?: SecurityReviewTrigger[];
  /** Employee name to route security-review context to. */
  securityReviewer?: string;
  /** Execution profile for this employee. Defaults to { tier: "solo" } if absent. */
  execution?: EmployeeExecutionConfig;
  /**
   * Lifecycle state managed by the HR / Org Steward flow. Defaults to "active".
   * `disabled` employees stay in the registry (so the hierarchy and reporting
   * lines don't break) but are non-assignable; `retired` personas are moved to
   * `org/_retired/` and excluded from the active scan entirely.
   */
  lifecycle?: EmployeeLifecycle;
}

export type EmployeeLifecycle = "draft" | "active" | "probation" | "disabled" | "retired";
export type EmployeeApprovalPolicy = "none" | "notify" | "checkpoint";
export type SecurityReviewTrigger =
  | "destructive_shell"
  | "privileged_shell"
  | "secret_access"
  | "external_network"
  | "prompt_injection_risk";

export const EMPLOYEE_LIFECYCLES: readonly EmployeeLifecycle[] = [
  "draft",
  "active",
  "probation",
  "disabled",
  "retired",
];

export const EMPLOYEE_APPROVAL_POLICIES: readonly EmployeeApprovalPolicy[] = [
  "none",
  "notify",
  "checkpoint",
];

export const SECURITY_REVIEW_TRIGGERS: readonly SecurityReviewTrigger[] = [
  "destructive_shell",
  "privileged_shell",
  "secret_access",
  "external_network",
  "prompt_injection_risk",
];

/** A service that an employee can provide to other employees/departments. */
export interface ServiceDeclaration {
  name: string;
  description: string;
}

export type ExecutionTier = "solo" | "mid_pair";

export type ReviewerLossPolicy =
  | "block"
  | "replace_then_block"
  | "replace_then_degrade"
  | "degrade";

export type ReviewerToolProfile =
  | "read_only"
  | "read_plus_inspect"
  | "patch_suggestions";

export type ReviewVerdict =
  | "approved"
  | "changes_requested"
  | "blocked"
  | "needs_human_review";

export interface ReviewResult {
  verdict: ReviewVerdict;
  summary: string;
  requiredChanges: string[];
  riskAreas: string[];
  confidence: "low" | "medium" | "high";
}

export interface RoleModelOverride {
  engine?: string;
  model?: string;
  effortLevel?: string;
}

/**
 * One backup target in a role's deterministic failover chain. Exactly one of
 * two shapes is valid:
 *  - direct agent: `engine` + `model` (optional `effortLevel`)
 *  - external agent deferral: `employee` (engine/model/effort resolve from
 *    that org employee at dispatch time; must not be combined with engine/model)
 */
export interface RoleFallbackTarget {
  engine?: string;
  model?: string;
  effortLevel?: string;
  /** Defer to this org employee's configured agent instead of a fixed engine/model. */
  employee?: string;
}

export interface RoleExecutionPolicy {
  override?: RoleModelOverride;
  fallbackChain?: RoleFallbackTarget[];
}

/** Hard cap on a role's failover chain length — keeps failover deterministic and bounded. */
export const MAX_ROLE_FALLBACK_CHAIN = 5;

export interface EmployeeExecutionConfig {
  tier: ExecutionTier;
  /** Max implementer→reviewer→revise passes (default 1) */
  maxInternalPasses?: number;
  /** Max child sessions spawned per employee run (default 3) */
  maxChildSessions?: number;
  /** Wall-clock cap for the entire employee run in ms (default 300000) */
  maxWallClockMs?: number;
  maxToolCalls?: number;
  maxEstimatedCostUsd?: number;
  /** What to do when the reviewer role is unavailable (default replace_then_degrade) */
  reviewerLossPolicy?: ReviewerLossPolicy;
  /** Tool access granted to the reviewer role (default read_only) */
  reviewerToolProfile?: ReviewerToolProfile;
  roles?: {
    implementer?: RoleExecutionPolicy;
    reviewer?: RoleExecutionPolicy;
  };
}

export const EXECUTION_TIERS: readonly ExecutionTier[] = ["solo", "mid_pair"];

export const REVIEWER_LOSS_POLICIES: readonly ReviewerLossPolicy[] = [
  "block",
  "replace_then_block",
  "replace_then_degrade",
  "degrade",
];

export const REVIEWER_TOOL_PROFILES: readonly ReviewerToolProfile[] = [
  "read_only",
  "read_plus_inspect",
  "patch_suggestions",
];

export const REVIEW_VERDICTS: readonly ReviewVerdict[] = [
  "approved",
  "changes_requested",
  "blocked",
  "needs_human_review",
];

/** A node in the resolved org tree. Wraps an Employee with computed hierarchy data. */
export interface OrgNode {
  employee: Employee;
  /** Resolved primary parent name (null = reports to root) */
  parentName: string | null;
  /** Names of direct reports */
  directReports: string[];
  /** Depth in tree (root = 0, root's reports = 1, etc.) */
  depth: number;
  /** Path from root to this node (excluding virtual root), e.g. ["content-lead", "content-writer"] */
  chain: string[];
}

/** Warning about a hierarchy issue. */
export interface OrgWarning {
  employee: string;
  type: "broken_ref" | "cycle" | "self_ref" | "cross_department" | "multiple_executives" | "parse_error";
  message: string;
  /** The invalid reportsTo value that caused this warning */
  ref?: string;
}

/** The fully resolved org hierarchy. */
export interface OrgHierarchy {
  /** Root node name — executive employee name, or null if no executive YAML exists */
  root: string | null;
  /** All nodes keyed by employee name */
  nodes: Record<string, OrgNode>;
  /** Ordered list for flat iteration (topological/BFS order, root first) */
  sorted: string[];
  /** Any resolution warnings */
  warnings: OrgWarning[];
}

export interface Department {
  name: string;
  displayName: string;
  description: string;
}
