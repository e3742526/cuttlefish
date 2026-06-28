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
  const names = employees
    .map((employee) => employee.name)
    .filter((name) => name && name !== exclude)

  const cooName = portalSupervisorName(opts.portalName)
  if (cooName && cooName !== exclude && !names.includes(cooName)) {
    names.unshift(cooName)
  }

  return names
}
