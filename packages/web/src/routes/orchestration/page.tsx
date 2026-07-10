import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react"
import { AlertTriangle, CheckCircle2, GitBranch, Network, Pause, Play, RefreshCw, RotateCcw, Square } from "lucide-react"
import { PageLayout, ToolbarActions } from "@/components/page-layout"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { EmptyState } from "@/components/ui/empty-state"
import { ErrorState } from "@/components/ui/error-state"
import { Skeleton } from "@/components/ui/skeleton"
import { useBreadcrumbs } from "@/context/breadcrumb-context"
import {
  applyDualLaneWinner,
  cancelHold,
  createHold,
  extendHold,
  loadOrchestrationDashboard,
  pauseOrchestrationQueue,
  pauseQueuedTask,
  requeueRecoveredTask,
  retryContinuation,
  resumeOrchestrationQueue,
  resumeQueuedTask,
  selectDualLaneWinner,
  stopOrchestrationLease,
  viewArtifact,
  type ContinuationSummary,
  type DualLaneSummary,
  type OrchestrationDashboardData,
} from "@/lib/orchestration-api"

const TABS = ["Overview", "Workers", "Queue", "Holds", "Continuations", "Dual-lane", "Recovery", "Worktrees", "Telemetry"] as const

export default function OrchestrationPage() {
  useBreadcrumbs([{ label: "Orchestration" }])
  const [data, setData] = useState<OrchestrationDashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionKey, setActionKey] = useState<string | null>(null)
  const [artifactText, setArtifactText] = useState<string | null>(null)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      setData(await loadOrchestrationDashboard())
      setLastRefresh(new Date())
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load orchestration state")
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const failedContinuations = useMemo(
    () => data?.continuations.filter((entry) => entry.state === "failed") ?? [],
    [data],
  )
  const selectableRuns = useMemo(
    () => data?.dualLane.filter((entry) => entry.state === "selection_required") ?? [],
    [data],
  )
  const canControlQueue = Boolean(data?.status.enabled && data.status.runtimeBound)
  const queueActionKey = data?.status.queuePaused ? "queue:resume" : "queue:pause"

  async function runAction(key: string, action: () => Promise<unknown>) {
    setActionKey(key)
    setActionError(null)
    try {
      await action()
      await refresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed")
    } finally {
      setActionKey(null)
    }
  }

  return (
    <PageLayout>
      <div className="h-full flex flex-col overflow-hidden bg-[var(--bg)]">
        <header className="sticky top-0 z-10 flex-shrink-0 bg-[var(--material-regular)] border-b border-[var(--separator)]">
          <div className="flex items-center justify-between gap-[var(--space-4)] px-[var(--space-6)] py-[var(--space-4)]">
            <div className="min-w-0">
              <h1 className="text-[length:var(--text-title1)] font-[var(--weight-bold)] text-[var(--text-primary)] leading-[var(--leading-tight)]">
                Orchestration
              </h1>
              <p className="text-[length:var(--text-footnote)] text-[var(--text-secondary)] mt-[var(--space-1)]">
                {statusText(data)}
              </p>
            </div>
            <ToolbarActions>
              <div className="flex items-center gap-[var(--space-3)]">
                {lastRefresh && (
                  <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                    Updated {lastRefresh.toLocaleTimeString()}
                  </span>
                )}
                {data && (
                  <QueueControlButton
                    data={data}
                    disabled={!canControlQueue || actionKey === queueActionKey}
                    onClick={() => runAction(
                      queueActionKey,
                      () => data.status.queuePaused ? resumeOrchestrationQueue() : pauseOrchestrationQueue("Paused from dashboard"),
                    )}
                  />
                )}
                <button
                  onClick={() => void refresh()}
                  className="focus-ring w-8 h-8 flex items-center justify-center rounded-[var(--radius-sm)] border border-[var(--separator)] bg-[var(--material-thin)] text-[var(--text-secondary)]"
                  aria-label="Refresh orchestration"
                >
                  <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} />
                </button>
              </div>
            </ToolbarActions>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-[var(--space-6)] py-[var(--space-4)] min-h-0">
          {(error || actionError) && (
            <ErrorState className="mb-[var(--space-3)]" message={error ?? actionError ?? ""} onRetry={() => void refresh()} />
          )}
          {data && (
            <div className="mb-[var(--space-3)] lg:hidden">
              <QueueControlButton
                data={data}
                disabled={!canControlQueue || actionKey === queueActionKey}
                fullWidth
                onClick={() => runAction(
                  queueActionKey,
                  () => data.status.queuePaused ? resumeOrchestrationQueue() : pauseOrchestrationQueue("Paused from dashboard"),
                )}
              />
            </div>
          )}
          {loading ? (
            <OrchestrationLoadingSkeleton />
          ) : !data ? (
            <EmptyState
              icon={Network}
              title="No orchestration state available."
              description="Try refreshing, or check the gateway's orchestration configuration."
            />
          ) : (
            <Tabs defaultValue="Overview" className="gap-[var(--space-4)]">
              <TabsList className="flex flex-wrap h-auto justify-start bg-[var(--material-regular)] border border-[var(--separator)]">
                {TABS.map((tab) => (
                  <TabsTrigger key={tab} value={tab} className="min-h-8">
                    {tab}
                  </TabsTrigger>
                ))}
              </TabsList>

              <TabsContent value="Overview">
                <Overview
                  data={data}
                  failedContinuations={failedContinuations.length}
                  selectableRuns={selectableRuns.length}
                  actionKey={actionKey}
                  onStopLease={(leaseId) => runAction(`stop:${leaseId}`, () => stopOrchestrationLease(leaseId, "Stopped from dashboard"))}
                />
              </TabsContent>
              <TabsContent value="Workers">
                <Section title="Workers" count={data.workers.length}>
                  <Table
                    columns={["Worker", "Provider", "Family", "Tier", "Cost", "Workspace", "Capabilities"]}
                    rows={data.workers.map((worker) => [
                      worker.id,
                      worker.provider,
                      worker.family,
                      worker.tier,
                      worker.costClass,
                      worker.workspacePolicy,
                      worker.capabilities.join(", "),
                    ])}
                  />
                </Section>
              </TabsContent>
              <TabsContent value="Queue">
                <Section title="Queue" count={data.queue.length}>
                  <QueueList
                    queue={data.queue}
                    pauses={data.taskPauses}
                    actionKey={actionKey}
                    onPause={(item) => runAction(`pause-task:${item.taskId}:${item.coordinatorId}`, () => pauseQueuedTask(item.taskId, item.coordinatorId))}
                    onResume={(item) => runAction(`resume-task:${item.taskId}:${item.coordinatorId}`, () => resumeQueuedTask(item.taskId, item.coordinatorId))}
                  />
                </Section>
              </TabsContent>
              <TabsContent value="Holds">
                <Section title="Holds" count={data.holds.length}>
                  <HoldsPanel
                    data={data}
                    actionKey={actionKey}
                    onCreate={(managerName, workerId) => runAction("hold:create", () => createHold({ managerName, workerIds: workerId ? [workerId] : [], roles: [], ttlMs: 60 * 60 * 1000, reason: "Created from dashboard" }))}
                    onExtend={(holdId, managerName) => runAction(`hold:extend:${holdId}`, () => extendHold(holdId, managerName, 60 * 60 * 1000))}
                    onCancel={(holdId, managerName) => runAction(`hold:cancel:${holdId}`, () => cancelHold(holdId, managerName))}
                  />
                </Section>
              </TabsContent>
              <TabsContent value="Continuations">
                <Section title="Continuations" count={data.continuations.length}>
                  <ContinuationList
                    continuations={data.continuations}
                    actionKey={actionKey}
                    onRetry={(entry) => runAction(
                      `retry:${entry.taskId}:${entry.coordinatorId}`,
                      () => retryContinuation(entry.taskId, entry.coordinatorId),
                    )}
                  />
                </Section>
              </TabsContent>
              <TabsContent value="Dual-lane">
                <Section title="Dual-lane selections" count={data.dualLane.length}>
                  <DualLaneList
                    runs={data.dualLane}
                    actionKey={actionKey}
                    onSelect={(run, lane) => runAction(
                      `select:${run.taskId}:${run.coordinatorId}:${lane}`,
                      () => selectDualLaneWinner(run.taskId, run.coordinatorId, lane),
                    )}
                    onApply={(run, lane) => runAction(
                      `apply:${run.taskId}:${run.coordinatorId}:${lane}`,
                      () => applyDualLaneWinner(run.taskId, run.coordinatorId, lane),
                    )}
                    onArtifact={(run, kind) => runAction(
                      `artifact:${run.taskId}:${run.coordinatorId}:${kind}`,
                      async () => {
                        const response = await viewArtifact(run.taskId, run.coordinatorId, kind)
                        setArtifactText(response.artifacts.map((artifact) => {
                          const lane = artifact.record.lane ?? "base"
                          return `# ${response.kind} ${lane}\n${artifact.content}`
                        }).join("\n\n") || "No artifact content.")
                      },
                    )}
                  />
                  {artifactText && (
                    <pre className="mt-[var(--space-3)] max-h-[28rem] overflow-auto border border-[var(--separator)] rounded-[var(--radius-md)] bg-[var(--material-thin)] p-3 text-[length:var(--text-caption1)] whitespace-pre-wrap">
                      {artifactText}
                    </pre>
                  )}
                </Section>
              </TabsContent>
              <TabsContent value="Recovery">
                <Section title="Recovery notices" count={data.status.recoveryNotices?.length ?? 0}>
                  <RecoveryPanel
                    notices={data.status.recoveryNotices ?? []}
                    actionKey={actionKey}
                    onRequeue={(manifestPath, taskId, coordinatorId, managerName) => runAction(
                      `recovery:${taskId}:${coordinatorId}`,
                      () => requeueRecoveredTask(manifestPath, taskId, coordinatorId, managerName),
                    )}
                  />
                </Section>
              </TabsContent>
              <TabsContent value="Worktrees">
                <Section title="Managed worktrees" count={data.worktrees.length}>
                  <Table
                    columns={["Task", "Lane", "Branch", "Path", "Created"]}
                    rows={data.worktrees.map((worktree) => [
                      worktree.taskId,
                      worktree.lane,
                      worktree.branch,
                      worktree.path,
                      formatDate(worktree.createdAt),
                    ])}
                    empty="No managed worktrees."
                  />
                </Section>
              </TabsContent>
              <TabsContent value="Telemetry">
                <Telemetry data={data} />
              </TabsContent>
            </Tabs>
          )}
        </div>
      </div>
    </PageLayout>
  )
}

