import path from "node:path";
import {
  EMPLOYEE_APPROVAL_POLICIES,
  EMPLOYEE_LIFECYCLES,
  SECURITY_REVIEW_TRIGGERS,
  EXECUTION_TIERS,
  REVIEWER_LOSS_POLICIES,
  REVIEWER_TOOL_PROFILES,
  MAX_ROLE_FALLBACK_CHAIN,
  ORG_CHANGE_TYPES,
} from "../shared/types.js";
import type {
  Employee,
  EmployeeApprovalPolicy,
  EmployeeLifecycle,
  SecurityReviewTrigger,
  EmployeeExecutionConfig,
  CuttlefishConfig,
  OrgChangeType,
} from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { getModelRegistry, effortLevelsForModel } from "../shared/models.js";
import { resolveModelAlias } from "../sessions/session-patch.js";
import { findDisallowedCliFlag } from "../shared/cli-flag-policy.js";

/** Fields of an employee YAML that may be mutated via the update API.
 *  `name` is intentionally excluded — it is the immutable identity/lookup key. */
export interface EmployeeUpdate {
  displayName?: string;
  department?: string;
  rank?: Employee["rank"];
  engine?: string;
  model?: string;
  effortLevel?: string;
  persona?: string;
  reportsTo?: string | string[] | null;
  cliFlags?: string[];
  alwaysNotify?: boolean;
  lifecycle?: EmployeeLifecycle;
  approvalPolicy?: EmployeeApprovalPolicy;
  reviewTriggers?: SecurityReviewTrigger[];
  securityReviewer?: string;
  /** UI convenience field persisted into modelPolicy.fallback_chain[0]. */
  fallbackEngine?: string | null;
  /** UI convenience field persisted into modelPolicy.fallback_chain[0]. */
  fallbackModel?: string | null;
  /** Canonical icon: an ocean avatar id ("kind:id"). "" clears it. Mutually
   *  exclusive with `emoji` — setting one clears the other on merge. */
  avatar?: string;
  /** Canonical icon: a plain emoji. "" clears it. See `avatar`. */
  emoji?: string;
  /** V1 execution profile. Replaces the existing block wholesale. null clears to solo default. */
  execution?: Partial<EmployeeExecutionConfig> | null;
}

export interface EmployeeCreate {
  name: string;
  displayName: string;
  department: string;
  rank: Employee["rank"];
  engine: string;
  model: string;
  effortLevel?: string;
  persona: string;
  reportsTo?: string | string[];
  cliFlags?: string[];
  alwaysNotify?: boolean;
  lifecycle?: EmployeeLifecycle;
  approvalPolicy?: EmployeeApprovalPolicy;
  reviewTriggers?: SecurityReviewTrigger[];
  securityReviewer?: string;
  fallbackEngine?: string | null;
  fallbackModel?: string | null;
  avatar?: string;
  emoji?: string;
  execution?: Partial<EmployeeExecutionConfig> | null;
}

/** The set of YAML keys the update path is allowed to write. `name` is never here. */
export const WRITABLE_FIELDS = [
  "displayName",
  "department",
  "rank",
  "engine",
  "model",
  "effortLevel",
  "persona",
  "reportsTo",
  "cliFlags",
  "alwaysNotify",
  "lifecycle",
  "approvalPolicy",
  "reviewTriggers",
  "securityReviewer",
] as const;

// `avatar`/`emoji` are accepted but not in WRITABLE_FIELDS — like `fallbackModel`,
// they are merged via dedicated XOR logic (see mergeEmployeeUpdateData).
// `execution` is accepted but handled separately since it's an object block.
const ACCEPTED_UPDATE_FIELDS = [...WRITABLE_FIELDS, "fallbackEngine", "fallbackModel", "avatar", "emoji", "execution"] as const;

const VALID_RANKS: ReadonlyArray<Employee["rank"]> = [
  "executive",
  "manager",
  "senior",
  "employee",
];

export interface EmployeeUpdateResult {
  ok: boolean;
  updates?: EmployeeUpdate;
  error?: string;
}

const VALID_CHANGE_TYPES = new Set<OrgChangeType>(ORG_CHANGE_TYPES);

