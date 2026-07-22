import type { PublicSession } from "@cuttlefish/contracts"
import { ExternalLink, X } from "lucide-react"
import { Button } from "@/components/ui/button"

export function SessionInspector({
  session,
  onClose,
  onOpenSession,
}: {
  session: PublicSession
  onClose: () => void
  onOpenSession: (sessionId: string) => void
}) {
  const rows = [
    ["Status", session.jobState ?? session.status ?? "unknown"],
    ["Employee", session.employee ?? "Cuttlefish"],
    ["Parent", session.parentSessionId ?? "Project root"],
    ["Engine", session.engine ?? "default"],
    ["Model", session.model ?? "default"],
    ["Created", session.createdAt ? new Date(session.createdAt).toLocaleString() : "unknown"],
    ["Last activity", session.lastActivity ? new Date(session.lastActivity).toLocaleString() : "unknown"],
  ]
  return (
    <aside aria-label="Session inspector" className="absolute inset-y-0 right-0 z-30 flex w-full max-w-sm flex-col border-l border-[var(--separator)] bg-[var(--material-thick)] shadow-[var(--shadow-overlay)] sm:w-[360px]">
      <header className="flex items-start gap-3 border-b border-[var(--separator)] px-4 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-foreground">{session.title || session.id}</h2>
          <p className="mt-1 truncate font-mono text-[10px] text-[var(--text-tertiary)]">{session.id}</p>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close session inspector"><X className="size-4" /></Button>
      </header>
      <dl className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[92px_1fr] gap-3 text-xs">
            <dt className="text-[var(--text-tertiary)]">{label}</dt>
            <dd className="min-w-0 break-words text-[var(--text-secondary)]">{value}</dd>
          </div>
        ))}
        {session.lastError ? (
          <div className="rounded-lg border border-[var(--system-red)]/30 bg-[var(--fill-tertiary)] p-3 text-xs text-[var(--system-red)]">{session.lastError}</div>
        ) : null}
      </dl>
      <div className="border-t border-[var(--separator)] p-4">
        <Button variant="outline" className="w-full" onClick={() => onOpenSession(session.id)}>
          <ExternalLink className="mr-2 size-4" />Open underlying session
        </Button>
      </div>
    </aside>
  )
}

