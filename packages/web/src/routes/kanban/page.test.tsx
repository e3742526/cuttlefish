import { describe, expect, it } from 'vitest'
import { buildAssigneeChangeUpdate, buildDepartmentBoardSaveRequests, getBoardLoadDepartments, loadDepartmentBoards } from './page'
import type { Employee } from '@/lib/api'
import type { KanbanStore } from '@/lib/kanban/store'

const store: KanbanStore = {
  'ticket-1': {
    id: 'ticket-1',
    title: 'Build scoped saves',
    description: '',
    status: 'todo',
    priority: 'medium',
    complexity: 'medium',
    assigneeId: 'engineer',
    department: 'engineering',
    workState: 'idle',
    createdAt: Date.parse('2026-06-25T10:00:00.000Z'),
    updatedAt: Date.parse('2026-06-25T10:01:00.000Z'),
    baseUpdatedAt: Date.parse('2026-06-25T09:59:00.000Z'),
    departmentId: 'engineering',
  },
  'ticket-2': {
    id: 'ticket-2',
    title: 'Keep marketing local',
    description: '',
    status: 'blocked',
    priority: 'high',
    complexity: 'low',
    assigneeId: 'marketer',
    department: 'marketing',
    workState: 'idle',
    createdAt: Date.parse('2026-06-25T11:00:00.000Z'),
    updatedAt: Date.parse('2026-06-25T11:01:00.000Z'),
    departmentId: 'marketing',
  },
}

describe('buildDepartmentBoardSaveRequests', () => {
  it('serializes only targeted department boards', () => {
    const requests = buildDepartmentBoardSaveRequests(
      store,
      [{ department: 'engineering' }],
      { engineering: 3, marketing: 5 },
    )

    expect(requests).toHaveLength(1)
    expect(requests[0].department).toBe('engineering')
    expect(requests[0].payload.tickets.map((ticket) => ticket.id)).toEqual(['ticket-1'])
    expect(requests[0].payload.retentionDays).toBe(3)
  })

  it('keeps cross-department assignment deletion metadata on the source board only', () => {
    const requests = buildDepartmentBoardSaveRequests(
      store,
      [
        { department: 'engineering' },
        {
          department: 'marketing',
          deletedIds: ['ticket-1'],
          deletedVersions: { 'ticket-1': '2026-06-25T09:59:00.000Z' },
        },
      ],
      { engineering: 3, marketing: 5 },
    )

    expect(requests.find((request) => request.department === 'engineering')?.payload).toMatchObject({
      deletedIds: [],
      tickets: [expect.objectContaining({ id: 'ticket-1', assignee: 'engineer' })],
    })
    expect(requests.find((request) => request.department === 'marketing')?.payload).toMatchObject({
      deletedIds: ['ticket-1'],
      deletedVersions: { 'ticket-1': '2026-06-25T09:59:00.000Z' },
      tickets: [expect.objectContaining({ id: 'ticket-2' })],
    })
  })

  it('omits baseUpdatedAt for tickets the user did not edit', () => {
    // An untouched ticket has updatedAt === baseUpdatedAt; it should be bundled
    // without a freshness claim so a concurrent agent write to it can't block
    // an unrelated save. An edited ticket (updatedAt advanced past baseUpdatedAt)
    // still asserts its base version.
    const requests = buildDepartmentBoardSaveRequests(
      {
        'unchanged': {
          ...store['ticket-1'],
          id: 'unchanged',
          updatedAt: Date.parse('2026-06-25T10:00:00.000Z'),
          baseUpdatedAt: Date.parse('2026-06-25T10:00:00.000Z'),
        },
        'edited': {
          ...store['ticket-1'],
          id: 'edited',
          updatedAt: Date.parse('2026-06-25T10:05:00.000Z'),
          baseUpdatedAt: Date.parse('2026-06-25T10:00:00.000Z'),
        },
      },
      [{ department: 'engineering' }],
      { engineering: 3, marketing: 5 },
    )

    const tickets = requests[0].payload.tickets
    const unchanged = tickets.find((t) => t.id === 'unchanged')
    const edited = tickets.find((t) => t.id === 'edited')
    expect(unchanged?.baseUpdatedAt).toBeUndefined()
    expect(edited?.baseUpdatedAt).toBe('2026-06-25T10:00:00.000Z')
  })

  it('serializes ticket resource context and manual-only flags', () => {
    const requests = buildDepartmentBoardSaveRequests(
      {
        ...store,
        'ticket-1': {
          ...store['ticket-1'],
          resourcePath: '/tmp/project',
          manualOnly: true,
        },
      },
      [{ department: 'engineering' }],
      { engineering: 3, marketing: 5 },
    )

    expect(requests[0].payload.tickets[0]).toMatchObject({
      id: 'ticket-1',
      resourcePath: '/tmp/project',
      manualOnly: true,
    })
  })
})