export type ParsedChangeInput =
  | { ok: true; value: { changeType: OrgChangeType; employeeName: string; proposed: Record<string, unknown> } }
  | { ok: false; error: string };

/** Validate the shared {changeType, employeeName, proposed} shape used by the
 *  /api/org/validate and /api/org/change-requests routes. */
export function parseChangeInput(body: unknown): ParsedChangeInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.changeType !== "string" || !VALID_CHANGE_TYPES.has(b.changeType as OrgChangeType)) {
    return { ok: false, error: `invalid changeType (valid: ${[...VALID_CHANGE_TYPES].join(", ")})` };
  }
  const employeeName = typeof b.employeeName === "string" ? b.employeeName.trim() : "";
  if (!employeeName) return { ok: false, error: "employeeName must be a non-empty string" };
  if (!b.proposed || typeof b.proposed !== "object" || Array.isArray(b.proposed)) {
    return { ok: false, error: "proposed must be a JSON object" };
  }
  return {
    ok: true,
    value: { changeType: b.changeType as OrgChangeType, employeeName, proposed: b.proposed as Record<string, unknown> },
  };
}

export interface EmployeeCreateResult {
  ok: boolean;
  employee?: EmployeeCreate;
  error?: string;
}

export function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateModelIdForEngine(
  registry: ReturnType<typeof getModelRegistry>,
  engineId: string,
  modelId: string,
  fieldName: string,
): string | undefined {
  const entry = registry[engineId];
  if (entry && !entry.models.some((m) => m.id === modelId)) {
    if (engineId === "pi") {
      logger.warn(`pi model "${modelId}" not in discovered set yet — allowing`);
      return undefined;
    }
    const known = entry.models.map((m) => m.id).join(", ");
    return `unknown ${fieldName} "${modelId}" for engine "${engineId}" (known: ${known || "none"})`;
  }
  return undefined;
}

function normalizeModelForEngine(
  registry: ReturnType<typeof getModelRegistry>,
  engineId: string,
  modelId: string,
): string {
  const knownModelIds = new Set((registry[engineId]?.models ?? []).map((model) => model.id));
  return resolveModelAlias(engineId, modelId, knownModelIds);
}

/**
 * Validate an employee update body against the model/engine registry and the
 * Employee type's constraints. Pure — does no IO. Rejects:
 *  - `name` (immutable) and any key not in WRITABLE_FIELDS
 *  - empty/whitespace displayName or persona (an empty persona makes scanOrg drop
 *    the employee — G3)
 *  - an invalid rank enum
 *  - an unknown engine, or a model/effortLevel invalid for the *resulting* engine
 *  - wrong-typed cliFlags / alwaysNotify / reportsTo
 *
 * `current` supplies the existing engine/model so model+effort can be validated
 * even when those fields aren't part of this update.
 */
/**
 * Structurally validate an `execution.roles` update payload. Returns an error
 * message, or null when valid. Enforces:
 *  - only implementer/reviewer roles, only override/fallbackChain policy keys
 *  - override fields are strings
 *  - fallbackChain is a bounded array whose entries are either a direct agent
 *    (engine + model) or an external-agent deferral (employee), never both
 *  - employee deferral targets must reference a known employee and never the
 *    employee being edited (no self-failover loops)
 */
