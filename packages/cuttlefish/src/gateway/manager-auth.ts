import type { Employee } from "../shared/types.js";
import { getSession } from "../sessions/registry.js";
import { orgWorkerIdForName } from "./org-worker-bridge.js";
import { resolveOrgHierarchy, withPortalExecutive } from "./org-hierarchy.js";
import { HR_EMPLOYEE_NAME } from "./org-policy.js";
import type { GatewayPrincipal } from "./auth.js";

/**
 * HR / Org Steward is a human-operator-facing advisory lane, not a worker
 * other employees, agents, or orchestration flows may delegate to — otherwise
 * singleton reuse can cross-contaminate a human HR thread and lose a child
 * callback. Only a direct, top-level request from a human operator may reach
 * it.
 *
 * This is the single shared predicate for that gate. It previously existed as
 * two independently-maintained checks (the cross-request router in org.ts,
 * and session creation in session-write.ts) that could silently drift; both
 * now call this. A cross-request is by construction never a direct top-level
 * human request (it always originates from another employee), so that call
 * site passes `isDirectTopLevelHumanRequest: false` unconditionally.
 */
export function isHrHumanOnlyBlocked(
  targetEmployeeName: string | null | undefined,
  requestContext: { isDirectTopLevelHumanRequest: boolean },
): boolean {
  return targetEmployeeName === HR_EMPLOYEE_NAME && !requestContext.isDirectTopLevelHumanRequest;
}

export type ManagerAuthorizationResult =
  | { ok: true; manager: Employee }
  | { ok: false; error: string };

/**
 * Ledger-0007 Finding 4 (manager identity is body-claimed, not
 * gateway-enforced): a clean fix needs a full per-manager auth principal,
 * which doesn't exist yet — deferred. This is a partial mitigation: when the
 * caller identifies itself via a scoped session token (the kind an agent
 * subprocess holds), require the claimed `managerName` to match that
 * session's own bound employee — a session cannot claim to act as a
 * *different* manager than the one it is actually running as. Admin
 * principals (the operator) and an absent principal (today's default
 * unauthenticated-loopback-human case) keep the existing trust-the-body
 * behavior; binding those callers to a real identity is out of scope here.
 */
export function isManagerNameAuthorizedForPrincipal(
  managerName: string,
  principal: GatewayPrincipal | undefined,
  deps: { getSession: typeof getSession } = { getSession },
): boolean {
  if (!principal || principal.kind === "admin") return true;
  const callerSession = deps.getSession(principal.sessionId);
  return callerSession?.employee === managerName;
}

/** Fields a manager-scoped employee update (PATCH with a `managerName` claim)
 *  may touch. Anything else is an authorization failure — a manager-scoped
 *  caller may retune its report's engine/model/effort, not reassign it,
 *  rename it, or change its rank/department. */
export const MANAGER_MUTABLE_EMPLOYEE_FIELDS = new Set([
  "engine",
  "model",
  "effortLevel",
  "fallbackEngine",
  "fallbackModel",
] as const);

/** Field names in `body` (besides the `managerName` claim itself) that fall
 *  outside `MANAGER_MUTABLE_EMPLOYEE_FIELDS` — i.e. that a manager-scoped
 *  update is not authorized to change. Empty when the body is fully in-scope. */
export function disallowedManagerScopedFields(body: Record<string, unknown>): string[] {
  return Object.keys(body).filter(
    (key) => key !== "managerName" && !MANAGER_MUTABLE_EMPLOYEE_FIELDS.has(key as "engine" | "model" | "effortLevel" | "fallbackEngine" | "fallbackModel"),
  );
}

export function authorizeManagerScope(
  registry: Map<string, Employee>,
  managerName: string,
  affectedEmployeeNames: string[],
  portalName?: string | null,
): ManagerAuthorizationResult {
  const effectiveRegistry = withPortalExecutive(registry, portalName);
  const manager = effectiveRegistry.get(managerName);
  if (!manager) return { ok: false, error: `managerName does not resolve to an employee: ${managerName}` };
  if (manager.rank !== "manager" && manager.rank !== "executive") {
    return { ok: false, error: `${managerName} is ${manager.rank}; manager or executive rank is required` };
  }
  if (manager.rank === "executive") return { ok: true, manager };

  const hierarchy = resolveOrgHierarchy(effectiveRegistry);
  for (const employeeName of unique(affectedEmployeeNames)) {
    if (employeeName === manager.name) continue;
    const node = hierarchy.nodes[employeeName];
    if (!node) return { ok: false, error: `affected employee does not exist: ${employeeName}` };
    if (!node.chain.includes(manager.name)) {
      return { ok: false, error: `${employeeName} is outside ${manager.name}'s hierarchy` };
    }
  }
  return { ok: true, manager };
}

export function employeeNamesForOrgWorkerIds(registry: Map<string, Employee>, workerIds: string[]): {
  employeeNames: string[];
  unknownWorkerIds: string[];
} {
  const byWorkerId = new Map([...registry.keys()].map((name) => [orgWorkerIdForName(name), name]));
  const employeeNames: string[] = [];
  const unknownWorkerIds: string[] = [];
  for (const workerId of unique(workerIds)) {
    const employeeName = byWorkerId.get(workerId);
    if (employeeName) employeeNames.push(employeeName);
    else unknownWorkerIds.push(workerId);
  }
  return { employeeNames, unknownWorkerIds };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