describe('buildAssigneeChangeUpdate', () => {
  it('moves department and departmentId with a cross-department assignee', () => {
    const employees: Employee[] = [
      {
        name: 'researcher',
        displayName: 'Researcher',
        department: 'research',
        rank: 'employee',
        engine: 'claude',
        model: 'opus',
        persona: '',
      },
    ]

    expect(buildAssigneeChangeUpdate('researcher', employees)).toMatchObject({
      assigneeId: 'researcher',
      department: 'research',
      departmentId: 'research',
    })
  })
})

describe('getBoardLoadDepartments', () => {
  it('uses directory-backed board departments when the org payload provides them', () => {
    expect(getBoardLoadDepartments({
      departments: ['dataflow', 'general', 'qa', 'Personnel', 'Compliance'],
      boardDepartments: ['dataflow', 'general', 'qa'],
      employees: [],
      hierarchy: { root: null, sorted: [], warnings: [] },
    })).toEqual(['dataflow', 'general', 'qa'])
  })

  it('falls back to departments for older org payloads', () => {
    expect(getBoardLoadDepartments({
      departments: ['general'],
      employees: [],
      hierarchy: { root: null, sorted: [], warnings: [] },
    })).toEqual(['general'])
  })
})

describe('loadDepartmentBoards', () => {
  it('starts department fetches in parallel and merges the results once they settle', async () => {
    let resolveEngineering!: (value: any) => void
    let resolveMarketing!: (value: any) => void
    const calls: string[] = []

    const promise = loadDepartmentBoards(['engineering', 'marketing'], (department) => {
      calls.push(department)
      return new Promise((resolve) => {
        if (department === 'engineering') resolveEngineering = resolve
        else resolveMarketing = resolve
      })
    })

    expect(calls).toEqual(['engineering', 'marketing'])

    resolveMarketing({
      tickets: [{
        id: 'marketing-1',
        title: 'Marketing board',
        description: '',
        status: 'todo',
        priority: 'medium',
        createdAt: '2026-06-25T12:00:00.000Z',
        updatedAt: '2026-06-25T12:00:00.000Z',
      }],
      deletedTickets: [],
      retentionDays: 4,
    })
    resolveEngineering({
      tickets: [{
        id: 'engineering-1',
        title: 'Engineering board',
        description: '',
        status: 'blocked',
        priority: 'high',
        createdAt: '2026-06-25T13:00:00.000Z',
        updatedAt: '2026-06-25T13:00:00.000Z',
      }],
      deletedTickets: [],
      retentionDays: 2,
    })

    await expect(promise).resolves.toMatchObject({
      retentionDays: 4,
      departmentRetentionDays: { engineering: 2, marketing: 4 },
      warnings: [],
      boardTickets: {
        'marketing-1': expect.objectContaining({ departmentId: 'marketing' }),
        'engineering-1': expect.objectContaining({ departmentId: 'engineering' }),
      },
    })
  })
})
