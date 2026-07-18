import type { Employee, OrgNode, OrgWarning, OrgHierarchy } from "../shared/types.js";
import { portalEmployeeSlug } from "../shared/portal-slug.js";

const RANK_PRIORITY: Record<string, number> = {
  executive: 0,
  manager: 1,
  senior: 2,
  employee: 3,
};

export function getPrimaryParent(
  reportsTo: string | string[] | undefined,
): string | undefined {
  if (reportsTo === undefined) return undefined;
  if (typeof reportsTo === "string") return reportsTo;
  return reportsTo.length > 0 ? reportsTo[0] : undefined;
}

export function getAllParents(
  reportsTo: string | string[] | undefined,
): string[] {
  if (reportsTo === undefined) return [];
  if (typeof reportsTo === "string") return [reportsTo];
  return [...reportsTo];
}

export function portalExecutiveEmployee(portalName: string | null | undefined): Employee {
  const displayName = portalName?.trim() || "Cuttlefish";
  return {
    name: portalEmployeeSlug(displayName),
    displayName,
    department: "",
    rank: "executive",
    engine: "claude",
    model: "opus",
    persona: "COO and AI gateway daemon",
    reportsTo: [],
  };
}

export function withPortalExecutive(
  registry: Map<string, Employee>,
  portalName: string | null | undefined,
): Map<string, Employee> {
  if ([...registry.values()].some((employee) => employee.rank === "executive")) {
    return registry;
  }
  const executive = portalExecutiveEmployee(portalName);
  if (registry.has(executive.name)) return registry;
  return new Map([[executive.name, executive], ...registry]);
}

function shouldReportToRoot(emp: Employee): boolean {
  return emp.rank === "manager" || !emp.department;
}

