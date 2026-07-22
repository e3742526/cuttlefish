
import { useEffect, useState, useCallback } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import type { DepartmentBoardResponse, DepartmentBoardTicket, Employee, OrgData } from '@/lib/api'
import { useGateway } from '@/hooks/use-gateway'
import type { KanbanTicket, TicketStatus, TicketPriority, TicketComplexity } from '@/lib/kanban/types'
import {
  saveTickets,
  createTicket,
  updateTicket,
  appendTicketNote,
  moveTicket,
  deleteTicket,
  type KanbanStore,
} from '@/lib/kanban/store'
import { PageLayout, ToolbarActions } from '@/components/page-layout'
import { useBreadcrumbs } from '@/context/breadcrumb-context'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { StalePill } from '@/components/ui/stale-pill'
import { KanbanBoard } from '@/components/kanban/kanban-board'
import { CreateTicketModal } from '@/components/kanban/create-ticket-modal'
import { TicketDetailPanel } from '@/components/kanban/ticket-detail-panel'

const DEFAULT_RECYCLE_BIN_RETENTION_DAYS = 3
const MIN_RECYCLE_BIN_RETENTION_DAYS = 0
const MAX_RECYCLE_BIN_RETENTION_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

type DeletedKanbanTicket = KanbanTicket & { deletedAt: number }

export function getBoardLoadDepartments(data: OrgData): string[] {
  return Array.isArray(data.boardDepartments) ? data.boardDepartments : data.departments
}

export interface LoadedDepartmentBoards {
  boardTickets: KanbanStore
  deletedTickets: DeletedKanbanTicket[]
  retentionDays: number
  departmentRetentionDays: Record<string, number>
  warnings: string[]
}

function clampRecycleBinRetentionDays(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_RECYCLE_BIN_RETENTION_DAYS
  return Math.max(MIN_RECYCLE_BIN_RETENTION_DAYS, Math.min(MAX_RECYCLE_BIN_RETENTION_DAYS, Math.round(n)))
}

function formatRecycleBinDays(days: number): string {
  if (days === 0) return 'Immediate purge'
  return `${days} day${days === 1 ? '' : 's'}`
}

function formatDeletedAt(ts: number): string {
  return new Date(ts).toLocaleString()
}

function formatDeletionExpiry(ts: number, retentionDays: number): string {
  if (retentionDays <= 0) return 'immediately'
  return new Date(ts + (retentionDays * DAY_MS)).toLocaleString()
}

function mapBoardTicket(item: DepartmentBoardTicket, department: string): KanbanTicket {
  const statusMap: Record<string, TicketStatus> = {
    todo: 'todo',
    in_progress: 'in-progress',
    'in-progress': 'in-progress',
    done: 'done',
    blocked: 'blocked',
    backlog: 'backlog',
    review: 'review',
  }
  const priorityMap: Record<string, TicketPriority> = {
    low: 'low',
    medium: 'medium',
    high: 'high',
  }
  const complexityMap: Record<string, TicketComplexity> = {
    low: 'low',
    medium: 'medium',
    high: 'high',
  }
  return {
    id: item.id,
    title: item.title,
    description: item.description || '',
    resourcePath: item.resourcePath,
    resourceUrl: item.resourceUrl,
    manualOnly: item.manualOnly === true,
    status: statusMap[item.status] ?? (() => { throw new Error(`Unknown ticket status '${String(item.status)}' in ${department}/${item.id}`) })(),
    priority: priorityMap[item.priority || 'medium'] || 'medium',
    complexity: complexityMap[item.complexity || 'medium'] || 'medium',
    assigneeId: item.assignee || null,
    source: item.source,
    sessionId: item.sessionId,
    department,
    workState: 'idle',
    createdAt: item.createdAt ? new Date(item.createdAt).getTime() : Date.now(),
    updatedAt: item.updatedAt ? new Date(item.updatedAt).getTime() : Date.now(),
    baseUpdatedAt: item.updatedAt ? new Date(item.updatedAt).getTime() : undefined,
    departmentId: department,
  }
}

function mapDeletedBoardTicket(item: DepartmentBoardTicket, department: string): DeletedKanbanTicket {
  return {
    ...mapBoardTicket(item, department),
    deletedAt: item.deletedAt ? new Date(item.deletedAt).getTime() : Date.now(),
  }
}