function Overview({ data, failedContinuations, selectableRuns, actionKey, onStopLease }: {
  data: OrchestrationDashboardData
  failedContinuations: number
  selectableRuns: number
  actionKey: string | null
  onStopLease: (leaseId: string) => void
}) {
  const totalCost = data.telemetry.summary.totals.totalCost
  const runningLeases = data.leases.filter((lease) => lease.state === "running")
  return (
    <div className="grid gap-[var(--space-4)]">
      {data.status.degradedReason && <Banner text={data.status.degradedReason} />}
      {data.status.disabledReason && <Banner text={data.status.disabledReason} />}
      {data.status.queuePaused && (
        <Banner text={`Queue paused${data.status.pauseReason ? `: ${data.status.pauseReason}` : ""}`} />
      )}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-[var(--space-3)]">
        <Metric label="Workers" value={data.workers.length} icon={<Network size={16} />} />
        <Metric label="Running leases" value={data.status.counts.runningLeases} icon={<CheckCircle2 size={16} />} />
        <Metric label="Blocked queue" value={data.queue.length} tone={data.queue.length ? "warn" : undefined} icon={<AlertTriangle size={16} />} />
        <Metric label="Failed continuations" value={failedContinuations} tone={failedContinuations ? "error" : undefined} icon={<RotateCcw size={16} />} />
        <Metric label="Dual-lane choices" value={selectableRuns} tone={selectableRuns ? "warn" : undefined} icon={<GitBranch size={16} />} />
        <Metric label="Worktrees" value={data.worktrees.length} icon={<GitBranch size={16} />} />
        <Metric label="Telemetry runs" value={data.telemetry.summary.totals.count} />
        <Metric label="Recorded cost" value={`$${totalCost.toFixed(3)}`} />
      </div>
      <Section title="Running leases" count={runningLeases.length}>
        <RunningLeaseList leases={runningLeases} actionKey={actionKey} onStopLease={onStopLease} />
      </Section>
    </div>
  )
}

