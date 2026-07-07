import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { ORG_DIR, ORG_RETIRED_DIR } from "../shared/paths.js";
import { safeWriteYaml } from "../shared/safe-write.js";
import {
  EMPLOYEE_APPROVAL_POLICIES,
  EMPLOYEE_LIFECYCLES,
  SECURITY_REVIEW_TRIGGERS,
  EXECUTION_TIERS,
  REVIEWER_LOSS_POLICIES,
  REVIEWER_TOOL_PROFILES,
  MAX_ROLE_FALLBACK_CHAIN,
} from "../shared/types.js";
import type {
  Employee,
  EmployeeApprovalPolicy,
  EmployeeLifecycle,
  SecurityReviewTrigger,
  EmployeeExecutionConfig,
  ExecutionTier,
  ReviewerLossPolicy,
  ReviewerToolProfile,
  RoleExecutionPolicy,
  RoleFallbackTarget,
  CuttlefishConfig,
  OrgChangeType,
  OrgWarning,
} from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { getModelRegistry, effortLevelsForModel } from "../shared/models.js";
import { resolveModelAlias } from "../sessions/session-patch.js";

/**
 * Reserved `org/` subdirectories that hold HR / Org-Steward artifacts (change
 * requests, drafts, retired personas), not active employees. The scan must never
 * load these as employees — they are surfaced through dedicated APIs instead.
 */
export const RESERVED_ORG_DIRS = new Set(["_changes", "_drafts", "_retired"]);

/**
 * Recursively walk `dir`, invoking `visit` for every employee YAML file
 * (.yaml/.yml, skipping department.yaml and the reserved HR dirs). Stops early
 * and returns the first non-undefined value `visit` returns; visitors that never
 * return a value walk the whole tree.
 */
function walkEmployeeYamls<T>(
  dir: string,
  visit: (fullPath: string) => T | undefined,
): T | undefined {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (RESERVED_ORG_DIRS.has(entry.name)) continue;
      const found = walkEmployeeYamls(fullPath, visit);
      if (found !== undefined) return found;
    } else if (
      (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) &&
      entry.name !== "department.yaml"
    ) {
      const found = visit(fullPath);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Parse the `execution` block from a raw YAML data object.
 * Returns undefined (not { tier: "solo" }) when absent — callers that need
 * the default should apply it themselves; parseEmployeeData leaves it
 * undefined so the caller can distinguish "explicitly set" vs "defaulted".
 */
/**
 * Parse one role fallback-chain entry. Valid shapes (see RoleFallbackTarget):
 * external-agent deferral (`employee`, no engine/model) or direct agent
 * (`engine` + `model`). Anything else is dropped rather than half-parsed.
 */
function parseRoleFallbackTarget(raw: unknown): RoleFallbackTarget | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const fc = raw as Record<string, unknown>;
  const employee = typeof fc.employee === "string" ? fc.employee.trim() : "";
  const engine = typeof fc.engine === "string" ? fc.engine.trim() : "";
  const model = typeof fc.model === "string" ? fc.model.trim() : "";
  const effortLevel = typeof fc.effortLevel === "string" && fc.effortLevel.trim() ? fc.effortLevel.trim() : undefined;
  if (employee) {
    if (engine || model) return undefined; // ambiguous: employee XOR engine/model
    return { employee, effortLevel };
  }
  if (engine && model) return { engine, model, effortLevel };
  return undefined;
}

