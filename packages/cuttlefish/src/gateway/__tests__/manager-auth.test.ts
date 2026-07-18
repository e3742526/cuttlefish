import { describe, expect, it, vi } from "vitest";
import type { Employee } from "../../shared/types.js";
import { authorizeManagerScope, isHrHumanOnlyBlocked, isManagerNameAuthorizedForPrincipal } from "../manager-auth.js";
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
