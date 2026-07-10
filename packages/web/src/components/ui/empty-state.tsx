import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

interface EmptyStateProps {
  icon?: LucideIcon
  title: string
  description?: string
  action?: ReactNode
  className?: string
}

// One of the five async-state primitives (loading / empty / error / stale /
// populated) every data surface should implement. See
// docs/plans/2026-07-10-fleetview-ux-implementation-plan.md, Section 7.
function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex h-full flex-col items-center justify-center gap-[var(--space-2)] p-[var(--space-6)] text-center",
        className,
      )}
    >
      {Icon && <Icon className="size-8 text-[var(--text-tertiary)]" strokeWidth={1.5} />}
      <p className="text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-secondary)]">
        {title}
      </p>
      {description && (
        <p className="max-w-sm text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
          {description}
        </p>
      )}
      {action}
    </div>
  )
}

export { EmptyState }