function parseExecutionConfig(raw: unknown): EmployeeExecutionConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const data = raw as Record<string, unknown>;

  const tier = data.tier;
  if (!(EXECUTION_TIERS as readonly string[]).includes(tier as string)) return undefined;

  const config: EmployeeExecutionConfig = { tier: tier as ExecutionTier };

  if (typeof data.maxInternalPasses === "number") config.maxInternalPasses = data.maxInternalPasses;
  if (typeof data.maxChildSessions === "number") config.maxChildSessions = data.maxChildSessions;
  if (typeof data.maxWallClockMs === "number") config.maxWallClockMs = data.maxWallClockMs;
  if (typeof data.maxToolCalls === "number") config.maxToolCalls = data.maxToolCalls;
  if (typeof data.maxEstimatedCostUsd === "number") config.maxEstimatedCostUsd = data.maxEstimatedCostUsd;

  if (
    typeof data.reviewerLossPolicy === "string" &&
    (REVIEWER_LOSS_POLICIES as readonly string[]).includes(data.reviewerLossPolicy)
  ) {
    config.reviewerLossPolicy = data.reviewerLossPolicy as ReviewerLossPolicy;
  }

  if (
    typeof data.reviewerToolProfile === "string" &&
    (REVIEWER_TOOL_PROFILES as readonly string[]).includes(data.reviewerToolProfile)
  ) {
    config.reviewerToolProfile = data.reviewerToolProfile as ReviewerToolProfile;
  }

  if (data.roles && typeof data.roles === "object" && !Array.isArray(data.roles)) {
    const roles = data.roles as Record<string, unknown>;
    const parsedRoles: EmployeeExecutionConfig["roles"] = {};
    for (const role of ["implementer", "reviewer"] as const) {
      if (roles[role] && typeof roles[role] === "object" && !Array.isArray(roles[role])) {
        const r = roles[role] as Record<string, unknown>;
        const policy: RoleExecutionPolicy = {};
        if (r.override && typeof r.override === "object" && !Array.isArray(r.override)) {
          const ov = r.override as Record<string, unknown>;
          policy.override = {
            engine: typeof ov.engine === "string" ? ov.engine : undefined,
            model: typeof ov.model === "string" ? ov.model : undefined,
            effortLevel: typeof ov.effortLevel === "string" ? ov.effortLevel : undefined,
          };
        }
        if (Array.isArray(r.fallbackChain)) {
          policy.fallbackChain = r.fallbackChain
            .map((fc: unknown) => parseRoleFallbackTarget(fc))
            .filter((fc): fc is RoleFallbackTarget => fc !== undefined)
            .slice(0, MAX_ROLE_FALLBACK_CHAIN);
        }
        parsedRoles[role] = policy;
      }
    }
    if (Object.keys(parsedRoles).length > 0) config.roles = parsedRoles;
  }

  return config;
}

/** Parse a single employee YAML data object into an Employee (applying defaults),
 *  or undefined if it lacks the required name/persona. Shared by scanOrg and the
 *  retired-employee listing. `fullPath` supplies the department fallback. */
function parseEmployeeData(data: any, fullPath: string): Employee | undefined {
  if (!data || !data.name || !data.persona) return undefined;
  const explicitDepartment = Object.prototype.hasOwnProperty.call(data, "department");
  const department = explicitDepartment
    ? String(data.department ?? "").trim()
    : path.basename(path.dirname(fullPath));
  return {
    name: data.name,
    displayName: data.displayName || data.name,
    department,
    rank: data.rank || "employee",
    engine: data.engine || "claude",
    model: data.model || "sonnet",
    persona: data.persona,
    emoji: typeof data.emoji === "string" ? data.emoji : undefined,
    avatar: typeof data.avatar === "string" ? data.avatar : undefined,
    cliFlags: Array.isArray(data.cliFlags) ? data.cliFlags : undefined,
    effortLevel: typeof data.effortLevel === "string" ? data.effortLevel : undefined,
    maxCostUsd: typeof data.maxCostUsd === "number" ? data.maxCostUsd : undefined,
    alwaysNotify: typeof data.alwaysNotify === "boolean" ? data.alwaysNotify : true,
    reportsTo: data.reportsTo ?? undefined,
    mcp: data.mcp ?? undefined,
    modelPolicy: (data.model_policy && typeof data.model_policy === "object") ? data.model_policy : ((data.modelPolicy && typeof data.modelPolicy === "object") ? data.modelPolicy : undefined),
    provides: Array.isArray(data.provides)
      ? data.provides.filter((s: unknown) => s && typeof s === "object" && typeof (s as any).name === "string" && typeof (s as any).description === "string")
        .map((s: any) => ({ name: s.name as string, description: s.description as string }))
      : undefined,
    approvalPolicy:
      typeof data.approvalPolicy === "string" &&
      (EMPLOYEE_APPROVAL_POLICIES as readonly string[]).includes(data.approvalPolicy)
        ? (data.approvalPolicy as EmployeeApprovalPolicy)
        : undefined,
    reviewTriggers: Array.isArray(data.reviewTriggers)
      ? data.reviewTriggers
        .filter((trigger: unknown): trigger is SecurityReviewTrigger =>
          typeof trigger === "string" && (SECURITY_REVIEW_TRIGGERS as readonly string[]).includes(trigger),
        )
      : undefined,
    securityReviewer: typeof data.securityReviewer === "string" ? data.securityReviewer : undefined,
    lifecycle:
      typeof data.lifecycle === "string" && (EMPLOYEE_LIFECYCLES as readonly string[]).includes(data.lifecycle)
        ? (data.lifecycle as EmployeeLifecycle)
        : "active",
    execution: parseExecutionConfig(data.execution),
  };
}

