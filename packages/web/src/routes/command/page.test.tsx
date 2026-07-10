import { describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { render, screen } from '@testing-library/react'
import { runAxe, formatViolations } from '@/test/axe'

vi.mock('@/components/page-layout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@/context/breadcrumb-context', () => ({
  useBreadcrumbs: () => undefined,
}))

const commandCenterState = vi.hoisted(() => ({
  data: {
    generatedAt: '2026-07-01T00:00:00Z',
    summary: { agents: 5, agentsRunning: 2, cronJobs: 3, ticketsOpen: 5, ticketsTotal: 9 },
    ticketCounts: { todo: 4, blocked: 1, done: 4 },
    managers: [{ employee: 'boss', displayName: 'Boss', department: 'engineering', rank: 'manager', running: true }],
    availableAgents: [{
      employee: 'boss',
      displayName: 'Boss',
      rank: 'manager',
      department: 'engineering',
      engine: 'claude',
      model: 'sonnet',
      running: true,
      usage: {
        day: { range: 'day', sessionCount: 2, totalCostUsd: 1.5, totalTurns: 3, totalTokens: 1200 },
        week: { range: 'week', sessionCount: 3, totalCostUsd: 2, totalTurns: 5, totalTokens: 1800 },
        month: { range: 'month', sessionCount: 4, totalCostUsd: 3, totalTurns: 8, totalTokens: 2400 },
      },
    }],
  },
  isLoading: false,
  error: null as Error | null,
}))

vi.mock('@/hooks/use-command-center', () => ({
  useCommandCenter: () => commandCenterState,
}))

const triageState = vi.hoisted(() => ({
  approvals: [] as unknown[],
  cronJobs: [] as { scheduleValid?: boolean }[],
  limits: { generatedAt: '', default: '', engines: {} } as {
    generatedAt: string
    default: string
    engines: Record<string, { windows?: { usedPercent?: number }[] }>
  },
}))

vi.mock('@/hooks/use-approvals', () => ({
  useApprovals: () => ({ data: triageState.approvals, isLoading: false }),
}))

vi.mock('@/hooks/use-cron', () => ({
  useCronJobs: () => ({ data: triageState.cronJobs, isLoading: false }),
}))

vi.mock('@/hooks/use-engine-limits', () => ({
  useEngineLimits: () => ({ data: triageState.limits, isLoading: false }),
}))

import CommandPage from './page'

describe('CommandPage', () => {
  it('renders the dashboard shell, manager chat link, and agent usage without redundant shortcut cards', () => {
    render(
      <MemoryRouter>
        <CommandPage />
      </MemoryRouter>,
    )

    expect(screen.getByText('Command Center')).toBeTruthy()
    expect(screen.getByText(/blocked ticket need attention/i)).toBeTruthy()
    expect(screen.getByText(/fleet status, manager routing, and usage rollups/i)).toBeTruthy()
    expect((screen.getByRole('link', { name: /Start chat with Boss/i }) as HTMLAnchorElement).getAttribute('href')).toBe('/?employee=boss')
    expect(screen.getByText(/claude · sonnet · 3 turns · \$1\.50/i)).toBeTruthy()
    expect(screen.getByText('Open tickets')).toBeTruthy()
    expect(screen.queryByText('Fleet routing')).toBeNull()
    expect(screen.queryByText('Automation load')).toBeNull()
    expect(screen.queryByText('Board triage')).toBeNull()
  })

  it('shows an error state with retry and suppresses the "nominal" badge, zeroed metrics, and empty state on fetch failure', () => {
    const prevData = commandCenterState.data
    const prevError = commandCenterState.error
    commandCenterState.data = undefined as unknown as typeof commandCenterState.data
    commandCenterState.error = new Error('gateway unavailable')
    try {
      render(
        <MemoryRouter>
          <CommandPage />
        </MemoryRouter>,
      )
      expect(screen.getByText('gateway unavailable')).toBeTruthy()
      expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy()
      // Health badge must not claim the fleet is healthy while the fetch failed.
      expect(screen.queryByText(/All systems nominal/i)).toBeNull()
      // The "no activity" empty state is a success signal — never on error.
      expect(screen.queryByText(/No agent activity yet/i)).toBeNull()
    } finally {
      commandCenterState.data = prevData
      commandCenterState.error = prevError
    }
  })

  it('renders finite usage-bar widths (no NaN) when every agent has zero tokens', () => {
    const prevData = commandCenterState.data
    commandCenterState.data = {
      ...prevData,
      availableAgents: [{
        employee: 'z',
        displayName: 'Zed',
        rank: 'employee',
        department: 'ops',
        engine: 'claude',
        model: 'sonnet',
        running: false,
        usage: {
          day: { range: 'day', sessionCount: 0, totalCostUsd: 0, totalTurns: 0, totalTokens: 0 },
          week: { range: 'week', sessionCount: 0, totalCostUsd: 0, totalTurns: 0, totalTokens: 0 },
          month: { range: 'month', sessionCount: 0, totalCostUsd: 0, totalTurns: 0, totalTokens: 0 },
        },
      }],
    }
    try {
      const { container } = render(
        <MemoryRouter>
          <CommandPage />
        </MemoryRouter>,
      )
      expect(container.innerHTML).not.toContain('NaN')
    } finally {
      commandCenterState.data = prevData
    }
  })

  it('renders the triage strip with attention counts from each source', () => {
    const prevApprovals = triageState.approvals
    const prevCronJobs = triageState.cronJobs
    const prevLimits = triageState.limits
    triageState.approvals = [{ id: 'a1' }, { id: 'a2' }]
    triageState.cronJobs = [{ scheduleValid: false }, { scheduleValid: true }]
    triageState.limits = {
      generatedAt: '',
      default: '',
      engines: { claude: { windows: [{ usedPercent: 92 }] } },
    }
    try {
      render(
        <MemoryRouter>
          <CommandPage />
        </MemoryRouter>,
      )
      expect(screen.getByText('Needs approval')).toBeTruthy()
      expect(screen.getByRole('link', { name: /Needs approval/i }).getAttribute('href')).toBe('/approvals')
      expect(screen.getByText('Cron failures')).toBeTruthy()
      expect(screen.getByRole('link', { name: /Cron failures/i }).getAttribute('href')).toBe('/cron')
      expect(screen.getByText('Limits at risk')).toBeTruthy()
      expect(screen.getByRole('link', { name: /Limits at risk/i }).getAttribute('href')).toBe('/limits')
    } finally {
      triageState.approvals = prevApprovals
      triageState.cronJobs = prevCronJobs
      triageState.limits = prevLimits
    }
  })

  it('has no axe-core structural/semantic violations (color-contrast excluded — jsdom has no real paint)', async () => {
    const { container } = render(
      <MemoryRouter>
        <CommandPage />
      </MemoryRouter>,
    )
    const violations = await runAxe(container)
    expect(violations, formatViolations(violations)).toEqual([])
  })
})
