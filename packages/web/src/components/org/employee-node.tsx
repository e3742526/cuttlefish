import { Handle, Position, type NodeProps } from "@xyflow/react"
import { MessageSquare } from "lucide-react"
import { Link } from "react-router-dom"
import type { Employee } from "@/lib/api"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { deptHue } from "@/components/org/layout/dept-color"

type EmployeeNodeData = Employee & Record<string, unknown>

function roleLabel(emp: EmployeeNodeData): string {
  if (emp.rank === "executive") return "COO"
  return emp.rank.charAt(0).toUpperCase() + emp.rank.slice(1)
}

export function EmployeeNode({ data, selected }: NodeProps) {
  const employee = data as EmployeeNodeData
  const isExec = employee.rank === "executive"
  const employeeLabel = employee.displayName || employee.name
  const roleText = roleLabel(employee)
  const chatTarget = isExec ? "/" : `/?employee=${encodeURIComponent(employee.name)}`
  const modelTitle = employee.model || ""

  return (
    <div
      className="group hover-lift relative w-[200px] h-[76px] flex items-center gap-[10px] px-[var(--space-3)] rounded-[var(--radius-md)] bg-[var(--material-regular)] backdrop-blur-[20px] backdrop-saturate-[180%] [-webkit-backdrop-filter:blur(20px)_saturate(180%)] cursor-pointer overflow-hidden"
      style={{
        border: `1px solid ${selected ? "var(--accent)" : isExec ? "color-mix(in srgb, var(--accent) 45%, var(--separator))" : "var(--separator)"}`,
        boxShadow: selected
          ? "0 0 0 1px var(--accent), var(--shadow-card)"
          : isExec
            ? "var(--inset-shine), var(--shadow-card)"
            : "var(--shadow-subtle)",
      }}
    >
      <Link
        to={chatTarget}
        aria-label={`Chat with ${employeeLabel}`}
        className="nodrag nopan absolute right-[8px] top-1/2 z-10 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--separator)] bg-[color-mix(in_srgb,var(--material-regular)_92%,transparent)] text-[var(--text-tertiary)] transition-colors duration-150 hover:text-[var(--accent)] hover:border-[color-mix(in_srgb,var(--accent)_35%,var(--separator))] hover:bg-[var(--fill-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]"
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
          className="absolute left-0 top-0 bottom-0 w-[2px] bg-[var(--accent)]"
        />
      )}

      <EmployeeAvatar name={employee.name} avatar={employee.avatar as string | undefined} emoji={employee.emoji as string | undefined} size={isExec ? 28 : 22} />

      <div className="min-w-0 flex-1 pr-12">
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
      </div>

      <div className="absolute right-[40px] top-[8px] flex max-w-[84px] flex-col items-end gap-[3px] shrink-0">
        <span className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] text-[var(--accent)] bg-[var(--accent-fill)] py-px px-[7px] rounded-[10px]">
          {employee.engine}
        </span>
        {employee.model && (
          <span
            title={modelTitle}
            className="max-w-full truncate text-[length:var(--text-caption2)] text-[var(--text-tertiary)] bg-[var(--fill-quaternary)] py-px px-[7px] rounded-[10px]"
          >
            {employee.model}
          </span>
        )}
      </div>

      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
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
