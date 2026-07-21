import { describe, expect, it, vi } from "vitest";
import type { Employee } from "../../shared/types.js";
import { authorizeManagerScope, isAuthorizedHumanDelegatePrincipal, isCooSession, isDirectChildSession, isHrHumanOnlyBlocked, isHumanDelegationSessionEligible, isManagerNameAuthorizedForPrincipal } from "../manager-auth.js";
import { buildOperatorDelegationGrant, operatorDelegationPromptHash } from "../../sessions/operator-delegation.js";
import { HR_EMPLOYEE_NAME } from "../org-policy.js";

function employee(overrides: Partial<Employee>): Employee {
  return {
    name: "worker",
    displayName: "Worker",
    department: "engineering",
    rank: "employee",
    engine: "claude",
    model: "opus",
    persona: "worker",
    ...overrides,
  };
}

describe("authorizeManagerScope", () => {
  it("rejects a managerName that does not resolve to an employee", () => {
    const registry = new Map<string, Employee>();
    expect(authorizeManagerScope(registry, "ghost", []).ok).toBe(false);
  });

  it("rejects a non-manager/executive employee", () => {
    const registry = new Map<string, Employee>([["worker", employee({ name: "worker" })]]);
    const result = authorizeManagerScope(registry, "worker", []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/manager or executive rank is required/);
  });

  it("allows an executive to act on any employee", () => {
    const registry = new Map<string, Employee>([
      ["ceo", employee({ name: "ceo", rank: "executive" })],
      ["worker", employee({ name: "worker", department: "engineering" })],
    ]);
    expect(authorizeManagerScope(registry, "ceo", ["worker"]).ok).toBe(true);
  });

  it("allows a manager to act on their own direct report", () => {
    const registry = new Map<string, Employee>([
      ["manager-a", employee({ name: "manager-a", rank: "manager" })],
      ["worker", employee({ name: "worker", reportsTo: "manager-a" })],
    ]);
    expect(authorizeManagerScope(registry, "manager-a", ["worker"]).ok).toBe(true);
  });

  it("rejects a manager acting on an employee outside their hierarchy", () => {
    const registry = new Map<string, Employee>([
      ["manager-a", employee({ name: "manager-a", rank: "manager" })],
      ["manager-b", employee({ name: "manager-b", rank: "manager", department: "sales" })],
      ["worker", employee({ name: "worker", department: "sales", reportsTo: "manager-b" })],
    ]);
    const result = authorizeManagerScope(registry, "manager-a", ["worker"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/outside manager-a's hierarchy/);
  });
});

describe("isManagerNameAuthorizedForPrincipal (Ledger-0007 Finding 4 partial mitigation)", () => {
  it("trusts the body when no principal is attached (default unauthenticated loopback)", () => {
    expect(isManagerNameAuthorizedForPrincipal("manager-a", undefined)).toBe(true);
  });

  it("trusts the body for an admin principal", () => {
    expect(isManagerNameAuthorizedForPrincipal("manager-a", { kind: "admin" })).toBe(true);
  });

  it("allows a session-scoped principal to claim its own bound employee identity", () => {
    const getSession = vi.fn(() => ({ employee: "manager-a" }) as any);
    expect(
      isManagerNameAuthorizedForPrincipal("manager-a", { kind: "session", sessionId: "s1" }, { getSession }),
    ).toBe(true);
    expect(getSession).toHaveBeenCalledWith("s1");
  });

  it("rejects a session-scoped principal claiming a different manager identity", () => {
    const getSession = vi.fn(() => ({ employee: "manager-a" }) as any);
    expect(
      isManagerNameAuthorizedForPrincipal("manager-b", { kind: "session", sessionId: "s1" }, { getSession }),
    ).toBe(false);
  });

  it("rejects a session-scoped principal with no bound employee at all", () => {
    const getSession = vi.fn(() => undefined);
    expect(
      isManagerNameAuthorizedForPrincipal("manager-a", { kind: "session", sessionId: "s1" }, { getSession }),
    ).toBe(false);
  });
});

describe("isDirectChildSession", () => {
  it("binds access to the concrete parent session for this delegation run", () => {
    const getSession = vi.fn((id: string) => id === "child-run"
      ? { id, parentSessionId: "manager-run" }
      : undefined) as any;

    expect(isDirectChildSession("manager-run", "child-run", { getSession })).toBe(true);
    expect(isDirectChildSession("other-manager-run", "child-run", { getSession })).toBe(false);
    expect(isDirectChildSession("manager-run", "missing", { getSession })).toBe(false);
  });
});

describe("isCooSession", () => {
  it("recognizes a gateway COO session from server-owned session state", () => {
    const getSession = vi.fn(() => ({ employee: null, source: "web" }) as any);
    expect(isCooSession("coo-run", { getSession })).toBe(true);
    expect(getSession).toHaveBeenCalledWith("coo-run");
  });

  it("does not grant COO authority to employee, Talk orchestrator, or missing sessions", () => {
    const getSession = vi.fn((id: string) => ({
      employee: id === "employee-run" ? "engineering-lead" : null,
      source: id === "talk-run" ? "talk" : "web",
    })) as any;
    expect(isCooSession("employee-run", { getSession })).toBe(false);
    expect(isCooSession("talk-run", { getSession })).toBe(false);
    expect(isCooSession("missing", { getSession: vi.fn(() => undefined) as any })).toBe(false);
  });
});

describe("human-delegated operator authority", () => {
  const prompt = "/delegate-authority approve,decide\nResolve the release gate.";
  const delegationId = operatorDelegationPromptHash(prompt);
  const activeGrant = buildOperatorDelegationGrant({ prompt, scopes: ["approve", "decide"] });
  const eligible = {
    id: "pm-run",
    employee: "program-manager",
    source: "web",
    engine: "codex",
    model: "gpt-5.6-sol",
    transportMeta: { operatorDelegation: activeGrant },
  } as any;

  it("requires the eligible role, model, active grant, and exact prompt binding", () => {
    expect(isHumanDelegationSessionEligible("pm-run", delegationId, { getSession: vi.fn(() => eligible) as any })).toBe(true);
    expect(isHumanDelegationSessionEligible("pm-run", operatorDelegationPromptHash("old turn"), { getSession: vi.fn(() => eligible) as any })).toBe(false);
    expect(isHumanDelegationSessionEligible("pm-run", delegationId, { getSession: vi.fn(() => ({ ...eligible, model: "sonnet" })) as any })).toBe(false);
    expect(isHumanDelegationSessionEligible("pm-run", delegationId, { getSession: vi.fn(() => ({ ...eligible, employee: "engineering-manager" })) as any })).toBe(false);
    expect(isHumanDelegationSessionEligible("pm-run", delegationId, { getSession: vi.fn(() => ({ ...eligible, transportMeta: { operatorDelegation: { ...activeGrant, state: "expired" } } })) as any })).toBe(false);
  });

  it("requires a signed matching scope in addition to live eligibility", () => {
    const deps = { getSession: vi.fn(() => eligible) as any };
    expect(isAuthorizedHumanDelegatePrincipal({ kind: "session", sessionId: "pm-run", delegatedScopes: ["approve"], operatorDelegationId: delegationId }, ["approve"], deps)).toBe(true);
    expect(isAuthorizedHumanDelegatePrincipal({ kind: "session", sessionId: "pm-run", delegatedScopes: ["approve"], operatorDelegationId: delegationId }, ["decide"], deps)).toBe(false);
  });
});

// ARCN-CTF-002: org.ts's cross-request router and session-write.ts's session
// creation route each independently re-implemented "is this an HR-human-only
// violation" — a correctness risk since the two copies could silently drift.
// Both now delegate to this single shared predicate; these cases cover the
// two call sites' distinct request shapes plus the target-employee gate.
describe("isHrHumanOnlyBlocked", () => {
  it("never blocks a non-HR target, regardless of request shape", () => {
    expect(isHrHumanOnlyBlocked("worker", { isDirectTopLevelHumanRequest: false })).toBe(false);
    expect(isHrHumanOnlyBlocked("worker", { isDirectTopLevelHumanRequest: true })).toBe(false);
  });

  it("blocks HR when the request is not a direct top-level human request", () => {
    expect(isHrHumanOnlyBlocked(HR_EMPLOYEE_NAME, { isDirectTopLevelHumanRequest: false })).toBe(true);
  });

  it("allows HR only for a direct top-level human request", () => {
    expect(isHrHumanOnlyBlocked(HR_EMPLOYEE_NAME, { isDirectTopLevelHumanRequest: true })).toBe(false);
  });

  it("treats an absent/null employee name as never HR", () => {
    expect(isHrHumanOnlyBlocked(null, { isDirectTopLevelHumanRequest: false })).toBe(false);
    expect(isHrHumanOnlyBlocked(undefined, { isDirectTopLevelHumanRequest: false })).toBe(false);
  });

  it("matches org.ts's cross-request semantics: always unconditionally blocked (never a direct human request)", () => {
    // org.ts's cross-request route always passes isDirectTopLevelHumanRequest:
    // false, since a cross-request is by construction routed from another
    // employee, never a human operator's direct top-level call.
    expect(isHrHumanOnlyBlocked(HR_EMPLOYEE_NAME, { isDirectTopLevelHumanRequest: false })).toBe(true);
  });

  it("matches session-write.ts's semantics: blocked only for a parented or session-principal request", () => {
    const isDirectTopLevelHumanRequest = (isParentedRequest: boolean, principalKind: "admin" | "session" | undefined) =>
      !isParentedRequest && principalKind !== "session";

    // Direct human request (no parent, no session principal): allowed.
    expect(isHrHumanOnlyBlocked(HR_EMPLOYEE_NAME, { isDirectTopLevelHumanRequest: isDirectTopLevelHumanRequest(false, undefined) })).toBe(false);
    // Parented (child session) request: blocked.
    expect(isHrHumanOnlyBlocked(HR_EMPLOYEE_NAME, { isDirectTopLevelHumanRequest: isDirectTopLevelHumanRequest(true, undefined) })).toBe(true);
    // Session-scoped (agent) principal: blocked even with no parent.
    expect(isHrHumanOnlyBlocked(HR_EMPLOYEE_NAME, { isDirectTopLevelHumanRequest: isDirectTopLevelHumanRequest(false, "session") })).toBe(true);
  });
});
