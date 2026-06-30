import type { PolicyAction, PolicyArtifactDescriptor, PolicyRule, PolicyVerdict } from "./types.js";

const DEFAULT_ALLOW_ACTIONS = new Set<PolicyAction>(["retain", "register"]);

const _globRegexpCache = new Map<string, RegExp>();

function matchesGlob(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  let re = _globRegexpCache.get(pattern);
  if (!re) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    re = new RegExp(`^${escaped}$`);
    _globRegexpCache.set(pattern, re);
  }
  return re.test(value);
}

function ruleMatches(rule: PolicyRule, descriptor: PolicyArtifactDescriptor, action: PolicyAction): boolean {
  if (rule.action !== undefined && rule.action !== action) return false;
  if (rule.kindPattern !== undefined && !matchesGlob(rule.kindPattern, descriptor.kind)) return false;
  if (rule.locatorPattern !== undefined) {
    if (!descriptor.locator) return false;
    if (!matchesGlob(rule.locatorPattern, descriptor.locator)) return false;
  }
  return true;
}

export function evaluatePolicy(
  descriptor: PolicyArtifactDescriptor,
  action: PolicyAction,
  rules: PolicyRule[],
): PolicyVerdict {
  for (const rule of rules) {
    if (ruleMatches(rule, descriptor, action)) {
      return {
        allowed: rule.allow,
        rule: rule.id,
        reason: rule.allow
          ? `allowed by rule "${rule.id}"`
          : `denied by rule "${rule.id}"`,
      };
    }
  }
  const allowed = DEFAULT_ALLOW_ACTIONS.has(action);
  return {
    allowed,
    reason: allowed ? `default allow for action "${action}"` : `default deny for action "${action}"`,
  };
}
