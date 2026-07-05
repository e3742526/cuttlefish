import { describe, expect, it } from "vitest";
import {
  buildManagerDelegationTelemetry,
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
});
