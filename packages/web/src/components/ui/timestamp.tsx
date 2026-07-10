import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"

interface TimestampProps {
  value: string | number | Date
  /** Always render the absolute form, even for recent timestamps (e.g. resolved-at columns). */
  alwaysAbsolute?: boolean
  className?: string
}

function relative(date: Date): string {
  const mins = Math.floor((Date.now() - date.getTime()) / 60_000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function absolute(date: Date): string {
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

// Shared timestamp rendering: relative under 24h, absolute after — with the
// absolute form always available on hover via the title attribute. See
// docs/plans/2026-07-10-fleetview-ux-implementation-plan.md, Section 4.3.
function Timestamp({ value, alwaysAbsolute, className }: TimestampProps) {
  const date = value instanceof Date ? value : new Date(value)
  const [, forceTick] = useState(0)

  useEffect(() => {
    if (alwaysAbsolute) return
    const id = window.setInterval(() => forceTick((n) => n + 1), 30_000)
    return () => window.clearInterval(id)
  }, [alwaysAbsolute])

  if (isNaN(date.getTime())) {
    return <span className={className}>—</span>
  }

  const isRecent = Date.now() - date.getTime() < 86_400_000
  const label = alwaysAbsolute || !isRecent ? absolute(date) : relative(date)

  return (
    <time dateTime={date.toISOString()} title={absolute(date)} className={cn("tabular-nums", className)}>
      {label}
    </time>
  )
}

export { Timestamp }