function RunningLeaseList({ leases, actionKey, onStopLease }: {
  leases: OrchestrationDashboardData["leases"]
  actionKey: string | null
  onStopLease: (leaseId: string) => void
}) {
  if (leases.length === 0) return <EmptyState title="No running leases." />
  return (
    <div className="grid gap-[var(--space-2)]">
      {leases.map((lease) => {
        const key = `stop:${lease.leaseId}`
        return (
          <Row key={lease.leaseId}>
            <div className="min-w-0">
              <div className="font-[var(--weight-semibold)] text-[var(--text-primary)] truncate">{lease.taskId}</div>
              <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] truncate">
                {lease.leaseId} - {lease.workerId} - {lease.role} - expires {formatDate(lease.leaseExpiresAt)}
              </div>
            </div>
            <button
              disabled={actionKey === key}
              title="Stop the mapped running session for this lease"
              onClick={() => onStopLease(lease.leaseId)}
              className="focus-ring h-8 px-3 flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--separator)] disabled:opacity-45 text-[length:var(--text-footnote)] shrink-0"
            >
              <Square size={13} />
              Stop lease
            </button>
          </Row>
        )
      })}
    </div>
  )
}

function QueueControlButton({ data, disabled, fullWidth, onClick }: {
  data: OrchestrationDashboardData
  disabled: boolean
  fullWidth?: boolean
  onClick: () => void
}) {
  return (
    <button
      disabled={disabled}
      title={queueControlTitle(data)}
      onClick={onClick}
      className={`focus-ring h-8 px-3 flex items-center justify-center gap-2 rounded-[var(--radius-sm)] border border-[var(--separator)] bg-[var(--material-thin)] text-[length:var(--text-footnote)] text-[var(--text-secondary)] disabled:opacity-45 ${fullWidth ? "w-full" : ""}`}
    >
      {data.status.queuePaused ? <Play size={14} /> : <Pause size={14} />}
      {data.status.queuePaused ? "Resume queue" : "Pause queue"}
    </button>
  )
}