function validateExecutionRoles(
  raw: unknown,
  currentName: string,
  knownEmployeeNames?: readonly string[],
): string | null {
  if (raw === null) return null; // explicit clear
  if (typeof raw !== "object" || Array.isArray(raw)) return "execution.roles must be an object";
  const roles = raw as Record<string, unknown>;
  const unknownRoles = Object.keys(roles).filter((k) => k !== "implementer" && k !== "reviewer");
  if (unknownRoles.length > 0) {
    return `unknown execution.roles key(s): ${unknownRoles.join(", ")} (valid: implementer, reviewer)`;
  }
  for (const role of ["implementer", "reviewer"] as const) {
    const policy = roles[role];
    if (policy === undefined || policy === null) continue;
    if (typeof policy !== "object" || Array.isArray(policy)) {
      return `execution.roles.${role} must be an object`;
    }
    const p = policy as Record<string, unknown>;
    const unknownPolicyKeys = Object.keys(p).filter((k) => k !== "override" && k !== "fallbackChain");
    if (unknownPolicyKeys.length > 0) {
      return `unknown execution.roles.${role} key(s): ${unknownPolicyKeys.join(", ")}`;
    }
    if (p.override !== undefined && p.override !== null) {
      if (typeof p.override !== "object" || Array.isArray(p.override)) {
        return `execution.roles.${role}.override must be an object`;
      }
      const ov = p.override as Record<string, unknown>;
      for (const key of ["engine", "model", "effortLevel"] as const) {
        if (ov[key] !== undefined && typeof ov[key] !== "string") {
          return `execution.roles.${role}.override.${key} must be a string`;
        }
      }
      const unknownOverrideKeys = Object.keys(ov).filter((k) => !["engine", "model", "effortLevel"].includes(k));
      if (unknownOverrideKeys.length > 0) {
        return `unknown execution.roles.${role}.override key(s): ${unknownOverrideKeys.join(", ")}`;
      }
    }
    if (p.fallbackChain !== undefined && p.fallbackChain !== null) {
      if (!Array.isArray(p.fallbackChain)) {
        return `execution.roles.${role}.fallbackChain must be an array`;
      }
      if (p.fallbackChain.length > MAX_ROLE_FALLBACK_CHAIN) {
        return `execution.roles.${role}.fallbackChain exceeds the maximum of ${MAX_ROLE_FALLBACK_CHAIN} targets`;
      }
      for (const [i, entry] of p.fallbackChain.entries()) {
        const label = `execution.roles.${role}.fallbackChain[${i}]`;
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return `${label} must be an object`;
        }
        const fc = entry as Record<string, unknown>;
        const unknownTargetKeys = Object.keys(fc).filter((k) => !["engine", "model", "effortLevel", "employee"].includes(k));
        if (unknownTargetKeys.length > 0) {
          return `unknown ${label} key(s): ${unknownTargetKeys.join(", ")}`;
        }
        for (const key of ["engine", "model", "effortLevel", "employee"] as const) {
          if (fc[key] !== undefined && typeof fc[key] !== "string") {
            return `${label}.${key} must be a string`;
          }
        }
        const employee = typeof fc.employee === "string" ? fc.employee.trim() : "";
        const engine = typeof fc.engine === "string" ? fc.engine.trim() : "";
        const model = typeof fc.model === "string" ? fc.model.trim() : "";
        if (employee) {
          if (engine || model) {
            return `${label} must set either employee OR engine+model, not both`;
          }
          if (employee === currentName) {
            return `${label}.employee cannot reference the employee itself`;
          }
          if (knownEmployeeNames && !knownEmployeeNames.includes(employee)) {
            return `${label}.employee references unknown employee "${employee}"`;
          }
        } else if (!engine || !model) {
          return `${label} must set employee, or both engine and model`;
        }
      }
    }
  }
  return null;
}

