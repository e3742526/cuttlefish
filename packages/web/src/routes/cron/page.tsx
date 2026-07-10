
import { useCallback, useEffect, useMemo, useState } from "react"
import { api, type Employee } from "@/lib/api"
import { useGateway } from "@/hooks/use-gateway"
import { usePageVisibility } from "@/hooks/use-page-visibility"
import { describeCron, formatDuration } from "@/lib/cron-utils"
import { PageLayout, ToolbarActions } from "@/components/page-layout"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Skeleton } from "@/components/ui/skeleton"
import { WeeklySchedule } from "@/components/crons/weekly-schedule"
import { PipelineGraph } from "@/components/crons/pipeline-graph"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { StalePill } from "@/components/ui/stale-pill"
import { Clock } from "lucide-react"

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface CronJob {
  id: string
  name: string
  schedule: string
  enabled: boolean
  scheduleValid?: boolean
  scheduleError?: string | null
  timezone?: string
  engine?: string
  model?: string
  employee?: string
  prompt?: string
  delivery?: unknown
  [key: string]: unknown
}

interface CronRun {
  id?: string
  timestamp?: string
  ts?: string
  startedAt?: string
  finishedAt?: string
  status?: string
  durationMs?: number
  error?: string
  [key: string]: unknown
}

type Filter = "all" | "enabled" | "disabled"
type TriggerTone = "running" | "success" | "error"
interface TriggerState { label: string; tone: TriggerTone; error?: string }

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function titleCase(slug: string): string {
  return slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
}

function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return "never"
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return "\u2014"
  const diff = Date.now() - d.getTime()
  const mins = Math.floor(diff / 60000)
  const hrs = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  if (hrs < 24) return `${hrs}h ago`
  return `${days}d ago`
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* ------------------------------------------------------------------ */
/*  RecentRuns (lazy-loaded per job)                                    */
/* ------------------------------------------------------------------ */

