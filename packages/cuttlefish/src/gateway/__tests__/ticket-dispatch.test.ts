import { describe, expect, it } from "vitest";
import type { Employee } from "../../shared/types.js";
import { findDepartmentManager, resolveDispatchEmployee } from "../ticket-dispatch.js";
import type { BoardTicket } from "../board-service.js";

function employee(overrides: Partial<Employee>): Employee {
  return {
    name: "worker",
    displayName: "Worker",
    department: "software-delivery",
    rank: "employee",
    engine: "claude",
    model: "opus",
    persona: "worker",
    ...overrides,
  };
}

function ticket(overrides: Partial<BoardTicket> = {}): BoardTicket {
  return {
    id: "ticket-1",
    title: "Investigate failing test",
    description: "Details",
    status: "todo",
    priority: "high",
    complexity: "low",
    assignee: "worker",
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("ticket dispatch resolution", () => {
  it("routes poller work to the department manager", () => {
    const registry = new Map<string, Employee>([
      ["worker", employee({ name: "worker", rank: "employee" })],
      ["manager-b", employee({ name: "manager-b", rank: "manager", displayName: "Manager B" })],
      ["manager-a", employee({ name: "manager-a", rank: "manager", displayName: "Manager A" })],
    ]);
    expect(findDepartmentManager("software-delivery", registry)?.name).toBe("manager-a");
    expect(
      resolveDispatchEmployee("software-delivery", ticket(), registry, true).employee?.name,
    ).toBe("manager-a");
  });

  it("returns no-manager when a department has no manager", () => {
    const registry = new Map<string, Employee>([
      ["worker", employee({ name: "worker", rank: "employee" })],
    ]);
    expect(resolveDispatchEmployee("software-delivery", ticket(), registry, true)).toEqual({
      reason: "no-manager",
    });
  });

  it("rejects manual dispatch when a ticket has no assignee", () => {
    const registry = new Map<string, Employee>([
      ["worker", employee({ name: "worker" })],
    ]);
    expect(resolveDispatchEmployee("software-delivery", ticket({ assignee: "" }), registry, false)).toEqual({
      reason: "no-assignee",
    });
  });

  it("rejects manual dispatch to an employee from another department", () => {
    const registry = new Map<string, Employee>([
      ["worker", employee({ name: "worker", department: "research" })],
    ]);
    expect(resolveDispatchEmployee("software-delivery", ticket(), registry, false)).toEqual({
      reason: "foreign-department-assignee",
    });
  });

  it("rejects manual dispatch to a disabled/retired assignee", () => {
    const registry = new Map<string, Employee>([
      ["worker", employee({ name: "worker", lifecycle: "disabled" })],
    ]);
    expect(resolveDispatchEmployee("software-delivery", ticket(), registry, false)).toEqual({
      reason: "employee-not-active",
    });
    const retired = new Map<string, Employee>([
      ["worker", employee({ name: "worker", lifecycle: "retired" })],
    ]);
    expect(resolveDispatchEmployee("software-delivery", ticket(), retired, false)).toEqual({
      reason: "employee-not-active",
    });
  });

  it("rejects poller routing to an inactive department manager", () => {
    const registry = new Map<string, Employee>([
      ["manager-a", employee({ name: "manager-a", rank: "manager", lifecycle: "disabled" })],
    ]);
    expect(resolveDispatchEmployee("software-delivery", ticket(), registry, true)).toEqual({
      reason: "employee-not-active",
    });
  });

  it("still dispatches to active (or lifecycle-unset) assignees", () => {
    const active = new Map<string, Employee>([["worker", employee({ name: "worker", lifecycle: "active" })]]);
    expect(resolveDispatchEmployee("software-delivery", ticket(), active, false).employee?.name).toBe("worker");
    const unset = new Map<string, Employee>([["worker", employee({ name: "worker" })]]);
    expect(resolveDispatchEmployee("software-delivery", ticket(), unset, false).employee?.name).toBe("worker");
    const probation = new Map<string, Employee>([["worker", employee({ name: "worker", lifecycle: "probation" })]]);
    expect(resolveDispatchEmployee("software-delivery", ticket(), probation, false).employee?.name).toBe("worker");
  });

  it("marks tickets as manual-only through the board ticket contract", () => {
    expect(ticket({ manualOnly: true }).manualOnly).toBe(true);
  });
});
