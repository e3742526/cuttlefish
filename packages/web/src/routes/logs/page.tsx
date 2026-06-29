import { useCallback, useEffect, useState } from "react"
import { RefreshCw } from "lucide-react"
import { api } from "@/lib/api"
import { PageLayout, ToolbarActions } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { Skeleton } from "@/components/ui/skeleton"
import { LogBrowser } from "@/components/activity/log-browser"

const LOG_LINE_LIMIT = 1000

export default function LogsPage() {
  useBreadcrumbs([{ label: "Activity" }])
  const [lines, setLines] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    setRefreshing(true)
    setError(null)
    api
      .getLogs(LOG_LINE_LIMIT)
      .then((res) => setLines(res.lines))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load activity log"))
      .finally(() => {
        setLoading(false)
        setRefreshing(false)
      })
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return (
    <PageLayout>
      <div className="h-full flex flex-col overflow-hidden animate-fade-in bg-[var(--bg)]">
        <header
          className="sticky top-0 z-10 flex-shrink-0 bg-[var(--material-regular)] border-b border-[var(--separator)]"
          style={{
            backdropFilter: "blur(40px) saturate(180%)",
            WebkitBackdropFilter: "blur(40px) saturate(180%)",
          }}
        >
          <div className="flex items-center justify-between px-[var(--space-6)] py-[var(--space-3)]">
            <h1 className="text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
              Activity
            </h1>
            <ToolbarActions>
              <button
                onClick={refresh}
                className="focus-ring w-8 h-8 flex items-center justify-center rounded-[var(--radius-sm)] border-none bg-transparent text-[var(--text-tertiary)] cursor-pointer transition-colors duration-150 ease-[var(--ease-smooth)]"
                aria-label="Refresh activity log"
              >
                <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} />
              </button>
            </ToolbarActions>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-[var(--space-6)] pt-[var(--space-5)] pb-[var(--space-8)]">
          <div className="mx-auto max-w-[900px]">
            {error && (
              <div className="mb-[var(--space-5)] px-[var(--space-4)] py-[var(--space-3)] rounded-[var(--radius-md)] border border-[var(--system-red)] text-[length:var(--text-footnote)] text-[var(--system-red)]">
                {error}
              </div>
            )}

            {loading ? (
              <div className="grid gap-[var(--space-3)]">
                <Skeleton height={44} className="rounded-[var(--radius-md)]" />
                <Skeleton height={44} className="rounded-[var(--radius-md)]" />
                <Skeleton height={44} className="rounded-[var(--radius-md)]" />
              </div>
            ) : (
              <LogBrowser lines={lines} />
            )}
          </div>
        </div>
      </div>
    </PageLayout>
  )
}