function RecentRuns({ jobId, refreshKey }: { jobId: string; refreshKey: number }) {
  const [runs, setRuns] = useState<CronRun[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api
      .getCronRuns(jobId)
      .then((data) => {
        setRuns((data as CronRun[]).slice(0, 5))
        setLoading(false)
      })
      .catch(() => {
        setRuns([])
        setLoading(false)
      })
  }, [jobId, refreshKey])

  if (loading) {
    return (
      <div className="mt-[var(--space-3)]">
        <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] font-semibold mb-[var(--space-2)]">
          Recent Runs
        </div>
        {[1, 2, 3].map(i => (
          <Skeleton key={i} className="h-4 mb-1 w-4/5" />
        ))}
      </div>
    )
  }

  if (!runs || runs.length === 0) {
    return (
      <div className="mt-[var(--space-3)]">
        <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] font-semibold mb-[var(--space-2)]">
          Recent Runs
        </div>
        <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">No run history</div>
      </div>
    )
  }

  return (
    <div className="mt-[var(--space-3)]">
      <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] font-semibold mb-[var(--space-2)]">
        Recent Runs
      </div>
      <div className="flex flex-col gap-1">
        {runs.map((run, i) => {
          const ts = run.timestamp || run.ts || run.startedAt || ""
          const status = run.status || "unknown"
          const statusDot =
            status === "success" || status === "ok" ? "var(--system-green)"
            : status === "error" || status === "failed" ? "var(--system-red)"
            : "var(--text-tertiary)"
          const ago = timeAgo(ts)
          const duration = run.durationMs != null ? formatDuration(run.durationMs) : "\u2014"

          return (
            <div
              key={`${ts}-${i}`}
              className="flex items-center gap-[var(--space-2)] text-[length:var(--text-caption2)] min-h-[22px] py-0.5"
            >
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: statusDot }} />
              <span className="text-[var(--text-tertiary)] min-w-[52px] shrink-0">{ago}</span>
              <span className="text-[var(--text-secondary)] min-w-[52px] shrink-0">{duration}</span>
              <span className="text-[var(--text-secondary)] capitalize">{status}</span>
              {run.error && (
                <span className="truncate text-[var(--system-red)] min-w-0 flex-1">
                  {run.error}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function CronPage() {
  useBreadcrumbs([{ label: 'Cron' }])
  const { subscribe } = useGateway()
  const pageVisible = usePageVisibility()
  const [jobs, setJobs] = useState<CronJob[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>("all")
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [updatedAgo, setUpdatedAgo] = useState("just now")
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())
  const [triggering, setTriggering] = useState<Record<string, TriggerState>>({})
  const [employeeMap, setEmployeeMap] = useState<Map<string, Employee>>(new Map())

  // Fetch employee display names
  useEffect(() => {
    api.getOrg().then((org) => {
      const map = new Map<string, Employee>()
      for (const emp of org.employees) {
        map.set(emp.name, emp)
      }
      setEmployeeMap(map)
    }).catch(() => {})
  }, [])

  const refresh = useCallback(() => {
    setError(null)
    api
      .getCronJobs()
      .then((data) => {
        setJobs(data as CronJob[])
        setLastRefresh(new Date())
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unknown error"))
      .finally(() => setLoading(false))
  }, [])

  // Cron runs push completion events over the gateway websocket — refresh on
  // those instead of fast-polling. The interval is a slow safety net and both
  // it and the initial refresh pause while the tab is hidden (the effect
  // re-runs on return, refreshing immediately).
  useEffect(() => {
    if (!pageVisible) return
    refresh()
    const unsubscribe = subscribe((event) => {
      if (event === 'cron:completed' || event === 'cron:error') refresh()
    })
    const interval = setInterval(refresh, 5 * 60000)
    return () => {
      unsubscribe()
      clearInterval(interval)
    }
  }, [refresh, subscribe, pageVisible])

  // "Updated X ago" ticker (paused while hidden; re-runs on return)
  useEffect(() => {
    if (!pageVisible) return
    const tick = () => setUpdatedAgo(timeAgo(lastRefresh.toISOString()))
    tick()
    const interval = setInterval(tick, 30000)
    return () => clearInterval(interval)
  }, [lastRefresh, pageVisible])

  // Toggle enabled via PUT
  function toggleEnabled(job: CronJob) {
    const newEnabled = !job.enabled
    api
      .updateCronJob(job.id, { enabled: newEnabled })
      .then(() => {
        setJobs((prev) =>
          prev.map((j) => (j.id === job.id ? { ...j, enabled: newEnabled } : j))
        )
      })
      .catch(() => {})
  }

  const runNow = useCallback(async (job: CronJob) => {
    setTriggering((prev) => ({ ...prev, [job.id]: { label: "Starting", tone: "running" } }))
    try {
      const started = await api.triggerCronJob(job.id) as { runId?: string; status?: string }
      const runId = started.runId
      if (!runId) {
        setTriggering((prev) => ({ ...prev, [job.id]: { label: "Started", tone: "running" } }))
        refresh()
        return
      }
      setTriggering((prev) => ({ ...prev, [job.id]: { label: "Running", tone: "running" } }))
      for (let attempt = 0; attempt < 120; attempt++) {
        await wait(1000)
        const runs = await api.getCronRuns(job.id, runId) as CronRun[]
        const current = runs[0]
        if (!current) continue
        if (current.status === "success") {
          setTriggering((prev) => ({ ...prev, [job.id]: { label: "Succeeded", tone: "success" } }))
          refresh()
          setTimeout(() => setTriggering((prev) => {
            const next = { ...prev }
            delete next[job.id]
            return next
          }), 2500)
          return
        }
        if (current.status === "error" || current.status === "skipped_overlap") {
          setTriggering((prev) => ({
            ...prev,
            [job.id]: { label: current.status === "skipped_overlap" ? "Already running" : "Failed", tone: "error", error: current.error },
          }))
          refresh()
          return
        }
      }
      setTriggering((prev) => ({ ...prev, [job.id]: { label: "Still running", tone: "running" } }))
      refresh()
    } catch (err) {
      setTriggering((prev) => ({
        ...prev,
        [job.id]: { label: "Failed", tone: "error", error: err instanceof Error ? err.message : "Trigger failed" },
      }))
    }
  }, [refresh])

  // Derived data
  const enabledCount = jobs.filter(j => j.enabled).length
  const disabledCount = jobs.filter(j => !j.enabled).length
  const brokenCount = jobs.filter(j => j.scheduleValid === false).length
  const filtered = jobs.filter(j => {
    if (filter === "enabled") return j.enabled
    if (filter === "disabled") return !j.enabled
    return true
  })

  // Group filtered jobs by employee
  const groupedByEmployee = useMemo(() => {
    const groups = new Map<string, CronJob[]>()
    for (const job of filtered) {
      const key = job.employee || "_unassigned"
      const list = groups.get(key) || []
      list.push(job)
      groups.set(key, list)
    }
    return groups
  }, [filtered])

  return (
    <PageLayout>
      <div className="h-full flex flex-col overflow-hidden bg-[var(--bg)]">
        {/* Header */}
        <header
          className="flex-shrink-0 bg-[var(--material-regular)] border-b border-[var(--separator)] px-[var(--space-6)] py-[var(--space-4)]"
        >
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-[length:var(--text-title1)] font-bold text-[var(--text-primary)] tracking-tight leading-[1.2]">
                Cron Jobs
              </h1>
              {!loading && (
                <p className="text-[length:var(--text-footnote)] text-[var(--text-secondary)] mt-[var(--space-1)]">
                  {jobs.length} total &middot; {enabledCount} enabled &middot; {disabledCount} disabled &middot; {brokenCount} broken
                </p>
              )}
            </div>
            <ToolbarActions>
              <div className="flex items-center gap-[var(--space-3)]">
                <StalePill />
                <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                  Updated {updatedAgo}
                </span>
                <button
                  onClick={refresh}
                  aria-label="Refresh cron data"
                  className="w-8 h-8 flex items-center justify-center rounded-[var(--radius-sm)] border-none bg-transparent text-[var(--text-tertiary)] cursor-pointer"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                    <path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                  </svg>
                </button>
              </div>
            </ToolbarActions>
          </div>
        </header>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-[var(--space-6)] pt-[var(--space-4)] pb-[var(--space-6)]">
          {error && jobs.length === 0 ? (
            <ErrorState
              className="mb-[var(--space-4)]"
              message={`Failed to load cron jobs: ${error}`}
              onRetry={refresh}
            />
          ) : loading ? (
            <div>
              <div className="grid grid-cols-4 gap-[var(--space-3)] mb-[var(--space-4)]">
                {[1, 2, 3, 4].map(i => (
                  <div key={i} className="bg-[var(--material-regular)] border border-[var(--separator)] rounded-[var(--radius-md)] p-[var(--space-4)]">
                    <Skeleton className="w-[60px] h-2.5 mb-2" />
                    <Skeleton className="w-20 h-3.5" />
                  </div>
                ))}
              </div>
              {[1, 2, 3, 4].map(i => (
                <Skeleton key={i} className="h-12 mb-1 rounded-[var(--radius-sm)]" />
              ))}
            </div>
          ) : (
            <Tabs defaultValue="overview">
              <TabsList variant="line">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="schedule">Schedule</TabsTrigger>
                <TabsTrigger value="pipelines">Pipelines</TabsTrigger>
              </TabsList>

              {/* ─── OVERVIEW TAB ────────────────────────────── */}
              <TabsContent value="overview">
                {/* Summary cards */}
                <div className="grid grid-cols-4 gap-[var(--space-3)] mb-[var(--space-4)] mt-[var(--space-4)]">
                  <SummaryCard label="Total Jobs" value={jobs.length} />
                  <SummaryCard label="Enabled" value={enabledCount} color="var(--system-green)" />
                  <SummaryCard label="Disabled" value={disabledCount} color="var(--text-tertiary)" />
                  <SummaryCard label="Broken" value={brokenCount} color="var(--system-red)" />
                </div>

                {/* Filter pills */}
                <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-3)]">
                  {(["all", "enabled", "disabled"] as Filter[]).map(f => {
                    const isActive = filter === f
                    const count = f === "all" ? jobs.length : f === "enabled" ? enabledCount : disabledCount
                    return (
                      <button
                        key={f}
                        onClick={() => setFilter(f)}
                        className="rounded-[20px] px-3.5 py-1.5 text-[length:var(--text-footnote)] font-medium border-none cursor-pointer transition-all duration-200 ease-in-out"
                        style={{
                          background: isActive ? "var(--accent-fill)" : "var(--fill-secondary)",
                          color: isActive ? "var(--accent)" : "var(--text-primary)",
                        }}
                      >
                        {f.charAt(0).toUpperCase() + f.slice(1)} ({count})
                      </button>
                    )
                  })}
                </div>

                {/* Job list grouped by employee */}
                {filtered.length === 0 ? (
                  <EmptyState
                    className="h-[200px]"
                    icon={Clock}
                    title={jobs.length === 0 ? "No cron jobs configured" : "No jobs match this filter"}
                    description={
                      jobs.length === 0
                        ? "Schedule a job to have an employee run on a recurring timer."
                        : undefined
                    }
                  />
                ) : (
                  <div className="flex flex-col gap-[var(--space-3)]">
                    {Array.from(groupedByEmployee.entries()).map(([empKey, empJobs]) => {
                      const empData = empKey !== "_unassigned" ? employeeMap.get(empKey) : null
                      const displayName = empData?.displayName || (empKey === "_unassigned" ? "Unassigned" : titleCase(empKey))

                      return (
                        <div key={empKey}>
                          {/* Group header */}
                          <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-2)]">
                            {empKey !== "_unassigned" && <EmployeeAvatar name={empKey} size={20} />}
                            <span className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-secondary)]">
                              {displayName}
                            </span>
                            <span className="text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">
                              {empJobs.length} job{empJobs.length !== 1 ? "s" : ""}
                            </span>
                          </div>

                          {/* Jobs in group */}
                          <div className="rounded-[var(--radius-md)] overflow-hidden bg-[var(--material-regular)] border border-[var(--separator)]">
                            {empJobs.map((job, idx) => {
                              const isExpanded = expandedId === job.id
                              const triggerState = triggering[job.id]
                              const isBroken = job.scheduleValid === false

                              return (
                                <div key={job.id}>
                                  {idx > 0 && (
                                    <div className="h-px bg-[var(--separator)] mx-[var(--space-4)]" />
                                  )}

                                  {/* Row */}
                                  <div
                                    role="button"
                                    tabIndex={0}
                                    aria-expanded={isExpanded}
                                    onClick={() => setExpandedId(isExpanded ? null : job.id)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter" || e.key === " ") {
                                        e.preventDefault()
                                        setExpandedId(isExpanded ? null : job.id)
                                      }
                                    }}
                                    className="flex items-center cursor-pointer min-h-[48px] px-[var(--space-4)] transition-[background] duration-150 ease-in-out"
                                    style={{
                                      borderLeft: `3px solid ${isBroken ? "var(--system-red)" : job.enabled ? "var(--system-green)" : "transparent"}`,
                                    }}
                                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--fill-secondary)" }}
                                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "" }}
                                  >
                                    {/* Status dot */}
                                    <span
                                      className="w-2 h-2 rounded-full shrink-0"
                                      style={{
                                        background: isBroken ? "var(--system-red)" : job.enabled ? "var(--system-green)" : "var(--text-tertiary)",
                                      }}
                                    />

                                    {/* Name + schedule */}
                                    <div className="min-w-0 flex-1 ml-3 flex flex-col">
                                      <span className="truncate text-[length:var(--text-footnote)] font-semibold text-[var(--text-primary)]">
                                        {job.name}
                                      </span>
                                      <span
                                        className="text-[length:var(--text-caption1)]"
                                        style={{ color: isBroken ? "var(--system-red)" : "var(--text-tertiary)" }}
                                      >
                                        {isBroken ? (job.scheduleError || "Broken schedule") : describeCron(job.schedule)}
                                      </span>
                                    </div>

                                    {/* Metadata badges */}
                                    <div className="flex items-center shrink-0 gap-[var(--space-2)] ml-auto">
                                      {job.engine && (
                                        <span className="text-[length:var(--text-caption1)] px-2 py-px rounded-xl bg-[var(--fill-tertiary)] text-[var(--text-tertiary)]">
                                          {job.engine}
                                        </span>
                                      )}

                                      {/* Enable/disable toggle */}
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          toggleEnabled(job)
                                        }}
                                        aria-label={job.enabled ? "Disable job" : "Enable job"}
                                        className="relative inline-flex items-center w-9 h-5 rounded-[10px] border-none cursor-pointer shrink-0 transition-[background] duration-200 ease-in-out"
                                        style={{
                                          background: job.enabled ? "var(--system-green)" : "var(--fill-tertiary)",
                                        }}
                                      >
                                        <span
                                          className="block w-3.5 h-3.5 rounded-full transition-transform duration-200 ease-in-out"
                                          style={{
                                            background: "var(--bg-secondary)",
                                            boxShadow: "var(--shadow-subtle)",
                                            transform: job.enabled ? "translateX(18px)" : "translateX(3px)",
                                          }}
                                        />
                                      </button>

                                      {/* Chevron */}
                                      <span
                                        className="text-[length:var(--text-footnote)] text-[var(--text-tertiary)] transition-transform duration-200 ease-in-out inline-block"
                                        style={{
                                          transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)",
                                        }}
                                      >
                                        &#8250;
                                      </span>
                                    </div>
                                  </div>

                                  {/* Expanded detail */}
                                  {isExpanded && (
                                    <div className="px-[var(--space-4)] pb-[var(--space-4)] ml-[3px]">
                                      <div className="grid grid-cols-[auto_1fr] gap-x-[var(--space-4)] gap-y-[var(--space-1)] mt-[var(--space-2)] mb-[var(--space-3)]">
                                        <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">Schedule</span>
                                        <div>
                                          <div className="text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
                                            {describeCron(job.schedule)}
                                          </div>
                                          <div className="text-[length:var(--text-caption2)] font-[family-name:var(--font-mono)] text-[var(--text-tertiary)] mt-0.5">
                                            {job.schedule}
                                            {job.timezone && <span className="ml-2">({job.timezone})</span>}
                                          </div>
                                        </div>

                                        <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">Status</span>
                                        <span
                                          className="text-[length:var(--text-caption1)] font-medium"
                                          style={{
                                            color: isBroken ? "var(--system-red)" : job.enabled ? "var(--system-green)" : "var(--text-tertiary)",
                                          }}
                                        >
                                          {isBroken ? "Broken schedule" : job.enabled ? "Enabled" : "Disabled"}
                                        </span>

                                        {isBroken && job.scheduleError && (
                                          <>
                                            <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">Error</span>
                                            <span className="text-[length:var(--text-caption1)] text-[var(--system-red)]">{job.scheduleError}</span>
                                          </>
                                        )}

                                        {job.engine && (
                                          <>
                                            <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">Engine</span>
                                            <span className="text-[length:var(--text-caption1)] text-[var(--text-secondary)]">{job.engine}</span>
                                          </>
                                        )}

                                        {job.model && (
                                          <>
                                            <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">Model</span>
                                            <span className="text-[length:var(--text-caption1)] text-[var(--text-secondary)] font-[family-name:var(--font-mono)]">{job.model}</span>
                                          </>
                                        )}
                                      </div>

                                      {/* Trigger button */}
                                      <div className="mb-[var(--space-3)]">
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation()
                                            void runNow(job)
                                          }}
                                          disabled={Boolean(triggerState) || !job.enabled}
                                          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--separator)] text-[length:var(--text-caption1)] font-semibold transition-all duration-200 ease-in-out"
                                          style={{
                                            background: triggerState ? "var(--fill-tertiary)" : "var(--material-regular)",
                                            color: triggerState?.tone === "success"
                                              ? "var(--system-green)"
                                              : triggerState?.tone === "error"
                                                ? "var(--system-red)"
                                                : triggerState
                                                  ? "var(--text-secondary)"
                                                  : "var(--text-secondary)",
                                            cursor: triggerState || !job.enabled ? "default" : "pointer",
                                          }}
                                        >
                                          {triggerState ? (
                                            <>
                                              <span className="text-sm">{triggerState.tone === "success" ? "✓" : triggerState.tone === "error" ? "!" : "…"}</span>
                                              {triggerState.label}
                                            </>
                                          ) : !job.enabled ? (
                                            <>Disabled</>
                                          ) : (
                                            <>
                                              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                                                <polygon points="5,3 19,12 5,21" />
                                              </svg>
                                              Run Now
                                            </>
                                          )}
                                        </button>
                                        {triggerState?.error && (
                                          <div className="mt-2 text-[length:var(--text-caption2)] text-[var(--system-red)]">
                                            {triggerState.error}
                                          </div>
                                        )}
                                      </div>

                                      {/* Run history */}
                                      <RecentRuns jobId={job.id} refreshKey={lastRefresh.getTime()} />
                                    </div>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </TabsContent>

              {/* ─── SCHEDULE TAB ─────────────────────────────── */}
              <TabsContent value="schedule">
                <div className="mt-[var(--space-4)]">
                  <WeeklySchedule crons={jobs} />
                </div>
              </TabsContent>

              {/* ─── PIPELINES TAB ────────────────────────────── */}
              <TabsContent value="pipelines">
                <div className="mt-[var(--space-4)]">
                  <PipelineGraph crons={jobs} />
                </div>
              </TabsContent>
            </Tabs>
          )}
        </div>
      </div>
    </PageLayout>
  )
}

/* ------------------------------------------------------------------ */
/*  Summary Card                                                       */
/* ------------------------------------------------------------------ */

function SummaryCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="bg-[var(--material-regular)] border border-[var(--separator)] rounded-[var(--radius-md)] p-[var(--space-4)]">
      <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] font-medium mb-[var(--space-1)]">
        {label}
      </div>
      <div
        className="text-[length:var(--text-title2)] font-bold"
        style={{ color: color || "var(--text-primary)" }}
      >
        {value}
      </div>
    </div>
  )
}
