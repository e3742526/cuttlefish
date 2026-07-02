
import { useCallback, useEffect, useRef } from 'react'
import { COLUMNS } from '@/lib/kanban/types'
import type { KanbanTicket, TicketStatus } from '@/lib/kanban/types'
import type { KanbanStore } from '@/lib/kanban/store'
import { getTicketsByStatus } from '@/lib/kanban/store'
import type { Employee } from '@/lib/api'
import { KanbanColumn } from './kanban-column'
import { TicketCard } from './ticket-card'

// When a card is dragged near the left/right edge of the board, auto-scroll so
// off-screen columns become reachable without dropping and re-dragging. Distance
// into the edge zone controls speed (px per animation frame).
const EDGE_ZONE_PX = 64
const MAX_EDGE_SPEED_PX = 24

interface KanbanBoardProps {
  tickets: KanbanStore
  employees: Employee[]
  onTicketClick: (ticket: KanbanTicket) => void
  onMoveTicket: (ticketId: string, status: TicketStatus) => void
  onCreateTicket: () => void
  onDeleteTicket?: (ticket: KanbanTicket) => void
  filterEmployeeId?: string | null
}

export function KanbanBoard({
  tickets,
  employees,
  onTicketClick,
  onMoveTicket,
  onCreateTicket,
  onDeleteTicket,
  filterEmployeeId,
}: KanbanBoardProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const edgeVelocity = useRef(0)
  const rafId = useRef<number | null>(null)

  const stopEdgeScroll = useCallback(() => {
    edgeVelocity.current = 0
    if (rafId.current !== null) {
      cancelAnimationFrame(rafId.current)
      rafId.current = null
    }
  }, [])

  const step = useCallback(() => {
    const el = scrollRef.current
    if (el && edgeVelocity.current !== 0) {
      el.scrollLeft += edgeVelocity.current
      rafId.current = requestAnimationFrame(step)
    } else {
      rafId.current = null
    }
  }, [])

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const el = scrollRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const fromLeft = e.clientX - rect.left
      const fromRight = rect.right - e.clientX
      let velocity = 0
      if (fromLeft < EDGE_ZONE_PX) {
        velocity = -Math.ceil(((EDGE_ZONE_PX - fromLeft) / EDGE_ZONE_PX) * MAX_EDGE_SPEED_PX)
      } else if (fromRight < EDGE_ZONE_PX) {
        velocity = Math.ceil(((EDGE_ZONE_PX - fromRight) / EDGE_ZONE_PX) * MAX_EDGE_SPEED_PX)
      }
      edgeVelocity.current = velocity
      if (velocity !== 0 && rafId.current === null) {
        rafId.current = requestAnimationFrame(step)
      } else if (velocity === 0) {
        stopEdgeScroll()
      }
    },
    [step, stopEdgeScroll],
  )

  useEffect(() => stopEdgeScroll, [stopEdgeScroll])

  return (
    <div
      ref={scrollRef}
      onDragOver={handleDragOver}
      onDrop={stopEdgeScroll}
      onDragLeave={(e) => {
        // Stop only when the pointer actually leaves the board, not when it moves
        // over a child column. e.relatedTarget is unreliable during dragleave (null
        // in Safari), so test the pointer against the board's bounding box instead.
        const rect = e.currentTarget.getBoundingClientRect()
        if (
          e.clientX < rect.left ||
          e.clientX >= rect.right ||
          e.clientY < rect.top ||
          e.clientY >= rect.bottom
        ) {
          stopEdgeScroll()
        }
      }}
      onDragEnd={stopEdgeScroll}
      style={{
        display: 'flex',
        gap: 'var(--space-3)',
        height: '100%',
        overflowX: 'auto',
        overflowY: 'hidden',
        padding: 'var(--space-2) 0',
        WebkitOverflowScrolling: 'touch',
      }}
    >
      {COLUMNS.map((column) => {
        const allColumnTickets = getTicketsByStatus(tickets, column.id)
        const columnTickets = filterEmployeeId
          ? allColumnTickets.filter((t) => t.assigneeId === filterEmployeeId)
          : allColumnTickets

        return (
          <KanbanColumn
            key={column.id}
            column={column}
            tickets={columnTickets}
            onDrop={onMoveTicket}
            onCreateTicket={column.id === 'backlog' ? onCreateTicket : undefined}
            renderTicket={(ticket) => {
              const emp = employees.find((e) => e.name === ticket.assigneeId)
              return (
                <TicketCard
                  ticket={ticket}
                  assigneeName={emp?.displayName ?? null}
                  onClick={() => onTicketClick(ticket)}
                  onDelete={onDeleteTicket ? () => onDeleteTicket(ticket) : undefined}
                />
              )
            }}
          />
        )
      })}
    </div>
  )
}
