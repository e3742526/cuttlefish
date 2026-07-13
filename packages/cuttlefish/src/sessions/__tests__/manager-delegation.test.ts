import { describe, expect, it } from "vitest";
import {
  buildManagerDelegationPlan,
  buildManagerDelegationTelemetry,
  isInitialManagerDelegationTurn,
  recordManagerDelegationChildCompletion,
  resolveManagerDelegationSynthesis,
  resolveSupervisedNodes,
} from "../manager-delegation.js";
import type { Employee, OrgHierarchy } from "../../shared/types.js";

const lead: Employee = {
  name: "lead",
  displayName: "Lead",
  department: "delivery",
  rank: "manager",
  engine: "claude",
  model: "opus",
  persona: "Lead the delivery team.",
};

const worker: Employee = {
  name: "worker",
  displayName: "Worker",
  department: "delivery",
  rank: "employee",
  engine: "claude",
  model: "sonnet",
  persona: "Implement focused delivery work.",
};

const dottedLine: Employee = {
  ...worker,
  name: "dotted-line-reviewer",
  displayName: "Dotted Line Reviewer",
  reportsTo: ["other-lead", "lead"],
};

const securityOfficer: Employee = {
  name: "senior-security-officer",
  displayName: "Senior Security Officer",
  department: "compliance",
  rank: "manager",
  engine: "claude",
  model: "opus",
  persona: "Investigate authentication, bearer tokens, secrets, vulnerabilities, and security risk.",
};

const hrManager: Employee = {
  name: "hr-manager",
  displayName: "HR Manager",
  department: "personnel",
  rank: "manager",
  engine: "claude",
  model: "sonnet",
  persona: "Own hiring, onboarding, employee changes, personnel policy, and org stewardship.",
};

