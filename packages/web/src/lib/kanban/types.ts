// Kanban board types

export type TicketStatus = 'backlog' | 'todo' | 'in-progress' | 'review' | 'blocked' | 'done'

export type TicketPriority = 'low' | 'medium' | 'high'

export type TicketComplexity = 'low' | 'medium' | 'high'

export type WorkState = 'idle' | 'starting' | 'working' | 'done' | 'failed'

export interface KanbanTicket {
  id: string
  title: string
  description: string
  resourcePath?: string
  resourceUrl?: string
  manualOnly?: boolean
  status: TicketStatus
  priority: TicketPriority
  complexity: TicketComplexity
  assigneeId: string | null // employee name from /api/org
  source?: string
  sessionId?: string
  department: string | null // department for API persistence
  workState: WorkState
  createdAt: number
  updatedAt: number
  /** Last server-observed board version used for optimistic concurrency. */
  baseUpdatedAt?: number
  /** The department this ticket belongs to; null for tickets not yet saved to any department */
  departmentId: string | null
}

export interface KanbanColumn {
  id: TicketStatus
  title: string
}

export const COLUMNS: KanbanColumn[] = [
  { id: 'backlog', title: 'Backlog' },
  { id: 'todo', title: 'To Do' },
  { id: 'in-progress', title: 'In Progress' },
  { id: 'review', title: 'Review' },
  { id: 'blocked', title: 'Blocked' },
  { id: 'done', title: 'Done' },
]

export const PRIORITY_COLORS: Record<TicketPriority, string> = {
  low: 'var(--system-green)',
  medium: 'var(--system-orange)',
  high: 'var(--system-red)',
}
