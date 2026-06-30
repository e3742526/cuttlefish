import fs from "node:fs";
import path from "node:path";
import { buildDefaultProfile } from "./profiles.js";
import type { PolicyProfile, PolicyRule } from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRule(raw: unknown, index: number): PolicyRule | null {
  if (!isPlainObject(raw)) return null;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `rule-${index}`;
  if (typeof raw.allow !== "boolean") return null;
  const rule: PolicyRule = { id, allow: raw.allow };
  if (raw.action !== undefined) {
    if (raw.action === "export" || raw.action === "retain" || raw.action === "quarantine" || raw.action === "register") {
      rule.action = raw.action;
    } else {
      throw new Error(`policy: rule ${index} has unknown action "${String(raw.action)}"; fix the policy file or remove the rule`);
    }
  }
  if (typeof raw.kindPattern === "string" && raw.kindPattern) rule.kindPattern = raw.kindPattern;
  if (typeof raw.locatorPattern === "string" && raw.locatorPattern) rule.locatorPattern = raw.locatorPattern;
  return rule;
}

function parseProfileFile(filePath: string): PolicyProfile {
  const raw: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  if (!isPlainObject(raw)) throw new Error(`policy: ${filePath} is not a JSON object`);
  if (!Array.isArray(raw.rules)) throw new Error(`policy: ${filePath} 'rules' field is missing or not an array`);
  const rulesRaw = raw.rules;
  const rules: PolicyRule[] = rulesRaw
    .map((r, i) => parseRule(r, i))
    .filter((r): r is PolicyRule => r !== null);
  return { rules };
}

export function loadPolicyProfile(policyDir: string): PolicyProfile {
  if (!fs.existsSync(policyDir) || !fs.statSync(policyDir).isDirectory()) return buildDefaultProfile();
  const entries = (fs.readdirSync(policyDir) as string[]).filter((name: string) => name.endsWith(".json")).sort();
  if (entries.length === 0) return buildDefaultProfile();
  const allRules: PolicyRule[] = [];
  for (const entry of entries) {
    const profile = parseProfileFile(path.join(policyDir, entry));
    allRules.push(...profile.rules);
  }
  return { rules: allRules };
}

/**
 * How long (in milliseconds) a cached policy profile is considered fresh.
 * After this interval elapses, the next call to getPolicyProfile() will
 * re-read and re-parse all policy files from disk, picking up any live
 * changes an operator made without restarting the gateway.
 * Set to 60 seconds as a balance between responsiveness and I/O cost.
 */
const POLICY_CACHE_TTL_MS = 60_000;

let _cached: PolicyProfile | undefined;
let _cachedDir: string | undefined;
let _cachedAt: number | undefined;

export function getPolicyProfile(policyDir: string): PolicyProfile {
  const now = Date.now();
  if (
    _cached &&
    _cachedDir === policyDir &&
    _cachedAt !== undefined &&
    now - _cachedAt < POLICY_CACHE_TTL_MS
  ) {
    return _cached;
  }
  _cached = loadPolicyProfile(policyDir);
  _cachedDir = policyDir;
  _cachedAt = now;
  return _cached;
}

export function invalidatePolicyCache(): void {
  _cached = undefined;
  _cachedDir = undefined;
  _cachedAt = undefined;
}