describe("manager delegation helpers", () => {
  it("resolves primary and secondary direct reports consistently", () => {
    const hierarchy = {
      nodes: {
        lead: { employee: lead, parentName: null, directReports: ["worker"], depth: 0, chain: [] },
        worker: { employee: worker, parentName: "lead", directReports: [], depth: 1, chain: ["lead"] },
        "dotted-line-reviewer": {
          employee: dottedLine,
          parentName: "other-lead",
          directReports: [],
          depth: 1,
          chain: ["other-lead"],
        },
      },
      sorted: ["lead", "worker", "dotted-line-reviewer"],
      root: null,
      warnings: [],
    } satisfies OrgHierarchy;

    expect(resolveSupervisedNodes("lead", hierarchy, hierarchy.nodes.lead).map((n) => n.employee.name)).toEqual([
      "worker",
      "dotted-line-reviewer",
    ]);
  });

  it("emits telemetry only for manager-eligible sessions and records child-session delta", () => {
    expect(
      buildManagerDelegationTelemetry({
        sessionId: "s1",
        engine: "claude",
        employee: lead,
        directReportCount: 2,
        childSessionsBefore: 1,
        childSessionsAfter: 3,
      }),
    ).toMatchObject({
      event: "manager_delegation",
      sessionId: "s1",
      engine: "claude",
      employee: "lead",
      directReportCount: 2,
      childSessionsBefore: 1,
      childSessionsAfter: 3,
      childSessionsSpawned: 2,
      delegationAvailable: true,
    });

    expect(
      buildManagerDelegationTelemetry({
        sessionId: "s2",
        engine: "claude",
        employee: worker,
        directReportCount: 0,
        childSessionsBefore: 0,
        childSessionsAfter: 0,
      }),
    ).toBeNull();
  });

  it("builds a bounded enforced plan for strong direct-report specialty matches", () => {
    const hierarchy = {
      nodes: {
        lead: { employee: lead, parentName: null, directReports: ["senior-security-officer", "hr-manager"], depth: 0, chain: [] },
        "senior-security-officer": { employee: securityOfficer, parentName: "lead", directReports: [], depth: 1, chain: ["lead"] },
        "hr-manager": { employee: hrManager, parentName: "lead", directReports: [], depth: 1, chain: ["lead"] },
      },
      sorted: ["lead", "senior-security-officer", "hr-manager"],
      root: null,
      warnings: [],
    } satisfies OrgHierarchy;

    const plan = buildManagerDelegationPlan({
      manager: lead,
      prompt: "Review the bearer token security exposure and the HR onboarding impact. MANAGER_ONLY_SENTINEL.",
      supervisedNodes: resolveSupervisedNodes("lead", hierarchy, hierarchy.nodes.lead),
    });

    expect(plan.enforced).toBe(true);
    expect(plan.matches.map((m) => m.employee.name).sort()).toEqual(["hr-manager", "senior-security-officer"]);
    for (const match of plan.matches) {
      expect(match.prompt).toContain("bounded specialist assignment");
      expect(match.prompt).not.toContain("Original task:");
      expect(match.prompt).not.toContain("MANAGER_ONLY_SENTINEL");
    }
  });

  it("requires an explicit report reference or two distinct specialty signals", () => {
    const supervisedNodes = [
      { employee: securityOfficer, parentName: "lead", directReports: [], depth: 1, chain: ["lead"] },
    ];

    expect(buildManagerDelegationPlan({
      manager: lead,
      prompt: "Check the security posture.",
      supervisedNodes,
    }).enforced).toBe(false);

    expect(buildManagerDelegationPlan({
      manager: lead,
      prompt: "Ask senior-security-officer for a concise assessment.",
      supervisedNodes,
    }).matches.map((match) => match.employee.name)).toEqual(["senior-security-officer"]);

    expect(buildManagerDelegationPlan({
      manager: lead,
      prompt: "PT20_MANAGER_UNMATCHED_INLINE",
      supervisedNodes: [{
        employee: { ...worker, name: "pt20-solo", displayName: "PT20 Solo" },
        parentName: "lead",
        directReports: [],
        depth: 1,
        chain: ["lead"],
      }],
    }).enforced).toBe(false);
  });

  it("allows automatic delegation only for a manager's initial task turn", () => {
    expect(isInitialManagerDelegationTurn([{ role: "user" }])).toBe(true);
    expect(isInitialManagerDelegationTurn([{ role: "user" }, { role: "assistant" }])).toBe(false);
    expect(isInitialManagerDelegationTurn([{ role: "user" }, { role: "notification" }])).toBe(false);
  });

  it("does not enforce delegation for synthesis callbacks or explicit inline requests", () => {
    const supervisedNodes = [
      { employee: securityOfficer, parentName: "lead", directReports: [], depth: 1, chain: ["lead"] },
    ];

    expect(buildManagerDelegationPlan({
      manager: lead,
      prompt: "📩 Employee \"senior-security-officer\" replied in child session child-1.\n\nReply preview:\nDone.",
      supervisedNodes,
    }).enforced).toBe(false);

    expect(buildManagerDelegationPlan({
      manager: lead,
      prompt: "Do not delegate; handle this security token review yourself.",
      supervisedNodes,
    }).enforced).toBe(false);

    expect(buildManagerDelegationPlan({
      manager: lead,
      prompt: "Do not use tools, call APIs, delegate, or create files; keep this security token review report-only.",
      supervisedNodes,
    }).enforced).toBe(false);
  });

  it("waits for every recorded child callback before allowing one manager synthesis", () => {
    const initial = {
      managerDelegationEnforcement: {
        childSessionIds: ["child-a", "child-b"],
        completedChildSessionIds: [],
        synthesisDispatched: false,
      },
    } as any;
    const afterFirst = recordManagerDelegationChildCompletion(initial, "child-a");
    expect(resolveManagerDelegationSynthesis({ transportMeta: afterFirst } as any)).toMatchObject({
      shouldDispatch: false,
      pendingChildSessionIds: ["child-b"],
    });
    const afterSecond = recordManagerDelegationChildCompletion(afterFirst, "child-b");
    expect(resolveManagerDelegationSynthesis({ transportMeta: afterSecond } as any)).toMatchObject({ shouldDispatch: true });
  });
});
