import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { api, type ApprovalState } from '@/lib/api'

/** Feature 1: the pending human-approval queue (model-fallback gates). */
export function useApprovals(state: ApprovalState | 'all' = 'pending', sessionId?: string | null) {
  return useQuery({
    queryKey: queryKeys.approvals.list(state, sessionId),
    queryFn: () => api.getApprovals(state, sessionId),
  })
}

export function useApproveApproval() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.approveApproval(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.approvals.all })
      qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
    },
  })
}

export function useRejectApproval() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.rejectApproval(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.approvals.all })
      qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
    },
  })
}
