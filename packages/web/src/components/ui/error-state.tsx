import { useState } from "react"
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface ErrorStateProps {
  /** Plain-language cause, always visible. */
  message: string
  /** Technical detail (stack trace, raw error), collapsed behind a disclosure. */
  detail?: string
  onRetry?: () => void
  className?: string
}

// One of the five async-state primitives (loading / empty / error / stale /
// populated) every data surface should implement. See
// docs/plans/2026-07-10-fleetview-ux-implementation-plan.md, Section 7.
function ErrorState({ message, detail, onRetry, className }: ErrorStateProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col gap-[var(--space-2)] rounded-[var(--radius-md)] border p-[var(--space-4)]",
        className,
      )}
      style={{
        borderColor: "color-mix(in srgb, var(--system-red) 30%, transparent)",
        background: "color-mix(in srgb, var(--system-red) 8%, transparent)",
      }}
    >
      <div className="flex items-start gap-[var(--space-2)]">
        <AlertTriangle className="size-4 shrink-0 text-[var(--system-red)]" />
        <p className="min-w-0 flex-1 text-[length:var(--text-footnote)] text-[var(--system-red)]">
          {message}
        </p>
      </div>
      {(onRetry || detail) && (
        <div className="flex items-center gap-[var(--space-3)]">
          {onRetry && (
            <Button size="sm" variant="outline" onClick={onRetry}>
              Retry
            </Button>
          )}
          {detail && (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              className="inline-flex items-center gap-1 text-[length:var(--text-caption1)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
            >
              {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              Technical detail
            </button>
          )}
        </div>
      )}
      {expanded && detail && (
        <pre className="overflow-x-auto rounded-[var(--radius-sm)] bg-[var(--fill-secondary)] p-[var(--space-2)] text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
          {detail}
        </pre>
      )}
    </div>
  )
}

export { ErrorState }
