
import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useGateway } from '@/hooks/use-gateway'
import { queryKeys } from '@/lib/query-keys'
import { patchSessionBackgroundActivity, removeFromSessionsCache } from '@/hooks/use-sessions'
import type { BackgroundActivity } from '@/lib/api'

/**
 * Subscribes to WebSocket events and invalidates React Query caches.
 * Mount once at app root (in client-providers.tsx).
 */
export function useQueryInvalidation() {
  const qc = useQueryClient()
  const { subscribe } = useGateway()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const unsub = subscribe((event: string, payload: unknown) => {
      const p = payload as Record<string, unknown> | undefined

      switch (event) {
        case 'session:started':
          pendingRef.current.add('sessions')
          pendingRef.current.add('work')
          break
        case 'session:updated':
          pendingRef.current.add('sessions')
          pendingRef.current.add('work')
          if (p?.sessionId) {
            qc.invalidateQueries({ queryKey: queryKeys.sessions.detail(p.sessionId as string) })
          }
          break
        case 'session:deleted':
          // Drop it from the merged list now; merge-on-refetch would otherwise
          // keep it as a previously-loaded extra.
          if (p?.sessionId) removeFromSessionsCache(qc, [p.sessionId as string])
          pendingRef.current.add('sessions')
          if (p?.sessionId) {
            qc.invalidateQueries({ queryKey: queryKeys.sessions.detail(p.sessionId as string) })
          }
          break
        case 'session:background':
          // Surgical cache patch only — no invalidation/refetch storm. These
          // fire on every background-activity change (including cleared=null).
          if (p?.sessionId) {
            patchSessionBackgroundActivity(
              qc,
              p.sessionId as string,
              (p.backgroundActivity as BackgroundActivity | null) ?? null,
            )
          }
          return
        case 'session:completed':
        case 'session:error':
        case 'session:notification':
          pendingRef.current.add('sessions')
          pendingRef.current.add('work')
          if (p?.sessionId) {
            qc.invalidateQueries({ queryKey: queryKeys.sessions.detail(p.sessionId as string) })
          }
          break
        // Feature 1: model-fallback approval lifecycle. Previously these events
        // fell through to the no-op default, so a session that hit a rate limit
        // and asked for approval would silently stall in the UI. Now they refresh
        // the approvals queue + the sessions list (status flips waiting↔running/error).
        case 'session:fallback-required':
        case 'approval:created':
        case 'approval:resolved':
          pendingRef.current.add('approvals')
          pendingRef.current.add('sessions')
          pendingRef.current.add('work')
          if (p?.sessionId) {
            qc.invalidateQueries({ queryKey: queryKeys.sessions.detail(p.sessionId as string) })
          }
          break
        case 'cron:completed':
        case 'cron:error':
          pendingRef.current.add('cron')
          break
        case 'skills:changed':
          pendingRef.current.add('skills')
          break
        case 'org:changed':
          // A turn (e.g. onboarding hatching an employee) rewrote org/.
          // Refetch the org/employee list so the new employee shows in the sidebar
          // live, without a manual page refresh.
          pendingRef.current.add('org')
          break
        case 'config:reloaded':
          pendingRef.current.add('config')
          pendingRef.current.add('engines')
          pendingRef.current.add('status')
          break
        case 'engines:updated':
          pendingRef.current.add('engines')
          break
        default:
          return // No invalidation for unknown events
      }

      // Debounce: flush pending invalidations after 1000ms of quiet
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        for (const key of pendingRef.current) {
          switch (key) {
            case 'sessions':
              qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
              break
            case 'approvals':
              qc.invalidateQueries({ queryKey: queryKeys.approvals.all })
              qc.invalidateQueries({ queryKey: queryKeys.checkpoints.all })
              break
            case 'cron':
              qc.invalidateQueries({ queryKey: queryKeys.cron.all })
              break
            case 'skills':
              qc.invalidateQueries({ queryKey: queryKeys.skills.all })
              break
            case 'org':
              qc.invalidateQueries({ queryKey: queryKeys.org.all })
              break
            case 'engines':
              qc.invalidateQueries({ queryKey: queryKeys.engines.all })
              break
            case 'config':
              qc.invalidateQueries({ queryKey: queryKeys.config })
              break
            case 'status':
              qc.invalidateQueries({ queryKey: queryKeys.status })
              break
          }
        }
        pendingRef.current.clear()
      }, 1000)
    })

    return () => {
      unsub()
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [subscribe, qc])
}
