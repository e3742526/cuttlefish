import { describe, it, expect } from "vitest";
import { resolveOrgHierarchy, getPrimaryParent, getAllParents } from "../org-hierarchy.js";
import type { Employee } from "../../shared/types.js";

function emp(name: string, opts: Partial<Employee> = {}): Employee {
  return {
    name,
    displayName: opts.displayName ?? name,
    department: opts.department ?? "default",
    rank: opts.rank ?? "employee",
    engine: opts.engine ?? "claude",
    model: opts.model ?? "opus",
    persona: opts.persona ?? `persona for ${name}`,
    reportsTo: opts.reportsTo,
  };
}

function registry(...employees: Employee[]): Map<string, Employee> {
  const map = new Map<string, Employee>();
  for (const e of employees) map.set(e.name, e);
  return map;
}

describe("getPrimaryParent", () => {
  it("returns undefined for undefined input", () => {
    expect(getPrimaryParent(undefined)).toBeUndefined();
  });
  it("returns the string when given a string", () => {
    expect(getPrimaryParent("boss")).toBe("boss");
  });
  it("returns first element when given an array", () => {
    expect(getPrimaryParent(["boss", "mentor"])).toBe("boss");
  });
  it("returns undefined for empty array", () => {
    expect(getPrimaryParent([])).toBeUndefined();
  });
});

describe("getAllParents", () => {
  it("returns empty array for undefined", () => {
    expect(getAllParents(undefined)).toEqual([]);
  });
  it("wraps string in array", () => {
    expect(getAllParents("boss")).toEqual(["boss"]);
  });
  it("returns array as-is", () => {
    expect(getAllParents(["boss", "mentor"])).toEqual(["boss", "mentor"]);
  });
});

