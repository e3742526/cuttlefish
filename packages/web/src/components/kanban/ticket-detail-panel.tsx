import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChatMessages } from '@/components/chat/chat-messages'
import { useGateway } from '@/hooks/use-gateway'
import { usePageVisibility } from '@/hooks/use-page-visibility'
import { api, type Employee, type TicketSessionResponse, type TicketSessionMessage } from '@/lib/api'
import type { Message } from '@/lib/conversations'
import type { KanbanTicket, TicketStatus, TicketPriority, TicketComplexity } from '@/lib/kanban/types'
import { PRIORITY_COLORS, COLUMNS } from '@/lib/kanban/types'
import { EmployeePicker } from './employee-picker'
import { FolderPicker } from '@/components/chat/folder-picker'

/* Priority badge */
function PriorityBadge({ priority }: { priority: TicketPriority }) {
  return (
    <span
      className="inline-flex items-center gap-[var(--space-1)] text-[length:var(--text-caption2)] font-semibold uppercase tracking-[0.5px]"
      style={{ color: PRIORITY_COLORS[priority] }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={{ background: PRIORITY_COLORS[priority] }}
      />
      {priority}
    </span>
  )
}

/* Status badge */
function StatusBadge({ status }: { status: TicketStatus }) {
  const label = COLUMNS.find(c => c.id === status)?.title ?? status
  return (
    <span className="text-[length:var(--text-caption2)] font-semibold text-[var(--text-secondary)] bg-[var(--fill-tertiary)] px-[var(--space-2)] py-[2px] rounded-[var(--radius-sm)] uppercase tracking-[0.3px]">
      {label}
    </span>
  )
}

const COMPLEXITIES: TicketComplexity[] = ['low', 'medium', 'high']
const COMPLEXITY_LABELS: Record<TicketComplexity, string> = {
  low: 'Low complexity',
  medium: 'Medium complexity',
  high: 'High complexity',
}
/** Slow safety-net only: session:delta/completed/started events over the
 *  gateway websocket are the primary refresh path — the interval exists to
 *  recover from a dropped frame, not to drive updates. */
const LIVE_REFRESH_MS = 30000
const LIVE_STALE_HINT_MS = 15000
const LIVE_TRANSCRIPT_LIMIT = 8

function LiveBadge({
  children,
  title,
  tone,
}: {
  children: string
  title?: string
  tone: 'amber' | 'red'
}) {
  const toneClass =
    tone === 'red'
      ? 'text-[var(--system-red)] border-[color:color-mix(in_srgb,var(--system-red)_34%,transparent)] bg-[color:color-mix(in_srgb,var(--system-red)_12%,transparent)]'
      : 'text-[var(--system-orange)] border-[color:color-mix(in_srgb,var(--system-orange)_34%,transparent)] bg-[color:color-mix(in_srgb,var(--system-orange)_12%,transparent)]'
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-[var(--radius-sm)] border px-[var(--space-2)] py-[2px] font-semibold uppercase tracking-[0.3px] ${toneClass}`}
    >
      {children}
    </span>
  )
}

function isTerminalLiveStatus(status: TicketSessionResponse['status'] | undefined) {
  return status === 'idle' || status === 'error' || status === 'interrupted'
}

function shouldShowTicketLiveSection(ticketStatus: TicketStatus, liveSession: TicketSessionResponse | null): boolean {
  if (ticketStatus === 'in-progress') return true
  if (!liveSession?.found) return false
  if (liveSession.status === 'running' || liveSession.status === 'waiting') return true
  if (ticketStatus !== 'blocked') return false
  return liveSession.status === 'error' || liveSession.status === 'interrupted' || liveSession.stalled === true
}

function formatRelativeMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return 'activity unknown'
  if (ms < 1000) return 'active just now'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `active ${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `active ${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return `active ${hours}h ago`
}

function formatInactivityMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return 'no activity'
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `no activity ${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `no activity ${minutes}m`
  const hours = Math.round(minutes / 60)
  return `no activity ${hours}h`
}

function formatCost(cost: number | undefined) {
  return `cost $${(cost ?? 0).toFixed(2)}`
}

function mapTailMessages(liveSession: TicketSessionResponse | null): Message[] {
  return (liveSession?.messages ?? []).map((message: TicketSessionMessage, index: number): Message => ({
    id: `${message.ts}-${index}`,
    role: message.role,
    content: message.text,
    timestamp: message.ts,
    toolCall: typeof message.toolCall === 'string' ? message.toolCall : undefined,
  }))
}

/* Main component */
interface TicketDetailPanelProps {
  ticket: KanbanTicket
  employees: Employee[]
  onClose: () => void
  onStatusChange: (status: TicketStatus) => void
  onComplexityChange: (complexity: TicketComplexity) => void
  onAssigneeChange: (employeeName: string | null) => void
  onRunNow: () => void
  onDelete: () => void
  onSaveDetails: (updates: Pick<KanbanTicket, 'title' | 'description' | 'resourcePath' | 'resourceUrl' | 'manualOnly'>) => void
  onAppendNote: (updates: { title: string; description: string; note: string }) => void
  onEscalateToLead?: () => void
}

export function TicketDetailPanel({
  ticket,
  employees,
  onClose,
  onStatusChange,
  onComplexityChange,
  onAssigneeChange,
  onRunNow,
  onDelete,
  onSaveDetails,
  onAppendNote,
  onEscalateToLead,
}: TicketDetailPanelProps) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const { subscribe } = useGateway()
  const pageVisible = usePageVisibility()
  const currentTicketIdRef = useRef(ticket.id)
  const [liveSession, setLiveSession] = useState<TicketSessionResponse | null>(null)
  const [liveLoading, setLiveLoading] = useState(false)
  if (currentTicketIdRef.current !== ticket.id) {
    // Reset synchronously during render so switching tickets doesn't flash the
    // previous ticket's live session (status/cost/messages) before the new
    // ticket's fetch resolves.
    currentTicketIdRef.current = ticket.id
    setLiveSession(null)
    setLiveLoading(false)
  }
  const [draftTitle, setDraftTitle] = useState(ticket.title)
  const [draftDescription, setDraftDescription] = useState(ticket.description)
  const [draftResourcePath, setDraftResourcePath] = useState<string | null>(ticket.resourcePath ?? null)
  const [draftResourceUrl, setDraftResourceUrl] = useState(ticket.resourceUrl ?? '')
  const [draftManualOnly, setDraftManualOnly] = useState(ticket.manualOnly === true)
  const [noteDraft, setNoteDraft] = useState('')

  // Escape key to close
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Focus close button on mount
  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  useEffect(() => {
    setDraftTitle(ticket.title)
    setDraftDescription(ticket.description)
    setDraftResourcePath(ticket.resourcePath ?? null)
    setDraftResourceUrl(ticket.resourceUrl ?? '')
    setDraftManualOnly(ticket.manualOnly === true)
    setNoteDraft('')
  }, [ticket.id, ticket.title, ticket.description, ticket.resourcePath, ticket.resourceUrl, ticket.manualOnly])

  function handleDelete() {
    onDelete()
  }

  function handleSaveDetails() {
    const title = draftTitle.trim()
    if (!title) return
    onSaveDetails({
      title,
      description: draftDescription,
      resourcePath: draftResourcePath?.trim() || undefined,
      resourceUrl: draftResourceUrl.trim() || undefined,
      manualOnly: draftManualOnly,
    })
  }

  function handleAppendNoteClick() {
    const title = draftTitle.trim()
    const note = noteDraft.trim()
    if (!title || !note) return
    onAppendNote({ title, description: draftDescription, note })
    setNoteDraft('')
  }

  const loadLiveSession = useCallback(async () => {
    const requestTicketId = ticket.id
    const isStale = () => currentTicketIdRef.current !== requestTicketId
    if (!ticket.departmentId) {
      if (isStale()) return
      setLiveSession({ found: false })
      setLiveLoading(false)
      return
    }
    setLiveLoading(true)
    try {
      const next = await api.getTicketSession(ticket.departmentId, requestTicketId)
      if (isStale()) return
      setLiveSession(next)
    } catch {
      if (isStale()) return
      setLiveSession({ found: false })
    } finally {
      if (!isStale()) setLiveLoading(false)
    }
  }, [ticket.departmentId, ticket.id])

  useEffect(() => {
    void loadLiveSession()
  }, [loadLiveSession])

  useEffect(() => {
    const shouldPoll =
      ticket.status === 'in-progress' &&
      (!liveSession?.found || !isTerminalLiveStatus(liveSession.status))
    if (!shouldPoll) return

    const unsubscribe = subscribe((event, payload) => {
      if (!liveSession?.sessionId) return
      const sessionId =
        payload && typeof payload === 'object' && 'sessionId' in payload
          ? String((payload as { sessionId?: unknown }).sessionId ?? '')
          : ''
      if (!sessionId || sessionId !== liveSession.sessionId) return
      if (event === 'session:delta' || event === 'session:completed' || event === 'session:started') {
        void loadLiveSession()
      }
    })

    let timer: number | null = null
    if (pageVisible) {
      timer = window.setInterval(() => {
        void loadLiveSession()
      }, LIVE_REFRESH_MS)
    }

    return () => {
      unsubscribe()
      if (timer !== null) window.clearInterval(timer)
    }
  }, [subscribe, ticket.status, liveSession?.found, liveSession?.sessionId, liveSession?.status, loadLiveSession, pageVisible])

  const assignee = employees.find(e => e.name === ticket.assigneeId) ?? null
  const accentColor = 'var(--accent)'
  const trimmedTitle = draftTitle.trim()
  const detailsDirty =
    trimmedTitle !== ticket.title ||
    draftDescription !== ticket.description ||
    (draftResourcePath ?? '') !== (ticket.resourcePath ?? '') ||
    draftResourceUrl !== (ticket.resourceUrl ?? '') ||
    draftManualOnly !== (ticket.manualOnly === true)
  const saveDetailsDisabled = trimmedTitle.length === 0 || !detailsDirty
  const appendNoteDisabled = trimmedTitle.length === 0 || noteDraft.trim().length === 0
  const runDisabled = !ticket.assigneeId || ticket.workState === 'starting'
  const runHelperText = !ticket.assigneeId
    ? 'Assign someone first.'
    : (ticket.workState === 'starting'
      ? 'Starting worker session…'
      : (ticket.manualOnly
        ? 'Manual-only ticket. It will never be launched by the board worker.'
        : 'Run immediately, bypassing idle and schedule gates.'))
  const transcriptMessages = useMemo(() => mapTailMessages(liveSession), [liveSession])
  const showLiveSection = shouldShowTicketLiveSection(ticket.status, liveSession)
  const showTranscript = transcriptMessages.length > 0 || liveSession?.status === 'running'
  const staleHint = liveSession?.status === 'running' && (liveSession.lastActivityAgoMs ?? 0) >= LIVE_STALE_HINT_MS
  const stalledLabel = liveSession?.stalled
    ? formatInactivityMs(liveSession.stalledForMs ?? liveSession.lastActivityAgoMs)
    : null
  const fallbackLabel = liveSession?.fallback?.active
    ? `running on fallback (${liveSession.fallback.toEngine || 'unknown'})`
    : null
  const liveStatusLabel = liveSession?.status ?? 'idle'
  const liveStatusColor = liveSession?.status === 'error'
    ? 'var(--system-red)'
    : liveSession?.status === 'waiting'
      ? 'var(--system-orange)'
      : liveSession?.status === 'interrupted'
        ? 'var(--text-tertiary)'
        : liveSession?.status === 'idle'
          ? 'var(--system-green)'
          : 'var(--system-blue)'

  return (
    <div
      className="absolute top-0 right-0 bottom-0 z-30"
    >
      <div
        className="w-[420px] max-w-[100vw] h-full bg-[var(--material-regular)] shadow-[var(--shadow-overlay)] flex flex-col"
      >
        {/* Color strip */}
        <div className="h-[3px] bg-[var(--accent)] shrink-0" />

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          {/* Panel controls */}
          <div className="pt-[var(--space-4)] px-[var(--space-5)] pb-0 flex justify-end gap-[var(--space-2)]">
            <button
              ref={closeRef}
              onClick={onClose}
              aria-label="Close detail panel"
              className="w-7 h-7 rounded-full flex items-center justify-center bg-[var(--fill-secondary)] text-[var(--text-secondary)] border-none cursor-pointer text-[length:var(--text-footnote)] transition-all duration-150 ease-[var(--ease-spring)]"
            >
              &#x2715;
            </button>
          </div>

          {/* Title + meta */}
          <div className="pt-[var(--space-2)] px-[var(--space-5)] pb-[var(--space-4)]">
            <label
              htmlFor={`ticket-title-${ticket.id}`}
              className="text-[length:var(--text-caption1)] font-semibold text-[var(--text-tertiary)] uppercase tracking-[0.5px]"
            >
              Title
            </label>
            <input
              id={`ticket-title-${ticket.id}`}
              aria-label="Title"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              className="mt-[var(--space-2)] w-full rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--fill-secondary)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-title3)] font-bold tracking-[-0.3px] text-[var(--text-primary)] outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--accent-fill)]"
            />

            <div className="flex items-center gap-[var(--space-3)] mt-[var(--space-2)]">
              <StatusBadge status={ticket.status} />
              <PriorityBadge priority={ticket.priority} />
              <span className="text-[length:var(--text-caption2)] font-semibold text-[var(--text-secondary)] bg-[var(--fill-tertiary)] px-[var(--space-2)] py-[2px] rounded-[var(--radius-sm)] uppercase tracking-[0.3px]">
                {ticket.complexity}
              </span>
              <span className="ml-auto text-[length:var(--text-caption2)] font-mono text-[var(--text-tertiary)]">
                ID: {ticket.id}
              </span>
            </div>

            {/* Assignee */}
            {assignee ? (
              <div className="flex items-center gap-[var(--space-2)] mt-[var(--space-3)] text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
                <span>{assignee.displayName}</span>
                <span className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] bg-[var(--fill-secondary)] rounded-[var(--radius-sm)] px-1">
                  {assignee.rank}
                </span>
              </div>
            ) : (
              <div className="mt-[var(--space-3)] text-[length:var(--text-footnote)] text-[var(--text-tertiary)] italic">
                Unassigned
              </div>
            )}
          </div>

          {/* Status controls */}
          <div className="px-[var(--space-5)] pb-[var(--space-4)]">
            <div className="text-[length:var(--text-caption1)] font-semibold text-[var(--text-tertiary)] uppercase tracking-[0.5px] mb-[var(--space-2)]">
              Move to
            </div>
            <div className="flex gap-[var(--space-1)] flex-wrap">
              {COLUMNS.map(col => {
                const isCurrent = col.id === ticket.status
                return (
                  <button
                    key={col.id}
                    onClick={() => { if (!isCurrent) onStatusChange(col.id) }}
                    disabled={isCurrent}
                    className="text-[length:var(--text-caption2)] font-semibold py-[3px] px-[var(--space-2)] rounded-[var(--radius-sm)] border-none transition-all duration-[120ms] ease-linear"
                    style={{
                      cursor: isCurrent ? 'default' : 'pointer',
                      background: isCurrent ? accentColor : 'var(--fill-tertiary)',
                      color: isCurrent ? 'var(--accent-contrast)' : 'var(--text-secondary)',
                      opacity: isCurrent ? 1 : 0.8,
                    }}
                  >
                    {col.title}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Assignee picker */}
          <div className="px-[var(--space-5)] pb-[var(--space-4)]">
            <div className="text-[length:var(--text-caption1)] font-semibold text-[var(--text-tertiary)] uppercase tracking-[0.5px] mb-[var(--space-2)]">
              Assignee
            </div>
            <EmployeePicker
              employees={employees}
              value={ticket.assigneeId ?? ''}
              onChange={(name) => onAssigneeChange(name || null)}
            />
          </div>

          <div className="px-[var(--space-5)] pb-[var(--space-4)]">
            <div className="text-[length:var(--text-caption1)] font-semibold text-[var(--text-tertiary)] uppercase tracking-[0.5px] mb-[var(--space-2)]">
              Complexity
            </div>
            <div className="flex gap-[var(--space-1)] flex-wrap">
              {COMPLEXITIES.map((complexity) => {
                const isCurrent = complexity === ticket.complexity
                return (
                  <button
                    key={complexity}
                    onClick={() => { if (!isCurrent) onComplexityChange(complexity) }}
                    disabled={isCurrent}
                    className="text-[length:var(--text-caption2)] font-semibold py-[3px] px-[var(--space-2)] rounded-[var(--radius-sm)] border-none transition-all duration-[120ms] ease-linear"
                    style={{
                      cursor: isCurrent ? 'default' : 'pointer',
                      background: isCurrent ? accentColor : 'var(--fill-tertiary)',
                      color: isCurrent ? 'var(--accent-contrast)' : 'var(--text-secondary)',
                      opacity: isCurrent ? 1 : 0.8,
                    }}
                  >
                    {COMPLEXITY_LABELS[complexity]}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Description */}
          <div className="px-[var(--space-5)] pb-[var(--space-4)]">
            <div className="h-px bg-[var(--separator)] mb-[var(--space-3)]" />
            <label
              htmlFor={`ticket-description-${ticket.id}`}
              className="text-[length:var(--text-caption1)] font-semibold text-[var(--text-tertiary)] uppercase tracking-[0.5px] mb-[var(--space-2)] block"
            >
              Description
            </label>
            <textarea
              id={`ticket-description-${ticket.id}`}
              aria-label="Description"
              rows={6}
              value={draftDescription}
              onChange={(e) => setDraftDescription(e.target.value)}
              className="w-full rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--fill-secondary)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--text-secondary)] leading-[1.5] outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--accent-fill)] resize-y"
            />
            <div className="mt-[var(--space-3)] text-[length:var(--text-caption1)] font-semibold text-[var(--text-tertiary)] uppercase tracking-[0.5px] mb-[var(--space-2)]">
              Ticket context
            </div>
            <div className="flex items-center gap-[var(--space-2)] mb-[var(--space-2)]">
              <FolderPicker
                value={draftResourcePath}
                onChange={(cwd) => {
                  setDraftResourcePath(cwd)
                  if (cwd) setDraftResourceUrl('')
                }}
              />
              <span className="min-w-0 truncate text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
                {draftResourcePath || 'No local directory selected'}
              </span>
            </div>
            <input
              aria-label="Ticket URL"
              type="url"
              placeholder="https://example.com/reference"
              value={draftResourceUrl}
              onChange={(e) => {
                const next = e.target.value
                setDraftResourceUrl(next)
                if (next.trim()) setDraftResourcePath(null)
              }}
              className="w-full rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--fill-secondary)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--text-secondary)] leading-[1.5] outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--accent-fill)]"
            />
            <label className="mt-[var(--space-3)] flex items-center gap-[var(--space-2)] text-[length:var(--text-caption2)] text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={draftManualOnly}
                onChange={(e) => setDraftManualOnly(e.target.checked)}
              />
              <span>Manual only</span>
              <span className="text-[var(--text-tertiary)]">Skip board-worker auto-dispatch.</span>
            </label>
            <div className="mt-[var(--space-2)] flex justify-end">
              <button
                onClick={handleSaveDetails}
                disabled={saveDetailsDisabled}
                className="rounded-[var(--radius-md)] border-none px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-footnote)] font-semibold transition-all duration-[120ms] ease-linear"
                style={{
                  background: saveDetailsDisabled ? 'var(--fill-tertiary)' : 'var(--accent)',
                  color: saveDetailsDisabled ? 'var(--text-tertiary)' : 'var(--accent-contrast)',
                  cursor: saveDetailsDisabled ? 'default' : 'pointer',
                }}
              >
                Save changes
              </button>
            </div>
          </div>

          <div className="px-[var(--space-5)] pb-[var(--space-4)]">
            <div className="text-[length:var(--text-caption1)] font-semibold text-[var(--text-tertiary)] uppercase tracking-[0.5px] mb-[var(--space-2)]">
              Append note
            </div>
            <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mb-[var(--space-2)]">
              Adds a timestamped update to the description so provenance stays visible.
            </div>
            <textarea
              id={`ticket-note-${ticket.id}`}
              aria-label="Append note"
              rows={4}
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="Add a timestamped update…"
              className="w-full rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--fill-secondary)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--text-secondary)] leading-[1.5] outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--accent-fill)] resize-y"
            />
            <div className="mt-[var(--space-2)] flex justify-end">
              <button
                onClick={handleAppendNoteClick}
                disabled={appendNoteDisabled}
                className="rounded-[var(--radius-md)] border border-[var(--separator)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-footnote)] font-semibold transition-all duration-[120ms] ease-linear"
                style={{
                  background: appendNoteDisabled ? 'var(--fill-tertiary)' : 'var(--fill-secondary)',
                  color: appendNoteDisabled ? 'var(--text-tertiary)' : 'var(--text-primary)',
                  cursor: appendNoteDisabled ? 'default' : 'pointer',
                }}
              >
                Append note
              </button>
            </div>
          </div>

          {showLiveSection && (
            <div className="px-[var(--space-5)] pb-[var(--space-4)]">
              <div className="h-px bg-[var(--separator)] mb-[var(--space-3)]" />
              <div className="flex items-center justify-between gap-[var(--space-3)] mb-[var(--space-2)]">
                <div className="text-[length:var(--text-caption1)] font-semibold text-[var(--text-tertiary)] uppercase tracking-[0.5px]">
                  Live session
                </div>
                {liveSession?.found && liveSession.sessionId && (
                  <a
                    href={`/?session=${encodeURIComponent(liveSession.sessionId)}`}
                    className="text-[length:var(--text-caption2)] font-semibold text-[var(--system-blue)] cursor-pointer no-underline"
                  >
                    Open live session
                  </a>
                )}
              </div>

              {!liveSession?.found && !liveLoading ? (
                <div className="text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
                  No active session for this ticket.
                </div>
              ) : liveSession?.found ? (
                <>
                  <div className="rounded-[var(--radius-md)] bg-[var(--fill-secondary)] px-[var(--space-3)] py-[var(--space-3)]">
                    <div className="flex items-center flex-wrap gap-[var(--space-2)] text-[length:var(--text-caption2)] text-[var(--text-secondary)]">
                      <span className="inline-flex items-center gap-[6px] font-semibold uppercase tracking-[0.3px]">
                        <span className="w-2 h-2 rounded-full" style={{ background: liveStatusColor }} />
                        {liveStatusLabel}
                      </span>
                      {liveSession.stalled && (
                        <LiveBadge tone="red" title={stalledLabel ?? undefined}>
                          stalled
                        </LiveBadge>
                      )}
                      {liveSession.fallback?.active && (
                        <LiveBadge tone="amber" title={fallbackLabel ?? undefined}>
                          fallback
                        </LiveBadge>
                      )}
                      <span>{liveSession.engine || 'unknown engine'} · {liveSession.model || 'default model'}</span>
                      <span>{formatCost(liveSession.totalCost)}</span>
                      <span>{formatRelativeMs(liveSession.lastActivityAgoMs)}</span>
                      {staleHint && <span className="text-[var(--system-orange)]">stale?</span>}
                    </div>
                    {liveSession.lastError && (
                      <div className="mt-[var(--space-2)] max-h-24 overflow-y-auto rounded text-[length:var(--text-caption2)] text-[var(--system-red)] whitespace-pre-wrap">
                        {liveSession.lastError}
                      </div>
                    )}
                  </div>

                  <div className="mt-[var(--space-3)]">
                    <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mb-[var(--space-2)]">
                      Showing latest {LIVE_TRANSCRIPT_LIMIT} messages. Open live session for full history.
                    </div>
                    {showTranscript ? (
                      <div className="rounded-[var(--radius-md)] border border-[var(--separator)] overflow-y-auto h-[280px] bg-[var(--bg)]">
                        <ChatMessages
                          messages={transcriptMessages}
                          loading={liveSession.status === 'running'}
                          streamingText=""
                        />
                      </div>
                    ) : (
                      <div className="text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
                        No transcript yet.
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
                  Loading live session…
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="shrink-0 py-[var(--space-2)] px-[var(--space-5)] pb-[var(--space-4)] border-t border-[var(--separator)]">
          <button
            onClick={onRunNow}
            disabled={runDisabled}
            className="w-full py-[var(--space-2)] px-[var(--space-3)] rounded-[var(--radius-md)] border-none text-[var(--accent-contrast)] text-[length:var(--text-footnote)] font-semibold transition-all duration-[120ms] ease-linear mb-[var(--space-2)]"
            style={{
              background: runDisabled ? 'var(--fill-tertiary)' : 'var(--accent)',
              color: runDisabled ? 'var(--text-tertiary)' : 'var(--accent-contrast)',
              cursor: runDisabled ? 'default' : 'pointer',
            }}
          >
            {ticket.workState === 'starting' ? 'Starting…' : 'Run now'}
          </button>
          <div className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mb-[var(--space-3)]">
            {runHelperText}
          </div>
          {ticket.status === 'blocked' && onEscalateToLead && (
            <button
              onClick={onEscalateToLead}
              className="w-full py-[var(--space-2)] px-[var(--space-3)] rounded-[var(--radius-md)] border border-[var(--system-orange)] bg-transparent text-[var(--system-orange)] text-[length:var(--text-footnote)] font-semibold cursor-pointer transition-all duration-[120ms] ease-linear mb-[var(--space-2)]"
            >
              Escalate to Lead
            </button>
          )}
          <button
            onClick={handleDelete}
            className="w-full py-[var(--space-2)] px-[var(--space-3)] rounded-[var(--radius-md)] border border-[var(--system-red)] bg-transparent text-[var(--system-red)] text-[length:var(--text-footnote)] font-semibold cursor-pointer transition-all duration-[120ms] ease-linear"
          >
            Delete Ticket
          </button>
        </div>
      </div>
    </div>
  )
}