/**
 * Scan all employee YAML files under ORG_DIR into a registry.
 *
 * @param warningsOut - optional array to receive an `OrgWarning` for each file
 *   that failed to parse, so callers that surface warnings to an operator
 *   (e.g. the `/api/org` route) can report a broken file instead of letting
 *   it silently vanish from the roster. Defaults to unused so every existing
 *   zero-arg call site keeps its exact prior behavior.
 */
export function scanOrg(warningsOut?: OrgWarning[]): Map<string, Employee> {
  const registry = new Map<string, Employee>();

  if (!fs.existsSync(ORG_DIR)) return registry;

  walkEmployeeYamls(ORG_DIR, (fullPath) => {
    try {
      const data = yaml.load(fs.readFileSync(fullPath, "utf-8")) as any;
      const employee = parseEmployeeData(data, fullPath);
      if (employee) registry.set(employee.name, employee);
    } catch (err) {
      logger.warn(`Failed to parse employee file ${fullPath}: ${err}`);
      warningsOut?.push({
        employee: path.basename(fullPath),
        type: "parse_error",
        message: `Failed to parse employee file ${path.relative(ORG_DIR, fullPath)}: ${err}`,
      });
    }
    return undefined; // keep walking — scanOrg visits every file
  });

  return registry;
}

/** List soft-retired employees from `org/_retired/` (excluded from the active scan). */
export function listRetiredEmployees(): Employee[] {
  if (!fs.existsSync(ORG_RETIRED_DIR)) return [];
  const out: Employee[] = [];
  for (const entry of fs.readdirSync(ORG_RETIRED_DIR)) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
    const fullPath = path.join(ORG_RETIRED_DIR, entry);
    try {
      const employee = parseEmployeeData(yaml.load(fs.readFileSync(fullPath, "utf-8")), fullPath);
      if (employee) out.push(employee);
    } catch (err) {
      logger.warn(`Failed to parse retired employee file ${fullPath}: ${err}`);
    }
  }
  return out;
}

/**
 * Find the YAML file for an employee by name.
 * Searches ORG_DIR recursively.
 */
export function findEmployeeYamlPath(name: string): string | undefined {
  if (!fs.existsSync(ORG_DIR)) return undefined;

  return walkEmployeeYamls(ORG_DIR, (fullPath) => {
    try {
      const raw = fs.readFileSync(fullPath, "utf-8");
      const data = yaml.load(raw) as any;
      if (data?.name === name) return fullPath;
    } catch {
      // skip unreadable files
    }
    return undefined;
  });
}

/**
 * Read the raw YAML text backing an employee, or null when no file is found.
 * Used to render the "before" side of a change-request diff without mutating
 * anything.
 */
