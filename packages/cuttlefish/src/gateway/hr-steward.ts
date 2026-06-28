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
  HR_EMPLOYEE_NAME,
  HR_SESSION_KEY,
} from "./org-policy.js";
import { createApproval } from "./approvals.js";
import { logger } from "../shared/logger.js";
import {
  createSession,
  getMessages,
  insertMessage,
  updateSession,
} from "../sessions/registry.js";
import { dispatchWebSessionRun } from "./api/session-dispatch.js";
import type { ApiContext } from "./api/context.js";
import type { Employee, OrgChangeRequest, OrgChangeType } from "../shared/types.js";
import { getReusableHrSession } from "./hr-session.js";

let hrSessionPromise: Promise<ReturnType<typeof createSession> | NonNullable<ReturnType<typeof updateSession>>> | null = null;

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

/** Result of an HR critique turn. */
export interface CritiqueResult {
  critique: string | null;
  /** The HR session that produced the critique, if one was spawned. */
  sessionId?: string;
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

/**
 * Apply an approved (or auto-appliable) change to the org. Re-checks the guards +
 * validation against the LIVE roster (it may have shifted since submission), then
 * dispatches to the existing org writers, hot-reloads, and records `applied`.
 */
export async function applyOrgChange(request: OrgChangeRequest, context: ApiContext): Promise<ApplyResult> {
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

/** Default critique runner: spawn the hr-manager employee in-process and read its reply. */
async function defaultRunCritique(request: OrgChangeRequest, context: ApiContext): Promise<CritiqueResult> {
  const config = context.getConfig();
  const registry = scanOrg();
  const hr = registry.get(HR_EMPLOYEE_NAME);
  if (!hr) {
    logger.warn(`HR critique skipped: "${HR_EMPLOYEE_NAME}" employee not found`);
    return { critique: null };
  }
  const engineName = hr.engine || config.engines.default;
  const engine = context.sessionManager.getEngine(engineName);
  if (!engine) {
    logger.warn(`HR critique skipped: engine "${engineName}" not available`);
    return { critique: null };
  }

  const prompt = buildCritiquePrompt(request, registry);
  const now = new Date().toISOString();
  const session = await getOrCreateHrSession({
    engineName,
    hr,
    now,
    prompt,
    portalName: config.portal?.portalName,
  });
  insertMessage(session.id, "user", prompt);
  await dispatchWebSessionRun(session, prompt, engine, config, context);
  return { critique: readLastAssistantMessage(session.id), sessionId: session.id };
}

async function getOrCreateHrSession(input: {
  engineName: string;
  hr: Employee;
  now: string;
  prompt: string;
  portalName: string | undefined;
}) {
  if (hrSessionPromise) return hrSessionPromise;
  hrSessionPromise = Promise.resolve().then(() => {
    const existing = getReusableHrSession();
    return existing
      ? (updateSession(existing.id, {
          engine: input.engineName,
          model: input.hr.model ?? null,
          effortLevel: input.hr.effortLevel ?? null,
          status: "running",
          lastActivity: input.now,
          lastError: null,
        }) ?? existing)
      : createSession({
          engine: input.engineName,
          source: "web",
          sourceRef: HR_SESSION_KEY,
          connector: "web",
          sessionKey: HR_SESSION_KEY,
          replyContext: { source: "web" },
          employee: HR_EMPLOYEE_NAME,
          model: input.hr.model,
          effortLevel: input.hr.effortLevel,
          prompt: input.prompt,
          portalName: input.portalName,
        });
  }).finally(() => {
    hrSessionPromise = null;
  });
  return hrSessionPromise;
}

function readLastAssistantMessage(sessionId: string): string | null {
  const assistant = getMessages(sessionId).filter((m) => m.role === "assistant" && !m.partial);
  const last = assistant[assistant.length - 1];
  return last ? last.content : null;
}

function buildCritiquePrompt(request: OrgChangeRequest, registry: Map<string, Employee>): string {
  const roster = [...registry.values()]
    .map(
      (e) =>
        `- ${e.name} (${e.displayName}) — ${e.rank} in ${e.department}, ${e.engine}/${e.model}` +
        (e.lifecycle && e.lifecycle !== "active" ? ` [${e.lifecycle}]` : ""),
    )
    .join("\n");

  return [
    `A **${request.changeType}** change has been proposed for "${request.employeeName}".`,
    request.rationale ? `\nStated rationale: ${request.rationale}` : "",
    `\n## Proposed change`,
    `\n### Before\n${request.beforeYaml ?? "(new employee — nothing exists yet)"}`,
    `\n### After\n${request.afterYaml ?? "(none)"}`,
    `\n## Current roster\n${roster || "(empty)"}`,
    `\n## Your task`,
    `Critique this change against your invariants. Lead with a verdict — recommend, revise, or argue against —`,
    `then cover: redundancy vs the roster, scope (narrow & measurable?), model & cost fit, structure`,
    `(department/rank/reportsTo, no cycles), guardrails (minimal tool grants, forbidden actions, escalation),`,
    `and a rollback path. Be concise and decisive. This is an automatic pre-decision review; the operator`,
    `will read your critique before approving.`,
  ].join("\n");
}
