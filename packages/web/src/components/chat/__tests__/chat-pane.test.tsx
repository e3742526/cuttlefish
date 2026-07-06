import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type React from 'react'
import { ChatPane } from '../chat-pane'

vi.mock('@/lib/api', () => ({ api: {} }))

vi.mock('@/hooks/use-employees', () => ({
  useOrg: () => ({ data: { employees: [] } }),
  useWorkspaceProfiles: () => ({ data: { profiles: [] } }),
}))

interface LiveSessionMockState {
  messages: unknown[]
  streamingText: string
  loading: boolean
  hydrating: boolean
  session: Record<string, unknown> | null
  error: Error | null
  liveContextTokens: number | null
  backgroundActivity: unknown
  reload: ReturnType<typeof vi.fn>
  beginSend: ReturnType<typeof vi.fn>
  failSend: ReturnType<typeof vi.fn>
  appendLocal: ReturnType<typeof vi.fn>
  reset: ReturnType<typeof vi.fn>
}

const liveSessionDefaults: LiveSessionMockState = {
  messages: [],
  streamingText: '',
  loading: false,
  hydrating: false,
  session: { id: 's1', status: 'idle', engine: 'claude', model: 'opus' },
  error: null,
  liveContextTokens: null,
  backgroundActivity: null,
  reload: vi.fn(),
  beginSend: vi.fn(),
  failSend: vi.fn(),
  appendLocal: vi.fn(),
  reset: vi.fn(),
}

let liveSessionState: LiveSessionMockState

vi.mock('@/hooks/use-live-session', () => ({
  useLiveSession: () => liveSessionState,
}))

vi.mock('@/components/chat/chat-input', () => ({
  ChatInput: ({ selectorSlot }: { selectorSlot?: React.ReactNode }) => (
    <div data-testid="chat-input">{selectorSlot}</div>
  ),
}))

vi.mock('@/components/chat/model-selector-row', () => ({
  ModelSelectorRow: ({ onNewChat }: { onNewChat?: () => void }) => (
    <button type="button" onClick={onNewChat}>selector new chat</button>
  ),
}))

vi.mock('@/components/chat/chat-messages', () => ({
  ChatMessages: () => <div data-testid="messages" />,
}))

vi.mock('@/components/chat/chat-employee-picker', () => ({
  ChatEmployeePicker: () => <div data-testid="employee-picker" />,
}))

vi.mock('@/components/chat/queue-panel', () => ({
  QueuePanel: () => null,
}))

vi.mock('@/components/chat/background-activity-pill', () => ({
  BackgroundActivityPill: () => null,
}))

vi.mock('@/components/chat/session-human-review', () => ({
  SessionHumanReview: ({ sessionId }: { sessionId: string | null }) => (
    <div data-testid="session-human-review">{sessionId}</div>
  ),
}))

vi.mock('@/components/chat/archive-dialog', () => ({
  ArchiveDialog: () => null,
}))

vi.mock('@/components/chat/cli-keybar', () => ({
  CliKeybar: () => null,
}))

function renderPane(props: Partial<React.ComponentProps<typeof ChatPane>> = {}) {
  return render(
    <ChatPane
      sessionId="s1"
      isActive
      onFocus={() => {}}
      subscribe={() => () => {}}
      events={[]}
      {...props}
    />,
  )
}

describe('ChatPane', () => {
  beforeEach(() => {
    liveSessionState = { ...liveSessionDefaults }
  })

  it('routes existing-chat engine switching to the parent new-chat flow', () => {
    const onNewChat = vi.fn()
    renderPane({ onNewChat })

    fireEvent.click(screen.getByRole('button', { name: /selector new chat/i }))

    expect(onNewChat).toHaveBeenCalledTimes(1)
  })

  it('shows a lightweight loading status instead of an empty new-chat picker while a session hydrates', () => {
    liveSessionState = { ...liveSessionDefaults, hydrating: true, session: null }

    renderPane()

    expect(screen.getByRole('status', { name: /loading chat/i })).toBeTruthy()
    expect(screen.queryByTestId('employee-picker')).toBeNull()
  })

  it('renders the session-scoped human review strip for the active chat', () => {
    renderPane({ sessionId: 'hr-session-1' })

    expect(screen.getByTestId('session-human-review').textContent).toBe('hr-session-1')
  })
})
