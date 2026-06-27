import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { ORG_DIR } from "../shared/paths.js";
import { safeWriteYaml } from "../shared/safe-write.js";
import type { Employee, CuttlefishConfig } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { getModelRegistry, effortLevelsForModel } from "../shared/models.js";

/**
 * Recursively walk `dir`, invoking `visit` for every employee YAML file
 * (.yaml/.yml, skipping department.yaml). Stops early and returns the first
 * non-undefined value `visit` returns; visitors that never return a value
 * walk the whole tree.
 */
function walkEmployeeYamls<T>(
  dir: string,
  visit: (fullPath: string) => T | undefined,
): T | undefined {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
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

export function scanOrg(): Map<string, Employee> {
  const registry = new Map<string, Employee>();

  if (!fs.existsSync(ORG_DIR)) return registry;

  walkEmployeeYamls(ORG_DIR, (fullPath) => {
    try {
      const raw = fs.readFileSync(fullPath, "utf-8");
      const data = yaml.load(raw) as any;
      if (data && data.name && data.persona) {
        const employee: Employee = {
          name: data.name,
          displayName: data.displayName || data.name,
          department:
            data.department || path.basename(path.dirname(fullPath)),
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
        };
        registry.set(employee.name, employee);
      }
    } catch (err) {
      logger.warn(`Failed to parse employee file ${fullPath}: ${err}`);
    }
    return undefined; // keep walking — scanOrg visits every file
  });

  return registry;
}

/**
 * Find the YAML file for an employee by name.
 * Searches ORG_DIR recursively.
 */
function findEmployeeYamlPath(name: string): string | undefined {
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
  reportsTo?: string | string[];
  cliFlags?: string[];
  alwaysNotify?: boolean;
  /** UI convenience field persisted into modelPolicy.fallback_chain[0]. */
  fallbackModel?: string | null;
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
  fallbackModel?: string | null;
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
] as const;

const ACCEPTED_UPDATE_FIELDS = [...WRITABLE_FIELDS, "fallbackModel"] as const;

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
export function validateEmployeeUpdate(
  config: CuttlefishConfig,
  current: Employee,
  body: Record<string, unknown>,
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

  const updates: EmployeeUpdate = {};

  // --- non-empty string fields ---
  for (const key of ["displayName", "department", "persona"] as const) {
    if (body[key] !== undefined) {
      const v = body[key];
      if (typeof v !== "string" || !v.trim()) {
        return { ok: false, error: `${key} must be a non-empty string` };
      }
      updates[key] = v;
    }
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
    const modelId = body.model.trim();
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

  // --- reportsTo (string | string[]) ---
  if (body.reportsTo !== undefined) {
    const v = body.reportsTo;
    const isString = typeof v === "string" && v.trim().length > 0;
    const isStringArray = Array.isArray(v) && v.every((x) => typeof x === "string" && x.trim().length > 0);
    if (!isString && !isStringArray) {
      return { ok: false, error: "reportsTo must be a non-empty string or array of strings" };
    }
    updates.reportsTo = v as string | string[];
  }

  // --- cliFlags (string[]) ---
  if (body.cliFlags !== undefined) {
    const v = body.cliFlags;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
      return { ok: false, error: "cliFlags must be an array of strings" };
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

  if (body.fallbackModel !== undefined) {
    if (body.fallbackModel === null) {
      updates.fallbackModel = null;
    } else if (typeof body.fallbackModel !== "string") {
      return { ok: false, error: "fallbackModel must be a string or null" };
    } else {
      const fallbackModel = body.fallbackModel.trim();
      if (!fallbackModel) {
        updates.fallbackModel = null;
      } else {
        const fallbackError = validateModelIdForEngine(registry, resultingEngine, fallbackModel, "fallbackModel");
        if (fallbackError) return { ok: false, error: fallbackError };
        updates.fallbackModel = fallbackModel;
      }
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
    "fallbackModel",
  ]);
  const unknownKeys = Object.keys(body).filter((key) => !known.has(key));
  if (unknownKeys.length > 0) {
    return { ok: false, error: `unknown field(s): ${unknownKeys.join(", ")}` };
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { ok: false, error: "name must be a non-empty string" };
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    return { ok: false, error: "name must use only letters, numbers, dot, underscore, or hyphen" };
  }
  if (Array.from(existingNames).some((candidate) => candidate === name)) {
    return { ok: false, error: `employee "${name}" already exists` };
  }

  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  if (!displayName) return { ok: false, error: "displayName must be a non-empty string" };

  const department = typeof body.department === "string" ? body.department.trim() : "";
  if (!department) return { ok: false, error: "department must be a non-empty string" };

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
    fallbackModel: body.fallbackModel,
  });
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
      reportsTo: updates.updates.reportsTo,
      cliFlags: updates.updates.cliFlags,
      alwaysNotify: updates.updates.alwaysNotify,
      fallbackModel: updates.updates.fallbackModel,
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

    for (const key of WRITABLE_FIELDS) {
      const value = (updates as Record<string, unknown>)[key];
      if (value !== undefined) {
        data[key] = value;
      }
    }
    const effectiveEngine = String(updates.engine ?? data.engine ?? "claude").trim() || "claude";
    const rawPolicy = isNonEmptyRecord(data.modelPolicy)
      ? { ...data.modelPolicy }
      : isNonEmptyRecord(data.model_policy)
        ? { ...data.model_policy }
        : undefined;
    if (Object.prototype.hasOwnProperty.call(updates, "fallbackModel")) {
      const fallbackModel = typeof updates.fallbackModel === "string" ? updates.fallbackModel.trim() : "";
      if (fallbackModel) {
        const nextPolicy = rawPolicy ?? {};
        nextPolicy.fallback_chain = [{ engine: effectiveEngine, model: fallbackModel }];
        data.modelPolicy = nextPolicy;
      } else if (rawPolicy) {
        const nextPolicy = { ...rawPolicy };
        delete nextPolicy.fallback_chain;
        if (Object.keys(nextPolicy).length > 0) data.modelPolicy = nextPolicy;
        else delete data.modelPolicy;
      } else {
        delete data.modelPolicy;
      }
      delete data.model_policy;
    } else if (updates.engine !== undefined && rawPolicy && Array.isArray(rawPolicy.fallback_chain) && rawPolicy.fallback_chain.length > 0) {
      const chain = rawPolicy.fallback_chain.map((entry, index) => {
        if (index !== 0 || !isNonEmptyRecord(entry)) return entry;
        return { ...entry, engine: effectiveEngine };
      });
      data.modelPolicy = { ...rawPolicy, fallback_chain: chain };
      delete data.model_policy;
    }
    // `name` is immutable — never write or rename it, even if present in `updates`.

    safeWriteYaml(filePath, data, { dumpOptions: { lineWidth: -1 }, audit: { actor: "gateway", op: "org.employee.save" } });
    return true;
  } catch (err) {
    logger.warn(`Failed to update employee YAML for ${name}: ${err}`);
    return false;
  }
}

export function createEmployeeYaml(employee: EmployeeCreate): boolean {
  const departmentDir = path.join(ORG_DIR, employee.department);
  const filePath = path.join(departmentDir, `${employee.name}.yaml`);
  if (fs.existsSync(filePath)) return false;

  try {
    fs.mkdirSync(departmentDir, { recursive: true });
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
    if (employee.fallbackModel && employee.fallbackModel.trim()) {
      data.modelPolicy = {
        fallback_chain: [{ engine: employee.engine, model: employee.fallbackModel.trim() }],
      };
    }
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
