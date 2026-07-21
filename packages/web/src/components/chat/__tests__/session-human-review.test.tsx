import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { Approval } from '@/lib/api'

const approvalState = vi.hoisted(() => ({
  approvals: [] as Approval[],
  approve: vi.fn(),
  reject: vi.fn(),
}))

vi.mock('@/hooks/use-approvals', () => ({
  useApprovals: () => ({
    data: approvalState.approvals,
    isLoading: false,
    error: null,
  }),
  useApproveApproval: () => ({ mutate: approvalState.approve, isPending: false, error: null }),
  useRejectApproval: () => ({ mutate: approvalState.reject, isPending: false, error: null }),
}))

vi.mock('@/hooks/use-checkpoints', () => ({
  useCheckpoints: () => ({ data: [], isLoading: false, error: null }),
  useDecideCheckpoint: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
}))

import { SessionHumanReview } from '../session-human-review'

describe('SessionHumanReview', () => {
  beforeEach(() => {
    approvalState.approvals = [{
      id: 'approval-hr-1',
      sessionId: 'session-hr-1',
      type: 'org-change',
      payload: {
        changeRequestId: 'change-request-1',
        changeType: 'create_agent',
        employeeName: 'business-manager',
        riskLevel: 'high',
      },
      state: 'pending',
      createdAt: '2026-07-21T14:00:00.000Z',
    }]
    approvalState.approve.mockReset()
    approvalState.reject.mockReset()
  })

  it('resolves in-chat HR decisions through the linked approval record', () => {
    render(<SessionHumanReview sessionId="session-hr-1" />)

    fireEvent.click(screen.getByRole('button', { name: /approve & apply/i }))
    fireEvent.click(screen.getByRole('button', { name: /^reject$/i }))

    expect(approvalState.approve).toHaveBeenCalledWith('approval-hr-1')
    expect(approvalState.reject).toHaveBeenCalledWith('approval-hr-1')
    expect(approvalState.approve).not.toHaveBeenCalledWith('change-request-1')
    expect(approvalState.reject).not.toHaveBeenCalledWith('change-request-1')
  })
})