function ContinuationList({ continuations, actionKey, onRetry }: {
  continuations: ContinuationSummary[]
  actionKey: string | null
  onRetry: (entry: ContinuationSummary) => void
}) {
  if (continuations.length === 0) return <EmptyState title="No durable continuations." />
  return (
    <div className="grid gap-[var(--space-2)]">
      {continuations.map((entry) => {
        const key = `retry:${entry.taskId}:${entry.coordinatorId}`
        const canRetry = entry.state === "failed"
        return (
          <Row key={`${entry.taskId}:${entry.coordinatorId}`}>
            <div className="min-w-0">
              <div className="font-[var(--weight-semibold)] text-[var(--text-primary)] truncate">{entry.taskId}</div>
              <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] truncate">
                {entry.coordinatorId} - {entry.mode} - updated {formatDate(entry.updatedAt)}
              </div>
              {entry.lastError && <div className="text-[length:var(--text-caption1)] text-[var(--system-red)] truncate">{entry.lastError}</div>}
            </div>
            <div className="flex items-center gap-[var(--space-2)] shrink-0">
              <Pill text={entry.state} tone={entry.state === "failed" ? "error" : "neutral"} />
              <button
                disabled={!canRetry || actionKey === key}
                title={canRetry ? "Retry failed continuation" : "Only failed continuations can be retried"}
                onClick={() => onRetry(entry)}
                className="focus-ring h-8 px-3 rounded-[var(--radius-sm)] border border-[var(--separator)] disabled:opacity-45 text-[length:var(--text-footnote)]"
              >
                Retry
              </button>
            </div>
          </Row>
        )
      })}
    </div>
  )
}

