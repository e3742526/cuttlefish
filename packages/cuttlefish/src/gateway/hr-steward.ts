/**
 * HR / Org Steward service — the always-on critique pipeline + the apply path.
 *
 * Every org mutation funnels through `submitOrgChange`, which:
 *   1. runs the hard guards (no self-edit, no cycle) — blocked changes are
 *      persisted as `rejected` with the reason, never applied;
 *   2. classifies the change into a risk tier (org-policy.ts);
 *   3. persists it `pending_critique` and fires an HR critique turn in the
 *      BACKGROUND (the route returns 202 immediately — the critique is an LLM
 *      turn and must not block the response);
 *   4. when the critique completes, advances to `pending_approval` (creating the
 *      reused Approval gate) or, for low-risk auto-appliable changes, applies it.
 *
 * `applyOrgChange` re-checks the guards + validation against the live roster and
 * dispatches to the existing org writers. The critique itself (`defaultRunCritique`)
 * spawns the `hr-manager` employee in-process; it is injectable so the pipeline
 * is testable without a live engine.
 */
import {
  scanOrg,
  validateOrgChange,
  validateEmployeeCreate,
  validateEmployeeUpdate,
  createEmployeeYaml,
  updateEmployeeYaml,
  retireEmployeeYaml,
} from "./org.js";
import {
  createChangeRequest,
  getChangeRequest,
  updateChangeRequest,
  updateChangeRequestStatus,
} from "./org-changes.js";
import {
  classifyChange,
  assertNotSelfModification,
  assertAcyclic,
  OrgChangeBlockedError,
} from "./org-policy.js";
import { createApproval } from "./approvals.js";
import { logger } from "../shared/logger.js";
import {
  insertMessage,
  updateSession,
} from "../sessions/registry.js";
import type { ApiContext } from "./api/context.js";
import type { OrgChangeRequest, OrgChangeType } from "../shared/types.js";
import { type CritiqueResult, defaultRunCritique } from "./hr-critique-dispatch.js";
import { KeyedMutex } from "../shared/async-lock.js";

export type { CritiqueResult } from "./hr-critique-dispatch.js";

export interface SubmitOrgChangeInput {
  changeType: OrgChangeType;
  employeeName: string;
  proposed: Record<string, unknown>;
  rationale?: string;
  evidenceRefs?: string[];
  proposedBy?: string;
}

export interface SubmitOrgChangeResult {
  request: OrgChangeRequest;
  blocked: boolean;
  reason?: string;
}

export interface HrStewardDeps {
  /** Injectable critique runner. Defaults to spawning the hr-manager employee. */
  runCritique?: (request: OrgChangeRequest, context: ApiContext) => Promise<CritiqueResult>;
}

/**
 * Submit a proposed org change. Runs guards synchronously, then kicks off the HR
 * critique in the background. Returns as soon as the change is persisted —
 * callers (the route) should return 202 with the returned request.
 */
