import type { CollaborationFeedItem } from "@cuttlefish/contracts"
import { AlertCircle, ArrowDownToLine, CheckCircle2, Clock3, GitBranch, Info, RotateCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { formatMessage } from "./message-markdown"

function kindIcon(kind: CollaborationFeedItem["kind"]) {
  if (kind === "delegation") return <GitBranch className="size-3.5" />
  if (kind === "callback") return <ArrowDownToLine className="size-3.5" />
  if (kind === "error") return <AlertCircle className="size-3.5" />
  if (kind === "status") return <Info className="size-3.5" />
  return null
}

export function CollaborationFeed({
  items,
  loading,
  error,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  onRetry,
  onInspectSession,
}: {
  items: CollaborationFeedItem[]
  loading: boolean
  error?: string | null
  hasOlder: boolean
  loadingOlder: boolean
  onLoadOlder: () => void
  onRetry: () => void
  onInspectSession: (sessionId: string) => void
}) {
  if (loading && items.length === 0) {
    return <div className="flex flex-1 items-center justify-center text-sm text-[var(--text-tertiary)]">Loading collaboration feed…</div>
  }
  if (error && items.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <AlertCircle className="size-6 text-[var(--system-red)]" />
        <p className="text-sm text-[var(--text-secondary)]">{error}</p>
        <Button variant="outline" size="sm" onClick={onRetry}><RotateCw className="mr-1 size-3.5" />Retry</Button>
      </div>
    )
  }
  if (items.length === 0) {
    return <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-[var(--text-tertiary)]">No collaboration messages yet.</div>
  }
  return (
    <div className="chat-messages-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-8 pt-4 sm:px-6" role="feed" aria-busy={loading || loadingOlder}>
      <div className="mx-auto flex max-w-4xl flex-col gap-3">
        {hasOlder ? (
          <Button variant="ghost" size="sm" onClick={onLoadOlder} disabled={loadingOlder} className="self-center">
            {loadingOlder ? "Loading…" : "Load older activity"}
          </Button>
        ) : null}
        {error ? <div role="status" className="rounded-lg border border-[var(--system-orange)]/30 bg-[var(--fill-tertiary)] px-3 py-2 text-xs text-[var(--system-orange)]">Feed refresh failed: {error}</div> : null}
        {items.map((item) => {
          const operator = item.author.kind === "operator"
          const event = item.kind !== "message"
          return (
            <article
              key={item.id}
              className={cn(
                "rounded-2xl border px-4 py-3",
                operator ? "ml-auto max-w-[86%] border-[var(--accent)]/25 bg-[var(--fill-secondary)]" : "mr-auto w-full border-[var(--separator)] bg-[var(--material-thin)]",
                event && "border-dashed",
              )}
              aria-label={`${item.author.displayName} ${item.kind}`}
            >
              <header className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-tertiary)]">
                <span className="font-semibold text-[var(--text-secondary)]">{item.author.displayName}</span>
                {event ? <span className="inline-flex items-center gap-1 rounded-full bg-[var(--fill-secondary)] px-1.5 py-0.5">{kindIcon(item.kind)}{item.kind}</span> : null}
                {item.projectTitle ? <span className="rounded bg-[var(--fill-tertiary)] px-1.5 py-0.5">{item.projectTitle}</span> : null}
                {item.attribution === "inferred" ? <span title="Legacy attribution was inferred conservatively" className="rounded bg-[var(--fill-tertiary)] px-1.5 py-0.5 text-[var(--system-orange)]">inferred</span> : null}
                <time dateTime={new Date(item.timestamp).toISOString()} className="ml-auto">{new Date(item.timestamp).toLocaleString()}</time>
              </header>
              <div className="text-sm leading-6 text-[var(--text-primary)]">{formatMessage(item.content)}</div>
              <footer className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-[var(--text-tertiary)]">
                {item.recipients.length > 0 ? <span>To {item.recipients.join(", ")}</span> : null}
                {item.sessionId ? (
                  <button type="button" onClick={() => onInspectSession(item.sessionId!)} className="rounded px-1.5 py-0.5 text-[var(--accent)] hover:bg-[var(--fill-secondary)]">Inspect session</button>
                ) : null}
                {item.deliveryReceipts?.map((receipt) => (
                  <span key={`${item.id}:${receipt.recipientId}`} className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5", receipt.state === "queued" ? "text-[var(--system-green)]" : "text-[var(--system-red)]")} title={receipt.error}>
                    {receipt.state === "queued" ? <CheckCircle2 className="size-3" /> : receipt.state === "unavailable" ? <Clock3 className="size-3" /> : <AlertCircle className="size-3" />}
                    {receipt.recipientId}: {receipt.state}
                  </span>
                ))}
              </footer>
            </article>
          )
        })}
      </div>
    </div>
  )
}
