import type { Employee } from "@/lib/api"

/**
 * Employees visible given a set of collapsed manager names — hides any
 * employee whose ancestor chain includes a collapsed manager. `chain` is the
 * ancestor path from root to that employee (see d3-tree-layout.ts's
 * selection-highlight logic, which reads it the same way).
 */
export function filterCollapsedEmployees(employees: Employee[], collapsed: Set<string>): Employee[] {
  if (collapsed.size === 0) return employees
  return employees.filter((employee) => !employee.chain?.some((ancestor) => collapsed.has(ancestor)))
}

/**
 * True if `candidateName` is in `ancestorName`'s reporting subtree (a direct
 * or transitive report) — used to block a drag-to-reassign drop that would
 * create a reporting cycle (a manager can't be moved to report to their own
 * report).
 */
export function isDescendantOf(employees: Employee[], ancestorName: string, candidateName: string): boolean {
  const byName = new Map(employees.map((e) => [e.name, e]))
  const stack = [...(byName.get(ancestorName)?.directReports ?? [])]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const name = stack.pop()!
    if (name === candidateName) return true
    if (seen.has(name)) continue
    seen.add(name)
    const employee = byName.get(name)
    if (employee?.directReports) stack.push(...employee.directReports)
  }
  return false
}
