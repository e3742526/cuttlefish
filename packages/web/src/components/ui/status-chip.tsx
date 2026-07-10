import type { LucideIcon } from "lucide-react"
import { Circle, CheckCircle2, XCircle, AlertTriangle, Clock, ShieldQuestion } from "lucide-react"
import { cn } from "@/lib/utils"

// Closed status vocabulary shared across the app — see
// docs/plans/2026-07-10-fleetview-ux-implementation-plan.md, Section 9.4.
// StatusChip is the only component allowed to render a status color; every
// other surface renders status through this component so a color always
// carries the same meaning everywhere.
export type StatusTone = "running" | "success" | "failed" | "attention" | "idle" | "pending"

interface StatusMeta {
  label: string
  icon: LucideIcon
  color: string
  animate?: boolean
}

const STATUS_META: Record<StatusTone, StatusMeta> = {
  running: { label: "Running", icon: Circle, color: "var(--accent)", animate: true },
  success: { label: "Success", icon: CheckCircle2, color: "var(--system-green)" },
  failed: { label: "Failed", icon: XCircle, color: "var(--system-red)" },
  attention: { label: "Attention", icon: AlertTriangle, color: "var(--system-orange)" },
  idle: { label: "Idle", icon: Clock, color: "var(--text-tertiary)" },
  pending: { label: "Pending", icon: ShieldQuestion, color: "var(--system-purple)" },
}

interface StatusChipProps {
  tone: StatusTone
  /** Override the default label for this tone, e.g. "Blocked" instead of "Attention". Meaning (color/icon) stays fixed. */
  label?: string
  className?: string
}

function StatusChip({ tone, label, className }: StatusChipProps) {
  const meta = STATUS_META[tone]
  const Icon = meta.icon
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[length:var(--text-caption1)] font-medium",
        className,
      )}
      style={{
        color: meta.color,
        background: `color-mix(in srgb, ${meta.color} 12%, transparent)`,
      }}
    >
      <Icon
        className={cn("size-3", meta.animate && "animate-pulse")}
        fill={tone === "running" ? "currentColor" : "none"}
      />
      {label ?? meta.label}
    </span>
  )
}

export { StatusChip, STATUS_META }