function QueueList({ queue, pauses, actionKey, onPause, onResume }: {
  queue: OrchestrationDashboardData["queue"]
  pauses: OrchestrationDashboardData["taskPauses"]
  actionKey: string | null
  onPause: (item: OrchestrationDashboardData["queue"][number]) => void
  onResume: (item: OrchestrationDashboardData["queue"][number]) => void
}) {
  if (queue.length === 0) return <EmptyState title="No blocked queue items." />
  const paused = new Set(pauses.map((pause) => `${pause.taskId}:${pause.coordinatorId}`))
  return (
    <div className="grid gap-[var(--space-2)]">
      {queue.map((item) => {
        const key = `${item.taskId}:${item.coordinatorId}`
        const isPaused = paused.has(key)
        return (
          <Row key={key}>
            <div className="min-w-0">
              <div className="font-[var(--weight-semibold)] text-[var(--text-primary)] truncate">{item.taskId}</div>
              <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] truncate">
                {item.coordinatorId} - {item.priority ?? "-"} - {item.missingRoles?.join(", ") || "-"}
              </div>
            </div>
            <div className="flex items-center gap-[var(--space-2)] shrink-0">
              {isPaused && <Pill text="paused" tone="warn" />}
              <button
                disabled={isPaused || actionKey === `pause-task:${key}`}
                title="Pause this queued task"
                onClick={() => onPause(item)}
                className="focus-ring h-8 px-3 rounded-[var(--radius-sm)] border border-[var(--separator)] disabled:opacity-45 text-[length:var(--text-footnote)]"
              >
                Pause
              </button>
              <button
                disabled={!isPaused || actionKey === `resume-task:${key}`}
                title="Resume this queued task"
                onClick={() => onResume(item)}
                className="focus-ring h-8 px-3 rounded-[var(--radius-sm)] border border-[var(--separator)] disabled:opacity-45 text-[length:var(--text-footnote)]"
              >
                Resume
              </button>
            </div>
          </Row>
        )
      })}
    </div>
  )
}