export function resolveOrgHierarchy(
  registry: Map<string, Employee>,
): OrgHierarchy {
  const warnings: OrgWarning[] = [];
  const parentMap = new Map<string, string | null>();

  if (registry.size === 0) {
    return { root: null, nodes: {}, sorted: [], warnings: [] };
  }

  // Step 1: Find root
  const executives = [...registry.values()]
    .filter((e) => e.rank === "executive")
    .sort((a, b) => a.name.localeCompare(b.name));

  let rootName: string | null = null;
  if (executives.length > 0) {
    rootName = executives[0].name;
    for (let i = 1; i < executives.length; i++) {
      warnings.push({
        employee: executives[i].name,
        type: "multiple_executives",
        message: `Multiple executives found. "${executives[i].name}" is not the primary root; "${rootName}" was chosen.`,
      });
    }
  }

  // Step 2: Resolve explicit reportsTo
  for (const [name, emp] of registry) {
    if (Array.isArray(emp.reportsTo) && emp.reportsTo.length === 0) {
      parentMap.set(name, null);
      continue;
    }
    const primary = getPrimaryParent(emp.reportsTo);
    if (primary === undefined) continue;
    if (primary === name) {
      warnings.push({ employee: name, type: "self_ref", message: `"${name}" lists itself as reportsTo.`, ref: primary });
      continue;
    }
    if (!registry.has(primary)) {
      warnings.push({ employee: name, type: "broken_ref", message: `"${name}" reports to "${primary}" which does not exist.`, ref: primary });
      continue;
    }
    parentMap.set(name, primary);
  }

  // Step 3: Smart defaults for unresolved
  for (const [name, emp] of registry) {
    if (parentMap.has(name)) continue;
    if (name === rootName) { parentMap.set(name, null); continue; }

    const deptMembers = [...registry.values()].filter(
      (m) => m.department === emp.department && m.name !== name,
    );
    const empRank = RANK_PRIORITY[emp.rank] ?? 3;
    const candidates = deptMembers
      .filter((m) => (RANK_PRIORITY[m.rank] ?? 3) < empRank)
      .sort((a, b) => {
        const rankDiff = (RANK_PRIORITY[a.rank] ?? 3) - (RANK_PRIORITY[b.rank] ?? 3);
        if (rankDiff !== 0) return rankDiff;
        return a.name.localeCompare(b.name);
      });

    parentMap.set(name, candidates.length > 0 ? candidates[0].name : null);
  }

  // Step 3b: Attach eligible top-level reports to the executive root. This is
  // actual hierarchy (parentName/directReports/chain), not merely chart wiring.
  if (rootName) {
    for (const [name, emp] of registry) {
      if (name === rootName) continue;
      if (parentMap.get(name) === null && shouldReportToRoot(emp)) {
        parentMap.set(name, rootName);
      }
    }
  }

  // Step 4: Cycle detection
  for (const [name] of registry) {
    const visited = new Set<string>();
    let current: string | null = name;
    while (current !== null) {
      if (visited.has(current)) {
        warnings.push({
          employee: name,
          type: "cycle",
          message: `Cycle detected involving "${name}". Detached from parent "${parentMap.get(name)}".`,
          ref: parentMap.get(name) ?? undefined,
        });
        parentMap.set(name, null);
        break;
      }
      visited.add(current);
      current = parentMap.get(current) ?? null;
    }
  }

  // Step 5: Cross-department check
  for (const [name, emp] of registry) {
    const parent = parentMap.get(name);
    if (parent === null || parent === undefined) continue;
    const parentEmp = registry.get(parent);
    if (parentEmp && parentEmp.department !== emp.department) {
      const primary = getPrimaryParent(emp.reportsTo);
      if (primary === parent) {
        warnings.push({
          employee: name,
          type: "cross_department",
          message: `"${name}" (${emp.department}) reports to "${parent}" (${parentEmp.department}) across departments.`,
        });
      }
    }
  }

  // Step 6: Compute directReports, depth, chain, sorted
  const nodes: Record<string, OrgNode> = {};
  const childrenMap = new Map<string, string[]>();

  for (const [name, emp] of registry) {
    nodes[name] = { employee: emp, parentName: parentMap.get(name) ?? null, directReports: [], depth: 0, chain: [] };
  }

  for (const [name] of registry) {
    const parent = parentMap.get(name);
    if (parent !== null && parent !== undefined && registry.has(parent)) {
      if (!childrenMap.has(parent)) childrenMap.set(parent, []);
      childrenMap.get(parent)!.push(name);
    }
  }

  for (const [, children] of childrenMap) {
    children.sort((a, b) => {
      const empA = registry.get(a)!;
      const empB = registry.get(b)!;
      const deptCmp = empA.department.localeCompare(empB.department);
      if (deptCmp !== 0) return deptCmp;
      return a.localeCompare(b);
    });
  }

  for (const [parent, children] of childrenMap) {
    if (nodes[parent]) nodes[parent].directReports = children;
  }

  const sorted: string[] = [];
  const rootNodes = Object.keys(nodes)
    .filter((name) => {
      const parent = nodes[name].parentName;
      return parent === null || !registry.has(parent);
    })
    .sort((a, b) => {
      const empA = registry.get(a)!;
      const empB = registry.get(b)!;
      const deptCmp = empA.department.localeCompare(empB.department);
      if (deptCmp !== 0) return deptCmp;
      return a.localeCompare(b);
    });

  const queue: string[] = [...rootNodes];
  // Index cursor instead of queue.shift(): shift() is O(n) per call, making this
  // hierarchy BFS O(n²) in the number of employees. A head pointer keeps it O(n).
  let head = 0;
  while (head < queue.length) {
    const name = queue[head++];
    sorted.push(name);
    const node = nodes[name];
    const parent = node.parentName;
    if (parent !== null && nodes[parent]) {
      node.depth = nodes[parent].depth + 1;
      node.chain = [...nodes[parent].chain, name];
    } else {
      node.depth = 0;
      node.chain = [name];
    }
    for (const child of node.directReports) queue.push(child);
  }

  return { root: rootName, nodes, sorted, warnings };
}

/** Walk a resolved hierarchy from `name` up to its root via `parentName`
 *  links, returning the chain in name-to-root order (self first). Cycle-safe
 *  via a `seen` guard, though `resolveOrgHierarchy` already detaches cycles. */
export function chainToRoot(name: string, hierarchy: OrgHierarchy): string[] {
  const out: string[] = [];
  let current: string | null | undefined = name;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    out.push(current);
    current = hierarchy.nodes[current]?.parentName ?? null;
  }
  return out;
}

/** Resolve the escalation route between two employees through their nearest
 *  common manager: the chain from `fromEmployee` up to the common ancestor,
 *  then back down to `providerEmployee`, plus the manager/executive names on
 *  that route (excluding the two endpoints). */
export function resolveCrossRequestRoute(
  fromEmployee: string,
  providerEmployee: string,
  hierarchy: OrgHierarchy,
): { route: string[]; managers: string[] } {
  const fromChain = chainToRoot(fromEmployee, hierarchy);
  const providerChain = chainToRoot(providerEmployee, hierarchy);
  const providerSet = new Set(providerChain);
  const common = fromChain.find((name) => providerSet.has(name));
  if (!common) {
    return { route: [fromEmployee, providerEmployee], managers: [] };
  }
  const up = fromChain.slice(0, fromChain.indexOf(common) + 1);
  const down = providerChain.slice(0, providerChain.indexOf(common)).reverse();
  const route = [...up, ...down];
  const managers = route.filter((name) => {
    if (name === fromEmployee || name === providerEmployee) return false;
    const rank = hierarchy.nodes[name]?.employee.rank;
    return rank === "manager" || rank === "executive";
  });
  return { route, managers };
}