describe("resolveOrgHierarchy", () => {
  it("handles empty registry", () => {
    const h = resolveOrgHierarchy(new Map());
    expect(h.root).toBeNull();
    expect(h.sorted).toEqual([]);
    expect(h.warnings).toEqual([]);
    expect(Object.keys(h.nodes)).toHaveLength(0);
  });

  it("single employee, no reportsTo → reports to root", () => {
    const h = resolveOrgHierarchy(registry(emp("alice")));
    expect(h.root).toBeNull();
    expect(h.nodes["alice"].parentName).toBeNull();
    expect(h.nodes["alice"].depth).toBe(0);
    expect(h.sorted).toEqual(["alice"]);
  });

  it("executive becomes root", () => {
    const h = resolveOrgHierarchy(
      registry(
        emp("coo", { rank: "executive", department: "exec" }),
        emp("alice", { department: "eng", reportsTo: "coo" }),
      ),
    );
    expect(h.root).toBe("coo");
    expect(h.nodes["coo"].parentName).toBeNull();
    expect(h.nodes["coo"].depth).toBe(0);
    expect(h.nodes["alice"].parentName).toBe("coo");
    expect(h.nodes["alice"].depth).toBe(1);
  });

  it("linear chain → correct depths and directReports", () => {
    const h = resolveOrgHierarchy(
      registry(
        emp("coo", { rank: "executive", department: "exec" }),
        emp("mgr", { rank: "manager", department: "eng", reportsTo: "coo" }),
        emp("dev", { rank: "employee", department: "eng", reportsTo: "mgr" }),
      ),
    );
    expect(h.nodes["coo"].depth).toBe(0);
    expect(h.nodes["mgr"].depth).toBe(1);
    expect(h.nodes["dev"].depth).toBe(2);
    expect(h.nodes["coo"].directReports).toContain("mgr");
    expect(h.nodes["mgr"].directReports).toContain("dev");
    expect(h.nodes["dev"].directReports).toEqual([]);
  });

  it("chain is computed correctly", () => {
    const h = resolveOrgHierarchy(
      registry(
        emp("coo", { rank: "executive", department: "exec" }),
        emp("mgr", { rank: "manager", department: "eng", reportsTo: "coo" }),
        emp("dev", { rank: "employee", department: "eng", reportsTo: "mgr" }),
      ),
    );
    expect(h.nodes["coo"].chain).toEqual(["coo"]);
    expect(h.nodes["mgr"].chain).toEqual(["coo", "mgr"]);
    expect(h.nodes["dev"].chain).toEqual(["coo", "mgr", "dev"]);
  });

  it("cycle → cycle broken, warning emitted", () => {
    const h = resolveOrgHierarchy(
      registry(
        emp("a", { department: "d", reportsTo: "c" }),
        emp("b", { department: "d", reportsTo: "a" }),
        emp("c", { department: "d", reportsTo: "b" }),
      ),
    );
    const cycleWarnings = h.warnings.filter((w) => w.type === "cycle");
    expect(cycleWarnings.length).toBeGreaterThanOrEqual(1);
    expect(h.sorted.length).toBe(3);
  });

  it("broken ref → warning emitted, smart default applied", () => {
    const h = resolveOrgHierarchy(
      registry(emp("alice", { department: "eng", reportsTo: "nonexistent" })),
    );
    const brokenWarnings = h.warnings.filter((w) => w.type === "broken_ref");
    expect(brokenWarnings).toHaveLength(1);
    expect(brokenWarnings[0].employee).toBe("alice");
    expect(brokenWarnings[0].ref).toBe("nonexistent");
    expect(h.nodes["alice"].parentName).toBeNull();
  });

  it("self ref → warning emitted, smart default applied", () => {
    const h = resolveOrgHierarchy(
      registry(emp("alice", { department: "eng", reportsTo: "alice" })),
    );
    const selfWarnings = h.warnings.filter((w) => w.type === "self_ref");
    expect(selfWarnings).toHaveLength(1);
    expect(h.nodes["alice"].parentName).toBeNull();
  });

  it("cross-department reporting → warning emitted, relationship preserved", () => {
    const h = resolveOrgHierarchy(
      registry(
        emp("mgr", { rank: "manager", department: "eng" }),
        emp("writer", { rank: "employee", department: "marketing", reportsTo: "mgr" }),
      ),
    );
    const crossWarnings = h.warnings.filter((w) => w.type === "cross_department");
    expect(crossWarnings).toHaveLength(1);
    expect(h.nodes["writer"].parentName).toBe("mgr");
  });

  it("multiple executives → first alphabetical used as root, warning emitted", () => {
    const h = resolveOrgHierarchy(
      registry(
        emp("alpha", { rank: "executive", department: "exec" }),
        emp("beta", { rank: "executive", department: "exec" }),
      ),
    );
    expect(h.root).toBe("alpha");
    const multiWarnings = h.warnings.filter((w) => w.type === "multiple_executives");
    expect(multiWarnings).toHaveLength(1);
    expect(multiWarnings[0].employee).toBe("beta");
  });

  it("no executive → root is null", () => {
    const h = resolveOrgHierarchy(
      registry(
        emp("alice", { rank: "manager", department: "eng" }),
        emp("bob", { rank: "employee", department: "eng", reportsTo: "alice" }),
      ),
    );
    expect(h.root).toBeNull();
    expect(h.nodes["alice"].parentName).toBeNull();
    expect(h.nodes["bob"].parentName).toBe("alice");
  });

  it("smart defaults: manager preferred over senior in same dept", () => {
    const h = resolveOrgHierarchy(
      registry(
        emp("mgr", { rank: "manager", department: "eng" }),
        emp("sr", { rank: "senior", department: "eng" }),
        emp("dev", { rank: "employee", department: "eng" }),
      ),
    );
    expect(h.nodes["sr"].parentName).toBe("mgr");
    expect(h.nodes["dev"].parentName).toBe("mgr");
  });

  it("smart defaults: employee alone in dept reports to root", () => {
    const h = resolveOrgHierarchy(
      registry(emp("lonely", { rank: "employee", department: "solo" })),
    );
    expect(h.nodes["lonely"].parentName).toBeNull();
  });

  it("smart defaults: two managers same dept both report to root (same-rank rule)", () => {
    const h = resolveOrgHierarchy(
      registry(
        emp("mgr-a", { rank: "manager", department: "eng" }),
        emp("mgr-b", { rank: "manager", department: "eng" }),
      ),
    );
    expect(h.nodes["mgr-a"].parentName).toBeNull();
    expect(h.nodes["mgr-b"].parentName).toBeNull();
  });

  it("smart defaults: two seniors no manager both report to root", () => {
    const h = resolveOrgHierarchy(
      registry(
        emp("sr-a", { rank: "senior", department: "eng" }),
        emp("sr-b", { rank: "senior", department: "eng" }),
      ),
    );
    expect(h.nodes["sr-a"].parentName).toBeNull();
    expect(h.nodes["sr-b"].parentName).toBeNull();
  });

  it("treats an explicit empty reportsTo array as intentionally top-level", () => {
    const h = resolveOrgHierarchy(
      registry(
        emp("mgr", { rank: "manager", department: "general" }),
        emp("security", { rank: "senior", department: "general", reportsTo: [] }),
      ),
    );
    expect(h.nodes["security"].parentName).toBeNull();
  });

  it("mixed explicit and smart defaults → correct tree", () => {
    const h = resolveOrgHierarchy(
      registry(
        emp("coo", { rank: "executive", department: "exec" }),
        emp("eng-lead", { rank: "manager", department: "eng", reportsTo: "coo" }),
        emp("dev-a", { rank: "employee", department: "eng" }),
        emp("dev-b", { rank: "employee", department: "eng", reportsTo: "eng-lead" }),
        emp("mkt-lead", { rank: "manager", department: "mkt" }),
        emp("writer", { rank: "employee", department: "mkt" }),
      ),
    );
    expect(h.nodes["eng-lead"].parentName).toBe("coo");
    expect(h.nodes["dev-a"].parentName).toBe("eng-lead");
    expect(h.nodes["dev-b"].parentName).toBe("eng-lead");
    expect(h.nodes["mkt-lead"].parentName).toBeNull();
    expect(h.nodes["writer"].parentName).toBe("mkt-lead");
  });

  it("sorted order is BFS (root first)", () => {
    const h = resolveOrgHierarchy(
      registry(
        emp("coo", { rank: "executive", department: "exec" }),
        emp("mgr", { rank: "manager", department: "eng", reportsTo: "coo" }),
        emp("dev", { rank: "employee", department: "eng", reportsTo: "mgr" }),
      ),
    );
    expect(h.sorted.indexOf("coo")).toBeLessThan(h.sorted.indexOf("mgr"));
    expect(h.sorted.indexOf("mgr")).toBeLessThan(h.sorted.indexOf("dev"));
  });

  it("directReports are sorted by department then name", () => {
    const h = resolveOrgHierarchy(
      registry(
        emp("coo", { rank: "executive", department: "exec" }),
        emp("charlie", { rank: "manager", department: "eng", reportsTo: "coo" }),
        emp("alice", { rank: "manager", department: "design", reportsTo: "coo" }),
        emp("bob", { rank: "manager", department: "design", reportsTo: "coo" }),
      ),
    );
    const reports = h.nodes["coo"].directReports;
    expect(reports).toEqual(["alice", "bob", "charlie"]);
  });
});
