import {
  MAX_ROLE_FALLBACK_CHAIN,
  type EmployeeExecutionConfig,
  type RoleExecutionPolicy,
  type RoleFallbackTarget,
} from "./api-org"

/**
 * Normalize one failover-chain entry to the backend contract: an external
 * deferral carries only `employee` (+ optional effort), a direct agent carries
 * engine+model. Incomplete rows normalize to undefined and are dropped.
 */
function normalizeTarget(target: RoleFallbackTarget): RoleFallbackTarget | undefined {
  const employee = target.employee?.trim()
  const engine = target.engine?.trim()
  const model = target.model?.trim()
  const effortLevel = target.effortLevel?.trim() || undefined
  if (employee) return { employee, ...(effortLevel ? { effortLevel } : {}) }
  if (engine && model) return { engine, model, ...(effortLevel ? { effortLevel } : {}) }
  return undefined
}

/** Normalize a role policy for persistence; undefined when it carries nothing. */
export function normalizeRolePolicy(policy: RoleExecutionPolicy | undefined): RoleExecutionPolicy | undefined {
  if (!policy) return undefined
  const override = Object.fromEntries(
    Object.entries(policy.override ?? {}).filter(([, v]) => typeof v === "string" && v.trim().length > 0),
  ) as RoleExecutionPolicy["override"]
  const fallbackChain = (policy.fallbackChain ?? [])
    .map(normalizeTarget)
    .filter((t): t is RoleFallbackTarget => t !== undefined)
    .slice(0, MAX_ROLE_FALLBACK_CHAIN)
  const out: RoleExecutionPolicy = {}
  if (override && Object.keys(override).length > 0) out.override = override
  if (fallbackChain.length > 0) out.fallbackChain = fallbackChain
  return Object.keys(out).length > 0 ? out : undefined
}

/** Compact human-readable summary of a role's agent + failover plan. */
export function describeRolePolicy(
  policy: RoleExecutionPolicy,
  inherited: { engine: string; model: string },
): string {
  const hasOverride = Boolean(policy.override?.engine || policy.override?.model)
  const primary = hasOverride
    ? `${policy.override?.engine ?? inherited.engine}/${policy.override?.model ?? "default"}`
    : `${inherited.engine}/${inherited.model} (inherited)`
  const chain = policy.fallbackChain ?? []
  if (chain.length === 0) return primary
  const steps = chain.map((t) => (t.employee ? `@${t.employee}` : `${t.engine}/${t.model}`)).join(" → ")
  return `${primary} · failover: ${steps}`
}

/** Combine both role policies into the `execution.roles` block (or undefined). */
export function normalizeRoles(
  implementer: RoleExecutionPolicy | undefined,
  reviewer: RoleExecutionPolicy | undefined,
): EmployeeExecutionConfig["roles"] | undefined {
  const impl = normalizeRolePolicy(implementer)
  const rev = normalizeRolePolicy(reviewer)
  if (!impl && !rev) return undefined
  return { ...(impl ? { implementer: impl } : {}), ...(rev ? { reviewer: rev } : {}) }
}
