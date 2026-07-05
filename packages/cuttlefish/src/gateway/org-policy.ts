/**
 * Org-change permission policy + the steward's hard guards.
 *
 * Pure-ish module (the only IO is an optional read of the operator override at
 * ORG_POLICY_FILE). It answers three questions about a proposed change:
 *   1. classifyChange  — what risk tier is it, and does it need human approval?
 *   2. assertNotSelfModification — is the steward trying to edit itself? (blocked)
 *   3. assertAcyclic   — would it make the org graph cyclic / self-referential?
 *
 * The enforced source of truth is this code; ORG_POLICY_FILE only lets an
 * operator TIGHTEN/loosen the per-changeType tier without a code change. These
 * guards are called both when a change is submitted (hr-steward.submitOrgChange)
 * and again at apply time (the roster may have shifted under it).
 */
import fs from "node:fs";
import { ORG_POLICY_FILE } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { portalEmployeeSlug } from "../shared/portal-slug.js";
import { resolveOrgHierarchy } from "./org-hierarchy.js";
import type {
  Employee,
  OrgChangeRiskLevel,
  OrgChangeType,
} from "../shared/types.js";

/** The reserved identity of the HR / Org Steward employee. It may not be edited
 *  by the steward flow itself. */
export const HR_EMPLOYEE_NAME = "hr-manager";
/** HR runs as a singleton lane so critiques and direct chats share one queue. */
export const HR_SESSION_KEY = `employee:${HR_EMPLOYEE_NAME}`;

export interface PolicyTier {
  riskLevel: OrgChangeRiskLevel;
  requiresHumanApproval: boolean;
}

export interface PolicyInput {
  changeType: OrgChangeType;
  employeeName: string;
  proposed: Record<string, unknown>;
  /** Who proposed it. Agents (hr-manager/agent/system) may never self-edit HR. */
  proposedBy?: string;
}

/** Thrown when a change is categorically disallowed (self-edit, cycle, …). */
export class OrgChangeBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrgChangeBlockedError";
  }
}

/** Baked-in default tiers. Cosmetic edits are downgraded to low in classifyChange. */
const DEFAULT_CHANGE_POLICY: Record<OrgChangeType, PolicyTier> = {
  create_agent: { riskLevel: "high", requiresHumanApproval: true },
  modify_instructions: { riskLevel: "medium", requiresHumanApproval: true },
  change_model: { riskLevel: "medium", requiresHumanApproval: true },
  change_engine: { riskLevel: "medium", requiresHumanApproval: true },
  change_budget: { riskLevel: "medium", requiresHumanApproval: true },
  change_execution: { riskLevel: "medium", requiresHumanApproval: true },
  promote: { riskLevel: "high", requiresHumanApproval: true },
  demote: { riskLevel: "high", requiresHumanApproval: true },
  reassign_manager: { riskLevel: "high", requiresHumanApproval: true },
  change_department: { riskLevel: "high", requiresHumanApproval: true },
  disable_agent: { riskLevel: "high", requiresHumanApproval: true },
  retire_agent: { riskLevel: "high", requiresHumanApproval: true },
};

/** Fields whose change carries no real risk — a cosmetic-only edit is auto-appliable. */
const COSMETIC_FIELDS = new Set(["displayName", "emoji", "avatar", "alwaysNotify"]);
const AGENT_ACTOR_ALIASES = new Set([
  HR_EMPLOYEE_NAME,
  "agent",
  "system",
  "coo",
  // The default portal executive slug is "cuttlefish"; this is the canonical
  // COO identity in a default install even when older prompts still say "coo".
  portalEmployeeSlug(undefined),
]);

/** Reads the optional operator override and merges it over the defaults. */
export function loadChangePolicy(): Record<OrgChangeType, PolicyTier> {
  try {
    if (!fs.existsSync(ORG_POLICY_FILE)) return DEFAULT_CHANGE_POLICY;
    const override = JSON.parse(fs.readFileSync(ORG_POLICY_FILE, "utf-8")) as Partial<
      Record<OrgChangeType, Partial<PolicyTier>>
    >;
    const merged = { ...DEFAULT_CHANGE_POLICY };
    for (const key of Object.keys(merged) as OrgChangeType[]) {
      if (override[key]) merged[key] = { ...merged[key], ...override[key] };
    }
    return merged;
  } catch (err) {
    logger.warn(`Failed to read org policy override ${ORG_POLICY_FILE}: ${err}`);
    return DEFAULT_CHANGE_POLICY;
  }
}

function isCosmeticOnly(proposed: Record<string, unknown>): boolean {
  const keys = Object.keys(proposed);
  return keys.length > 0 && keys.every((k) => COSMETIC_FIELDS.has(k));
}

/** Classify a proposed change into a risk tier + approval requirement. */
export function classifyChange(input: PolicyInput): PolicyTier {
  // Any change to HR itself, and any broad tool grant (mcp: true), always needs
  // a human in the loop — regardless of changeType.
  const broadGrant = (input.proposed as { mcp?: unknown }).mcp === true;
  if (input.employeeName === HR_EMPLOYEE_NAME || broadGrant) {
    return { riskLevel: "high", requiresHumanApproval: true };
  }
  // A cosmetic-only instruction edit (rename, emoji, avatar) is low-risk and may
  // apply without sign-off.
  if (input.changeType === "modify_instructions" && isCosmeticOnly(input.proposed)) {
    return { riskLevel: "low", requiresHumanApproval: false };
  }
  return loadChangePolicy()[input.changeType] ?? { riskLevel: "high", requiresHumanApproval: true };
}

/**
 * Hard guard: the steward (an agent) may never create, modify, disable, or retire
 * itself. A human operator may still change HR (their changes are forced through
 * the approval gate by classifyChange), so the guard only fires for agent actors.
 */
export function assertNotSelfModification(input: PolicyInput): void {
  if (input.employeeName !== HR_EMPLOYEE_NAME) return;
  const actor = (input.proposedBy ?? "user").trim().toLowerCase();
  const isAgent = AGENT_ACTOR_ALIASES.has(actor);
  if (isAgent) {
    throw new OrgChangeBlockedError(
      "The HR / Org Steward may not create, modify, disable, or retire itself. Escalate to the human operator.",
    );
  }
}

/**
 * Hard guard: reject any reportsTo-affecting change that would make the org graph
 * cyclic or self-referential. Builds a hypothetical registry with the change
 * applied and runs the real hierarchy resolver.
 */
export function assertAcyclic(input: PolicyInput, registry: Map<string, Employee>): void {
  const proposedReportsTo = (input.proposed as { reportsTo?: string | string[] }).reportsTo;
  // Only changes that touch reportsTo (or create a node with one) can add a cycle.
  if (proposedReportsTo === undefined && input.changeType !== "reassign_manager") return;

  const clone = new Map(registry);
  const current = clone.get(input.employeeName);
  const hypothetical: Employee = current
    ? { ...current, reportsTo: proposedReportsTo ?? current.reportsTo }
    : {
        name: input.employeeName,
        displayName: input.employeeName,
        department: String((input.proposed as { department?: unknown }).department ?? "general"),
        rank: ((input.proposed as { rank?: Employee["rank"] }).rank) ?? "employee",
        engine: "claude",
        model: "sonnet",
        persona: "x",
        reportsTo: proposedReportsTo,
      };
  clone.set(input.employeeName, hypothetical);

  const { warnings } = resolveOrgHierarchy(clone);
  const bad = warnings.find(
    (w) => w.employee === input.employeeName && (w.type === "cycle" || w.type === "self_ref"),
  );
  if (bad) throw new OrgChangeBlockedError(bad.message);
}