export async function loadDepartmentBoards(
  boardDepartments: string[],
  getDepartmentBoard: (department: string) => Promise<DepartmentBoardResponse> = (department) => api.getDepartmentBoard(department),
): Promise<LoadedDepartmentBoards> {
  const results = await Promise.all(
    boardDepartments.map(async (department) => {
      try {
        const board = await getDepartmentBoard(department)
        return { department, board } as const
      } catch (err) {
        return { department, error: err } as const
      }
    }),
  )

  const boardTickets: KanbanStore = {}
  const deletedTickets: DeletedKanbanTicket[] = []
  let retentionDays: number | null = null
  const departmentRetentionDays: Record<string, number> = {}
  const warnings: string[] = []

  for (const result of results) {
    if ('error' in result) {
      const message = result.error instanceof Error ? result.error.message : 'Failed to load board.'
      if (/404|not found/i.test(message)) continue
      warnings.push(`${result.department}: ${message}`)
      continue
    }
    const nextRetentionDays = clampRecycleBinRetentionDays(result.board.retentionDays)
    departmentRetentionDays[result.department] = nextRetentionDays
    retentionDays = retentionDays == null ? nextRetentionDays : Math.max(retentionDays, nextRetentionDays)
    for (const item of result.board.tickets) {
      boardTickets[item.id] = mapBoardTicket(item, result.department)
    }
    for (const item of result.board.deletedTickets) {
      deletedTickets.push(mapDeletedBoardTicket(item, result.department))
    }
  }

  return {
    boardTickets,
    deletedTickets: deletedTickets.sort((a, b) => b.deletedAt - a.deletedAt),
    retentionDays: retentionDays ?? DEFAULT_RECYCLE_BIN_RETENTION_DAYS,
    departmentRetentionDays,
    warnings,
  }
}

const BOARD_STATUS_BY_KANBAN_STATUS: Record<KanbanTicket['status'], DepartmentBoardTicket['status']> = {
  backlog: 'backlog',
  todo: 'todo',
  'in-progress': 'in_progress',
  review: 'review',
  done: 'done',
  blocked: 'blocked',
}

export interface DepartmentBoardSaveTarget {
  department: string
  deletedIds?: string[]
  deletedVersions?: Record<string, string>
  retentionDays?: number | null
}

export function buildDepartmentBoardSaveRequests(
  store: KanbanStore,
  targets: DepartmentBoardSaveTarget[],
  departmentRetentionDays: Record<string, number>,
): Array<{ department: string; payload: import('@/lib/api').UpdateDepartmentBoardPayload }> {
  const mergedTargets = new Map<string, Required<Omit<DepartmentBoardSaveTarget, 'retentionDays'>> & { retentionDays: number | null }>()
  for (const target of targets) {
    if (!target.department) continue
    const existing = mergedTargets.get(target.department) ?? {
      department: target.department,
      deletedIds: [],
      deletedVersions: {},
      retentionDays: null,
    }
    existing.deletedIds = [...new Set([...existing.deletedIds, ...(target.deletedIds ?? [])])]
    existing.deletedVersions = { ...existing.deletedVersions, ...(target.deletedVersions ?? {}) }
    if (target.retentionDays != null) existing.retentionDays = target.retentionDays
    mergedTargets.set(target.department, existing)
  }

  return [...mergedTargets.values()].map((target) => {
    const boardData: DepartmentBoardTicket[] = Object.values(store)
      .filter((ticket) => ticket.departmentId === target.department)
      .map((t) => {
        // Only assert optimistic-concurrency freshness for tickets the user
        // actually edited. `updateTicket` advances `updatedAt` but leaves
        // `baseUpdatedAt` at the loaded snapshot, so a ticket is "dirty" when
        // those differ (or when it has no snapshot, i.e. newly created).
        // Untouched tickets — bundled only because a save sends the whole
        // department board — omit `baseUpdatedAt` so a concurrent agent write
        // to one of them can't block an unrelated delete/move/edit.
        const changed = t.baseUpdatedAt == null || t.baseUpdatedAt !== t.updatedAt
        return {
          id: t.id,
          title: t.title,
          description: t.description,
          resourcePath: t.resourcePath,
          resourceUrl: t.resourceUrl,
          manualOnly: t.manualOnly === true,
          status: BOARD_STATUS_BY_KANBAN_STATUS[t.status],
          priority: t.priority,
          complexity: t.complexity,
          assignee: t.assigneeId ?? undefined,
          source: t.source,
          sessionId: t.sessionId,
          createdAt: new Date(t.createdAt || Date.now()).toISOString(),
          updatedAt: new Date(t.updatedAt || Date.now()).toISOString(),
          ...(changed
            ? { baseUpdatedAt: new Date(t.baseUpdatedAt ?? t.updatedAt ?? Date.now()).toISOString() }
            : {}),
        }
      })
    return {
      department: target.department,
      payload: {
        tickets: boardData,
        deletedIds: target.deletedIds,
        deletedVersions: target.deletedVersions,
        retentionDays: target.retentionDays ?? departmentRetentionDays[target.department],
      },
    }
  })
}

