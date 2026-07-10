import { describe, it, expect } from "vitest"
import { filterCollapsedEmployees, isDescendantOf } from "./org-map-helpers"
import type { Employee } from "@/lib/api"

function emp(overrides: Partial<Employee> & { name: string }): Employee {
  return {
    displayName: overrides.name,
    department: "General",
    rank: "employee",
    engine: "claude",
    model: "opus",
    persona: "",
    ...overrides,
  }
}

// coo -> manager -> senior -> lead
//                          -> other
const TREE: Employee[] = [
  emp({ name: "coo", rank: "executive", directReports: ["manager"], chain: [] }),
  emp({ name: "manager", rank: "manager", directReports: ["senior"], chain: ["coo"] }),
  emp({ name: "senior", rank: "senior", directReports: ["lead", "other"], chain: ["coo", "manager"] }),
  emp({ name: "lead", directReports: [], chain: ["coo", "manager", "senior"] }),
  emp({ name: "other", directReports: [], chain: ["coo", "manager", "senior"] }),
]

describe("filterCollapsedEmployees", () => {
  it("returns everything unchanged when nothing is collapsed", () => {
    expect(filterCollapsedEmployees(TREE, new Set())).toEqual(TREE)
  })

  it("hides every descendant of a collapsed manager, but keeps the manager itself", () => {
    const visible = filterCollapsedEmployees(TREE, new Set(["senior"]))
    expect(visible.map((e) => e.name).sort()).toEqual(["coo", "manager", "senior"])
  })

  it("collapsing a higher node hides everything below it, including nested collapses", () => {
    const visible = filterCollapsedEmployees(TREE, new Set(["manager"]))
    expect(visible.map((e) => e.name).sort()).toEqual(["coo", "manager"])
  })

  it("collapsing a leaf with no reports changes nothing below it (there is nothing below)", () => {
    const visible = filterCollapsedEmployees(TREE, new Set(["lead"]))
    expect(visible.map((e) => e.name).sort()).toEqual(["coo", "lead", "manager", "other", "senior"])
  })
})

describe("isDescendantOf", () => {
  it("finds a direct report", () => {
    expect(isDescendantOf(TREE, "senior", "lead")).toBe(true)
  })

  it("finds a transitive (grandchild) report", () => {
    expect(isDescendantOf(TREE, "manager", "lead")).toBe(true)
  })

  it("is false for a sibling, not a descendant", () => {
    expect(isDescendantOf(TREE, "senior", "manager")).toBe(false)
  })

  it("is false for an unrelated employee", () => {
    expect(isDescendantOf(TREE, "lead", "other")).toBe(false)
  })

  it("is false for a leaf with no reports", () => {
    expect(isDescendantOf(TREE, "lead", "senior")).toBe(false)
  })
})
