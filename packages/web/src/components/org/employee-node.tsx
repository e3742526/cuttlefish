import { Handle, Position, type NodeProps } from "@xyflow/react"
import { MessageSquare, ChevronDown, ChevronUp } from "lucide-react"
import { Link } from "react-router-dom"
import type { Employee } from "@/lib/api"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { deptHue } from "@/components/org/layout/dept-color"

type EmployeeNodeData = Employee &
  Record<string, unknown> & {
    /** Present (and true when the subtree is hidden) only on nodes with reports. */
    collapsed?: boolean
    onToggleCollapse?: () => void
  }

function roleLabel(emp: EmployeeNodeData): string {
  if (emp.rank === "executive") return "COO"
  return emp.rank.charAt(0).toUpperCase() + emp.rank.slice(1)
}

function executionProfileLabel(tier: string | undefined): string | null {
  if (tier !== "mid_pair") return null
  return "profile"
}

export function EmployeeNode({ data, selected }: NodeProps) {
  const employee = data as EmployeeNodeData
  const isExec = employee.rank === "executive"
  const employeeLabel = employee.displayName || employee.name
  const roleText = roleLabel(employee)
  const chatTarget = isExec ? "/" : `/?employee=${encodeURIComponent(employee.name)}`
  const modelTitle = employee.model || ""
  const execSummary = employee.executionProfileSummary as { tier?: string } | undefined
  const execProfileLabel = executionProfileLabel(execSummary?.tier)
  const hasReports = typeof employee.onToggleCollapse === "function"
  const reportCount = Array.isArray(employee.directReports) ? employee.directReports.length : 0

  return (
    // The inner card clips its own content (rounded corners, COO stripe);
    // the collapse toggle sits just outside that box, so it lives on this
    // unclipped outer wrapper instead — sized to the card via inline-block.
    <div className="relative inline-block">
    <div
      className="group hover-lift relative flex h-[78px] w-[240px] items-center gap-[10px] overflow-hidden rounded-[var(--radius-md)] bg-[var(--material-regular)] px-[var(--space-3)] backdrop-blur-[20px] backdrop-saturate-[180%] [-webkit-backdrop-filter:blur(20px)_saturate(180%)] cursor-pointer"
      style={{
        border: `1px solid ${selected ? "var(--accent)" : isExec ? "color-mix(in srgb, var(--accent) 45%, var(--separator))" : "var(--separator)"}`,
        boxShadow: selected
          ? "0 0 0 1px var(--accent), var(--shadow-card), var(--accent-glow)"
          : isExec
            ? "var(--inset-shine), var(--shadow-card), var(--accent-glow)"
            : "var(--shadow-subtle)",
      }}
    >
      <Link
        to={chatTarget}
        aria-label={`Chat with ${employeeLabel}`}
        className="nodrag nopan order-3 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--separator)] bg-[color-mix(in_srgb,var(--material-regular)_92%,transparent)] text-[var(--text-tertiary)] transition-colors duration-150 hover:text-[var(--accent)] hover:border-[color-mix(in_srgb,var(--accent)_35%,var(--separator))] hover:bg-[var(--fill-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]"
        onPointerDown={(event) => {
          event.stopPropagation()
        }}
        onClick={(event) => {
          event.stopPropagation()
        }}
      >
        <MessageSquare size={14} aria-hidden />
      </Link>

      {/* COO accent stripe — the only chromatic emphasis on a node */}
      {isExec && (
        <span
          aria-hidden
          className="absolute left-0 top-0 bottom-0 w-[2px]"
          style={{ background: 'var(--accent-bg)' }}
        />
      )}

      <EmployeeAvatar name={employee.name} avatar={employee.avatar as string | undefined} emoji={employee.emoji as string | undefined} size={isExec ? 28 : 22} />

      <div className="min-w-0 flex-1">
        <div
          title={employeeLabel}
          className={`${isExec ? "text-[length:var(--text-subheadline)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)]" : "text-[13px] font-[var(--weight-semibold)]"} text-[var(--text-primary)] whitespace-nowrap overflow-hidden text-ellipsis leading-[1.15]`}
        >
          {employeeLabel}
        </div>
        <div
          title={roleText}
          className="text-[11px] text-[var(--text-tertiary)] whitespace-nowrap overflow-hidden text-ellipsis leading-[1.1] opacity-90"
        >
          {roleText}
        </div>
        <div className="mt-[5px] flex min-w-0 items-center gap-[5px]">
          <span className="shrink-0 rounded-[10px] bg-[var(--accent-fill)] px-[7px] py-px text-[length:var(--text-caption2)] font-[var(--weight-semibold)] leading-[1.2] text-[var(--accent)]">
            {employee.engine}
          </span>
          {employee.model && (
            <span
              title={modelTitle}
              className="min-w-0 truncate rounded-[10px] bg-[var(--fill-quaternary)] px-[7px] py-px text-[length:var(--text-caption2)] font-[family-name:var(--font-code)] leading-[1.2] text-[var(--text-tertiary)]"
            >
              {employee.model}
            </span>
          )}
          {execProfileLabel && (
            <span
              title="Review profile configured"
              className="shrink-0 rounded-[10px] bg-[color-mix(in_srgb,var(--system-purple)_15%,transparent)] px-[7px] py-px text-[length:var(--text-caption2)] font-[var(--weight-semibold)] leading-[1.2] text-[var(--system-purple)]"
            >
              {execProfileLabel}
            </span>
          )}
        </div>
      </div>

      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
      {hasReports && (
        <button
          type="button"
          aria-label={employee.collapsed ? `Show ${reportCount} direct report${reportCount === 1 ? "" : "s"}` : "Collapse direct reports"}
          aria-expanded={!employee.collapsed}
          title={employee.collapsed ? `Show ${reportCount} direct report${reportCount === 1 ? "" : "s"}` : "Collapse direct reports"}
          className="nodrag nopan absolute -bottom-[9px] left-1/2 z-10 flex h-[18px] w-[18px] -translate-x-1/2 items-center justify-center rounded-full border border-[var(--separator)] bg-[var(--material-thick)] text-[var(--text-tertiary)] shadow-[var(--shadow-subtle)] transition-colors hover:text-[var(--accent)]"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            employee.onToggleCollapse?.()
          }}
        >
          {employee.collapsed ? <ChevronDown size={12} aria-hidden /> : <ChevronUp size={12} aria-hidden />}
        </button>
      )}
    </div>
  )
}

export function DepartmentGroupNode({ data }: NodeProps) {
  const { label } = data as { label: string } & Record<string, unknown>
  const hue = deptHue(label)
  return (
    <div
      className="w-full h-full relative rounded-[var(--radius-lg)] bg-[var(--fill-quaternary)] overflow-hidden"
      style={{ border: "1px solid var(--separator)", ["--dept-h" as string]: String(hue) }}
    >
      {/* Subtle per-department hue: left stripe only (amber stays for selection) */}
      <span
        aria-hidden
        className="org-dept-accent absolute left-0 top-0 bottom-0 w-[3px] opacity-70"
      />
      <div className="absolute top-[10px] left-0 right-0 flex items-center justify-center gap-[6px] select-none pointer-events-none">
        <span className="org-dept-accent w-[6px] h-[6px] rounded-full" />
        <span className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] tracking-[var(--tracking-wide)] uppercase text-[var(--text-tertiary)]">
          {label}
        </span>
      </div>
    </div>
  )
}

export const nodeTypes = {
  employeeNode: EmployeeNode,
  departmentGroup: DepartmentGroupNode,
}