function HoldsPanel({ data, actionKey, onCreate, onExtend, onCancel }: {
  data: OrchestrationDashboardData
  actionKey: string | null
  onCreate: (managerName: string, workerId: string) => void
  onExtend: (holdId: string, managerName: string) => void
  onCancel: (holdId: string, managerName: string) => void
}) {
  function promptCreate() {
    const managerName = window.prompt("Manager name")?.trim()
    if (!managerName) return
    const workerId = window.prompt("Worker id to hold")?.trim() ?? ""
    onCreate(managerName, workerId)
  }
  return (
    <div className="grid gap-[var(--space-3)]">
      <button
        disabled={actionKey === "hold:create"}
        onClick={promptCreate}
        className="focus-ring h-8 px-3 justify-self-start rounded-[var(--radius-sm)] border border-[var(--separator)] disabled:opacity-45 text-[length:var(--text-footnote)]"
      >
        Create hold
      </button>
      {data.holds.length === 0 ? <EmptyState title="No orchestration holds." /> : (
        <div className="grid gap-[var(--space-2)]">
          {data.holds.map((hold) => (
            <Row key={hold.holdId}>
              <div className="min-w-0">
                <div className="font-[var(--weight-semibold)] text-[var(--text-primary)] truncate">{hold.holdId}</div>
                <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] truncate">
                  {hold.managerName} - expires {formatDate(hold.expiresAt)} - {hold.workerIds.join(", ") || hold.roles.join(", ") || "-"}
                </div>
              </div>
              <div className="flex items-center gap-[var(--space-2)] shrink-0">
                <Pill text={hold.state} tone={hold.state === "active" ? "warn" : "neutral"} />
                <button
                  disabled={hold.state !== "active" || actionKey === `hold:extend:${hold.holdId}`}
                  onClick={() => onExtend(hold.holdId, hold.managerName)}
                  className="focus-ring h-8 px-3 rounded-[var(--radius-sm)] border border-[var(--separator)] disabled:opacity-45 text-[length:var(--text-footnote)]"
                >
                  Extend
                </button>
                <button
                  disabled={hold.state !== "active" || actionKey === `hold:cancel:${hold.holdId}`}
                  onClick={() => onCancel(hold.holdId, hold.managerName)}
                  className="focus-ring h-8 px-3 rounded-[var(--radius-sm)] border border-[var(--separator)] disabled:opacity-45 text-[length:var(--text-footnote)]"
                >
                  Cancel
                </button>
              </div>
            </Row>
          ))}
        </div>
      )}
    </div>
  )
}

function DualLaneList({ runs, actionKey, onSelect, onApply, onArtifact }: {
  runs: DualLaneSummary[]
  actionKey: string | null
  onSelect: (run: DualLaneSummary, lane: "openai" | "anthropic") => void
  onApply: (run: DualLaneSummary, lane: "openai" | "anthropic") => void
  onArtifact: (run: DualLaneSummary, kind: "diff" | "prompt" | "output") => void
}) {
  if (runs.length === 0) return <EmptyState title="No dual-lane manifests." />
  return (
    <div className="grid gap-[var(--space-2)]">
      {runs.map((run) => {
        const canSelect = run.state === "selection_required"
        return (
          <Row key={run.taskId}>
            <div className="min-w-0">
              <div className="font-[var(--weight-semibold)] text-[var(--text-primary)] truncate">{run.taskId}</div>
              <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                {run.coordinatorId} - {run.lanes.map((lane) => `${lane.id}:${lane.sessionStatus}`).join(" / ")}
              </div>
              {run.comparisonReport.majorDifferences.length > 0 && (
                <div className="text-[length:var(--text-caption1)] text-[var(--text-secondary)] truncate">
                  {run.comparisonReport.majorDifferences.join("; ")}
                </div>
              )}
            </div>
            <div className="flex items-center gap-[var(--space-2)] shrink-0">
              <Pill text={run.state} tone={canSelect ? "warn" : "neutral"} />
              {run.lanes.map((lane) => (
                <div key={lane.id} className="flex items-center gap-[var(--space-1)]">
                  <button
                    disabled={!canSelect || actionKey === `select:${run.taskId}:${run.coordinatorId}:${lane.id}`}
                    title={canSelect ? `Select ${lane.id} lane` : "Only selection_required manifests can be selected"}
                    onClick={() => onSelect(run, lane.id)}
                    className="focus-ring h-8 px-3 rounded-[var(--radius-sm)] border border-[var(--separator)] disabled:opacity-45 text-[length:var(--text-footnote)]"
                  >
                    Select {lane.id}
                  </button>
                  <button
                    disabled={actionKey === `apply:${run.taskId}:${run.coordinatorId}:${lane.id}`}
                    title={`Apply ${lane.id} winner as unstaged base repo changes`}
                    onClick={() => onApply(run, lane.id)}
                    className="focus-ring h-8 px-3 rounded-[var(--radius-sm)] border border-[var(--separator)] disabled:opacity-45 text-[length:var(--text-footnote)]"
                  >
                    Apply
                  </button>
                </div>
              ))}
              {(["prompt", "output", "diff"] as const).map((kind) => (
                <button
                  key={kind}
                  disabled={actionKey === `artifact:${run.taskId}:${run.coordinatorId}:${kind}`}
                  onClick={() => onArtifact(run, kind)}
                  className="focus-ring h-8 px-3 rounded-[var(--radius-sm)] border border-[var(--separator)] disabled:opacity-45 text-[length:var(--text-footnote)]"
                >
                  {kind}
                </button>
              ))}
            </div>
          </Row>
        )
      })}
    </div>
  )
}