export function readEmployeeYamlText(name: string): string | null {
  const filePath = findEmployeeYamlPath(name);
  if (!filePath) return null;
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

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
const WRITABLE_FIELDS = [
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

export interface EmployeeCreateResult {
  ok: boolean;
  employee?: EmployeeCreate;
  error?: string;
}

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
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

/**
 * Update an employee's YAML file by read-merging the provided writable fields.
 * Only keys in WRITABLE_FIELDS are written; `name` is never touched (immutable).
 * Untouched YAML fields are preserved. Returns true on success, false if the
 * employee's YAML can't be found/parsed. Validate with validateEmployeeUpdate first.
 */
export function updateEmployeeYaml(
  name: string,
  updates: EmployeeUpdate,
): boolean {
  const filePath = findEmployeeYamlPath(name);
  if (!filePath) return false;

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = yaml.load(raw) as Record<string, unknown>;
    if (!data || typeof data !== "object") return false;

    const merged = mergeEmployeeUpdateData(data, updates);
    safeWriteYaml(filePath, merged, { dumpOptions: { lineWidth: -1 }, audit: { actor: "gateway", op: "org.employee.save" } });
    return true;
  } catch (err) {
    logger.warn(`Failed to update employee YAML for ${name}: ${err}`);
    return false;
  }
}

/**
 * Pure read-merge of an employee update onto a parsed YAML data object. Returns a
 * NEW object (never mutates `data`). Only WRITABLE_FIELDS are applied and `name`
 * is never touched (immutable). Shared by `updateEmployeeYaml` (which writes the
 * result) and the change-request preview (which dumps it), so the human-reviewed
 * "after" YAML and the actually-applied YAML never drift.
 */
export function mergeEmployeeUpdateData(
  data: Record<string, unknown>,
  updates: EmployeeUpdate,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...data };

  for (const key of WRITABLE_FIELDS) {
    const value = (updates as Record<string, unknown>)[key];
    if (value !== undefined) {
      next[key] = value;
    }
  }
  if (Object.prototype.hasOwnProperty.call(updates, "reportsTo") && updates.reportsTo === null) {
    delete next.reportsTo;
  }
  // Canonical icon: exactly one of avatar/emoji persists. An explicit "" clears
  // that key; setting one to a non-empty value clears the sibling so legacy YAML
  // carrying both fields normalizes to a single field on save. When both are sent
  // non-empty (out-of-contract input), `avatar` wins — matching the read precedence
  // (parseEmployeeData / Employee.avatar) and the create path (buildEmployeeCreateData),
  // rather than the previous order-dependent last-write-wins.
  const hasAvatar = Object.prototype.hasOwnProperty.call(updates, "avatar");
  const hasEmoji = Object.prototype.hasOwnProperty.call(updates, "emoji");
  if (hasAvatar || hasEmoji) {
    const avatarValue = hasAvatar && typeof updates.avatar === "string" ? updates.avatar.trim() : "";
    const emojiValue = hasEmoji && typeof updates.emoji === "string" ? updates.emoji.trim() : "";
    if (avatarValue) {
      next.avatar = avatarValue;
      delete next.emoji;
    } else if (emojiValue) {
      next.emoji = emojiValue;
      delete next.avatar;
    } else {
      // Only the provided field(s) are cleared; an unmentioned field is untouched.
      if (hasAvatar) delete next.avatar;
      if (hasEmoji) delete next.emoji;
    }
  }
  const effectiveEngine = String(updates.engine ?? next.engine ?? "claude").trim() || "claude";
  const rawPolicy = isNonEmptyRecord(next.modelPolicy)
    ? { ...next.modelPolicy }
    : isNonEmptyRecord(next.model_policy)
      ? { ...next.model_policy }
      : undefined;
  if (
    Object.prototype.hasOwnProperty.call(updates, "fallbackModel") ||
    Object.prototype.hasOwnProperty.call(updates, "fallbackEngine")
  ) {
    const requestedFallbackEngine =
      typeof updates.fallbackEngine === "string" ? updates.fallbackEngine.trim() : "";
    const fallbackModel = typeof updates.fallbackModel === "string" ? updates.fallbackModel.trim() : "";
    const currentFallbackEngine =
      rawPolicy && Array.isArray(rawPolicy.fallback_chain) && rawPolicy.fallback_chain.length > 0 && isNonEmptyRecord(rawPolicy.fallback_chain[0])
        ? String(rawPolicy.fallback_chain[0].engine ?? "").trim()
        : "";
    if (fallbackModel) {
      const nextPolicy = rawPolicy ?? {};
      nextPolicy.fallback_chain = [{
        engine: requestedFallbackEngine || currentFallbackEngine || effectiveEngine,
        model: fallbackModel,
      }];
      next.modelPolicy = nextPolicy;
    } else if (rawPolicy) {
      if (requestedFallbackEngine && Array.isArray(rawPolicy.fallback_chain) && rawPolicy.fallback_chain.length > 0) {
        const nextPolicy = {
          ...rawPolicy,
          fallback_chain: rawPolicy.fallback_chain.map((entry, index) =>
            index === 0 && isNonEmptyRecord(entry)
              ? { ...entry, engine: requestedFallbackEngine }
              : entry,
          ),
        };
        next.modelPolicy = nextPolicy;
      } else {
        const nextPolicy = { ...rawPolicy };
        delete nextPolicy.fallback_chain;
        if (Object.keys(nextPolicy).length > 0) next.modelPolicy = nextPolicy;
        else delete next.modelPolicy;
      }
    } else {
      delete next.modelPolicy;
    }
    delete next.model_policy;
  } else if (updates.engine !== undefined && rawPolicy && Array.isArray(rawPolicy.fallback_chain) && rawPolicy.fallback_chain.length > 0) {
    const chain = rawPolicy.fallback_chain.map((entry, index) => {
      if (index !== 0 || !isNonEmptyRecord(entry)) return entry;
      return { ...entry, engine: effectiveEngine };
    });
    next.modelPolicy = { ...rawPolicy, fallback_chain: chain };
    delete next.model_policy;
  }
  // --- execution block ---
  // The execution profile is REPLACED wholesale (see EmployeeUpdate.execution
  // docstring), not deep-merged. A shallow `{ ...existing, ...incoming }` left
  // reviewer-only fields (reviewerLossPolicy, reviewerToolProfile, maxInternalPasses,
  // …) behind when an operator downgraded mid_pair → solo, persisting a stale
  // reviewer config under a solo tier. Writing the incoming block verbatim drops
  // any field the new tier no longer carries.
  if (Object.prototype.hasOwnProperty.call(updates, "execution")) {
    if (updates.execution === null) {
      delete next.execution;
    } else if (updates.execution !== undefined) {
      next.execution = { ...updates.execution };
    }
  }

  // `name` is immutable — never write or rename it, even if present in `updates`.
  return next;
}