export function buildAssigneeChangeUpdate(
  assigneeId: string | null,
  employees: Employee[],
): Partial<Omit<KanbanTicket, 'id' | 'createdAt'>> {
  const emp = assigneeId ? employees.find(e => e.name === assigneeId) : null
  const updates: Partial<Omit<KanbanTicket, 'id' | 'createdAt'>> = { assigneeId }
  if (emp?.department) {
    updates.department = emp.department
    updates.departmentId = emp.department
  }
  return updates
}

/** Delete confirmation dialog */
function DeleteConfirmDialog({
  ticket,
  onConfirm,
  onCancel,
}: {
  ticket: KanbanTicket
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel() }}>
      <DialogContent
        showCloseButton={false}
        className="bg-[var(--bg)] border border-[var(--separator)] rounded-[var(--radius-lg)] shadow-[var(--shadow-card)] max-w-[400px]"
      >
        <DialogHeader>
          <DialogTitle
            className="text-[length:var(--text-title3)] font-[var(--weight-bold)] text-[var(--text-primary)]"
          >
            Delete Ticket
          </DialogTitle>
          <DialogDescription
            className="text-[length:var(--text-footnote)] text-[var(--text-secondary)] leading-[1.5]"
          >
            Move &ldquo;{ticket.title}&rdquo; to the recycle bin? It can be restored until the retention window expires.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button
            onClick={onCancel}
            className="px-[var(--space-4)] py-[var(--space-2)] rounded-[var(--radius-md)] border border-[var(--separator)] bg-transparent text-[var(--text-secondary)] text-[length:var(--text-footnote)] font-semibold cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            autoFocus
            className="px-[var(--space-4)] py-[var(--space-2)] rounded-[var(--radius-md)] border-none bg-[var(--system-red)] text-white text-[length:var(--text-footnote)] font-semibold cursor-pointer"
          >
            Delete
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function KanbanPage() {
  useBreadcrumbs([{ label: 'Kanban' }])
  const { subscribe } = useGateway()
  const [tickets, setTickets] = useState<KanbanStore>({})
  const [employees, setEmployees] = useState<Employee[]>([])
  const [departments, setDepartments] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [rejectedWarning, setRejectedWarning] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [selectedTicket, setSelectedTicket] = useState<KanbanTicket | null>(null)
  const [filterEmployeeId, setFilterEmployeeId] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<KanbanTicket | null>(null)
  const [deletedTickets, setDeletedTickets] = useState<DeletedKanbanTicket[]>([])
  const [recycleBinRetentionDays, setRecycleBinRetentionDays] = useState(DEFAULT_RECYCLE_BIN_RETENTION_DAYS)
  const [departmentRetentionDays, setDepartmentRetentionDays] = useState<Record<string, number>>({})
  const [boardLoadWarnings, setBoardLoadWarnings] = useState<string[]>([])

  const loadData = useCallback(() => {
    setLoading(true)
    setError(null)

    // Load employees from API, then load board data from department boards
    api
      .getOrg()
      .then(async (data: OrgData) => {
        const boardDepartments = getBoardLoadDepartments(data)
        setEmployees(data.employees)
        setDepartments(boardDepartments)
        const loadedBoards = await loadDepartmentBoards(boardDepartments)

        // API is the sole source of truth on load. Do not merge localStorage —
        // agent-made changes (moves, deletes) are only reflected in the API,
        // and stale localStorage entries would cause ghost / wrong-state tickets.
        setTickets(loadedBoards.boardTickets)
        setDeletedTickets(loadedBoards.deletedTickets)
        setDepartmentRetentionDays(loadedBoards.departmentRetentionDays)
        setBoardLoadWarnings(loadedBoards.warnings)
        setRecycleBinRetentionDays(loadedBoards.retentionDays)
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  useEffect(() => {
    const unsubscribe = subscribe((event, payload) => {
      if (event !== 'board:updated') return
      const department =
        payload && typeof payload === 'object' && 'department' in payload
          ? String((payload as { department?: unknown }).department ?? '')
          : ''
      if (!department || departments.length === 0 || departments.includes(department)) {
        loadData()
      }
    })
    return unsubscribe
  }, [subscribe, departments, loadData])

  // Persist tickets to both localStorage and the API whenever the store changes
  useEffect(() => {
    if (!loading) {
      saveTickets(tickets)
    }
  }, [tickets, loading])

  /**
   * Persist the current ticket store back to the affected department boards.
   * Tickets without a departmentId are silently skipped until a department can
   * be assigned.
   */
  const persistToApi = useCallback(
    async (
      store: KanbanStore,
      targets: DepartmentBoardSaveTarget[],
    ) => {
      // Write affected department boards. Errors are surfaced to the UI and the
      // board is refetched from the gateway so optimistic local state does not
      // become the hidden source of truth.
      const responses = await Promise.all(
        buildDepartmentBoardSaveRequests(store, targets, departmentRetentionDays)
          .map(({ department, payload }) => api.updateDepartmentBoard(department, payload)),
      )
      const allRejected = responses.flatMap((r) => r.rejectedTickets ?? [])
      if (allRejected.length > 0) {
        const summary = allRejected
          .map((r) => `"${r.title ?? r.id ?? `ticket[${r.index}]`}": ${r.error}`)
          .join(' • ')
        setRejectedWarning(`${allRejected.length} ticket${allRejected.length === 1 ? '' : 's'} skipped (invalid): ${summary}`)
      } else {
        setRejectedWarning(null)
      }
    },
    [departmentRetentionDays],
  )

  const persistBoardChange = useCallback(
    (
      store: KanbanStore,
      targets: DepartmentBoardSaveTarget[],
      // Most callers are fine with the default "refetch the whole board"
      // recovery. Interactive drag-and-drop passes a targeted rollback
      // instead, so a failed move reverts just that one optimistic change
      // rather than discarding any other still-unsaved local edit too.
      onFailure?: () => void,
    ) => {
      setSaveError(null)
      void persistToApi(store, targets)
        .then(() => {
          setTickets((current) => {
            let changed = false
            const next: KanbanStore = { ...current }
            for (const [id, saved] of Object.entries(store)) {
              const live = current[id]
              if (!live || live.updatedAt !== saved.updatedAt || live.baseUpdatedAt === saved.updatedAt) continue
              next[id] = { ...live, baseUpdatedAt: saved.updatedAt }
              changed = true
            }
            return changed ? next : current
          })
        })
        .catch((err) => {
          setSaveError(err instanceof Error ? err.message : 'Failed to save board changes.')
          if (onFailure) onFailure()
          else loadData()
        })
    },
    [persistToApi, loadData],
  )

  function targetForTicket(ticket: KanbanTicket | undefined): DepartmentBoardSaveTarget[] {
    return ticket?.departmentId ? [{ department: ticket.departmentId }] : []
  }

  // Keep selectedTicket in sync with store
  useEffect(() => {
    if (selectedTicket && tickets[selectedTicket.id]) {
      const current = tickets[selectedTicket.id]
      if (current.updatedAt !== selectedTicket.updatedAt) {
        setSelectedTicket(current)
      }
    }
  }, [tickets, selectedTicket])

  function handleCreateTicket(data: {
    title: string
    description: string
    resourcePath?: string
    resourceUrl?: string
    manualOnly?: boolean
    priority: TicketPriority
    complexity: TicketComplexity
    assigneeId: string | null
  }) {
    // Infer department from assignee, fallback to first known department
    const emp = data.assigneeId ? employees.find(e => e.name === data.assigneeId) : null
    const departmentId = emp?.department || departments[0] || null

    setTickets((prev) => {
      const next = createTicket(prev, {
        ...data,
        status: 'backlog',
        department: departmentId,
        departmentId,
      })
      persistBoardChange(next, departmentId ? [{ department: departmentId }] : [])
      return next
    })
  }

  function handleMoveTicket(ticketId: string, status: TicketStatus) {
    // Computed and applied outside the updater — persistBoardChange's API
    // call is a side effect, and state updaters must stay pure (React may
    // invoke one more than once, e.g. under Strict Mode).
    const previousStatus = tickets[ticketId]?.status
    if (previousStatus === undefined || previousStatus === status) return
    const next = moveTicket(tickets, ticketId, status)
    setTickets(next)
    persistBoardChange(next, targetForTicket(next[ticketId]), () => {
      // Revert just this ticket's column instead of loadData()'s full
      // refetch — a true optimistic-update rollback.
      setTickets((current) => moveTicket(current, ticketId, previousStatus))
    })
  }

  function handleDeleteTicket(ticketId: string) {
    const deletedTicket = tickets[ticketId]
    const deletedVersions = deletedTicket
      ? { [ticketId]: new Date(deletedTicket.baseUpdatedAt ?? deletedTicket.updatedAt).toISOString() }
      : {}
    setTickets((prev) => {
      const next = deleteTicket(prev, ticketId)
      persistBoardChange(next, deletedTicket?.departmentId
        ? [{ department: deletedTicket.departmentId, deletedIds: [ticketId], deletedVersions }]
        : [])
      return next
    })
    if (deletedTicket && recycleBinRetentionDays > 0) {
      setDeletedTickets((prev) => [
        { ...deletedTicket, deletedAt: Date.now() },
        ...prev.filter((ticket) => ticket.id !== ticketId),
      ])
    } else {
      setDeletedTickets((prev) => prev.filter((ticket) => ticket.id !== ticketId))
    }
    setSelectedTicket(null)
    setDeleteConfirm(null)
  }

  function handleRestoreTicket(ticketId: string) {
    const deletedTicket = deletedTickets.find((ticket) => ticket.id === ticketId)
    if (!deletedTicket) return
    setTickets((prev) => {
      const { deletedAt: _deletedAt, ...restored } = deletedTicket
      const restoredTicket: KanbanTicket = {
        ...restored,
        workState: 'idle',
        updatedAt: Date.now(),
      }
      const next = {
        ...prev,
        [ticketId]: restoredTicket,
      }
      persistBoardChange(next, targetForTicket(restoredTicket))
      return next
    })
    setDeletedTickets((prev) => prev.filter((ticket) => ticket.id !== ticketId))
  }

  function handleRecycleBinRetentionChange(days: number) {
    const nextRetentionDays = clampRecycleBinRetentionDays(days)
    setRecycleBinRetentionDays(nextRetentionDays)
    setDepartmentRetentionDays(Object.fromEntries(departments.map((dept) => [dept, nextRetentionDays])))
    setDeletedTickets((prev) => {
      if (nextRetentionDays <= 0) return []
      const cutoff = Date.now() - (nextRetentionDays * DAY_MS)
      return prev.filter((ticket) => ticket.deletedAt >= cutoff)
    })
    persistBoardChange(tickets, departments.map((department) => ({ department, retentionDays: nextRetentionDays })))
  }

  function handleAssigneeChange(ticketId: string, assigneeId: string | null) {
    const updates = buildAssigneeChangeUpdate(assigneeId, employees)
    setTickets((prev) => {
      const currentTicket = prev[ticketId]
      const previousDepartmentId = currentTicket?.departmentId ?? null
      const next = updateTicket(prev, ticketId, updates)
      const updatedTicket = next[ticketId]
      const nextDepartmentId = updatedTicket?.departmentId ?? null
      const targets: DepartmentBoardSaveTarget[] = targetForTicket(updatedTicket)
      if (previousDepartmentId && nextDepartmentId && previousDepartmentId !== nextDepartmentId) {
        const baseUpdatedAt = currentTicket?.baseUpdatedAt ?? currentTicket?.updatedAt
        targets.push({
          department: previousDepartmentId,
          deletedIds: [ticketId],
          deletedVersions: baseUpdatedAt ? { [ticketId]: new Date(baseUpdatedAt).toISOString() } : {},
        })
      }
      persistBoardChange(next, targets)
      return next
    })
  }

  function handleComplexityChange(ticketId: string, complexity: TicketComplexity) {
    setTickets((prev) => {
      const next = updateTicket(prev, ticketId, { complexity })
      persistBoardChange(next, targetForTicket(next[ticketId]))
      return next
    })
  }

  function handleSaveTicketConfig(
    ticketId: string,
    updates: Pick<KanbanTicket, 'title' | 'description' | 'resourcePath' | 'resourceUrl' | 'manualOnly'>,
  ) {
    setTickets((prev) => {
      const next = updateTicket(prev, ticketId, updates)
      persistBoardChange(next, targetForTicket(next[ticketId]))
      return next
    })
  }

  function handleAppendNote(ticketId: string, updates: { title: string; description: string; note: string }) {
    setTickets((prev) => {
      const next = updateTicket(prev, ticketId, {
        title: updates.title,
        description: appendTicketNote(updates.description, updates.note),
      })
      persistBoardChange(next, targetForTicket(next[ticketId]))
      return next
    })
  }

  function handleRunNow(ticketId: string) {
    const ticket = tickets[ticketId]
    const department = ticket?.departmentId ?? ticket?.department ?? ''
    if (!ticket || !department) {
      setSaveError('Ticket is missing its department.')
      return
    }

    setSaveError(null)
    setTickets((prev) => updateTicket(prev, ticketId, { workState: 'starting' }))
    void api.dispatchTicket(department, ticketId)
      .catch((err) => {
        setSaveError(err instanceof Error ? err.message : 'Failed to start ticket.')
        loadData()
      })
  }

  function handleEscalateToLead(ticketId: string) {
    const ticket = tickets[ticketId]
    const department = ticket?.departmentId ?? ticket?.department ?? ''
    if (!ticket || !department) {
      setSaveError('Ticket is missing its department.')
      return
    }

    setSaveError(null)
    setTickets((prev) => updateTicket(prev, ticketId, { workState: 'starting' }))
    void api.escalateToLead(department, ticketId)
      .catch((err) => {
        setSaveError(err instanceof Error ? err.message : 'Failed to escalate ticket.')
        loadData()
      })
  }

  function handleTicketClick(ticket: KanbanTicket) {
    setSelectedTicket(ticket)
  }

  if (error) {
    return (
      <PageLayout>
        <div className="flex h-full items-center justify-center p-[var(--space-6)]">
          <ErrorState className="max-w-md" message={`Failed to load employees: ${error}`} onRetry={loadData} />
        </div>
      </PageLayout>
    )
  }

  const ticketCount = Object.keys(tickets).length

  // Employees that have at least one ticket assigned
  const assignedEmployeeNames = new Set(
    Object.values(tickets)
      .map((t) => t.assigneeId)
      .filter(Boolean),
  )
  const assignedEmployees = employees.filter((e) => assignedEmployeeNames.has(e.name))

  return (
    <PageLayout>
      <div className="flex h-full relative bg-[var(--bg)]">
        {/* Board area */}
        <div className="flex-1 h-full flex flex-col min-w-0">
          {/* Header */}
          <div
            className="px-[var(--space-5)] py-[var(--space-4)] flex items-center justify-between shrink-0 border-b border-[var(--separator)]"
          >
            <div>
              <h1
                className="text-[length:var(--text-title2)] font-[var(--weight-bold)] text-[var(--text-primary)] m-0 tracking-[-0.3px]"
              >
                Kanban Board
              </h1>
              <p
                className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mt-[2px] mb-0"
              >
                {ticketCount} ticket{ticketCount !== 1 ? 's' : ''}
              </p>
            </div>

            <ToolbarActions>
              <StalePill />
              <label className="flex items-center gap-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
                <span>Recycle bin</span>
                <select
                  aria-label="Recycle bin retention"
                  value={recycleBinRetentionDays}
                  onChange={(event) => handleRecycleBinRetentionChange(Number(event.target.value))}
                  className="rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--bg)] px-2 py-1 text-[length:var(--text-caption1)] text-[var(--text-primary)]"
                >
                  {Array.from(
                    { length: MAX_RECYCLE_BIN_RETENTION_DAYS - MIN_RECYCLE_BIN_RETENTION_DAYS + 1 },
                    (_, index) => index + MIN_RECYCLE_BIN_RETENTION_DAYS,
                  ).map((days) => (
                    <option key={days} value={days}>{formatRecycleBinDays(days)}</option>
                  ))}
                </select>
              </label>
              <button
                onClick={() => setCreateOpen(true)}
                className="rounded-[var(--radius-md)] px-4 py-2 text-[length:var(--text-footnote)] font-[var(--weight-semibold)] border-none flex items-center gap-[var(--space-2)] cursor-pointer"
                style={{ background: 'var(--accent-bg)', color: 'var(--accent-contrast)', boxShadow: 'var(--accent-glow)' }}
              >
                <Plus size={16} />
                New Ticket
              </button>
            </ToolbarActions>
          </div>

          {boardLoadWarnings.length > 0 && (
            <div className="mx-[var(--space-5)] mt-[var(--space-3)] rounded-[var(--radius-md)] border border-[color-mix(in_srgb,var(--system-orange)_35%,transparent)] bg-[color-mix(in_srgb,var(--system-orange)_10%,transparent)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--system-orange)]">
              Partial board load failure: {boardLoadWarnings.join('; ')}
            </div>
          )}

          {saveError && (
            <div className="mx-[var(--space-5)] mt-[var(--space-3)]">
              <ErrorState
                message={`Board save failed: ${saveError}`}
                onRetry={() => {
                  setSaveError(null)
                  loadData()
                }}
              />
            </div>
          )}

          {rejectedWarning && (
            <div className="mx-[var(--space-5)] mt-[var(--space-3)] rounded-[var(--radius-md)] border border-[color-mix(in_srgb,var(--system-orange)_35%,transparent)] bg-[color-mix(in_srgb,var(--system-orange)_10%,transparent)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--system-orange)] flex items-center justify-between gap-[var(--space-3)]">
              <span className="min-w-0 break-words">{rejectedWarning}</span>
              <button
                onClick={() => setRejectedWarning(null)}
                className="shrink-0 rounded-[var(--radius-sm)] border border-current bg-transparent px-[var(--space-2)] py-[2px] text-[length:var(--text-caption2)] font-semibold cursor-pointer"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Employee filter bar */}
          {assignedEmployees.length > 0 && (
            <div
              className="flex items-center gap-[var(--space-2)] px-[var(--space-5)] py-[var(--space-2)] overflow-x-auto shrink-0"
            >
              <button
                onClick={() => setFilterEmployeeId(null)}
                className={`flex items-center gap-[var(--space-1)] px-3 py-1 rounded-full border-none text-[length:var(--text-caption1)] font-semibold cursor-pointer shrink-0 ${
                  filterEmployeeId === null
                    ? ''
                    : 'bg-[var(--fill-tertiary)] text-[var(--text-secondary)]'
                }`}
                style={filterEmployeeId === null ? { background: 'var(--accent-bg)', color: 'var(--accent-contrast)' } : undefined}
              >
                All
              </button>
              {assignedEmployees.map((emp) => (
                <button
                  key={emp.name}
                  onClick={() =>
                    setFilterEmployeeId(filterEmployeeId === emp.name ? null : emp.name)
                  }
                  className={`flex items-center gap-[var(--space-1)] px-3 py-1 rounded-full border-none text-[length:var(--text-caption1)] font-semibold cursor-pointer shrink-0 ${
                    filterEmployeeId === emp.name
                      ? ''
                      : 'bg-[var(--fill-tertiary)] text-[var(--text-secondary)]'
                  }`}
                  style={filterEmployeeId === emp.name ? { background: 'var(--accent-bg)', color: 'var(--accent-contrast)' } : undefined}
                >
                  {emp.displayName}
                </button>
              ))}
            </div>
          )}

          {/* Board */}
          <div className="flex-1 px-[var(--space-3)] min-h-0">
            {loading ? (
              <div
                className="flex items-center justify-center h-full text-[var(--text-tertiary)] text-[length:var(--text-caption1)]"
              >
                Loading...
              </div>
            ) : (
              <KanbanBoard
                tickets={tickets}
                employees={employees}
                onTicketClick={handleTicketClick}
                onMoveTicket={handleMoveTicket}
                onCreateTicket={() => setCreateOpen(true)}
                onDeleteTicket={(ticket) => setDeleteConfirm(ticket)}
                filterEmployeeId={filterEmployeeId}
              />
            )}
          </div>

          <div className="shrink-0 border-t border-[var(--separator)] bg-[var(--fill-secondary)] px-[var(--space-5)] py-[var(--space-4)]">
            <div className="mb-[var(--space-2)] flex items-center justify-between gap-[var(--space-3)]">
              <div>
                <h2 className="m-0 text-[length:var(--text-footnote)] font-semibold text-[var(--text-primary)]">
                  Recently deleted
                </h2>
                <p className="m-0 mt-[2px] text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
                  Restorable for {formatRecycleBinDays(recycleBinRetentionDays).toLowerCase()}.
                </p>
              </div>
              <span className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
                {deletedTickets.length} item{deletedTickets.length === 1 ? '' : 's'}
              </span>
            </div>
            {deletedTickets.length === 0 ? (
              <EmptyState icon={Trash2} title="No deleted tickets waiting for purge." />
            ) : (
              <div className="max-h-[220px] space-y-[var(--space-2)] overflow-y-auto pr-[var(--space-1)]">
                {deletedTickets.map((ticket) => (
                  <div
                    key={ticket.id}
                    className="flex items-start justify-between gap-[var(--space-3)] rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--bg)] px-[var(--space-3)] py-[var(--space-3)]"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[length:var(--text-footnote)] font-semibold text-[var(--text-primary)]">
                        {ticket.title}
                      </div>
                      <div className="mt-[2px] text-[length:var(--text-caption2)] text-[var(--text-tertiary)] font-mono">
                        ID: {ticket.id}
                      </div>
                      <div className="mt-[2px] text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
                        Deleted {formatDeletedAt(ticket.deletedAt)}
                      </div>
                      <div className="mt-[2px] text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
                        Purges {formatDeletionExpiry(ticket.deletedAt, recycleBinRetentionDays)}
                      </div>
                      <div className="mt-[2px] text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
                        {(ticket.departmentId ?? ticket.department ?? 'No department')} · {ticket.status}
                      </div>
                    </div>
                    <button
                      onClick={() => handleRestoreTicket(ticket.id)}
                      className="shrink-0 rounded-[var(--radius-md)] border border-[var(--separator)] bg-transparent px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-caption1)] font-semibold text-[var(--text-primary)] cursor-pointer"
                    >
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Mobile backdrop */}
        {selectedTicket && (
          <div
            className="fixed inset-0 z-30 lg:hidden bg-black/50"
            onClick={() => setSelectedTicket(null)}
          />
        )}

        {/* Detail panel */}
        {selectedTicket && (
            <TicketDetailPanel
              ticket={selectedTicket}
              employees={employees}
              onClose={() => setSelectedTicket(null)}
              onStatusChange={(status) => handleMoveTicket(selectedTicket.id, status)}
              onComplexityChange={(complexity) => handleComplexityChange(selectedTicket.id, complexity)}
              onAssigneeChange={(name) => handleAssigneeChange(selectedTicket.id, name)}
              onRunNow={() => handleRunNow(selectedTicket.id)}
              onDelete={() => setDeleteConfirm(selectedTicket)}
              onSaveDetails={(updates) => handleSaveTicketConfig(selectedTicket.id, updates)}
              onAppendNote={(updates) => handleAppendNote(selectedTicket.id, updates)}
              onEscalateToLead={() => handleEscalateToLead(selectedTicket.id)}
            />
        )}

        {/* Delete confirmation dialog */}
        {deleteConfirm && (
          <DeleteConfirmDialog
            ticket={deleteConfirm}
            onConfirm={() => handleDeleteTicket(deleteConfirm.id)}
            onCancel={() => setDeleteConfirm(null)}
          />
        )}

        {/* Create ticket modal */}
        <CreateTicketModal
          open={createOpen}
          onOpenChange={setCreateOpen}
          employees={employees}
          onSubmit={handleCreateTicket}
        />
      </div>
    </PageLayout>
  )
}
