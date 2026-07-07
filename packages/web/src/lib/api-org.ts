import { del, get, patch, post } from "./api-core"

export type EmployeeLifecycle = "draft" | "active" | "probation" | "disabled" | "retired"

export type ExecutionTier = "solo" | "mid_pair"
export type ReviewerLossPolicy = "block" | "replace_then_block" | "replace_then_degrade" | "degrade"
export type ReviewerToolProfile = "read_only" | "read_plus_inspect" | "patch_suggestions"

export interface RoleModelOverride {
  engine?: string
  model?: string
  effortLevel?: string
}

/**
 * One backup target in a role's failover chain. Either a direct agent
 * (engine + model) or a defer-to-external-agent entry (employee) — never both.
 */
export interface RoleFallbackTarget {
  engine?: string
  model?: string
  effortLevel?: string
  employee?: string
}

export interface RoleExecutionPolicy {
  override?: RoleModelOverride
  fallbackChain?: RoleFallbackTarget[]
}

/** Mirrors the backend cap on failover chain length. */
export const MAX_ROLE_FALLBACK_CHAIN = 5

export interface EmployeeExecutionConfig {
  tier: ExecutionTier
  maxInternalPasses?: number
  maxChildSessions?: number
  maxWallClockMs?: number
  maxToolCalls?: number
  maxEstimatedCostUsd?: number
  reviewerLossPolicy?: ReviewerLossPolicy
  reviewerToolProfile?: ReviewerToolProfile
  roles?: {
    implementer?: RoleExecutionPolicy
    reviewer?: RoleExecutionPolicy
  }
}

/** Static summary computed from execution config — used in org cards and detail panels. */
export interface ExecutionProfileSummary {
  tier: ExecutionTier
  /** Human-readable label from the org API. UI should avoid presenting non-solo profiles as active runtime execution unless a session exposes run state. */
  label: string
  reviewerLossPolicy?: ReviewerLossPolicy
  reviewerToolProfile?: ReviewerToolProfile
  hasCustomRoleOverrides: boolean
}

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
  lifecycle?: EmployeeLifecycle
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
  execution?: EmployeeExecutionConfig
  executionProfileSummary?: ExecutionProfileSummary
}

export interface EmployeeUpdate {
  displayName?: string
  department?: string
  rank?: "executive" | "manager" | "senior" | "employee"
  engine?: string
  model?: string
  effortLevel?: string
  persona?: string
  reportsTo?: string | string[] | null
  cliFlags?: string[]
  alwaysNotify?: boolean
  fallbackEngine?: string | null
  fallbackModel?: string | null
  /** Canonical icon: ocean avatar id ("kind:id"). "" clears it. Mutually exclusive with `emoji`. */
  avatar?: string
  /** Canonical icon: plain emoji. "" clears it. Mutually exclusive with `avatar`. */
  emoji?: string
  execution?: Partial<EmployeeExecutionConfig>
}

export interface ManagerEmployeeUpdate {
  managerName: string
  engine?: string
  model?: string
  effortLevel?: string
  fallbackEngine?: string | null
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
  boardDepartments?: string[]
  employees: Employee[]
  hierarchy: OrgHierarchy
}

export const orgApi = {
  getOrg: () => get<OrgData>("/api/org"),
  getEmployee: (name: string) => get<Employee>(`/api/org/employees/${name}`),
  updateEmployee: (name: string, data: EmployeeUpdate) =>
    patch<{ status: string; employee: Employee | null }>(`/api/org/employees/${name}`, data),
  updateEmployeeAsManager: (name: string, data: ManagerEmployeeUpdate) =>
    patch<{ status: string; employee: Employee | null }>(`/api/org/employees/${name}`, data),
  createEmployee: (data: EmployeeCreate) =>
    post<{ status: string; employee: Employee | null }>("/api/org/employees", data),
  deleteEmployee: (name: string) =>
    del<{ status: string }>(`/api/org/employees/${name}`),
  renameDepartment: (name: string, nextName: string) =>
    patch<{ status: string; previousDepartment: string; department: string; employees: string[]; movedDirectory: boolean }>(
      `/api/org/departments/${encodeURIComponent(name)}`,
      { name: nextName },
    ),
}
