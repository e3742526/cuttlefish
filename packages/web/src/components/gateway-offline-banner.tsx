import { WifiOff } from "lucide-react"
import { useDisconnected } from "@/hooks/use-connection-status"

// The app-level counterpart to StalePill (components/ui/stale-pill.tsx):
// where StalePill marks a single widget's data as non-live, this is the
// persistent, impossible-to-miss banner for when the gateway itself is
// unreachable — "killing the gateway during a demo produces the banner...
// never blank panes or uncaught errors" (the Phase 2 acceptance criterion,
// docs/plans/2026-07-10-fleetview-ux-implementation-plan.md, Section 12).
// Shares the same debounced connection read, so both surface together.
export function GatewayOfflineBanner() {
  const disconnected = useDisconnected()
  if (!disconnected) return null

  return (
    <div
      role="alert"
      className="pointer-events-none fixed inset-x-0 top-0 z-[500] flex justify-center px-[var(--space-3)] pt-[max(var(--safe-top),var(--space-2))]"
    >
      <div
        className="pointer-events-auto flex items-center gap-[var(--space-2)] rounded-full border px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-footnote)] font-[var(--weight-semibold)] shadow-[var(--shadow-overlay)] backdrop-blur-xl"
        style={{
          borderColor: "color-mix(in srgb, var(--system-red) 30%, transparent)",
          background: "color-mix(in srgb, var(--system-red) 14%, var(--material-thick))",
          color: "var(--system-red)",
        }}
      >
        <WifiOff className="size-4 shrink-0 animate-pulse" />
        Can't reach the Cuttlefish gateway — reconnecting. Some data may be out of date.
      </div>
    </div>
  )
}
