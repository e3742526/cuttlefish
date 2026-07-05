import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let policyFile: string;

vi.mock("../../shared/paths.js", () => ({
  get ORG_POLICY_FILE() {
    return policyFile;
  },
}));

vi.mock("../../shared/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  classifyChange,
  assertNotSelfModification,
  assertAcyclic,
  loadChangePolicy,
  OrgChangeBlockedError,
  HR_EMPLOYEE_NAME,
} from "../org-policy.js";
import type { Employee } from "../../shared/types.js";

function emp(name: string, reportsTo?: string | string[], rank: Employee["rank"] = "employee"): Employee {
  return { name, displayName: name, department: "general", rank, engine: "claude", model: "sonnet", persona: "x", reportsTo };
}

beforeEach(() => {
  policyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "org-policy-test-")), "_policy.json");
});

afterEach(() => {
  fs.rmSync(path.dirname(policyFile), { recursive: true, force: true });
});

describe("classifyChange", () => {
  it("maps change types to their default tiers", () => {
    expect(classifyChange({ changeType: "create_agent", employeeName: "x", proposed: {} })).toEqual({
      riskLevel: "high",
      requiresHumanApproval: true,
    });
    expect(classifyChange({ changeType: "change_model", employeeName: "x", proposed: { model: "opus" } })).toEqual({
      riskLevel: "medium",
      requiresHumanApproval: true,
    });
    expect(classifyChange({ changeType: "promote", employeeName: "x", proposed: { rank: "manager" } })).toEqual({
      riskLevel: "high",
      requiresHumanApproval: true,
    });
  });

  it("downgrades a cosmetic-only instruction edit to low/auto", () => {
    expect(
      classifyChange({ changeType: "modify_instructions", employeeName: "x", proposed: { displayName: "New Name" } }),
    ).toEqual({ riskLevel: "low", requiresHumanApproval: false });
  });

  it("forces approval for broad tool grants (mcp: true)", () => {
    expect(
      classifyChange({ changeType: "modify_instructions", employeeName: "x", proposed: { mcp: true } }),
    ).toEqual({ riskLevel: "high", requiresHumanApproval: true });
  });

  it("forces approval for any change touching HR itself", () => {
    expect(
      classifyChange({ changeType: "modify_instructions", employeeName: HR_EMPLOYEE_NAME, proposed: { displayName: "x" } }),
    ).toEqual({ riskLevel: "high", requiresHumanApproval: true });
  });

  it("honors an operator override file", () => {
    fs.writeFileSync(policyFile, JSON.stringify({ change_model: { requiresHumanApproval: false, riskLevel: "low" } }));
    expect(loadChangePolicy().change_model).toEqual({ riskLevel: "low", requiresHumanApproval: false });
  });
});

describe("assertNotSelfModification", () => {
  it("blocks an agent editing HR", () => {
    expect(() =>
      assertNotSelfModification({ changeType: "modify_instructions", employeeName: HR_EMPLOYEE_NAME, proposed: { model: "opus" }, proposedBy: "hr-manager" }),
    ).toThrow(OrgChangeBlockedError);
    expect(() =>
      assertNotSelfModification({ changeType: "retire_agent", employeeName: HR_EMPLOYEE_NAME, proposed: {}, proposedBy: "coo" }),
    ).toThrow(OrgChangeBlockedError);
    expect(() =>
      assertNotSelfModification({ changeType: "modify_instructions", employeeName: HR_EMPLOYEE_NAME, proposed: { persona: "tampered" }, proposedBy: "cuttlefish" }),
    ).toThrow(OrgChangeBlockedError);
  });

  it("allows a human operator to change HR", () => {
    expect(() =>
      assertNotSelfModification({ changeType: "modify_instructions", employeeName: HR_EMPLOYEE_NAME, proposed: { model: "opus" }, proposedBy: "user" }),
    ).not.toThrow();
  });

  it("ignores changes to other employees", () => {
    expect(() =>
      assertNotSelfModification({ changeType: "modify_instructions", employeeName: "someone-else", proposed: {}, proposedBy: "hr-manager" }),
    ).not.toThrow();
  });
});

describe("assertAcyclic", () => {
  it("rejects a reassignment that creates a cycle", () => {
    // a -> b -> a would be a cycle. Start with b reporting to a, then reassign a -> b.
    const registry = new Map<string, Employee>([
      ["a", emp("a", undefined, "manager")],
      ["b", emp("b", "a")],
    ]);
    expect(() =>
      assertAcyclic({ changeType: "reassign_manager", employeeName: "a", proposed: { reportsTo: "b" } }, registry),
    ).toThrow(OrgChangeBlockedError);
  });

  it("rejects self-reporting", () => {
    const registry = new Map<string, Employee>([["a", emp("a")]]);
    expect(() =>
      assertAcyclic({ changeType: "reassign_manager", employeeName: "a", proposed: { reportsTo: "a" } }, registry),
    ).toThrow(OrgChangeBlockedError);
  });

  it("accepts a valid reassignment", () => {
    const registry = new Map<string, Employee>([
      ["mgr", emp("mgr", undefined, "manager")],
      ["a", emp("a")],
    ]);
    expect(() =>
      assertAcyclic({ changeType: "reassign_manager", employeeName: "a", proposed: { reportsTo: "mgr" } }, registry),
    ).not.toThrow();
  });

  it("skips changes that don't touch reportsTo", () => {
    const registry = new Map<string, Employee>([["a", emp("a")]]);
    expect(() =>
      assertAcyclic({ changeType: "change_model", employeeName: "a", proposed: { model: "opus" } }, registry),
    ).not.toThrow();
  });
});
