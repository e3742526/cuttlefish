import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { hrApi, type CreateChangeRequestInput } from '@/lib/api-hr'
import { queryKeys } from '@/lib/query-keys'

/** List org change requests, optionally filtered by status (comma-separated). */
export function useOrgChanges(status?: string) {
  return useQuery({
    queryKey: queryKeys.orgChanges.list(status),
    queryFn: () => hrApi.listChangeRequests(status),
    // The org-change queue is an operator review surface just like approvals.
    // Force a mount refetch so navigation re-syncs instead of reusing a warm,
    // potentially stale 5-minute snapshot from the global query defaults.
    refetchOnMount: 'always',
  })
}

export function useOrgChange(id: string | null) {
  return useQuery({
    queryKey: queryKeys.orgChanges.detail(id!),
    queryFn: () => hrApi.getChangeRequest(id!),
    enabled: !!id,
    refetchOnMount: 'always',
  })
}

export function useCreateOrgChange() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateChangeRequestInput) => hrApi.createChangeRequest(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.orgChanges.all })
    },
  })
}

export function useApproveOrgChange() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => hrApi.approveChange(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.orgChanges.all })
      qc.invalidateQueries({ queryKey: queryKeys.org.all })
      qc.invalidateQueries({ queryKey: queryKeys.approvals.all })
    },
  })
}

export function useRejectOrgChange() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => hrApi.rejectChange(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.orgChanges.all })
      qc.invalidateQueries({ queryKey: queryKeys.approvals.all })
    },
  })
}

export function useRetiredEmployees() {
  return useQuery({
    queryKey: ['org', 'retired'] as const,
    queryFn: () => hrApi.listRetired(),
  })
}