function RecoveryPanel({ notices, actionKey, onRequeue }: {
  notices: NonNullable<OrchestrationDashboardData["status"]["recoveryNotices"]>
  actionKey: string | null
  onRequeue: (manifestPath: string, taskId: string, coordinatorId: string, managerName: string) => void
}) {
  if (notices.length === 0) return <EmptyState title="No recovery notices." />
  return (
    <div className="grid gap-[var(--space-2)]">
      {notices.map((notice) => (
        <Row key={notice.manifestPath}>
          <div className="min-w-0">
            <div className="font-[var(--weight-semibold)] text-[var(--text-primary)] truncate">{formatDate(notice.recoveredAt)}</div>
            <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] truncate">{notice.manifestPath}</div>
          </div>
          <button
            disabled={actionKey?.startsWith("recovery:")}
            onClick={() => {
              const taskId = window.prompt("Recovered task id")?.trim()
              if (!taskId) return
              const coordinatorId = window.prompt("Recovered coordinator id")?.trim()
              if (!coordinatorId) return
              const managerName = window.prompt("Manager name")?.trim()
              if (!managerName) return
              onRequeue(notice.manifestPath, taskId, coordinatorId, managerName)
            }}
            className="focus-ring h-8 px-3 rounded-[var(--radius-sm)] border border-[var(--separator)] disabled:opacity-45 text-[length:var(--text-footnote)] shrink-0"
          >
            Requeue
          </button>
        </Row>
      ))}
    </div>
  )
}

function Telemetry({ data }: { data: OrchestrationDashboardData }) {
  const summary = data.telemetry.summary
  const providers = Object.entries(summary.byProvider)
  return (
    <Section title="Telemetry summary" count={summary.totals.count}>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-[var(--space-3)] mb-[var(--space-3)]">
        <Metric label="Runs" value={summary.totals.count} />
        <Metric label="Cost" value={`$${summary.totals.totalCost.toFixed(3)}`} />
        <Metric label="Avg latency" value={summary.totals.avgLatencyMs === null ? "-" : `${summary.totals.avgLatencyMs}ms`} />
        <Metric label="Skipped lines" value={summary.skippedLines} tone={summary.skippedLines ? "warn" : undefined} />
      </div>
      <Table
        columns={["Provider", "Runs", "Score", "Cost", "Failures"]}
        rows={providers.map(([provider, bucket]) => [
          provider,
          String(bucket.count),
          String(bucket.score),
          `$${bucket.totalCost.toFixed(3)}`,
          String(bucket.dispositions.failed ?? 0),
        ])}
        empty="No telemetry records."
      />
    </Section>
  )
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="grid gap-[var(--space-3)]">
      <div className="flex items-center justify-between">
        <h2 className="text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-primary)]">{title}</h2>
        <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{count}</span>
      </div>
      {children}
    </section>
  )
}

