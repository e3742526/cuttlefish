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

let _cached: PolicyProfile | undefined;
let _cachedDir: string | undefined;

export function getPolicyProfile(policyDir: string): PolicyProfile {
  if (_cached && _cachedDir === policyDir) return _cached;
  _cached = loadPolicyProfile(policyDir);
  _cachedDir = policyDir;
  return _cached;
}

export function invalidatePolicyCache(): void {
  _cached = undefined;
  _cachedDir = undefined;
}
