
import { useState, useCallback } from 'react'
import { Plus } from 'lucide-react'
import type { Employee } from '@/lib/api'
import type { TicketComplexity, TicketPriority } from '@/lib/kanban/types'
import { PRIORITY_COLORS } from '@/lib/kanban/types'
import { EmployeePicker } from './employee-picker'
import { FolderPicker } from '@/components/chat/folder-picker'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'

interface CreateTicketModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  employees: Employee[]
  onSubmit: (ticket: {
    title: string
    description: string
    resourcePath?: string
    resourceUrl?: string
    manualOnly?: boolean
    priority: TicketPriority
    complexity: TicketComplexity
    assigneeId: string | null
  }) => void
}

const PRIORITIES: TicketPriority[] = ['low', 'medium', 'high']
const COMPLEXITIES: TicketComplexity[] = ['low', 'medium', 'high']
const PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}
const COMPLEXITY_LABELS: Record<TicketComplexity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

const initialState = {
  title: '',
  description: '',
  priority: 'medium' as TicketPriority,
  complexity: 'medium' as TicketComplexity,
  assigneeId: '' as string,
  resourcePath: null as string | null,
  resourceUrl: '',
  manualOnly: false,
}

/** The server requires ticket-context URLs to be absolute http(s) (see
 *  board-service assertValidBoardTicket). Validate client-side so an invalid URL
 *  gets an inline message instead of a silently-rejected submit. */
function resourceUrlError(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return 'Enter a valid URL, e.g. https://example.com/reference'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'URL must start with http:// or https://'
  }
  return null
}

