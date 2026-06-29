import type { Employee } from "@/lib/api"
import { portalEmployeeSlug } from "@/lib/portal-slug"

export function portalSupervisorName(portalName: string | null | undefined): string {
  return portalEmployeeSlug(portalName)
}

export function buildSupervisorOptions(
  employees: Pick<Employee, "name">[],
  opts: {
    portalName: string | null | undefined
    excludeName?: string
  },
): string[] {
  const exclude = opts.excludeName ?? null
  const portalSupervisor = portalSupervisorName(opts.portalName)
  return employees
    .map((employee) => employee.name)
    .filter((name) => name && name !== exclude && name !== portalSupervisor)
}
