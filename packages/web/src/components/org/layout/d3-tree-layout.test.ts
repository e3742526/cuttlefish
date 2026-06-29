import { describe, it, expect } from "vitest"
import { buildTreeLayout, NODE_W } from "./d3-tree-layout"
import type { Employee, OrgHierarchy } from "@/lib/api"

function emp(partial: Partial<Employee> & { name: string }): Employee {
  return {
    displayName: partial.name,
    department: "",
    rank: "employee",
    engine: "claude",
    model: "sonnet",
    persona: "x",
    ...partial,
  } as Employee
}

// COO (executive, injected client-side, not in hierarchy.sorted) + 2 managers,
// each with 2 reports. Mirrors the real org shape.
function fixture(): { employees: Employee[]; hierarchy: OrgHierarchy } {
  const employees: Employee[] = [
    emp({ name: "coo", rank: "executive" }),
    emp({ name: "m1", rank: "manager", department: "alpha", parentName: "coo", directReports: ["a1", "a2"], chain: ["coo", "m1"] }),
    emp({ name: "a1", rank: "employee", department: "alpha", parentName: "m1", chain: ["coo", "m1", "a1"] }),
    emp({ name: "a2", rank: "employee", department: "alpha", parentName: "m1", chain: ["coo", "m1", "a2"] }),
    emp({ name: "m2", rank: "manager", department: "beta", parentName: "coo", directReports: ["b1", "b2"], chain: ["coo", "m2"] }),
    emp({ name: "b1", rank: "employee", department: "beta", parentName: "m2", chain: ["coo", "m2", "b1"] }),
    emp({ name: "b2", rank: "employee", department: "beta", parentName: "m2", chain: ["coo", "m2", "b2"] }),
  ]
  const hierarchy: OrgHierarchy = {
    root: "coo",
    sorted: ["m1", "a1", "a2", "m2", "b1", "b2"],
    warnings: [],
  }
  return { employees, hierarchy }
}

describe("buildTreeLayout", () => {
  it("places every employee + a department box per department", () => {
    const { employees, hierarchy } = fixture()
    const { nodes, edges } = buildTreeLayout(employees, hierarchy, null)

    const empNodes = nodes.filter((n) => n.type === "employeeNode")
    const groupNodes = nodes.filter((n) => n.type === "departmentGroup")
    expect(empNodes).toHaveLength(7) // coo + 6
    expect(groupNodes.map((g) => g.id).sort()).toEqual(["group-alpha", "group-beta"])
    // 4 real department edges plus COO responsibility for top-level managers.
    expect(edges).toHaveLength(6)
    expect(edges.some((e) => e.source === "coo" && e.target === "m1")).toBe(true)
    expect(edges.some((e) => e.source === "coo" && e.target === "m2")).toBe(true)
    expect(edges.some((e) => e.source === "m1" && e.target === "a1")).toBe(true)
  })

  it("places employees with no department in an Unassigned group", () => {
    const employees: Employee[] = [
      emp({ name: "coo", rank: "executive" }),
      emp({ name: "security", rank: "senior", department: "", parentName: "coo", chain: ["coo", "security"] }),
    ]
    const hierarchy: OrgHierarchy = {
      root: "coo",
      sorted: ["security"],
      warnings: [],
    }
    const { nodes, edges } = buildTreeLayout(employees, hierarchy, null)

    expect(nodes.some((node) => node.id === "security")).toBe(true)
    expect(nodes.some((node) => node.id === "group-Unassigned")).toBe(true)
    expect(edges.some((edge) => edge.source === "coo" && edge.target === "security")).toBe(true)
  })

  it("does not synthesize a COO edge for non-manager department roots", () => {
    const employees: Employee[] = [
      emp({ name: "coo", rank: "executive" }),
      emp({ name: "specialist", rank: "senior", department: "alpha", parentName: undefined, chain: ["specialist"] }),
    ]
    const hierarchy: OrgHierarchy = {
      root: "coo",
      sorted: ["specialist"],
      warnings: [],
    }
    const { edges } = buildTreeLayout(employees, hierarchy, null)

    expect(edges.some((edge) => edge.source === "coo" && edge.target === "specialist")).toBe(false)
  })

  it("is deterministic (no Math.random / Date)", () => {
    const { employees, hierarchy } = fixture()
    const a = buildTreeLayout(employees, hierarchy, null)
    const b = buildTreeLayout(employees, hierarchy, null)
    expect(a.nodes.map((n) => [n.id, n.position])).toEqual(
      b.nodes.map((n) => [n.id, n.position]),
    )
  })

  it("centers a parent horizontally over its two children", () => {
    const { employees, hierarchy } = fixture()
    const { nodes } = buildTreeLayout(employees, hierarchy, null)
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const m1 = byId.get("m1")!.position.x
    const a1 = byId.get("a1")!.position.x
    const a2 = byId.get("a2")!.position.x
    // parent center ~= midpoint of children centers
    const parentCenter = m1 + NODE_W / 2
    const childMid = (a1 + a2) / 2 + NODE_W / 2
    expect(Math.abs(parentCenter - childMid)).toBeLessThan(1)
  })

  it("marks the selected ancestor/descendant chain as highlighted on edges", () => {
    const { employees, hierarchy } = fixture()
    const { edges } = buildTreeLayout(employees, hierarchy, "m1")
    const m1a1 = edges.find((e) => e.id === "m1-a1")!
    const m2b1 = edges.find((e) => e.id === "m2-b1")!
    expect((m1a1.data as { highlighted: boolean }).highlighted).toBe(true)
    expect((m2b1.data as { highlighted: boolean }).highlighted).toBe(false)
  })

  it("throws on a non-strict graph with no single root (caller falls back to dagre)", () => {
    // Two roots and no executive => stratify cannot find a single root and throws.
    const twoRoots: Employee[] = [
      emp({ name: "r1", rank: "manager" }),
      emp({ name: "r2", rank: "manager" }),
    ]
    const h2: OrgHierarchy = { root: null, sorted: ["r1", "r2"], warnings: [] }
    expect(() => buildTreeLayout(twoRoots, h2, null)).toThrow()
  })

  it("returns empty for no employees", () => {
    const { nodes, edges } = buildTreeLayout([], { root: null, sorted: [], warnings: [] }, null)
    expect(nodes).toEqual([])
    expect(edges).toEqual([])
  })
})
