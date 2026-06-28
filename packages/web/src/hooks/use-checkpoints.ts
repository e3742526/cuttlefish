import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type ApprovalState, type CheckpointDecisionInput } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'

export function useCheckpoints(state: ApprovalState | 'all' = 'pending', sessionId?: string | null) {
  return useQuery({
    queryKey: queryKeys.checkpoints.list(state, sessionId),
    queryFn: () => api.getCheckpoints(state, sessionId),
  })
}

export function useDecideCheckpoint() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: CheckpointDecisionInput }) =>
      api.decideCheckpoint(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.checkpoints.all })
      qc.invalidateQueries({ queryKey: queryKeys.approvals.all })
      qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
    },
  })
}
