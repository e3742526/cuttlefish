import { afterEach, describe, expect, it, vi } from 'vitest'
import { getJobStateLabel, getStatusDot, hasBackgroundActivity, isDirectSession, isRecentError, resolveRowIdentity } from '../chat-sidebar'

afterEach(() => {
  vi.useRealTimers()
})

describe('chat sidebar grouping helpers', () => {
  it('treats only employee-less, non-cron sessions as direct', () => {
    expect(isDirectSession({ source: 'web', sourceRef: 'web:1' })).toBe(true)
    expect(isDirectSession({ source: 'web', sourceRef: 'web:2', employee: 'cuttlefish' })).toBe(false)
    expect(isDirectSession({ source: 'cron', sourceRef: 'cron:daily' })).toBe(false)
    expect(isDirectSession({ source: 'web', sourceRef: 'cron:daily' })).toBe(false)
  })

  it('treats a session tagged with the portal slug as direct (case-insensitive)', () => {
    // ~30 child sessions were created with employee === portal slug; there is no
    // org employee by that name, so they must bucket into the direct/COO group
    // rather than spawn a phantom duplicate group.
    expect(isDirectSession({ source: 'web', sourceRef: 'web:3', employee: 'jimbo' }, 'jimbo')).toBe(true)
    expect(isDirectSession({ source: 'web', sourceRef: 'web:4', employee: 'Jimbo' }, 'jimbo')).toBe(true)
    // a real org employee is never folded into direct
    expect(isDirectSession({ source: 'web', sourceRef: 'web:5', employee: 'cuttlefish' }, 'jimbo')).toBe(false)
    // a portal-slug row is still a separate group when no slug is supplied
    expect(isDirectSession({ source: 'web', sourceRef: 'web:6', employee: 'jimbo' })).toBe(false)
  })
})

describe('chat sidebar background activity', () => {
  it('ignores stale cached background activity', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-10T10:10:00Z'))

    expect(
      hasBackgroundActivity({
        status: 'idle',
        backgroundActivity: {
          activeStreams: 1,
          lastActivityAt: '2026-06-10T10:00:00Z',
        },
      }),
    ).toBe(false)
  })

  it('keeps fresh idle background activity visible', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-10T10:01:00Z'))

    expect(
      hasBackgroundActivity({
        status: 'idle',
        backgroundActivity: {
          activeStreams: 1,
          lastActivityAt: '2026-06-10T10:00:00Z',
        },
      }),
    ).toBe(true)
  })
})

describe('chat sidebar job lifecycle', () => {
  const session = (jobState: 'idle' | 'working' | 'needs_attention' | 'finished' | 'failed', status = 'idle') => ({
    id: 'job-1',
    status,
    jobState,
    source: 'web',
    sourceRef: 'web:job-1',
    engine: 'claude',
    createdAt: '2026-07-20T12:00:00Z',
    lastActivity: '2026-07-20T12:00:00Z',
  }) as Parameters<typeof getStatusDot>[0]

  it('gives operator attention precedence over unread state', () => {
    const item = session('needs_attention')
    expect(getStatusDot(item, new Set())).toMatchObject({ label: 'needs your attention', pulse: true })
    expect(getJobStateLabel(item)).toBe('Needs your attention')
  })

  it('keeps finished delegated work visibly terminal', () => {
    const item = session('finished')
    expect(getStatusDot(item, new Set([item.id]))).toMatchObject({ label: 'job finished', pulse: false })
    expect(getJobStateLabel(item)).toBe('Job finished')
  })

  it('treats legacy waiting status as attention even before jobState arrives', () => {
    const item = session('idle', 'waiting')
    expect(getStatusDot(item, new Set([item.id]))?.label).toBe('needs your attention')
    expect(getJobStateLabel(item)).toBe('Needs your attention')
  })
})