/**
 * Build the YAML data object for a new employee. Pure — shared by
 * `createEmployeeYaml` (which writes it) and the change-request preview (which
 * dumps it) so the reviewed "after" YAML matches what actually gets written.
 */
export function buildEmployeeCreateData(employee: EmployeeCreate): Record<string, unknown> {
  const data: Record<string, unknown> = {
    name: employee.name,
    displayName: employee.displayName,
    department: employee.department,
    rank: employee.rank,
    engine: employee.engine,
    model: employee.model,
    persona: employee.persona,
  };
  if (employee.effortLevel) data.effortLevel = employee.effortLevel;
  if (employee.reportsTo) data.reportsTo = employee.reportsTo;
  if (employee.cliFlags && employee.cliFlags.length > 0) data.cliFlags = employee.cliFlags;
  if (typeof employee.alwaysNotify === "boolean") data.alwaysNotify = employee.alwaysNotify;
  if (employee.lifecycle && employee.lifecycle !== "active") data.lifecycle = employee.lifecycle;
  if (employee.fallbackModel && employee.fallbackModel.trim()) {
    data.modelPolicy = {
      fallback_chain: [{ engine: employee.fallbackEngine?.trim() || employee.engine, model: employee.fallbackModel.trim() }],
    };
  }
  // Canonical icon: avatar wins if both somehow set; never write empty keys.
  const avatar = (employee.avatar ?? "").trim();
  const emoji = (employee.emoji ?? "").trim();
  if (avatar) data.avatar = avatar;
  else if (emoji) data.emoji = emoji;
  if (employee.execution) data.execution = employee.execution;
  return data;
}

export function createEmployeeYaml(employee: EmployeeCreate): boolean {
  const departmentDir = path.join(ORG_DIR, employee.department);
  const resolvedDir = path.resolve(departmentDir);
  const resolvedOrg = path.resolve(ORG_DIR);
  if (!resolvedDir.startsWith(resolvedOrg + path.sep) && resolvedDir !== resolvedOrg) {
    throw new Error(`Department path is outside ORG_DIR`);
  }
  const filePath = path.join(departmentDir, `${employee.name}.yaml`);
  if (fs.existsSync(filePath)) return false;

  try {
    fs.mkdirSync(departmentDir, { recursive: true });
    const data = buildEmployeeCreateData(employee);
    safeWriteYaml(filePath, data, { dumpOptions: { lineWidth: -1 }, audit: { actor: "gateway", op: "org.employee.create" } });
    return true;
  } catch (err) {
    logger.warn(`Failed to create employee YAML for ${employee.name}: ${err}`);
    return false;
  }
}

