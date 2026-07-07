/**
 * Employee execution profiles (V1).
 *
 * Provides utilities for resolving execution configuration, enforcing recursion
 * guards, building transport metadata for role sessions, and orchestrating the
 * mid_pair implementer→reviewer flow.
 *
 * Architectural invariants enforced here:
 *  - Internal roles (implementer, reviewer) are runtime-only — never org members.
 *  - Role sessions at depth 1 cannot expand into fresh execution profiles (depth guard).
 *  - Reviewer does not directly mutate repo contents.
 *  - UI must not imply review occurred if it was skipped/degraded/failed.
 */

import { randomUUID } from "node:crypto";
import type {
  CuttlefishConfig,
  Employee,
  EmployeeExecutionConfig,
  ExecutionTier,
  ReviewResult,
  ReviewVerdict,
  ReviewerLossPolicy,
  RoleExecutionPolicy,
} from "../shared/types.js";
import { MAX_ROLE_FALLBACK_CHAIN } from "../shared/types.js";
import { logger } from "../shared/logger.js";

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

const DEFAULT_MAX_INTERNAL_PASSES = 1;
const DEFAULT_MAX_CHILD_SESSIONS = 3;
const DEFAULT_MAX_WALL_CLOCK_MS = 300_000;
const DEFAULT_REVIEWER_LOSS_POLICY: ReviewerLossPolicy = "replace_then_degrade";

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

export function isMultiRoleEnabled(config: CuttlefishConfig): boolean {
  return config.features?.multiRoleEmployeeExecution === true;
}

// ---------------------------------------------------------------------------
// Effective execution config (applies V1 defaults)
// ---------------------------------------------------------------------------

export function resolveEffectiveExecution(employee: Employee): EmployeeExecutionConfig {
  const raw = employee.execution ?? { tier: "solo" as ExecutionTier };
  return {
    tier: raw.tier ?? "solo",
    maxInternalPasses: raw.maxInternalPasses ?? DEFAULT_MAX_INTERNAL_PASSES,
    maxChildSessions: raw.maxChildSessions ?? DEFAULT_MAX_CHILD_SESSIONS,
    maxWallClockMs: raw.maxWallClockMs ?? DEFAULT_MAX_WALL_CLOCK_MS,
    maxToolCalls: raw.maxToolCalls,
    maxEstimatedCostUsd: raw.maxEstimatedCostUsd,
    reviewerLossPolicy: raw.reviewerLossPolicy ?? DEFAULT_REVIEWER_LOSS_POLICY,
    reviewerToolProfile: raw.reviewerToolProfile ?? "read_only",
    roles: raw.roles,
  };
}

// ---------------------------------------------------------------------------
// Recursion guard
// ---------------------------------------------------------------------------

/** Returns true when the session is already a role child (executionDepth ≥ 1).
 *  Dispatch paths MUST check this before expanding an execution profile. */
export function isExecutionDepthBlocked(transportMeta: Record<string, unknown> | null | undefined): boolean {
  if (!transportMeta) return false;
  const depth = transportMeta["executionDepth"];
  return typeof depth === "number" && depth >= 1;
}

// ---------------------------------------------------------------------------
// Transport metadata
// ---------------------------------------------------------------------------

export type InternalRole = "implementer" | "reviewer";

export interface EmployeeRunMeta {
  employeeRunId: string;
  executionDepth: number;
  executionParentRunId: string | null;
  executionOrigin: ExecutionTier;
  internalRole: InternalRole;
}

export function buildRoleTransportMeta(
  employeeRunId: string,
  role: InternalRole,
  tier: ExecutionTier,
): EmployeeRunMeta {
  return {
    employeeRunId,
    executionDepth: 1,
    executionParentRunId: employeeRunId,
    executionOrigin: tier,
    internalRole: role,
  };
}

// ---------------------------------------------------------------------------
// Dynamic execution run state (attached to session/API responses)
// ---------------------------------------------------------------------------

export type ExecutionPhase = "pending" | "implementing" | "reviewing" | "revising" | "done" | "degraded" | "failed";

export interface ExecutionRunState {
  employeeRunId: string;
  tier: ExecutionTier;
  phase: ExecutionPhase;
  childSessionCount: number;
  degraded: boolean;
  degradedReason?: string;
  fallbackActive: boolean;
  pass: number;
  maxPasses: number;
}

export function buildExecutionRunState(
  employeeRunId: string,
  tier: ExecutionTier,
  phase: ExecutionPhase,
  opts: {
    childSessionCount?: number;
    degraded?: boolean;
    degradedReason?: string;
    fallbackActive?: boolean;
    pass?: number;
    maxPasses?: number;
  } = {},
): ExecutionRunState {
  return {
    employeeRunId,
    tier,
    phase,
    childSessionCount: opts.childSessionCount ?? 0,
    degraded: opts.degraded ?? false,
    degradedReason: opts.degradedReason,
    fallbackActive: opts.fallbackActive ?? false,
    pass: opts.pass ?? 1,
    maxPasses: opts.maxPasses ?? DEFAULT_MAX_INTERNAL_PASSES,
  };
}

