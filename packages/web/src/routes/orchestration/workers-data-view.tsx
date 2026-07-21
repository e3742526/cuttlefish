import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ClipboardCopy, X } from "lucide-react"
import {
  ColumnConfigMenu,
  DataTable,
  DensityToggle,
  ExportMenu,
  SavedViewsMenu,
  type DataTableColumn,
  type Density,
  type ExportColumn,
  type SavedView,
  type SortState,
} from "@/components/data-view"
import { EmptyState } from "@/components/ui/empty-state"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { HoldSummary, LeaseSummary, WorkerSummary } from "@/lib/orchestration-api"
import {
  readWorkersViewUrlState,
  replaceOrchestrationViewUrl,
  type WorkersViewUrlState,
} from "./workers-view-url"

export interface WorkerViewFilters {
  search: string
}

type WorkerPresenceState = "available" | "held" | "working" | "at_capacity"

interface WorkerPresence {
  state: WorkerPresenceState
  label: string
  detail: string
  activeLeases: LeaseSummary[]
  activeHolds: HoldSummary[]
}

interface WorkerRow {
  worker: WorkerSummary
  presence: WorkerPresence
}

const WORKER_COLUMNS: DataTableColumn<WorkerRow>[] = [
  { key: "id", label: "Worker", render: (row) => row.worker.id, sortValue: (row) => row.worker.id, required: true },
  {
    key: "presence",
    label: "Presence",
    render: (row) => <PresenceBadge presence={row.presence} />,
    sortValue: (row) => presenceOrder(row.presence.state),
  },
  { key: "provider", label: "Provider", render: (row) => row.worker.provider, sortValue: (row) => row.worker.provider },
  { key: "family", label: "Family", render: (row) => row.worker.family, sortValue: (row) => row.worker.family },
  { key: "tier", label: "Tier", render: (row) => row.worker.tier, sortValue: (row) => row.worker.tier },
  { key: "cost", label: "Cost", render: (row) => row.worker.costClass, sortValue: (row) => row.worker.costClass },
  { key: "workspace", label: "Workspace", render: (row) => row.worker.workspacePolicy },
  { key: "capabilities", label: "Capabilities", render: (row) => row.worker.capabilities.join(", ") },
]

const WORKER_EXPORT_COLUMNS: ExportColumn<WorkerRow>[] = [
  { key: "id", label: "Worker", value: (row) => row.worker.id },
  { key: "presence", label: "Presence", value: (row) => row.presence.label },
  { key: "provider", label: "Provider", value: (row) => row.worker.provider },
  { key: "family", label: "Family", value: (row) => row.worker.family },
  { key: "tier", label: "Tier", value: (row) => row.worker.tier },
  { key: "cost", label: "Cost", value: (row) => row.worker.costClass },
  { key: "workspace", label: "Workspace", value: (row) => row.worker.workspacePolicy },
  { key: "capabilities", label: "Capabilities", value: (row) => row.worker.capabilities.join(", ") },
]

const WORKER_COLUMN_KEYS = new Set(WORKER_COLUMNS.map((column) => column.key))
const SORTABLE_WORKER_COLUMN_KEYS = new Set(WORKER_COLUMNS.filter((column) => column.sortValue).map((column) => column.key))

export function deriveWorkerPresence(worker: WorkerSummary, leases: LeaseSummary[], holds: HoldSummary[]): WorkerPresence {
  const activeLeases = leases.filter((lease) => lease.workerId === worker.id && lease.state === "running")
  const activeHolds = holds.filter((hold) => hold.state === "active" && hold.workerIds.includes(worker.id))
  if (activeLeases.length >= worker.maxConcurrentTasks && worker.maxConcurrentTasks > 0) {
    return {
      state: "at_capacity",
      label: "At capacity",
      detail: `${activeLeases.length} active orchestration assignment${activeLeases.length === 1 ? "" : "s"} (limit ${worker.maxConcurrentTasks})`,
      activeLeases,
      activeHolds,
    }
  }
  if (activeLeases.length) {
    return {
      state: "working",
      label: "Working",
      detail: `${activeLeases.length} active orchestration assignment${activeLeases.length === 1 ? "" : "s"}`,
      activeLeases,
      activeHolds,
    }
  }
  if (activeHolds.length) {
    return {
      state: "held",
      label: "Held",
      detail: `${activeHolds.length} active scheduling hold${activeHolds.length === 1 ? "" : "s"}`,
      activeLeases,
      activeHolds,
    }
  }
  return { state: "available", label: "Available", detail: "No active orchestration assignment or hold", activeLeases, activeHolds }
}

function presenceOrder(state: WorkerPresenceState): number {
  return { available: 0, held: 1, working: 2, at_capacity: 3 }[state]
}

function normalizeViewState(state: WorkersViewUrlState, fallbackHiddenColumns: string[]): WorkersViewUrlState {
  const hiddenColumns = (state.hiddenColumns.length ? state.hiddenColumns : fallbackHiddenColumns)
    .filter((column) => WORKER_COLUMN_KEYS.has(column))
  const sort = state.sort && SORTABLE_WORKER_COLUMN_KEYS.has(state.sort.key) ? state.sort : null
  return { ...state, sort, hiddenColumns: [...new Set(hiddenColumns)] }
}