export function validateEmployeeUpdate(
  config: CuttlefishConfig,
  current: Employee,
  body: Record<string, unknown>,
  knownEmployeeNames?: Iterable<string>,
): EmployeeUpdateResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "update body must be a JSON object" };
  }

  if ("name" in body) {
    return { ok: false, error: "field 'name' is immutable and cannot be changed" };
  }

  const unknownKeys = Object.keys(body).filter(
    (k) => !(ACCEPTED_UPDATE_FIELDS as readonly string[]).includes(k),
  );
  if (unknownKeys.length > 0) {
    return { ok: false, error: `unknown field(s): ${unknownKeys.join(", ")}` };
  }

  // Materialize once — callers may pass a live iterator, and both the reportsTo
  // and execution.roles checks below need the names.
  const knownNamesForRoles = knownEmployeeNames ? Array.from(knownEmployeeNames) : undefined;

  const updates: EmployeeUpdate = {};

  // --- non-empty string fields ---
  for (const key of ["displayName", "persona"] as const) {
    if (body[key] !== undefined) {
      const v = body[key];
      if (typeof v !== "string" || !v.trim()) {
        return { ok: false, error: `${key} must be a non-empty string` };
      }
      updates[key] = v;
    }
  }

  // --- department: empty string explicitly clears the department assignment ---
  if (body.department !== undefined) {
    const v = body.department;
    if (typeof v !== "string") {
      return { ok: false, error: "department must be a string" };
    }
    const department = v.trim();
    if (path.isAbsolute(department)) return { ok: false, error: "department must not be an absolute path" };
    if (department.includes("..")) return { ok: false, error: "department must not contain '..' traversal" };
    updates.department = department;
  }

  // --- rank enum ---
  if (body.rank !== undefined) {
    if (typeof body.rank !== "string" || !VALID_RANKS.includes(body.rank as Employee["rank"])) {
      return { ok: false, error: `invalid rank "${String(body.rank)}" (valid: ${VALID_RANKS.join(", ")})` };
    }
    updates.rank = body.rank as Employee["rank"];
  }

  // --- engine (must exist in the registry) ---
  const registry = getModelRegistry(config);
  if (body.engine !== undefined) {
    if (typeof body.engine !== "string" || !body.engine.trim()) {
      return { ok: false, error: "engine must be a non-empty string" };
    }
    const engineId = body.engine.trim();
    if (!registry[engineId]) {
      const known = Object.keys(registry).join(", ");
      return { ok: false, error: `unknown engine "${engineId}" (known: ${known || "none"})` };
    }
    updates.engine = engineId;
  }

  const resultingEngine = updates.engine ?? current.engine;

  // --- model (valid for the resulting engine) ---
  if (body.model !== undefined) {
    if (typeof body.model !== "string" || !body.model.trim()) {
      return { ok: false, error: "model must be a non-empty string" };
    }
    const modelId = normalizeModelForEngine(registry, resultingEngine, body.model.trim());
    const modelError = validateModelIdForEngine(registry, resultingEngine, modelId, "model");
    if (modelError) {
      return { ok: false, error: modelError };
    }
    updates.model = modelId;
  }

  // --- effortLevel (valid for the resulting engine+model) ---
  if (body.effortLevel !== undefined) {
    if (typeof body.effortLevel !== "string" || !body.effortLevel.trim()) {
      return { ok: false, error: "effortLevel must be a non-empty string" };
    }
    const level = body.effortLevel.trim();
    const effectiveModel = updates.model ?? current.model ?? undefined;
    const valid = effortLevelsForModel(config, resultingEngine, effectiveModel);
    if (valid.length === 0) {
      return { ok: false, error: `engine "${resultingEngine}"${effectiveModel ? ` model "${effectiveModel}"` : ""} does not support effort levels` };
    }
    if (!valid.includes(level)) {
      return { ok: false, error: `invalid effortLevel "${level}" (valid: ${valid.join(", ")})` };
    }
    updates.effortLevel = level;
  }

  // --- reportsTo (string | string[] | null) ---
  if (body.reportsTo !== undefined) {
    const v = body.reportsTo;
    if (v === null) {
      updates.reportsTo = [];
    } else {
      const isString = typeof v === "string" && v.trim().length > 0;
      const isStringArray = Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim().length > 0);
      if (!isString && !isStringArray) {
        return { ok: false, error: "reportsTo must be null, a non-empty string, or array of non-empty strings" };
      }
      const reportsTo = v as string | string[];
      const parentNames = Array.isArray(reportsTo) ? reportsTo : [reportsTo];
      if (parentNames.some((name) => name === current.name)) {
        return { ok: false, error: "reportsTo cannot reference the employee itself" };
      }
      if (knownNamesForRoles) {
        const known = new Set(knownNamesForRoles);
        const missing = parentNames.filter((name) => !known.has(name));
        if (missing.length > 0) {
          return { ok: false, error: `reportsTo references unknown employee(s): ${missing.join(", ")}` };
        }
      }
      updates.reportsTo = reportsTo;
    }
  }

  // --- cliFlags (string[]) ---
  if (body.cliFlags !== undefined) {
    const v = body.cliFlags;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
      return { ok: false, error: "cliFlags must be an array of strings" };
    }
    const badFlag = (v as string[]).find((f) => /[\x00-\x1f\x7f]/.test(f));
    if (badFlag !== undefined) {
      return { ok: false, error: "cliFlags entries must not contain control characters or newlines" };
    }
    // Audit A-F2/F-10: refuse permission-bypass / config-injection flags so a
    // roster edit cannot escalate the child engine's authority.
    const disallowed = findDisallowedCliFlag(v as string[]);
    if (disallowed !== undefined) {
      return { ok: false, error: `cliFlags may not include the privileged flag "${disallowed}"` };
    }
    updates.cliFlags = v as string[];
  }

  // --- alwaysNotify (boolean) ---
  if (body.alwaysNotify !== undefined) {
    if (typeof body.alwaysNotify !== "boolean") {
      return { ok: false, error: "alwaysNotify must be a boolean" };
    }
    updates.alwaysNotify = body.alwaysNotify;
  }

  // --- lifecycle enum ---
  if (body.lifecycle !== undefined) {
    if (typeof body.lifecycle !== "string" || !(EMPLOYEE_LIFECYCLES as readonly string[]).includes(body.lifecycle)) {
      return { ok: false, error: `invalid lifecycle "${String(body.lifecycle)}" (valid: ${EMPLOYEE_LIFECYCLES.join(", ")})` };
    }
    updates.lifecycle = body.lifecycle as EmployeeLifecycle;
  }

  if (body.approvalPolicy !== undefined) {
    if (
      typeof body.approvalPolicy !== "string" ||
      !(EMPLOYEE_APPROVAL_POLICIES as readonly string[]).includes(body.approvalPolicy)
    ) {
      return {
        ok: false,
        error: `invalid approvalPolicy "${String(body.approvalPolicy)}" (valid: ${EMPLOYEE_APPROVAL_POLICIES.join(", ")})`,
      };
    }
    updates.approvalPolicy = body.approvalPolicy as EmployeeApprovalPolicy;
  }

  if (body.reviewTriggers !== undefined) {
    if (
      !Array.isArray(body.reviewTriggers) ||
      body.reviewTriggers.length === 0 ||
      !body.reviewTriggers.every(
        (value) => typeof value === "string" && (SECURITY_REVIEW_TRIGGERS as readonly string[]).includes(value),
      )
    ) {
      return {
        ok: false,
        error: `reviewTriggers must be a non-empty array drawn from: ${SECURITY_REVIEW_TRIGGERS.join(", ")}`,
      };
    }
    updates.reviewTriggers = [...new Set(body.reviewTriggers as SecurityReviewTrigger[])];
  }

  if (body.securityReviewer !== undefined) {
    if (typeof body.securityReviewer !== "string" || !body.securityReviewer.trim()) {
      return { ok: false, error: "securityReviewer must be a non-empty string" };
    }
    updates.securityReviewer = body.securityReviewer.trim();
  }

  if (body.fallbackEngine !== undefined) {
    if (body.fallbackEngine === null) {
      updates.fallbackEngine = null;
    } else if (typeof body.fallbackEngine !== "string") {
      return { ok: false, error: "fallbackEngine must be a string or null" };
    } else {
      const fallbackEngine = body.fallbackEngine.trim();
      if (!fallbackEngine) {
        updates.fallbackEngine = null;
      } else if (!registry[fallbackEngine]) {
        return { ok: false, error: `unknown fallbackEngine "${fallbackEngine}"` };
      } else {
        updates.fallbackEngine = fallbackEngine;
        const currentFallbackModel =
          updates.fallbackModel ??
          current.modelPolicy?.fallback_chain?.[0]?.model;
        if (typeof currentFallbackModel === "string" && currentFallbackModel.trim()) {
          const fallbackError = validateModelIdForEngine(
            registry,
            fallbackEngine,
            currentFallbackModel.trim(),
            "fallbackModel",
          );
          if (fallbackError) return { ok: false, error: fallbackError };
        }
      }
    }
  }

  if (body.fallbackModel !== undefined) {
    const fallbackEngine =
      typeof updates.fallbackEngine === "string" && updates.fallbackEngine.trim()
        ? updates.fallbackEngine.trim()
        : resultingEngine;
    if (body.fallbackModel === null) {
      updates.fallbackModel = null;
    } else if (typeof body.fallbackModel !== "string") {
      return { ok: false, error: "fallbackModel must be a string or null" };
    } else {
      const fallbackModel = body.fallbackModel.trim();
      if (!fallbackModel) {
        updates.fallbackModel = null;
      } else {
        const normalizedFallbackModel = normalizeModelForEngine(registry, fallbackEngine, fallbackModel);
        const fallbackError = validateModelIdForEngine(registry, fallbackEngine, normalizedFallbackModel, "fallbackModel");
        if (fallbackError) return { ok: false, error: fallbackError };
        updates.fallbackModel = normalizedFallbackModel;
      }
    }
  }

  // --- canonical icon fields (avatar | emoji); "" is the explicit clear signal ---
  for (const key of ["avatar", "emoji"] as const) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "string") {
        return { ok: false, error: `${key} must be a string` };
      }
      updates[key] = body[key] as string;
    }
  }

  // --- execution block (V1: solo or mid_pair) ---
  if (body.execution !== undefined) {
    if (body.execution === null) {
      updates.execution = null;
    } else if (typeof body.execution !== "object" || Array.isArray(body.execution)) {
      return { ok: false, error: "execution must be an object or null" };
    } else {
      const exec = body.execution as Record<string, unknown>;
      if (exec.tier !== undefined && !(EXECUTION_TIERS as readonly string[]).includes(exec.tier as string)) {
        return { ok: false, error: `invalid execution.tier "${String(exec.tier)}" (valid: ${EXECUTION_TIERS.join(", ")})` };
      }
      if (exec.reviewerLossPolicy !== undefined && !(REVIEWER_LOSS_POLICIES as readonly string[]).includes(exec.reviewerLossPolicy as string)) {
        return { ok: false, error: `invalid execution.reviewerLossPolicy "${String(exec.reviewerLossPolicy)}"` };
      }
      if (exec.reviewerToolProfile !== undefined && !(REVIEWER_TOOL_PROFILES as readonly string[]).includes(exec.reviewerToolProfile as string)) {
        return { ok: false, error: `invalid execution.reviewerToolProfile "${String(exec.reviewerToolProfile)}"` };
      }
      for (const numField of ["maxInternalPasses", "maxChildSessions", "maxWallClockMs", "maxToolCalls", "maxEstimatedCostUsd"] as const) {
        if (exec[numField] !== undefined && (typeof exec[numField] !== "number" || (exec[numField] as number) <= 0)) {
          return { ok: false, error: `execution.${numField} must be a positive number` };
        }
      }
      // Reject unknown sub-keys to block future-tier fields from slipping in
      const knownExecKeys = new Set(["tier", "maxInternalPasses", "maxChildSessions", "maxWallClockMs", "maxToolCalls", "maxEstimatedCostUsd", "reviewerLossPolicy", "reviewerToolProfile", "roles"]);
      const unknownExecKeys = Object.keys(exec).filter((k) => !knownExecKeys.has(k));
      if (unknownExecKeys.length > 0) {
        return { ok: false, error: `unknown execution field(s): ${unknownExecKeys.join(", ")}` };
      }
      if (exec.roles !== undefined) {
        const rolesError = validateExecutionRoles(exec.roles, current.name, knownNamesForRoles);
        if (rolesError) return { ok: false, error: rolesError };
      }
      updates.execution = exec as Partial<EmployeeExecutionConfig>;
    }
  }

  if (Object.keys(updates).length === 0) {
    return { ok: false, error: "no recognized fields to update" };
  }

  return { ok: true, updates };
}

