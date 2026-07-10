import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertTriangle, Gauge, RefreshCw } from "lucide-react"
import { api } from "@/lib/api"
import type {
  EngineLimitEngineSnapshot,
  EngineLimitsResponse,
  EngineLimitWindow,
} from "@/lib/api"
import { PageLayout, ToolbarActions } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { usePageVisibility } from "@/hooks/use-page-visibility"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"

const DANGER = 90
const ENGINE_ORDER = ["claude", "codex", "kiro", "kilo", "antigravity", "ollama", "grok", "hermes", "pi"]

function engineLabel(name: string) {
  const labels: Record<string, string> = {
    claude: "Claude",
    codex: "Codex",
    kiro: "Kiro",
    kilo: "Kilo",
    antigravity: "Antigravity",
    ollama: "Ollama",
    grok: "Grok",
    hermes: "Hermes",
    pi: "Pi",
  }
  return labels[name] ?? name
}

function formatDuration(minutes?: number) {
  if (!minutes) return ""
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

function windowLabel(window: EngineLimitWindow) {
  return formatDuration(window.windowDurationMins) || window.name
}

function clampPercent(value?: number) {
  return Math.max(0, Math.min(100, value ?? 0))
}

function barColor(value?: number) {
  return (value ?? 0) >= DANGER ? "var(--system-red)" : "var(--accent)"
}

function resetLabel(iso?: string) {
  if (!iso) return null
  const diff = new Date(iso).getTime() - Date.now()
  if (diff <= 0) return "resetting now"
  const mins = Math.round(diff / 60000)
  if (mins < 60) return `resets in ${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `resets in ${hrs}h`
  const days = Math.round(hrs / 24)
  if (days <= 7) return `resets in ${days}d`
  return `resets ${new Date(iso).toLocaleDateString()}`
}

function agoLabel(iso?: string) {
  if (!iso) return "unknown"
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.max(0, Math.round(diff / 60000))
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

function freshness(engine: EngineLimitEngineSnapshot) {
  if (!engine.available) return { color: "var(--text-quaternary)", label: "Agent not available" }
  if (engine.status === "error") return { color: "var(--system-red)", label: "Error" }
  if (engine.stale) return { color: "var(--system-orange)", label: `Stale · ${agoLabel(engine.refreshedAt)}` }
  if (engine.status === "live") return { color: "var(--system-green)", label: "Live" }
  if (engine.status === "snapshot") return { color: "var(--text-tertiary)", label: `Updated ${agoLabel(engine.refreshedAt)}` }
  if (engine.available) return { color: "var(--system-green)", label: "CLI detected" }
  return { color: "var(--text-quaternary)", label: "No data" }
}

function hasObservedUsage(engine: EngineLimitEngineSnapshot) {
  return (
    (engine.windows ?? []).some((window) => typeof window.usedPercent === "number") ||
    typeof engine.credits?.remainingPercent === "number" ||
    typeof engine.credits?.balance === "string" ||
    typeof engine.context?.usedPercent === "number" ||
    typeof engine.context?.totalInputTokens === "number" ||
    typeof engine.context?.totalOutputTokens === "number" ||
    typeof engine.costUsd === "number"
  )
}

function formatTokens(n?: number) {
  if (typeof n !== "number") return null
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return `${n}`
}

function sortEngines(engines: EngineLimitEngineSnapshot[]) {
  return [...engines].sort((a, b) => {
    const ai = ENGINE_ORDER.indexOf(a.name)
    const bi = ENGINE_ORDER.indexOf(b.name)
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) || a.name.localeCompare(b.name)
  })
}

function WindowBar({ window }: { window: EngineLimitWindow }) {
  const observed = window.usedPercent !== undefined
  const used = clampPercent(window.usedPercent)
  const reset = resetLabel(window.resetsAtIso)

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-[var(--space-3)]">
        <span className="text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
          {windowLabel(window)} window
        </span>
        <span className="text-[length:var(--text-body)] font-[var(--weight-bold)] text-[var(--text-primary)] tabular-nums">
          {observed ? `${window.usedPercent}%` : "—"}
        </span>
      </div>
      <div className="mt-[var(--space-2)] h-2 rounded-full bg-[var(--fill-tertiary)] overflow-hidden">
        {observed && (
          <div
            className="h-full rounded-full transition-[width] duration-500 ease-[var(--ease-smooth)]"
            style={{ width: `${used}%`, background: barColor(window.usedPercent) }}
          />
        )}
      </div>
      {reset && (
        <div className="mt-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{reset}</div>
      )}
    </div>
  )
}

function EngineCard({ engine }: { engine: EngineLimitEngineSnapshot }) {
  const windows = engine.windows || []
  const tone = freshness(engine)
  const credits = engine.credits
  const creditLabel = credits?.unlimited
    ? "Unlimited credits"
    : credits?.balance
      ? `Balance ${credits.balance}`
      : null
  const hasCost = typeof engine.costUsd === "number"
  const inTok = formatTokens(engine.context?.totalInputTokens)
  const outTok = formatTokens(engine.context?.totalOutputTokens)
  const hasTokens = inTok !== null || outTok !== null
  // Cost-based providers (API-key / prepaid) have no rate-limit windows; show
  // cost + token usage instead of an empty "no windows" message.
  const isCostBased = windows.length === 0 && (hasCost || hasTokens || creditLabel)
  const note = engine.error || (engine.stale ? "Snapshot is over 30 minutes old — may be out of date." : null)

  return (
    <section className="rounded-[var(--radius-lg)] bg-[var(--bg-secondary)] border border-[var(--separator)] p-[var(--space-6)]">
      <div className="flex items-center justify-between gap-[var(--space-3)]">
        <div className="flex items-center gap-[var(--space-3)] min-w-0">
          <h2 className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)] capitalize truncate">
            {engineLabel(engine.name)}
          </h2>
          {engine.accountPlan && (
            <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] truncate">
              {engine.accountPlan}
            </span>
          )}
        </div>
        <span className="flex items-center gap-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-secondary)] whitespace-nowrap">
          <span className="w-2 h-2 rounded-full" style={{ background: tone.color }} />
          {tone.label}
        </span>
      </div>

      {windows.length > 0 ? (
        <div className="mt-[var(--space-6)] grid gap-[var(--space-5)]">
          {windows.map((window) => (
            <WindowBar key={`${engine.name}-${window.name}`} window={window} />
          ))}
        </div>
      ) : isCostBased ? (
        <div className="mt-[var(--space-6)] flex flex-wrap items-baseline gap-x-[var(--space-6)] gap-y-[var(--space-3)]">
          {hasCost && (
            <div>
              <div className="text-[length:var(--text-footnote)] text-[var(--text-secondary)]">API cost</div>
              <div className="text-[length:var(--text-title3)] font-[var(--weight-bold)] text-[var(--text-primary)] tabular-nums">
                ${engine.costUsd!.toFixed(engine.costUsd! < 1 ? 4 : 2)}
              </div>
            </div>
          )}
          {creditLabel && (
            <div>
              <div className="text-[length:var(--text-footnote)] text-[var(--text-secondary)]">Balance</div>
              <div className="text-[length:var(--text-title3)] font-[var(--weight-bold)] text-[var(--text-primary)] tabular-nums">
                {credits?.balance}
              </div>
            </div>
          )}
          {hasTokens && (
            <div>
              <div className="text-[length:var(--text-footnote)] text-[var(--text-secondary)]">Tokens (in / out)</div>
              <div className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)] tabular-nums">
                {inTok ?? "—"} / {outTok ?? "—"}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="mt-[var(--space-6)] text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
          No quota windows observed yet.
        </div>
      )}

      {creditLabel && !isCostBased && (
        <div className="mt-[var(--space-5)] text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
          {creditLabel}
        </div>
      )}

      {note && (
        <div className="mt-[var(--space-5)] flex items-start gap-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
          <AlertTriangle size={14} className="mt-[2px] flex-shrink-0" style={{ color: tone.color }} />
          <span>{note}</span>
        </div>
      )}
    </section>
  )
}

function CliDetectedCard({ engines }: { engines: EngineLimitEngineSnapshot[] }) {
  if (engines.length === 0) return null
  return (
    <section className="rounded-[var(--radius-lg)] bg-[var(--bg-secondary)] border border-[var(--separator)] p-[var(--space-6)]">
      <div className="mb-[var(--space-4)]">
        <h2 className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
          CLI detected, no usage statistics
        </h2>
        <p className="mt-[var(--space-1)] text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
          These agents are installed, but Cuttlefish does not have an authoritative usage source for them yet.
        </p>
      </div>
      <div className="grid gap-[var(--space-3)]">
        {engines.map((engine) => (
          <div key={engine.name} className="flex items-start justify-between gap-[var(--space-4)] border-t border-[var(--separator)] pt-[var(--space-3)] first:border-t-0 first:pt-0">
            <div className="min-w-0">
              <div className="text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
                {engineLabel(engine.name)}
              </div>
              {engine.defaultModel && (
                <div className="mt-[2px] text-[length:var(--text-caption1)] text-[var(--text-secondary)] truncate">
                  Default model: <span className="font-[var(--weight-medium)] text-[var(--text-primary)]">{engine.defaultModel}</span>
                </div>
              )}
              <div className="mt-[2px] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                {engine.unsupportedReason || "Usage statistics are not available for this CLI."}
              </div>
            </div>
            <span className="shrink-0 text-[length:var(--text-caption1)] text-[var(--system-green)]">
              CLI detected
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

function SupportedAgentsCard({ engines }: { engines: EngineLimitEngineSnapshot[] }) {
  if (engines.length === 0) return null
  return (
    <section className="rounded-[var(--radius-lg)] bg-[var(--bg-secondary)] border border-[var(--separator)] p-[var(--space-6)]">
      <div className="mb-[var(--space-4)]">
        <h2 className="text-[length:var(--text-body)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
          Supported agents
        </h2>
        <p className="mt-[var(--space-1)] text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
          Cuttlefish can route to these agents when the matching CLI is installed and configured.
        </p>
      </div>
      <div className="grid gap-[var(--space-3)]">
        {engines.map((engine) => {
          const tone = freshness(engine)
          return (
            <div key={engine.name} className="flex items-center justify-between gap-[var(--space-4)] border-t border-[var(--separator)] pt-[var(--space-3)] first:border-t-0 first:pt-0">
              <div className="min-w-0">
                <div className="text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
                  {engineLabel(engine.name)}
                </div>
                <div className="mt-[2px] truncate text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                  {engine.available
                    ? engine.defaultModel || engine.source
                    : engine.unsupportedReason || "Agent not available. Install the CLI to enable it."}
                </div>
              </div>
              <span className="flex shrink-0 items-center gap-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
                <span className="h-2 w-2 rounded-full" style={{ background: tone.color }} />
                {engine.available ? "Available" : "Agent not available"}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

export default function LimitsPage() {
  useBreadcrumbs([{ label: 'Limits' }])
  const [data, setData] = useState<EngineLimitsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    setRefreshing(true)
    setError(null)
    api
      .refreshEngineLimits()
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load engine limits"))
      .finally(() => {
        setLoading(false)
        setRefreshing(false)
      })
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Auto-update while the page is open: usage snapshots advance every session, so
  // a fetch-once-on-mount view goes stale immediately. Poll quietly (GET, no
  // spinner) every 30s so the numbers track live without a manual reload.
  // Paused while the tab is hidden; returning re-runs the effect, which also
  // serves as the catch-up fetch and re-renders the relative-time labels.
  const pageVisible = usePageVisibility()
  const [, setNowTick] = useState(0)
  useEffect(() => {
    if (!pageVisible) return
    const poll = () => {
      api
        .getEngineLimits()
        .then(setData)
        .catch(() => {
          /* transient poll failure — keep the last good snapshot, no error toast */
        })
    }
    poll()
    const id = window.setInterval(() => {
      poll()
      // Same cadence keeps relative "Updated Xm ago" / "Stale" labels ticking
      // (the label is derived from refreshedAt, not React state).
      setNowTick((n) => n + 1)
    }, 30_000)
    return () => window.clearInterval(id)
  }, [pageVisible])

  const allEngines = useMemo(
    () => sortEngines(Object.values(data?.engines ?? {})),
    [data],
  )
  const usageEngines = useMemo(
    () => allEngines.filter((engine) => engine.available && hasObservedUsage(engine)),
    [allEngines],
  )
  const detectedNoStats = useMemo(
    () => allEngines.filter((engine) => engine.available && !hasObservedUsage(engine)),
    [allEngines],
  )

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
              Limits
            </h1>
            <ToolbarActions>
              <button
                onClick={refresh}
                className="focus-ring w-8 h-8 flex items-center justify-center rounded-[var(--radius-sm)] border-none bg-transparent text-[var(--text-tertiary)] cursor-pointer transition-colors duration-150 ease-[var(--ease-smooth)]"
                aria-label="Refresh engine limits"
              >
                <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} />
              </button>
            </ToolbarActions>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-[var(--space-6)] pt-[var(--space-5)] pb-[var(--space-8)]">
          <div className="mx-auto grid max-w-[760px] gap-[var(--space-4)]">
            {error && (
              <ErrorState className="mb-[var(--space-5)]" message={error} onRetry={refresh} />
            )}

            {loading ? (
              <div className="grid gap-[var(--space-4)]">
                <Skeleton height={180} className="rounded-[var(--radius-lg)]" />
                <Skeleton height={180} className="rounded-[var(--radius-lg)]" />
              </div>
            ) : allEngines.length === 0 ? (
              <EmptyState
                icon={Gauge}
                title="No engine data yet"
                description="Cuttlefish hasn't collected usage snapshots yet. Try refreshing, or run a session to populate limits."
              />
            ) : (
              <>
                {usageEngines.map((engine) => (
                  <EngineCard key={engine.name} engine={engine} />
                ))}
                <CliDetectedCard engines={detectedNoStats} />
                <SupportedAgentsCard engines={allEngines} />
              </>
            )}
          </div>
        </div>
      </div>
    </PageLayout>
  )
}