export function CreateTicketModal({
  open,
  onOpenChange,
  employees,
  onSubmit,
}: CreateTicketModalProps) {
  const [form, setForm] = useState(initialState)
  const [urlError, setUrlError] = useState<string | null>(null)

  const resetForm = useCallback(() => {
    setForm(initialState)
    setUrlError(null)
  }, [])

  function handleOpenChange(next: boolean) {
    if (!next) resetForm()
    onOpenChange(next)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.title.trim()) return

    const urlErr = resourceUrlError(form.resourceUrl)
    if (urlErr) {
      setUrlError(urlErr)
      return
    }

    onSubmit({
      title: form.title.trim(),
      description: form.description.trim(),
      resourcePath: form.resourcePath?.trim() || undefined,
      resourceUrl: form.resourceUrl.trim() || undefined,
      manualOnly: form.manualOnly,
      priority: form.priority,
      complexity: form.complexity,
      assigneeId: form.assigneeId || null,
    })

    resetForm()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton
        className="bg-[var(--bg)] border border-[var(--separator)] rounded-[var(--radius-lg)] shadow-[var(--shadow-card)] max-w-[480px]"
      >
        <DialogHeader>
          <DialogTitle
            className="text-[length:var(--text-title3)] font-[var(--weight-bold)] text-[var(--text-primary)]"
          >
            Create Ticket
          </DialogTitle>
          <DialogDescription
            className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]"
          >
            Add a new ticket to the backlog.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-[var(--space-4)]"
        >
          {/* Title */}
          <div className="flex flex-col gap-[var(--space-1)]">
            <label
              htmlFor="ticket-title"
              className="text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)]"
            >
              Title
            </label>
            <input
              id="ticket-title"
              type="text"
              placeholder="What needs to be done?"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              required
              autoFocus
              className="text-[length:var(--text-body)] text-[var(--text-primary)] py-2 px-3 border border-[var(--separator)] rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--accent-fill)] font-[inherit]"
            />
          </div>

          {/* Description */}
          <div className="flex flex-col gap-[var(--space-1)]">
            <label
              htmlFor="ticket-description"
              className="text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)]"
            >
              Description
            </label>
            <textarea
              id="ticket-description"
              placeholder="Add details..."
              rows={3}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              className="text-[length:var(--text-body)] text-[var(--text-primary)] resize-y min-h-[72px] py-2 px-3 border border-[var(--separator)] rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--accent-fill)] font-[inherit]"
            />
          </div>

          {/* Priority */}
          <div className="flex flex-col gap-[var(--space-2)]">
            <span
              className="text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)]"
            >
              Priority
            </span>
            <div className="flex gap-[var(--space-2)]">
              {PRIORITIES.map((p) => {
                const isSelected = form.priority === p
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, priority: p }))}
                    className="flex-1 flex items-center justify-center gap-[var(--space-1)] py-[var(--space-2)] px-[var(--space-3)] rounded-[var(--radius-md)] cursor-pointer text-[length:var(--text-caption1)] font-[var(--weight-medium)] transition-all duration-150 ease-[var(--ease-smooth)]"
                    style={{
                      border: isSelected
                        ? `2px solid ${PRIORITY_COLORS[p]}`
                        : '2px solid var(--separator)',
                      background: isSelected ? 'var(--fill-tertiary)' : 'transparent',
                      color: isSelected ? 'var(--text-primary)' : 'var(--text-tertiary)',
                    }}
                  >
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: PRIORITY_COLORS[p] }}
                    />
                    {PRIORITY_LABELS[p]}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Complexity */}
          <div className="flex flex-col gap-[var(--space-2)]">
            <span
              className="text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)]"
            >
              Complexity
            </span>
            <div className="flex gap-[var(--space-2)]">
              {COMPLEXITIES.map((complexity) => {
                const isSelected = form.complexity === complexity
                return (
                  <button
                    key={complexity}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, complexity }))}
                    className="flex-1 flex items-center justify-center py-[var(--space-2)] px-[var(--space-3)] rounded-[var(--radius-md)] cursor-pointer text-[length:var(--text-caption1)] font-[var(--weight-medium)] transition-all duration-150 ease-[var(--ease-smooth)]"
                    style={{
                      border: isSelected
                        ? '2px solid var(--accent)'
                        : '2px solid var(--separator)',
                      background: isSelected ? 'var(--fill-tertiary)' : 'transparent',
                      color: isSelected ? 'var(--text-primary)' : 'var(--text-tertiary)',
                    }}
                  >
                    {COMPLEXITY_LABELS[complexity]}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Assignee */}
          <div className="flex flex-col gap-[var(--space-1)]">
            <label
              className="text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)]"
            >
              Assignee
            </label>
            <EmployeePicker
              employees={employees}
              value={form.assigneeId}
              onChange={(name) => setForm((f) => ({ ...f, assigneeId: name }))}
            />
          </div>

          <div className="flex flex-col gap-[var(--space-2)]">
            <span className="text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-secondary)]">
              Ticket context
            </span>
            <div className="flex items-center gap-[var(--space-2)]">
              <FolderPicker
                value={form.resourcePath}
                onChange={(cwd) => setForm((f) => ({ ...f, resourcePath: cwd, resourceUrl: cwd ? '' : f.resourceUrl }))}
              />
              <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] truncate">
                {form.resourcePath || 'No local directory selected'}
              </span>
            </div>
            <input
              type="url"
              aria-label="Reference URL"
              placeholder="https://example.com/reference"
              value={form.resourceUrl}
              aria-invalid={urlError ? true : undefined}
              onChange={(e) => {
                if (urlError) setUrlError(null)
                setForm((f) => ({ ...f, resourceUrl: e.target.value, resourcePath: e.target.value.trim() ? null : f.resourcePath }))
              }}
              className="text-[length:var(--text-body)] text-[var(--text-primary)] py-2 px-3 border rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--accent-fill)] font-[inherit]"
              style={{ borderColor: urlError ? 'var(--system-red)' : 'var(--separator)' }}
            />
            {urlError ? (
              <div className="text-[length:var(--text-caption1)]" style={{ color: 'var(--system-red)' }}>
                {urlError}
              </div>
            ) : (
              <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                Add either one local directory or one URL for the agent to inspect when this ticket runs.
              </div>
            )}
          </div>

          <label className="flex items-center gap-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={form.manualOnly}
              onChange={(e) => setForm((f) => ({ ...f, manualOnly: e.target.checked }))}
            />
            <span>Manual only</span>
            <span className="text-[var(--text-tertiary)]">No automatic board-worker runs.</span>
          </label>

          {/* Submit */}
          {!form.title.trim() && (
            <p className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] -mt-[var(--space-2)]">
              Title is required
            </p>
          )}
          <button
            type="submit"
            disabled={!form.title.trim()}
            title={form.title.trim() ? undefined : 'Title is required'}
            aria-label={form.title.trim() ? 'Create ticket' : 'Create ticket — title is required'}
            className="rounded-[var(--radius-md)] py-3 px-5 w-full text-[length:var(--text-body)] font-[var(--weight-semibold)] border-none flex items-center justify-center gap-[var(--space-2)] mt-[var(--space-2)] transition-opacity duration-150 ease-linear"
            style={{
              cursor: form.title.trim() ? 'pointer' : 'default',
              opacity: form.title.trim() ? 1 : 0.5,
              background: 'var(--accent-bg)',
              color: 'var(--accent-contrast)',
              boxShadow: 'var(--accent-glow)',
            }}
          >
            <Plus size={16} />
            Create Ticket
          </button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
