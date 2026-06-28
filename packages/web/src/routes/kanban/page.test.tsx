import { describe, expect, it } from 'vitest'
import { buildAssigneeChangeUpdate, buildDepartmentBoardSaveRequests } from './page'
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