export function validateEmployeeCreate(
  config: CuttlefishConfig,
  body: Record<string, unknown>,
  existingNames: Iterable<string>,
): EmployeeCreateResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "employee body must be a JSON object" };
  }

  const known = new Set([
    "name",
    "displayName",
    "department",
    "rank",
    "engine",
    "model",
    "effortLevel",
    "persona",
    "reportsTo",
    "cliFlags",
    "alwaysNotify",
    "lifecycle",
    "approvalPolicy",
    "reviewTriggers",
    "securityReviewer",
    "fallbackEngine",
    "fallbackModel",
    "avatar",
    "emoji",
    "execution",
  ]);
  const unknownKeys = Object.keys(body).filter((key) => !known.has(key));
  if (unknownKeys.length > 0) {
    return { ok: false, error: `unknown field(s): ${unknownKeys.join(", ")}` };
  }

  // Materialize the known-names iterable exactly once. Callers pass a live Map
  // iterator (`registry.keys()`); the duplicate-name guard below consumes it, and
  // passing the now-exhausted iterator on to validateEmployeeUpdate would leave its
  // reportsTo check with an empty set — silently rejecting every valid manager
  // ("reportsTo references unknown employee(s): …"). An array is safely re-iterable.
  const knownNames = Array.from(existingNames);

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { ok: false, error: "name must be a non-empty string" };
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    return { ok: false, error: "name must use only letters, numbers, dot, underscore, or hyphen" };
  }
  // Case-insensitive: employee YAML filenames derive from `name`, and a
  // case-only variant (e.g. "Foo" vs "foo") would silently collide or
  // overwrite on case-insensitive filesystems (default macOS/Windows).
  if (knownNames.some((candidate) => candidate.toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: `employee "${name}" already exists` };
  }

  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  if (!displayName) return { ok: false, error: "displayName must be a non-empty string" };

  const department = typeof body.department === "string" ? body.department.trim() : "";
  if (!department) return { ok: false, error: "department must be a non-empty string" };
  if (path.isAbsolute(department)) return { ok: false, error: "department must not be an absolute path" };
  if (department.includes("..")) return { ok: false, error: "department must not contain '..' traversal" };

  const persona = typeof body.persona === "string" ? body.persona.trim() : "";
  if (!persona) return { ok: false, error: "persona must be a non-empty string" };

  const rank = typeof body.rank === "string" ? body.rank : "employee";
  if (!VALID_RANKS.includes(rank as Employee["rank"])) {
    return { ok: false, error: `invalid rank "${String(body.rank)}" (valid: ${VALID_RANKS.join(", ")})` };
  }

  const engine = typeof body.engine === "string" ? body.engine.trim() : "";
  if (!engine) return { ok: false, error: "engine must be a non-empty string" };
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!model) return { ok: false, error: "model must be a non-empty string" };

  const placeholderCurrent: Employee = {
    name,
    displayName,
    department,
    rank: rank as Employee["rank"],
    engine,
    model,
    persona,
  };

  const updates = validateEmployeeUpdate(config, placeholderCurrent, {
    displayName,
    department,
    rank,
    engine: body.engine,
    model: body.model,
    effortLevel: body.effortLevel,
    persona,
    reportsTo: body.reportsTo,
    cliFlags: body.cliFlags,
    alwaysNotify: body.alwaysNotify,
    lifecycle: body.lifecycle,
    approvalPolicy: body.approvalPolicy,
    reviewTriggers: body.reviewTriggers,
    securityReviewer: body.securityReviewer,
    fallbackEngine: body.fallbackEngine,
    fallbackModel: body.fallbackModel,
    avatar: body.avatar,
    emoji: body.emoji,
    execution: body.execution,
  }, knownNames);
  if (!updates.ok || !updates.updates) {
    return { ok: false, error: updates.error || "invalid employee body" };
  }

  return {
    ok: true,
    employee: {
      name,
      displayName,
      department,
      rank: updates.updates.rank ?? (rank as Employee["rank"]),
      engine: updates.updates.engine ?? placeholderCurrent.engine,
      model: updates.updates.model ?? placeholderCurrent.model,
      effortLevel: updates.updates.effortLevel,
      persona,
      reportsTo: updates.updates.reportsTo ?? undefined,
      cliFlags: updates.updates.cliFlags,
      alwaysNotify: updates.updates.alwaysNotify,
      lifecycle: updates.updates.lifecycle,
      approvalPolicy: updates.updates.approvalPolicy,
      reviewTriggers: updates.updates.reviewTriggers,
      securityReviewer: updates.updates.securityReviewer,
      fallbackEngine: updates.updates.fallbackEngine,
      fallbackModel: updates.updates.fallbackModel,
      avatar: updates.updates.avatar,
      emoji: updates.updates.emoji,
      // Carry the validated execution profile through to persistence. Without
      // this the create path silently drops the mid_pair/reviewer config the
      // operator configured in the editor (buildEmployeeCreateData writes it,
      // but only if it survives to the returned employee object).
      execution: updates.updates.execution ?? undefined,
    },
  };
}