describe('chat sidebar recent-error dot gating', () => {
  // Fixed "now"; the helper takes nowMs so we never read Date.now() at module load.
  const now = new Date('2026-06-15T12:00:00Z').getTime()
  const HOUR = 60 * 60 * 1000

  it('flags an error whose last activity is within the 24h window (→ red)', () => {
    const oneHourAgo = new Date(now - HOUR).toISOString()
    expect(isRecentError('error', oneHourAgo, now)).toBe(true)
  })

  it('does NOT flag an error whose last activity is older than 24h (→ not red)', () => {
    const twoDaysAgo = new Date(now - 48 * HOUR).toISOString()
    expect(isRecentError('error', twoDaysAgo, now)).toBe(false)
  })

  it('never flags a non-error status, even when recent', () => {
    const oneHourAgo = new Date(now - HOUR).toISOString()
    expect(isRecentError('idle', oneHourAgo, now)).toBe(false)
    expect(isRecentError('running', oneHourAgo, now)).toBe(false)
    expect(isRecentError(undefined, oneHourAgo, now)).toBe(false)
  })

  it('treats a missing or unparseable timestamp as not-recent (→ not red)', () => {
    expect(isRecentError('error', '', now)).toBe(false)
    expect(isRecentError('error', 'not-a-date', now)).toBe(false)
  })

  it('treats the 24h boundary as stale (strictly inside the window is red)', () => {
    const exactly24h = new Date(now - 24 * HOUR).toISOString()
    expect(isRecentError('error', exactly24h, now)).toBe(false)
    const justInside = new Date(now - 24 * HOUR + 1000).toISOString()
    expect(isRecentError('error', justInside, now)).toBe(true)
  })
})

describe('chat sidebar search row identity', () => {
  const opts = {
    portalSlug: 'jimbo',
    portalName: 'Jimbo',
    employeeData: new Map([
      [
        'cuttlefish',
        {
          name: 'cuttlefish',
          avatar: 'nautical:life_ring',
          displayName: 'Cuttlefish Dev',
          department: 'platform',
          rank: 'employee' as const,
          engine: 'claude',
          model: 'opus',
          persona: '',
        },
      ],
    ]),
  }

  // The API types employee as `string | null`, but the local Session interface
  // narrows it to `string | undefined`; the server can still send null at
  // runtime. Cast to reproduce that real-world shape in the test.
  const cron = { source: 'cron', sourceRef: 'cron:nightly', employee: null } as unknown as Parameters<
    typeof resolveRowIdentity
  >[0]

  // Regression: search flattens cron rows (which the grouped view renders in a
  // separate cron section). isDirectSession returns false for cron sessions, so
  // the old `s.employee!` assertion fed `null` to titleCase → `null.split('-')`
  // → "Cannot read properties of null (reading 'split')". Must not throw.
  it('does not crash on a cron session with a null employee', () => {
    expect(() => resolveRowIdentity(cron, opts)).not.toThrow()
    expect(resolveRowIdentity(cron, opts)).toEqual({ avatarName: 'jimbo', displayName: 'Jimbo' })
  })

  it('does not crash on a session with an undefined employee', () => {
    expect(() => resolveRowIdentity({ source: 'web', sourceRef: 'web:1' }, opts)).not.toThrow()
    expect(resolveRowIdentity({ source: 'web', sourceRef: 'web:1' }, opts)).toEqual({
      avatarName: 'jimbo',
      displayName: 'Jimbo',
    })
  })

  it('resolves a real employee to its org display name', () => {
    expect(
      resolveRowIdentity({ source: 'web', sourceRef: 'web:2', employee: 'cuttlefish' }, opts),
    ).toEqual({ avatarName: 'cuttlefish', avatar: 'nautical:life_ring', displayName: 'Cuttlefish Dev' })
  })

  it('title-cases an employee with no org profile rather than crashing', () => {
    expect(
      resolveRowIdentity({ source: 'web', sourceRef: 'web:3', employee: 'magic-switch-lead' }, opts),
    ).toEqual({ avatarName: 'magic-switch-lead', displayName: 'Magic Switch Lead' })
  })
})