function Table({ columns, rows, empty = "No rows." }: { columns: string[]; rows: string[][]; empty?: string }) {
  if (rows.length === 0) return <EmptyState title={empty} />
  return (
    <div className="overflow-x-auto border border-[var(--separator)] rounded-[var(--radius-md)] bg-[var(--material-thin)]">
      <table className="w-full text-left text-[length:var(--text-footnote)]">
        <thead className="text-[var(--text-tertiary)] bg-[var(--material-regular)]">
          <tr>{columns.map((column) => <th key={column} className="px-3 py-2 font-[var(--weight-semibold)] whitespace-nowrap">{column}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-t border-[var(--separator)]">
              {row.map((cell, cellIndex) => <td key={cellIndex} className="px-3 py-2 max-w-[28rem] truncate">{cell || "-"}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Row({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-[var(--space-3)] border border-[var(--separator)] rounded-[var(--radius-md)] bg-[var(--material-thin)] px-3 py-2">
      {children}
    </div>
  )
}

function Metric({ label, value, icon, tone }: { label: string; value: string | number; icon?: ReactNode; tone?: "warn" | "error" }) {
  const color = tone === "error" ? "var(--system-red)" : tone === "warn" ? "var(--system-orange)" : "var(--text-primary)"
  return (
    <div className="border border-[var(--separator)] rounded-[var(--radius-md)] bg-[var(--material-thin)] p-3">
      <div className="flex items-center gap-2 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{icon}{label}</div>
      <div className="mt-1 text-[length:var(--text-title3)] font-[var(--weight-bold)]" style={{ color }}>{value}</div>
    </div>
  )
}

function Pill({ text, tone }: { text: string; tone: "neutral" | "warn" | "error" }) {
  const color = tone === "error" ? "var(--system-red)" : tone === "warn" ? "var(--system-orange)" : "var(--text-secondary)"
  return <span className="px-2 py-1 rounded-[var(--radius-sm)] bg-[var(--material-regular)] text-[length:var(--text-caption1)]" style={{ color }}>{text}</span>
}

// Informational/warning banner (degraded, disabled, queue-paused reasons) —
// distinct from ErrorState (components/ui/error-state.tsx), which is
// reserved for actual request/action failures and is always red with
// role="alert". This stays amber and non-alerting on purpose.
function Banner({ text }: { text: string }) {
  return (
    <div className="mb-[var(--space-3)] px-3 py-2 rounded-[var(--radius-md)] border text-[length:var(--text-footnote)]"
      style={{
        color: "var(--system-orange)",
        borderColor: "var(--separator)",
        background: "var(--material-thin)",
      }}
    >
      {text}
    </div>
  )
}

function OrchestrationLoadingSkeleton() {
  return (
    <div className="grid gap-[var(--space-4)]">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-[var(--space-3)]">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="border border-[var(--separator)] rounded-[var(--radius-md)] bg-[var(--material-thin)] p-3">
            <Skeleton className="h-3 w-16 mb-2" />
            <Skeleton className="h-5 w-10" />
          </div>
        ))}
      </div>
      {[1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-12 rounded-[var(--radius-md)]" />
      ))}
    </div>
  )
}

function statusText(data: OrchestrationDashboardData | null): string {
  if (!data) return "Loading runtime state"
  if (!data.status.enabled) return "Disabled by gateway configuration"
  if (!data.status.runtimeBound) return "Enabled, runtime not bound"
  if (data.status.queuePaused) return `Queue paused, ${data.status.counts.runningLeases} running lease(s)`
  return `${data.status.counts.runningLeases} running lease(s), ${data.status.counts.queueItems} queued item(s)`
}

function queueControlTitle(data: OrchestrationDashboardData): string {
  if (!data.status.enabled) return data.status.disabledReason ?? "Orchestration is disabled"
  if (!data.status.runtimeBound) return data.status.degradedReason ?? "Orchestration runtime is not bound"
  return data.status.queuePaused ? "Resume queued orchestration continuations" : "Pause queued orchestration continuations"
}

function formatDate(value: string | undefined): string {
  if (!value) return "-"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
