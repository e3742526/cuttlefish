import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TicketDetailPanel } from '../ticket-detail-panel'
import type { TicketSessionResponse } from '@/lib/api'
import type { KanbanTicket } from '@/lib/kanban/types'

const { getTicketSession, subscribeMock } = vi.hoisted(() => ({
  getTicketSession: vi.fn<(department: string, ticketId: string) => Promise<TicketSessionResponse>>(),
  subscribeMock: vi.fn<(fn: (event: string, payload: unknown) => void) => () => void>(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: {
      ...actual.api,
      getTicketSession,
    },
  }
})

vi.mock('@/hooks/use-gateway', () => ({
  useGateway: () => ({
    subscribe: subscribeMock,
  }),
}))

vi.mock('../employee-picker', () => ({
  EmployeePicker: () => <div data-testid="employee-picker" />,
}))

vi.mock('@/components/chat/folder-picker', () => ({
  FolderPicker: () => <div data-testid="folder-picker" />,
}))

vi.mock('@/components/chat/chat-messages', () => ({
  ChatMessages: ({ messages }: { messages: Array<{ content: string }> }) => (
    <div data-testid="chat-messages">{messages.map((message) => message.content).join('|')}</div>
  ),
}))

const baseTicket: KanbanTicket = {
  id: 'ticket-live',
  title: 'Live worker',
  description: 'Watch the session',
  status: 'in-progress',
  priority: 'medium',
  complexity: 'medium',
  assigneeId: 'worker',
  department: 'software-delivery',
  workState: 'working',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  departmentId: 'software-delivery',
}

const employees = [
  {
    name: 'worker',
    displayName: 'Worker',
    department: 'software-delivery',
    rank: 'employee' as const,
    engine: 'claude',
    model: 'opus',
    persona: '',
  },
]

function renderPanel(
  ticket: KanbanTicket = baseTicket,
  overrides: {
    onClose?: () => void
    onStatusChange?: (status: KanbanTicket['status']) => void
    onComplexityChange?: (complexity: KanbanTicket['complexity']) => void
    onAssigneeChange?: (employeeName: string | null) => void
    onRunNow?: () => void
    onDelete?: () => void
    onSaveDetails?: (updates: Pick<KanbanTicket, 'title' | 'description' | 'resourcePath' | 'resourceUrl' | 'manualOnly'>) => void
    onAppendNote?: (updates: { title: string; description: string; note: string }) => void
  } = {},
) {
  return render(
    <MemoryRouter>
      <TicketDetailPanel
        ticket={ticket}
        employees={employees}
        onClose={overrides.onClose ?? vi.fn()}
        onStatusChange={overrides.onStatusChange ?? vi.fn()}
        onComplexityChange={overrides.onComplexityChange ?? vi.fn()}
        onAssigneeChange={overrides.onAssigneeChange ?? vi.fn()}
        onRunNow={overrides.onRunNow ?? vi.fn()}
        onDelete={overrides.onDelete ?? vi.fn()}
        onSaveDetails={overrides.onSaveDetails ?? vi.fn()}
        onAppendNote={overrides.onAppendNote ?? vi.fn()}
      />
    </MemoryRouter>,
  )
}

describe('TicketDetailPanel', () => {
  beforeEach(() => {
    getTicketSession.mockReset()
    subscribeMock.mockReset()
    subscribeMock.mockReturnValue(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('saves edited title and description', async () => {
    getTicketSession.mockResolvedValue({ found: false })
    const onSaveDetails = vi.fn()

    renderPanel(baseTicket, { onSaveDetails })
    await waitFor(() => expect(getTicketSession).toHaveBeenCalled())

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Updated worker ticket' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Updated ticket description' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))

    expect(onSaveDetails).toHaveBeenCalledWith({
      title: 'Updated worker ticket',
      description: 'Updated ticket description',
      resourcePath: undefined,
      resourceUrl: undefined,
      manualOnly: false,
    })
  })

  it('appends a note using the current draft ticket state', async () => {
    getTicketSession.mockResolvedValue({ found: false })
    const onAppendNote = vi.fn()

    renderPanel(baseTicket, { onAppendNote })
    await waitFor(() => expect(getTicketSession).toHaveBeenCalled())

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Edited first line' } })
    fireEvent.change(screen.getByLabelText('Append note'), { target: { value: '  Added provenance note  ' } })
    fireEvent.click(screen.getByRole('button', { name: /^append note$/i }))

    expect(onAppendNote).toHaveBeenCalledWith({
      title: 'Live worker',
      description: 'Edited first line',
      note: 'Added provenance note',
    })
    expect((screen.getByLabelText('Append note') as HTMLTextAreaElement).value).toBe('')
  })

  it('shows live session header fields from the resolver response', async () => {
    getTicketSession.mockResolvedValue({
      found: true,
      sessionId: 's1',
      status: 'running',
      engine: 'claude',
      model: 'opus',
      totalCost: 12.34,
      lastActivityIso: '2026-06-22T10:00:00.000Z',
      lastActivityAgoMs: 4000,
      messages: [
        { role: 'assistant', text: 'Thinking through it', ts: 1, kind: 'message' },
        { role: 'assistant', text: 'Used read', ts: 2, kind: 'tool_call', toolCall: 'read' },
      ],
    })

    renderPanel()

    expect(await screen.findByText('Live session')).toBeDefined()
    expect(screen.getByText(/running/i)).toBeDefined()
    expect(screen.getByText('claude · opus')).toBeDefined()
    expect(screen.getByText('cost $12.34')).toBeDefined()
    expect(screen.getByText('active 4s ago')).toBeDefined()
    expect(screen.getByText(/Showing latest 8 messages/i)).toBeDefined()
    expect(screen.getByTestId('chat-messages').textContent).toContain('Thinking through it')
  })

  it('renders stalled and fallback header badges from live session metadata', async () => {
    getTicketSession.mockResolvedValue({
      found: true,
      sessionId: 's-badges',
      status: 'running',
      engine: 'codex',
      model: 'gpt-5.5',
      lastActivityIso: '2026-06-22T10:00:00.000Z',
      lastActivityAgoMs: 120000,
      stalled: true,
      stalledForMs: 120000,
      failureReason: 'timeout',
      fallback: {
        active: true,
        fromEngine: 'claude',
        toEngine: 'codex',
        toModel: 'gpt-5.5',
      },
      messages: [],
    })

    renderPanel()

    expect(await screen.findByText('stalled')).toBeDefined()
    expect(screen.getByText('fallback')).toBeDefined()
  })

  it('renders an open-live-session link that targets the chat route directly', async () => {
    getTicketSession.mockResolvedValue({
      found: true,
      sessionId: 's-link',
      status: 'running',
      engine: 'claude',
      model: 'opus',
      lastActivityIso: '2026-06-22T10:00:00.000Z',
      lastActivityAgoMs: 4000,
      messages: [],
    })

    renderPanel()

    const link = await screen.findByRole('link', { name: /open live session/i })
    expect(link.getAttribute('href')).toBe('/?session=s-link')
  })

  it('hides the live session section when the ticket is not in progress and no session is found', async () => {
    getTicketSession.mockResolvedValue({ found: false })

    renderPanel({ ...baseTicket, status: 'done' })

    await waitFor(() => expect(getTicketSession).toHaveBeenCalled())
    expect(screen.queryByText('Live session')).toBeNull()
    expect(screen.queryByText(/No active session for this ticket/i)).toBeNull()
  })

  it('unsubscribes and clears the polling interval on unmount', async () => {
    const unsubscribe = vi.fn()
    subscribeMock.mockReturnValue(unsubscribe)
    getTicketSession.mockResolvedValue({
      found: true,
      sessionId: 's-cleanup',
      status: 'running',
      engine: 'claude',
      model: 'opus',
      lastActivityIso: '2026-06-22T10:00:00.000Z',
      lastActivityAgoMs: 2000,
      messages: [],
    })
    const setSpy = vi.spyOn(window, 'setInterval').mockReturnValue(123 as unknown as ReturnType<typeof setInterval>)
    const clearSpy = vi.spyOn(window, 'clearInterval')

    const view = renderPanel()
    await waitFor(() => expect(getTicketSession).toHaveBeenCalled())

    view.unmount()

    expect(setSpy).toHaveBeenCalled()
    expect(unsubscribe.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(clearSpy).toHaveBeenCalledWith(123)
  })
})