export async function submitOrgChange(
  input: SubmitOrgChangeInput,
  context: ApiContext,
  deps: HrStewardDeps = {},
): Promise<SubmitOrgChangeResult> {
  const registry = scanOrg();
  const guardInput = {
    changeType: input.changeType,
    employeeName: input.employeeName,
    proposed: input.proposed,
    proposedBy: input.proposedBy,
  };

  // 1. Hard guards. A blocked change is persisted as rejected (for the audit
  //    trail + operator visibility) but never critiqued or applied.
  try {
    assertNotSelfModification(guardInput);
    assertAcyclic(guardInput, registry);
  } catch (err) {
    if (err instanceof OrgChangeBlockedError) {
      const rejected = createChangeRequest({
        ...input,
        riskLevel: "high",
        requiresHumanApproval: true,
        status: "rejected",
      });
      updateChangeRequest(rejected.id, { hrCritique: `Blocked: ${err.message}` }, "org.change.rejected");
      context.emit("org-change:created", { id: rejected.id, status: "rejected", changeType: rejected.changeType, employee: rejected.employeeName });
      return { request: getChangeRequest(rejected.id) ?? rejected, blocked: true, reason: err.message };
    }
    throw err;
  }

  // 2. Classify + persist pending_critique.
  const tier = classifyChange(guardInput);
  const request = createChangeRequest({
    ...input,
    riskLevel: tier.riskLevel,
    requiresHumanApproval: tier.requiresHumanApproval,
    status: "pending_critique",
  });
  context.emit("org-change:created", {
    id: request.id,
    status: request.status,
    changeType: request.changeType,
    employee: request.employeeName,
  });

  // 3. Fire the critique in the background — do NOT await (it's an LLM turn).
  const runCritique = deps.runCritique ?? defaultRunCritique;
  void runCritique(request, context)
    .then((result) => finishCritique(request.id, result, tier.requiresHumanApproval, context))
    .catch((err) => {
      logger.warn(`HR critique failed for ${request.id}: ${err instanceof Error ? err.message : String(err)}`);
      updateChangeRequest(request.id, {
        status: "error",
        hrCritique: `critique failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      context.emit("org-change:updated", { id: request.id, status: "error" });
    });

  return { request, blocked: false };
}

/** Move a critiqued change to pending_approval (gate) or auto-apply it. */
async function finishCritique(
  id: string,
  result: CritiqueResult,
  requiresHumanApproval: boolean,
  context: ApiContext,
): Promise<void> {
  const updated = updateChangeRequestStatus(id, "pending_approval", { hrCritique: result.critique ?? null });
  if (!updated) return;
  context.emit("org-change:updated", { id, status: "pending_approval" });

  if (requiresHumanApproval) {
    const approval = createApproval({
      sessionId: result.sessionId ?? `org-change:${id}`,
      type: "org-change",
      payload: {
        changeRequestId: id,
        changeType: updated.changeType,
        employeeName: updated.employeeName,
        riskLevel: updated.riskLevel,
      },
    });
    updateChangeRequest(id, { approvalId: approval.id });
    context.emit("approval:created", {
      approvalId: approval.id,
      sessionId: approval.sessionId,
      type: "org-change",
      changeRequestId: id,
    });
    return;
  }

  // Low-risk + auto-appliable → apply immediately.
  const fresh = getChangeRequest(id);
  if (fresh) {
    await applyOrgChange(fresh, context);
  }
}

export interface ApplyResult {
  ok: boolean;
  error?: string;
}

export function recordHrDecisionMessage(
  sessionId: string | null | undefined,
  request: OrgChangeRequest,
  opts: { action: "approved" | "rejected" | "applied" | "failed"; actor?: string | null; error?: string | null },
  context?: Pick<ApiContext, "emit">,
): void {
  if (!sessionId) return;
  const actor = opts.actor?.trim() ? opts.actor.trim() : "operator";
  const changeLabel = `${request.changeType} for "${request.employeeName}"`;
  const content =
    opts.action === "approved"
      ? `Human approval received from ${actor} for ${changeLabel}. Applying the approved change now.`
      : opts.action === "rejected"
        ? `Human approval rejected by ${actor} for ${changeLabel}. No org changes were applied.`
        : opts.action === "applied"
          ? `The approved ${changeLabel} has been applied successfully.`
          : `The approved ${changeLabel} could not be applied: ${opts.error ?? "unknown error"}.`;
  insertMessage(sessionId, "assistant", content);
  updateSession(sessionId, {
    lastActivity: new Date().toISOString(),
    ...(opts.action === "failed" ? { lastError: opts.error ?? "org change apply failed" } : {}),
  });
  context?.emit?.("session:updated", { sessionId });
}

// CON-001: org-change apply has 4 independent entry points (approvals.ts's
// org-change branch, org.ts's :id/approve and :id/apply routes, and
// finishCritique's auto-apply branch above) that each do their own
// get -> check-status -> apply sequence with no shared lock. Two
// near-simultaneous calls for the same change request could both pass their
// status check and both run the org-writer side effect. Since all four
// funnel through this one function, keying a mutex on the change-request id
// here — plus a fresh disk re-read of status taken *inside* the lock —
// serializes them and makes the loser's re-read see "applied" and bail
// cleanly, with no code changes needed at any of the four call sites.
const orgChangeApplyLock = new KeyedMutex();

/**
 * Apply an approved (or auto-appliable) change to the org. Re-checks the guards +
 * validation against the LIVE roster (it may have shifted since submission), then
 * dispatches to the existing org writers, hot-reloads, and records `applied`.
 */
export async function applyOrgChange(requestInput: OrgChangeRequest, context: ApiContext): Promise<ApplyResult> {
  return orgChangeApplyLock.withLock(requestInput.id, () => applyOrgChangeLocked(requestInput, context));
}

async function applyOrgChangeLocked(requestInput: OrgChangeRequest, context: ApiContext): Promise<ApplyResult> {
  // Re-read fresh from disk now that we hold the lock — the caller's `request`
  // snapshot may predate another racer's apply that just completed.
  const request = getChangeRequest(requestInput.id) ?? requestInput;
  if (!["pending_approval", "approved"].includes(request.status)) {
    return { ok: false, error: `Change request is '${request.status}' and cannot be applied` };
  }
  const config = context.getConfig();
  const registry = scanOrg();
  const guardInput = {
    changeType: request.changeType,
    employeeName: request.employeeName,
    proposed: request.proposed,
    proposedBy: request.proposedBy,
  };

  try {
    assertNotSelfModification(guardInput);
    assertAcyclic(guardInput, registry);
  } catch (err) {
    if (err instanceof OrgChangeBlockedError) {
      updateChangeRequestStatus(request.id, "rejected", { hrCritique: `Blocked at apply: ${err.message}` });
      context.emit("org-change:updated", { id: request.id, status: "rejected" });
      return { ok: false, error: err.message };
    }
    throw err;
  }

  const validation = validateOrgChange(config, guardInput);
  if (!validation.ok) {
    updateChangeRequestStatus(request.id, "rejected", { hrCritique: `Validation failed at apply: ${validation.error}` });
    context.emit("org-change:updated", { id: request.id, status: "rejected" });
    return { ok: false, error: validation.error };
  }

  let ok = false;
  switch (request.changeType) {
    case "create_agent": {
      const created = validateEmployeeCreate(config, { name: request.employeeName, ...request.proposed }, registry.keys());
      ok = created.ok && !!created.employee && createEmployeeYaml(created.employee);
      break;
    }
    case "retire_agent":
      ok = retireEmployeeYaml(request.employeeName);
      break;
    case "disable_agent":
      ok = updateEmployeeYaml(request.employeeName, { lifecycle: "disabled" });
      break;
    default: {
      const current = registry.get(request.employeeName);
      if (!current) {
        ok = false;
        break;
      }
      const upd = validateEmployeeUpdate(config, current, request.proposed, registry.keys());
      ok = upd.ok && !!upd.updates && updateEmployeeYaml(request.employeeName, upd.updates);
    }
  }

  if (!ok) {
    updateChangeRequestStatus(request.id, "rejected", { hrCritique: "Apply failed — the org writer rejected the change." });
    context.emit("org-change:updated", { id: request.id, status: "rejected" });
    return { ok: false, error: "apply failed" };
  }

  context.reloadOrg?.();
  context.emit("org:updated", { employee: request.employeeName, action: request.changeType });
  updateChangeRequestStatus(request.id, "applied", { appliedAt: new Date().toISOString() });
  context.emit("org-change:updated", { id: request.id, status: "applied" });
  return { ok: true };
}
