import { del, get, patch, post } from "./api-core"

export interface Employee {
  name: string
  displayName: string
  department: string
  rank: "executive" | "manager" | "senior" | "employee"
  engine: string
  model: string
  persona: string
  emoji?: string
  avatar?: string
  effortLevel?: string
  cliFlags?: string[]
  alwaysNotify?: boolean
  reportsTo?: string | string[]
  parentName?: string | null
  directReports?: string[]
  depth?: number
  chain?: string[]
  modelPolicy?: {
    fallback_chain?: Array<{
      engine: string
      model?: string
      effortLevel?: string
      employee?: string
      reason?: string
    }>
  }
}

export interface EmployeeUpdate {
  displayName?: string
  department?: string
  rank?: "executive" | "manager" | "senior" | "employee"
  engine?: string
  model?: string
  effortLevel?: string
  persona?: string
  reportsTo?: string | string[]
  cliFlags?: string[]
  alwaysNotify?: boolean
  fallbackModel?: string | null
}

export interface EmployeeCreate extends EmployeeUpdate {
  name: string
  displayName: string
  department: string
  rank: "manager" | "senior" | "employee"
  engine: string
  model: string
  persona: string
}

export interface OrgWarning {
  employee: string
  type: string
  message: string
  ref?: string
}

export interface OrgHierarchy {
  root: string | null
  sorted: string[]
  warnings: OrgWarning[]
}

export interface OrgData {
  departments: string[]
  employees: Employee[]
  hierarchy: OrgHierarchy
}

export const orgApi = {
  getOrg: () => get<OrgData>("/api/org"),
  getEmployee: (name: string) => get<Employee>(`/api/org/employees/${name}`),
  updateEmployee: (name: string, data: EmployeeUpdate) =>
    patch<{ status: string; employee: Employee | null }>(`/api/org/employees/${name}`, data),
  createEmployee: (data: EmployeeCreate) =>
    post<{ status: string; employee: Employee | null }>("/api/org/employees", data),
  deleteEmployee: (name: string) =>
    del<{ status: string }>(`/api/org/employees/${name}`),
}
