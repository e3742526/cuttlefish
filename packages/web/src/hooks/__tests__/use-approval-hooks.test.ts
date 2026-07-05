import { describe, it, expect, vi, beforeEach } from 'vitest'
import { queryKeys } from '@/lib/query-keys'

const recorded = vi.hoisted(() => ({
  useQueryCalls: [] as unknown[],
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn((options: unknown) => {
    recorded.useQueryCalls.push(options)
    return options
  }),
  useMutation: vi.fn(() => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, error: null })),
  useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
}))

vi.mock('@/lib/api', () => ({
  api: {
    getApprovals: vi.fn(),
    approveApproval: vi.fn(),
    rejectApproval: vi.fn(),
    getCheckpoints: vi.fn(),
    decideCheckpoint: vi.fn(),
  },
}))

vi.mock('@/lib/api-hr', () => ({
  hrApi: {
    listChangeRequests: vi.fn(),
    getChangeRequest: vi.fn(),
    createChangeRequest: vi.fn(),
    approveChange: vi.fn(),
    rejectChange: vi.fn(),
    listRetired: vi.fn(),
  },
}))

import { useApprovals } from '../use-approvals'
import { useCheckpoints } from '../use-checkpoints'
import { useOrgChange, useOrgChanges } from '../use-org-changes'

describe('approval queue hooks', () => {
  beforeEach(() => {
    recorded.useQueryCalls = []
  })

  it('forces approval queries to refetch on mount', () => {
    useApprovals('all', null)

    expect(recorded.useQueryCalls).toHaveLength(1)
    expect(recorded.useQueryCalls[0]).toEqual(expect.objectContaining({
      queryKey: queryKeys.approvals.list('all', null),
      refetchOnMount: 'always',
      queryFn: expect.any(Function),
    }))
  })

  it('forces checkpoint queries to refetch on mount', () => {
    useCheckpoints('all', null)

    expect(recorded.useQueryCalls).toHaveLength(1)
    expect(recorded.useQueryCalls[0]).toEqual(expect.objectContaining({
      queryKey: queryKeys.checkpoints.list('all', null),
      refetchOnMount: 'always',
      queryFn: expect.any(Function),
    }))
  })

  it('forces org-change list queries to refetch on mount', () => {
    useOrgChanges('pending_approval')

    expect(recorded.useQueryCalls).toHaveLength(1)
    expect(recorded.useQueryCalls[0]).toEqual(expect.objectContaining({
      queryKey: queryKeys.orgChanges.list('pending_approval'),
      refetchOnMount: 'always',
      queryFn: expect.any(Function),
    }))
  })

  it('forces org-change detail queries to refetch on mount', () => {
    useOrgChange('change-123')

    expect(recorded.useQueryCalls).toHaveLength(1)
    expect(recorded.useQueryCalls[0]).toEqual(expect.objectContaining({
      queryKey: queryKeys.orgChanges.detail('change-123'),
      enabled: true,
      refetchOnMount: 'always',
      queryFn: expect.any(Function),
    }))
  })
})