/**
 * Delete the YAML file backing an employee. Returns false when no matching
 * file is found (treated as 404 by the API).
 */
export function deleteEmployeeYaml(name: string): boolean {
  const filePath = findEmployeeYamlPath(name);
  if (!filePath) return false;
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (err) {
    logger.warn(`Failed to delete employee YAML for ${name}: ${err}`);
    return false;
  }
}

/**
 * Soft-retire an employee: stamp `lifecycle: retired` and MOVE the YAML to
 * `org/_retired/` (excluded from the active scan) instead of hard-deleting it.
 * Returns false when the employee can't be found/parsed. Callers should run the
 * same orphan guard the DELETE path uses before retiring.
 */
export function retireEmployeeYaml(name: string): boolean {
  const filePath = findEmployeeYamlPath(name);
  if (!filePath) return false;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = yaml.load(raw) as Record<string, unknown>;
    if (!data || typeof data !== "object") return false;
    data.lifecycle = "retired";
    const retiredPath = path.join(ORG_RETIRED_DIR, `${name}.yaml`);
    safeWriteYaml(retiredPath, data, { dumpOptions: { lineWidth: -1 }, audit: { actor: "gateway", op: "org.employee.retire" } });
    fs.unlinkSync(filePath);
    return true;
  } catch (err) {
    logger.warn(`Failed to retire employee YAML for ${name}: ${err}`);
    return false;
  }
}

/**
 * Whether an employee is assignable. `active`/`probation` employees can take
 * work; `draft`/`disabled`/`retired` cannot. (Retired personas are normally not
 * even in the registry — they live under `org/_retired/` — but this guards the
 * in-place `disabled` case and any straggler.)
 */
export function isActiveEmployee(employee: Pick<Employee, "lifecycle">): boolean {
  const lifecycle = employee.lifecycle ?? "active";
  return lifecycle === "active" || lifecycle === "probation";
}

export interface OrgChangeValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Dry-run validation of a proposed org change against the live registry + model
 * registry — NO write, NO IO beyond a fresh `scanOrg`. Backs `POST /api/org/validate`
 * and is re-checked at apply time (the roster may have shifted). For `create_agent`
 * it delegates to `validateEmployeeCreate`; every other change type validates the
 * proposed writable fields against the current employee via `validateEmployeeUpdate`.
 */
export function validateOrgChange(
  config: CuttlefishConfig,
  input: { changeType: OrgChangeType; employeeName: string; proposed: Record<string, unknown> },
): OrgChangeValidationResult {
  const registry = scanOrg();
  const proposed = input.proposed && typeof input.proposed === "object" ? input.proposed : {};

  if (input.changeType === "create_agent") {
    const body = { name: input.employeeName, ...proposed };
    const result = validateEmployeeCreate(config, body, registry.keys());
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }

  const current = registry.get(input.employeeName);
  if (!current) {
    return { ok: false, error: `employee "${input.employeeName}" not found` };
  }
  // retire/disable carry no writable fields — the employee existing is enough.
  if (input.changeType === "retire_agent" || input.changeType === "disable_agent") {
    return { ok: true };
  }
  const result = validateEmployeeUpdate(config, current, proposed);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

export function findEmployee(
  name: string,
  registry: Map<string, Employee>,
): Employee | undefined {
  return registry.get(name);
}

export function extractMention(
  text: string,
  registry: Map<string, Employee>,
): Employee | undefined {
  for (const [name, employee] of registry) {
    if (text.includes(`@${name}`)) {
      return employee;
    }
  }
  return undefined;
}

/**
 * Extract ALL mentioned employees from text (e.g. "@cuttlefish-dev @cuttlefish-qa do X").
 * Returns an array of matched employees (can be empty).
 */
export function extractMentions(
  text: string,
  registry: Map<string, Employee>,
): Employee[] {
  const mentioned: Employee[] = [];
  for (const [name, employee] of registry) {
    if (text.includes(`@${name}`)) {
      mentioned.push(employee);
    }
  }
  return mentioned;
}
