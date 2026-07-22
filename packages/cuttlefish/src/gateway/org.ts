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
import { getAllParents } from "./org-hierarchy.js";
import {
  isNonEmptyRecord,
  validateEmployeeCreate,
  validateEmployeeUpdate,
  WRITABLE_FIELDS,
} from "./org-validation.js";
import type {
  EmployeeCreate,
  EmployeeCreateResult,
  EmployeeUpdate,
  EmployeeUpdateResult,
} from "./org-validation.js";

export {
  validateEmployeeCreate,
  validateEmployeeUpdate,
};
export type {
  EmployeeCreate,
  EmployeeCreateResult,
  EmployeeUpdate,
  EmployeeUpdateResult,
};

/**
 * Reserved `org/` subdirectories that hold HR / Org-Steward artifacts (change
 * requests, drafts, retired personas), not active employees. The scan must never
 * load these as employees — they are surfaced through dedicated APIs instead.
 */
export const RESERVED_ORG_DIRS = new Set(["_changes", "_drafts", "_retired"]);

interface OrgScanCacheEntry {
  fingerprint: string;
  registry: Map<string, Employee>;
  warnings: OrgWarning[];
}

let orgScanCache: OrgScanCacheEntry | null = null;

function cloneOrgRegistry(registry: Map<string, Employee>): Map<string, Employee> {
  return new Map(
    Array.from(registry.entries(), ([name, employee]) => [name, structuredClone(employee)]),
  );
}

function cloneOrgWarnings(warnings: OrgWarning[]): OrgWarning[] {
  return warnings.map((warning) => structuredClone(warning));
}

function buildOrgFingerprint(dir: string): string {
  if (!fs.existsSync(dir)) return "missing";
  const parts: string[] = [];
  const walk = (currentDir: string): void => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (RESERVED_ORG_DIRS.has(entry.name)) continue;
        walk(fullPath);
        continue;
      }
      if (
        (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))
        && entry.name !== "department.yaml"
      ) {
        const stat = fs.statSync(fullPath);
        parts.push(`${path.relative(dir, fullPath)}:${stat.size}:${stat.mtimeMs}`);
      }
    }
  };
  walk(dir);
  return parts.join("|");
}

export function resetOrgScanCacheForTests(): void {
  orgScanCache = null;
}

function invalidateOrgScanCache(): void {
  orgScanCache = null;
}

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
  const fingerprint = buildOrgFingerprint(ORG_DIR);
  if (orgScanCache?.fingerprint === fingerprint) {
    warningsOut?.push(...cloneOrgWarnings(orgScanCache.warnings));
    return cloneOrgRegistry(orgScanCache.registry);
  }

  const registry = new Map<string, Employee>();
  const warnings: OrgWarning[] = [];

  if (!fs.existsSync(ORG_DIR)) {
    orgScanCache = { fingerprint, registry, warnings };
    return registry;
  }

  walkEmployeeYamls(ORG_DIR, (fullPath) => {
    try {
      const data = yaml.load(fs.readFileSync(fullPath, "utf-8")) as any;
      const employee = parseEmployeeData(data, fullPath);
      if (employee) registry.set(employee.name, employee);
    } catch (err) {
      logger.warn(`Failed to parse employee file ${fullPath}: ${err}`);
      warnings.push({
        employee: path.basename(fullPath),
        type: "parse_error",
        message: `Failed to parse employee file ${path.relative(ORG_DIR, fullPath)}: ${err}`,
      });
    }
    return undefined; // keep walking — scanOrg visits every file
  });

  orgScanCache = {
    fingerprint,
    registry: cloneOrgRegistry(registry),
    warnings: cloneOrgWarnings(warnings),
  };
  warningsOut?.push(...cloneOrgWarnings(warnings));
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
    invalidateOrgScanCache();
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
    invalidateOrgScanCache();
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
  // Audit §7.2: defense-in-depth — the reports-guard previously lived ONLY in the
  // HTTP delete route, so a non-route caller (CLI, a direct util call) could delete
  // a manager and orphan their reports. Refuse here too if anyone still reports to
  // this employee (primary or matrix reportsTo link).
  const dependents = [...scanOrg().values()].filter((emp) => getAllParents(emp.reportsTo).includes(name));
  if (dependents.length > 0) {
    logger.warn(`Refusing to delete "${name}" via deleteEmployeeYaml: ${dependents.length} employee(s) still report to them`);
    return false;
  }
  try {
    fs.unlinkSync(filePath);
    invalidateOrgScanCache();
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
    invalidateOrgScanCache();
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