// ---------------------------------------------------------------------------
// Reviewer verdict parsing
// ---------------------------------------------------------------------------

const VALID_VERDICTS = new Set<ReviewVerdict>([
  "approved",
  "changes_requested",
  "blocked",
  "needs_human_review",
]);

export function parseReviewResult(raw: string): ReviewResult | null {
  try {
    // Strip code fences if the reviewer wrapped the JSON
    const cleaned = raw.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
    const obj = JSON.parse(cleaned);
    if (!obj || typeof obj !== "object") return null;
    if (!VALID_VERDICTS.has(obj.verdict)) return null;
    return {
      verdict: obj.verdict as ReviewVerdict,
      summary: typeof obj.summary === "string" ? obj.summary : "",
      requiredChanges: Array.isArray(obj.requiredChanges) ? obj.requiredChanges : [],
      riskAreas: Array.isArray(obj.riskAreas) ? obj.riskAreas : [],
      confidence: obj.confidence === "low" || obj.confidence === "medium" || obj.confidence === "high"
        ? obj.confidence
        : "medium",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reviewer prompt builder
// ---------------------------------------------------------------------------

export function buildReviewerSystemPrompt(toolProfile: string): string {
  const toolNote = toolProfile === "read_only"
    ? "You have READ-ONLY access. Do not run shell commands, write files, or modify any repository contents."
    : toolProfile === "read_plus_inspect"
      ? "You may use read, search, and grep tools to inspect the codebase. Do not write files or run shell commands."
      : "You may suggest patches but must not apply them directly.";

  return `You are a code reviewer performing an independent quality review of a completed implementation.

${toolNote}

Your task:
1. Read the conversation and any changed files listed in the review packet.
2. Evaluate correctness, completeness, risk, and code quality.
3. Return a structured JSON verdict — your ENTIRE response must be valid JSON:

{
  "verdict": "approved" | "changes_requested" | "blocked" | "needs_human_review",
  "summary": "One or two sentence summary of your finding.",
  "requiredChanges": ["change 1", "change 2"],
  "riskAreas": ["area 1"],
  "confidence": "low" | "medium" | "high"
}

Verdict guide:
- "approved": Implementation is correct and complete.
- "changes_requested": Minor issues found; implementer should revise.
- "blocked": Critical issue — do not ship without human review.
- "needs_human_review": Uncertain — escalate to a human.

Return ONLY the JSON object. No prose before or after.`;
}

export function buildReviewPacketPrompt(
  task: string,
  implementerSummary: string,
): string {
  return `## Review Packet

**Original task:**
${task}

**Implementer output summary:**
${implementerSummary.slice(0, 4000)}

Please review the above and return your structured JSON verdict.`;
}

/** Prompt for a revision pass: the original task plus the reviewer's requested changes. */
export function buildRevisionPrompt(
  task: string,
  priorSummary: string,
  review: ReviewResult,
): string {
  const changes = review.requiredChanges.length > 0
    ? review.requiredChanges.map((c) => `- ${c}`).join("\n")
    : "(no specific changes listed — address the summary below)";
  return `## Revision Request

A reviewer evaluated your previous work on this task and requested changes.

**Original task:**
${task}

**Your previous output summary:**
${priorSummary.slice(0, 4000)}

**Reviewer summary:**
${review.summary || "(no summary provided)"}

**Requested changes:**
${changes}

Please revise your work to address the requested changes, then report the result.`;
}

// ---------------------------------------------------------------------------
// Deterministic role failover resolution
// ---------------------------------------------------------------------------

/** A concrete, launchable failover target after chain resolution. */
export interface ResolvedRoleTarget {
  engine: string;
  model: string;
  effortLevel?: string;
  /** Set when this target came from a defer-to-external-agent chain entry. */
  viaEmployee?: string;
}

export interface ResolveRoleFailoverOpts {
  role: RoleExecutionPolicy | undefined;
  /** The role's primary rung — resolved targets equal to it are dropped. */
  primary: { engine: string; model: string };
  /** Name of the employee whose profile is executing (self-deferral guard). */
  currentEmployeeName: string;
  /** Resolve an external-agent deferral target to its org employee. */
  lookupEmployee: (name: string) => Pick<Employee, "name" | "engine" | "model" | "effortLevel"> | undefined;
  /** Engine availability pre-check — unavailable targets are dropped up front. */
  isEngineAvailable: (engine: string) => boolean;
}

/**
 * Turn a role's configured fallback chain into an ordered list of launchable
 * targets. Pure and deterministic: chain order is preserved, external-agent
 * entries are resolved through `lookupEmployee`, and entries that are
 * malformed, self-referential, duplicates (same engine+model rung), equal to
 * the primary rung, or on unavailable engines are dropped rather than
 * attempted. Bounded by MAX_ROLE_FALLBACK_CHAIN.
 */
export function resolveRoleFailoverTargets(opts: ResolveRoleFailoverOpts): ResolvedRoleTarget[] {
  const chain = (opts.role?.fallbackChain ?? []).slice(0, MAX_ROLE_FALLBACK_CHAIN);
  const seen = new Set<string>([roleRungKey(opts.primary.engine, opts.primary.model)]);
  const targets: ResolvedRoleTarget[] = [];

  for (const entry of chain) {
    let resolved: ResolvedRoleTarget | undefined;
    const employeeRef = entry.employee?.trim();
    if (employeeRef) {
      if (employeeRef === opts.currentEmployeeName) continue; // self-failover loop
      const external = opts.lookupEmployee(employeeRef);
      if (!external?.engine || !external?.model) continue; // unknown/incomplete employee
      resolved = {
        engine: external.engine,
        model: external.model,
        effortLevel: entry.effortLevel ?? external.effortLevel,
        viaEmployee: external.name,
      };
    } else if (entry.engine?.trim() && entry.model?.trim()) {
      resolved = { engine: entry.engine.trim(), model: entry.model.trim(), effortLevel: entry.effortLevel };
    }
    if (!resolved) continue;

    const key = roleRungKey(resolved.engine, resolved.model);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!opts.isEngineAvailable(resolved.engine)) continue;
    targets.push(resolved);
  }
  return targets;
}

function roleRungKey(engine: string, model: string): string {
  return `${engine.trim().toLowerCase()}::${model.trim().toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Reviewer loss policy handling
// ---------------------------------------------------------------------------

export type ReviewerLossOutcome =
  | { action: "block"; reason: string }
  | { action: "degrade"; reason: string }
  | { action: "replace" };

/**
 * Decide what to do when the reviewer role cannot produce a verdict.
 * "replace" means the caller should walk the role's resolved failover chain
 * (resolveRoleFailoverTargets) in order; when the chain is exhausted the
 * caller re-applies the policy with hasFallback=false, which can only return
 * "block" or "degrade" — the retry loop always terminates.
 */
export function applyReviewerLossPolicy(
  policy: ReviewerLossPolicy,
  priorVerdict: ReviewVerdict | null,
  hasFallback: boolean,
): ReviewerLossOutcome {
  // If reviewer already emitted a non-approval verdict, must NOT degrade to success.
  if (priorVerdict && priorVerdict !== "approved") {
    return { action: "block", reason: `Reviewer previously returned "${priorVerdict}" and is now unavailable — cannot degrade to success` };
  }

  switch (policy) {
    case "block":
      return { action: "block", reason: "reviewerLossPolicy is 'block'" };

    case "replace_then_block":
      if (hasFallback) return { action: "replace" };
      return { action: "block", reason: "Reviewer unavailable and no fallback configured" };

    case "replace_then_degrade":
      if (hasFallback) return { action: "replace" };
      return { action: "degrade", reason: "Reviewer unavailable, no fallback — degrading to solo" };

    case "degrade":
    default:
      return { action: "degrade", reason: "reviewerLossPolicy is 'degrade'" };
  }
}

// ---------------------------------------------------------------------------
// Mid-pair orchestration (inline, V1)
// ---------------------------------------------------------------------------

/**
 * Determine whether a session dispatch should use mid_pair execution.
 * Returns true only when:
 *  - feature flag is on
 *  - employee tier is mid_pair
 *  - we are NOT already inside a role session (depth guard)
 */
export function shouldUseMidPairExecution(
  config: CuttlefishConfig,
  employee: Employee | null | undefined,
  transportMeta: Record<string, unknown> | null | undefined,
): boolean {
  if (!isMultiRoleEnabled(config)) return false;
  if (!employee) return false;
  if (isExecutionDepthBlocked(transportMeta)) return false;
  const exec = resolveEffectiveExecution(employee);
  return exec.tier === "mid_pair";
}

/**
 * Generate a new employee run ID for a mid_pair execution.
 * Should be stored on the parent session's transportMeta so it can be
 * read back from API responses as `executionRunState.employeeRunId`.
 */
export function generateEmployeeRunId(): string {
  return randomUUID();
}

/**
 * Log a degraded execution event so operators can track it.
 */
export function logExecutionDegraded(
  sessionId: string,
  reason: string,
  employeeRunId: string,
): void {
  logger.warn(`[execution] Session ${sessionId} run ${employeeRunId} degraded: ${reason}`);
}

/**
 * Log a blocked execution event.
 */
export function logExecutionBlocked(
  sessionId: string,
  reason: string,
  employeeRunId: string,
): void {
  logger.error(`[execution] Session ${sessionId} run ${employeeRunId} blocked: ${reason}`);
}
