import { WifiOff } from "lucide-react"
import { useGateway } from "@/hooks/use-gateway"
import { cn } from "@/lib/utils"

interface StalePillProps {
  className?: string
}

// Renders nothing while the gateway WebSocket is connected. Surfaces the
// partial/stale async state (the fourth of five, see
// docs/plans/2026-07-10-fleetview-ux-implementation-plan.md, Section 7.1)
// whenever it drops, instead of letting data go silently out of date.
function StalePill({ className }: StalePillProps) {
  const { connected } = useGateway()
  if (connected) return null

  return (
    <div
      role="status"
      className={cn(
        "inline-flex items-center gap-[var(--space-2)] rounded-full border px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--text-caption1)] font-medium",
        className,
      )}
      style={{
        borderColor: "color-mix(in srgb, var(--system-orange) 30%, transparent)",
        background: "color-mix(in srgb, var(--system-orange) 10%, var(--material-thick))",
        color: "var(--system-orange)",
      }}
    >
      <WifiOff className="size-3.5 animate-pulse" />
      Live updates paused — reconnecting
    </div>
  )
}

export { StalePill }