function viewStateFromLocation(fallbackHiddenColumns: string[]): WorkersViewUrlState {
  return normalizeViewState(readWorkersViewUrlState(), fallbackHiddenColumns)
}

export function WorkersDataView({
  workers,
  leases,
  holds,
  density,
  onDensityChange,
  storedHiddenColumns,
  onStoredHiddenColumnsChange,
  savedViews,
  onSaveView,
  onDeleteView,
}: {
  workers: WorkerSummary[]
  leases: LeaseSummary[]
  holds: HoldSummary[]
  density: Density
  onDensityChange: (density: Density) => void
  storedHiddenColumns: string[]
  onStoredHiddenColumnsChange: (hiddenColumns: string[]) => void
  savedViews: SavedView<WorkerViewFilters>[]
  onSaveView: (view: Omit<SavedView<WorkerViewFilters>, "id">) => void
  onDeleteView: (id: string) => void
}) {
  const [view, setView] = useState<WorkersViewUrlState>(() => viewStateFromLocation(storedHiddenColumns))
  const viewRef = useRef(view)
  const [shareMessage, setShareMessage] = useState("")

  useEffect(() => {
    const onPopState = () => {
      const restoredView = viewStateFromLocation(storedHiddenColumns)
      viewRef.current = restoredView
      setView(restoredView)
    }
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [storedHiddenColumns])

  const updateView = useCallback((patch: Partial<WorkersViewUrlState>) => {
    const next = { ...viewRef.current, ...patch }
    viewRef.current = next
    replaceOrchestrationViewUrl({ tab: "Workers", workers: next })
    setView(next)
  }, [])

  const rows = useMemo<WorkerRow[]>(
    () => workers.map((worker) => ({ worker, presence: deriveWorkerPresence(worker, leases, holds) })),
    [holds, leases, workers],
  )
  const filteredRows = useMemo(() => {
    const query = view.search.trim().toLowerCase()
    if (!query) return rows
    return rows.filter(({ worker, presence }) =>
      [worker.id, presence.label, worker.provider, worker.family, worker.tier, worker.costClass, worker.workspacePolicy, ...worker.capabilities]
        .join(" ")
        .toLowerCase()
        .includes(query),
    )
  }, [rows, view.search])
  const selectedRow = rows.find((row) => row.worker.id === view.selectedWorkerId) ?? null

  function applySavedView(savedView: SavedView<WorkerViewFilters>) {
    onStoredHiddenColumnsChange(savedView.hiddenColumns)
    updateView({
      search: savedView.filters.search,
      sort: savedView.sort,
      hiddenColumns: savedView.hiddenColumns,
      selectedWorkerId: null,
    })
  }

  async function copyShareLink() {
    const message = "Copy the browser address to share this Workers view."
    if (!navigator.clipboard?.writeText) {
      setShareMessage(message)
      return
    }
    try {
      await navigator.clipboard.writeText(window.location.href)
      setShareMessage("Workers view link copied.")
    } catch {
      setShareMessage(message)
    }
  }

  return (
    <section className="grid gap-[var(--space-3)]" aria-labelledby="workers-heading">
      <div className="flex flex-wrap items-center justify-between gap-[var(--space-3)]">
        <div className="flex items-center gap-[var(--space-2)]">
          <h2 id="workers-heading" className="text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-primary)]">Workers</h2>
          <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{filteredRows.length}</span>
        </div>
        <div className="flex flex-wrap items-center gap-[var(--space-2)]">
          <label className="sr-only" htmlFor="workers-search">Search workers</label>
          <input
            id="workers-search"
            type="search"
            value={view.search}
            onChange={(event) => updateView({ search: event.target.value })}
            placeholder="Search workers…"
            aria-label="Search workers"
            className="focus-ring h-8 rounded-[var(--radius-sm)] border border-[var(--separator)] bg-[var(--material-thin)] px-3 text-[length:var(--text-footnote)] text-[var(--text-primary)] outline-none"
          />
          <DensityToggle density={density} onChange={onDensityChange} />
          <ColumnConfigMenu
            columns={WORKER_COLUMNS.map((column) => ({ key: column.key, label: column.label, required: column.required }))}
            hiddenColumns={view.hiddenColumns}
            onChange={(hiddenColumns) => {
              onStoredHiddenColumnsChange(hiddenColumns)
              updateView({ hiddenColumns })
            }}
          />
          <SavedViewsMenu
            savedViews={savedViews}
            pinnedViewId={null}
            currentFilters={{ search: view.search }}
            currentSort={view.sort}
            currentHiddenColumns={view.hiddenColumns}
            onApply={applySavedView}
            onSave={onSaveView}
            onDelete={onDeleteView}
          />
          <Button type="button" variant="outline" size="sm" onClick={() => void copyShareLink()} aria-label="Copy worker view link">
            <ClipboardCopy className="size-3.5" />
            Share
          </Button>
          <ExportMenu rows={filteredRows} columns={WORKER_EXPORT_COLUMNS} filenamePrefix="orchestration-workers" />
          <span className="sr-only" role="status">{shareMessage}</span>
        </div>
      </div>
      <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
        Filters, columns, sorting, and the selected worker are reflected in this page’s URL for sharing.
      </p>
      <div className={cn("grid gap-[var(--space-3)]", selectedRow && "xl:grid-cols-[minmax(0,1fr)_20rem]")}>
        <DataTable
          columns={WORKER_COLUMNS}
          rows={filteredRows}
          getRowKey={(row) => row.worker.id}
          hiddenColumns={view.hiddenColumns}
          density={density}
          sort={view.sort}
          onSortChange={(sort) => updateView({ sort })}
          onRowClick={(row) => updateView({ selectedWorkerId: row.worker.id })}
          rowClassName={(row) => row.worker.id === view.selectedWorkerId ? "bg-[var(--fill-secondary)]" : undefined}
          emptyState={<EmptyState title="No workers match this search." />}
        />
        {selectedRow && (
          <WorkerInspector
            row={selectedRow}
            onClose={() => updateView({ selectedWorkerId: null })}
          />
        )}
      </div>
    </section>
  )
}

function PresenceBadge({ presence }: { presence: WorkerPresence }) {
  const color = presence.state === "at_capacity"
    ? "var(--system-orange)"
    : presence.state === "working"
      ? "var(--system-blue)"
      : presence.state === "held"
        ? "var(--system-orange)"
        : "var(--system-green)"
  return (
    <span className="inline-flex items-center gap-1.5 text-[length:var(--text-caption1)]" style={{ color }} title={presence.detail}>
      <span aria-hidden="true" className={cn("size-1.5 rounded-full bg-current", presence.state === "working" && "motion-safe:animate-pulse")} />
      {presence.label}
    </span>
  )
}

function WorkerInspector({ row, onClose }: { row: WorkerRow; onClose: () => void }) {
  const { worker, presence } = row
  return (
    <aside
      aria-label="Worker inspector"
      className="self-start rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--material-thin)] p-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-primary)]">{worker.id}</h3>
          <div className="mt-1"><PresenceBadge presence={presence} /></div>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Close worker inspector" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>

      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-[length:var(--text-footnote)]">
        <dt className="text-[var(--text-tertiary)]">Provider</dt><dd className="min-w-0 truncate text-[var(--text-primary)]">{worker.provider}</dd>
        <dt className="text-[var(--text-tertiary)]">Family</dt><dd className="min-w-0 truncate text-[var(--text-primary)]">{worker.family}</dd>
        <dt className="text-[var(--text-tertiary)]">Tier</dt><dd className="min-w-0 truncate text-[var(--text-primary)]">{worker.tier}</dd>
        <dt className="text-[var(--text-tertiary)]">Capacity</dt><dd className="text-[var(--text-primary)]">{worker.maxConcurrentTasks} concurrent task{worker.maxConcurrentTasks === 1 ? "" : "s"}</dd>
        <dt className="text-[var(--text-tertiary)]">Workspace</dt><dd className="min-w-0 text-[var(--text-primary)]">{worker.workspacePolicy}</dd>
      </dl>

      <InspectorSection title="Coordinator assignments">
        {presence.activeLeases.length === 0 ? (
          <p className="text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">No active orchestration assignments.</p>
        ) : (
          <ul className="grid gap-2">
            {presence.activeLeases.map((lease) => (
              <li key={lease.leaseId} className="rounded-[var(--radius-sm)] border border-[var(--separator)] bg-[var(--material-regular)] p-2 text-[length:var(--text-footnote)]">
                <div className="font-[var(--weight-semibold)] text-[var(--text-primary)] truncate">{lease.taskId}</div>
                <div className="mt-1 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                  {lease.coordinatorId} · {lease.role}
                </div>
                {lease.leaseExpiresAt && <div className="mt-1 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">Lease expires {formatDate(lease.leaseExpiresAt)}</div>}
              </li>
            ))}
          </ul>
        )}
      </InspectorSection>

      <InspectorSection title="Scheduling holds">
        {presence.activeHolds.length === 0 ? (
          <p className="text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">No active scheduling holds.</p>
        ) : (
          <ul className="grid gap-2">
            {presence.activeHolds.map((hold) => (
              <li key={hold.holdId} className="rounded-[var(--radius-sm)] border border-[var(--separator)] bg-[var(--material-regular)] p-2 text-[length:var(--text-footnote)]">
                <div className="font-[var(--weight-semibold)] text-[var(--text-primary)] truncate">{hold.managerName}</div>
                <div className="mt-1 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{hold.reason ?? "No reason recorded"}</div>
              </li>
            ))}
          </ul>
        )}
      </InspectorSection>

      <InspectorSection title="Capabilities">
        <p className="text-[length:var(--text-footnote)] text-[var(--text-primary)]">{worker.capabilities.join(", ") || "None recorded"}</p>
      </InspectorSection>
    </aside>
  )
}

function InspectorSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-4 border-t border-[var(--separator)] pt-3">
      <h4 className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)]">{title}</h4>
      <div className="mt-2">{children}</div>
    </section>
  )
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
