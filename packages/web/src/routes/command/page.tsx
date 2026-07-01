import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  Bot,
  Clock3,
  MessageSquarePlus,
  PlayCircle,
  Radio,
  RefreshCw,
  Ticket,
  Users,
  Zap,
} from 'lucide-react'
import { PageLayout } from '@/components/page-layout'
import { Skeleton } from '@/components/ui/skeleton'
import { useBreadcrumbs } from '@/context/breadcrumb-context'
import { useCommandCenter } from '@/hooks/use-command-center'
import type { CommandCenterAgentUsage, CommandCenterManagerSummary, CommandCenterUsageRange } from '@/lib/api'

const RANGE_OPTIONS: CommandCenterUsageRange[] = ['day', 'week', 'month']
const STATUS_META: Array<{ key: string; label: string; color: string; href: string }> = [
  { key: 'backlog', label: 'Backlog', color: 'var(--text-tertiary)', href: '/kanban' },
  { key: 'todo', label: 'Todo', color: 'var(--accent)', href: '/kanban' },
  { key: 'in_progress', label: 'In progress', color: 'var(--accent-2)', href: '/kanban' },
  { key: 'review', label: 'Review', color: 'var(--system-blue)', href: '/kanban' },
  { key: 'blocked', label: 'Blocked', color: 'var(--system-red)', href: '/kanban' },
  { key: 'done', label: 'Done', color: 'var(--system-green)', href: '/kanban' },
]

type HealthTone = 'ok' | 'warn' | 'error' | 'neutral'

// Header health chip styling per tone. Kept out of the JSX so the badge can
// honestly reflect loading/error states instead of defaulting to "nominal".
const HEALTH_TONES: Record<HealthTone, { chip: string; dot: string }> = {
  ok: {
    chip: 'border-[color:color-mix(in_srgb,var(--system-green)_35%,transparent)] bg-[color:color-mix(in_srgb,var(--system-green)_10%,transparent)] text-[var(--system-green)]',
    dot: 'var(--system-green)',
  },
  warn: {
    chip: 'border-[color:color-mix(in_srgb,var(--system-orange)_35%,transparent)] bg-[color:color-mix(in_srgb,var(--system-orange)_10%,transparent)] text-[var(--system-orange)]',
    dot: 'var(--system-orange)',
  },
  error: {
    chip: 'border-[color:color-mix(in_srgb,var(--system-red)_35%,transparent)] bg-[color:color-mix(in_srgb,var(--system-red)_10%,transparent)] text-[var(--system-red)]',
    dot: 'var(--system-red)',
  },
  neutral: {
    chip: 'border-[var(--separator)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]',
    dot: 'var(--text-tertiary)',
  },
}

function useUtcClock() {
  const [clock, setClock] = useState('00:00:00')

  useEffect(() => {
    const format = () => {
      const date = new Date()
      const part = (value: number) => String(value).padStart(2, '0')
      setClock(`${part(date.getUTCHours())}:${part(date.getUTCMinutes())}:${part(date.getUTCSeconds())}`)
    }

    format()
    const timer = window.setInterval(format, 1000)
    return () => window.clearInterval(timer)
  }, [])

  return clock
}

function MetricCard({
  title,
  value,
  detail,
  href,
  icon,
  emphasized,
}: {
  title: string
  value: string
  detail: string
  href: string
  icon: ReactNode
  emphasized?: boolean
}) {
  return (
    <Link
      to={href}
      className={[
        'group relative overflow-hidden rounded-[var(--radius-xl)] border p-5 shadow-[var(--shadow-card)] transition-transform duration-150 hover:-translate-y-0.5',
        emphasized
          ? 'border-[color:color-mix(in_srgb,var(--accent)_55%,transparent)] bg-[color:color-mix(in_srgb,var(--accent-fill)_65%,var(--material-regular))]'
          : 'border-[var(--separator)] bg-[var(--material-regular)]',
      ].join(' ')}
    >
      <div className="absolute inset-x-0 top-0 h-px bg-[color:color-mix(in_srgb,var(--text-primary)_22%,transparent)] opacity-70" />
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-tertiary)]">{title}</div>
        <div className={emphasized ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'}>{icon}</div>
      </div>
      <div className="mb-2 flex items-end gap-2">
        <span className={emphasized ? 'text-5xl font-bold tracking-[-0.04em] text-[var(--accent)]' : 'text-5xl font-bold tracking-[-0.04em] text-[var(--text-primary)]'}>
          {value}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
        <span>{detail}</span>
        <ArrowRight size={14} className="opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
    </Link>
  )
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return value.toLocaleString()
}

function prettifyTicketStatus(status: string): string {
  return status.replace(/_/g, ' ')
}

function buildAgentRows(agents: CommandCenterAgentUsage[], range: CommandCenterUsageRange) {
  const ranked = [...agents].sort((a, b) => b.usage[range].totalTokens - a.usage[range].totalTokens)
  // `|| 1` (not `?? 1`) so an all-zero range still divides by 1: `?? 1` leaves
  // maxTokens at 0, producing width `NaN%` that renders bars at full width.
  const maxTokens = ranked[0]?.usage[range].totalTokens || 1
  return ranked.map((agent, index) => {
    const usage = agent.usage[range]
    return {
      agent,
      usage,
      rank: String(index + 1).padStart(2, '0'),
      width: `${Math.max(6, Math.round((usage.totalTokens / maxTokens) * 100))}%`,
      accent: index % 4 === 0
        ? 'var(--accent)'
        : index % 4 === 1
          ? 'var(--accent-2)'
          : index % 4 === 2
            ? 'var(--system-purple)'
            : 'var(--system-green)',
    }
  })
}

function managerBadge(manager: CommandCenterManagerSummary) {
  if (manager.running) return { label: 'live', color: 'var(--system-green)' }
  return { label: 'ready', color: 'var(--text-tertiary)' }
}

export default function CommandPage() {
  useBreadcrumbs([{ label: 'Command Center' }])
  const { data, isLoading, error, refetch } = useCommandCenter()
  const [range, setRange] = useState<CommandCenterUsageRange>('day')
  const clock = useUtcClock()

  const ticketEntries = useMemo(
    () => STATUS_META.map((meta) => ({ ...meta, count: data?.ticketCounts?.[meta.key] ?? 0 })).filter((entry) => entry.count > 0),
    [data?.ticketCounts],
  )
  const totalTickets = useMemo(() => ticketEntries.reduce((sum, entry) => sum + entry.count, 0), [ticketEntries])
  const usageRows = useMemo(() => buildAgentRows(data?.availableAgents ?? [], range), [data?.availableAgents, range])

  const health = useMemo((): { label: string; tone: HealthTone } => {
    // Derive health from a successful reading, never from the absence of data:
    // a missing/failed fetch must not report "nominal".
    if (isLoading) return { label: 'Checking status…', tone: 'neutral' }
    if (error) return { label: 'Status unavailable', tone: 'error' }
    const blocked = data?.ticketCounts?.blocked ?? 0
    if (blocked > 0) return { label: `${blocked} blocked ticket${blocked === 1 ? '' : 's'} need attention`, tone: 'warn' }
    return { label: 'All systems nominal', tone: 'ok' }
  }, [isLoading, error, data?.ticketCounts?.blocked])

  return (
    <PageLayout>
      <div className="h-full overflow-y-auto">
        <div className="mx-auto flex max-w-[1320px] flex-col gap-5 px-4 py-5 sm:px-6 sm:py-6">
          <header className="flex flex-wrap items-center gap-4 rounded-[var(--radius-2xl)] border border-[var(--separator)] bg-[var(--material-thick)] px-5 py-4 shadow-[var(--shadow-card)]">
            <div className="flex size-12 items-center justify-center rounded-[18px] border border-[var(--separator)] bg-[var(--bg-secondary)] shadow-[var(--shadow-subtle)]">
              <img src="/brand/cuttlefish_icon_app.svg" alt="" className="size-8 object-contain" draggable={false} />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-[length:var(--text-title1)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
                Command Center
              </h1>
              <p className="text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
                Orchestration overview, fleet status, manager routing, and usage rollups.
              </p>
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-3">
              <div
                className={[
                  'inline-flex items-center gap-2 rounded-full border px-3 py-2 text-[length:var(--text-footnote)] font-[var(--weight-semibold)]',
                  HEALTH_TONES[health.tone].chip,
                ].join(' ')}
              >
                <span
                  className="size-2 rounded-full"
                  style={{ background: HEALTH_TONES[health.tone].dot, boxShadow: 'var(--accent-glow)' }}
                />
                {health.label}
              </div>
              <div className="inline-flex items-center gap-2 rounded-full border border-[var(--separator)] bg-[var(--bg-secondary)] px-3 py-2 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
                <span className="font-[family-name:var(--font-code)] text-[var(--text-primary)]">{clock}</span>
                <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-tertiary)]">UTC</span>
              </div>
            </div>
          </header>

          {error ? (
            // On failure, show only the error + a retry — not zeroed metric cards
            // and the "no activity" empty state, which read as a healthy idle fleet.
            <div className="flex flex-col items-start gap-3 rounded-[var(--radius-lg)] border border-[color:color-mix(in_srgb,var(--system-red)_35%,transparent)] bg-[color:color-mix(in_srgb,var(--system-red)_10%,transparent)] px-4 py-4">
              <div className="text-[var(--system-red)]">
                {error instanceof Error ? error.message : 'Failed to load command center'}
              </div>
              <button
                type="button"
                onClick={() => { void refetch() }}
                className="inline-flex items-center gap-2 rounded-full border border-[var(--separator)] bg-[var(--bg-secondary)] px-3 py-1.5 text-[length:var(--text-footnote)] font-[var(--weight-semibold)] text-[var(--text-primary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
              >
                <RefreshCw size={14} /> Retry
              </button>
            </div>
          ) : (
          <>
          <section className="grid gap-4 xl:grid-cols-4">
            {isLoading ? (
              Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-36 rounded-[var(--radius-xl)]" />)
            ) : (
              <>
                <MetricCard title="Agents" value={String(data?.summary?.agents ?? 0)} detail="registered across the org" href="/org" icon={<Users size={18} />} />
                <MetricCard
                  title="Running now"
                  value={String(data?.summary?.agentsRunning ?? 0)}
                  detail="live sessions across the fleet"
                  href="/org"
                  icon={<Radio size={18} />}
                  emphasized
                />
                <MetricCard title="Cron jobs" value={String(data?.summary?.cronJobs ?? 0)} detail="scheduled automations" href="/cron" icon={<Clock3 size={18} />} />
                <MetricCard title="Open tickets" value={String(data?.summary?.ticketsOpen ?? 0)} detail="open work across departments" href="/kanban" icon={<Ticket size={18} />} />
              </>
            )}
          </section>

          <section className="rounded-[var(--radius-2xl)] border border-[var(--separator)] bg-[var(--material-regular)] p-5 shadow-[var(--shadow-card)]">
            <div className="mb-4 flex items-center gap-3">
              <div>
                <h2 className="text-[length:var(--text-title3)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
                  Tickets by status
                </h2>
                <p className="text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
                  Board pressure at a glance, linked back to Kanban.
                </p>
              </div>
              <Link to="/kanban" className="ml-auto inline-flex items-center gap-1 text-[length:var(--text-footnote)] text-[var(--text-secondary)] transition-colors hover:text-[var(--accent)]">
                Open board <ArrowRight size={14} />
              </Link>
            </div>

            {isLoading ? (
              <Skeleton className="h-28 rounded-[var(--radius-lg)]" />
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
                  {ticketEntries.map((entry) => (
                    <Link
                      key={entry.key}
                      to={entry.href}
                      className="rounded-[var(--radius-lg)] border border-[var(--separator)] bg-[var(--bg-secondary)] px-4 py-3 transition-transform duration-150 hover:-translate-y-0.5"
                    >
                      <div className="mb-2 flex items-center gap-2">
                        <span className="size-2 rounded-sm" style={{ background: entry.color }} />
                        <span className="text-[10px] uppercase tracking-[0.16em] text-[var(--text-tertiary)]">{entry.label}</span>
                      </div>
                      <div className="text-3xl font-bold tracking-[-0.03em]" style={{ color: entry.color }}>
                        {entry.count}
                      </div>
                    </Link>
                  ))}
                </div>
                <div className="mt-4 h-2 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
                  {ticketEntries.map((entry) => (
                    <span
                      key={entry.key}
                      className="h-full"
                      style={{ display: 'inline-block', width: `${totalTickets ? (entry.count / totalTickets) * 100 : 0}%`, background: entry.color }}
                    />
                  ))}
                </div>
              </>
            )}
          </section>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
            <section className="rounded-[var(--radius-2xl)] border border-[var(--separator)] bg-[var(--material-regular)] p-5 shadow-[var(--shadow-card)]">
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <div>
                  <h2 className="text-[length:var(--text-title3)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
                    Agent usage
                  </h2>
                  <p className="text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
                    Context footprint, turns, sessions, and cost by active period.
                  </p>
                </div>
                <div className="ml-auto inline-flex rounded-[10px] border border-[var(--separator)] bg-[var(--bg-tertiary)] p-1">
                  {RANGE_OPTIONS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={option === range}
                      onClick={() => setRange(option)}
                      className={[
                        'rounded-[8px] px-3 py-1.5 text-[length:var(--text-footnote)] font-[var(--weight-semibold)] capitalize transition-colors',
                        option === range
                          ? 'text-[var(--accent-contrast)]'
                          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                      ].join(' ')}
                      style={option === range ? { background: 'var(--accent-bg)' } : undefined}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>

              {isLoading ? (
                <div className="grid gap-3">
                  {Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-14 rounded-[var(--radius-lg)]" />)}
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="grid grid-cols-[36px_minmax(0,1fr)_minmax(160px,240px)] gap-3 px-1 text-[10px] uppercase tracking-[0.18em] text-[var(--text-tertiary)]">
                    <span className="text-right">#</span>
                    <span>Agent</span>
                    <span>Context {range}</span>
                  </div>
                  {usageRows.map(({ agent, usage, rank, width, accent }) => (
                    <div
                      key={agent.employee}
                      className="grid grid-cols-[36px_minmax(0,1fr)_minmax(160px,240px)] items-center gap-3 rounded-[var(--radius-lg)] px-1 py-2 transition-colors hover:bg-[var(--fill-secondary)]"
                    >
                      <span className="text-right font-[family-name:var(--font-code)] text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">{rank}</span>
                      <div className="flex min-w-0 items-center gap-3">
                        <span
                          className="grid size-9 shrink-0 place-items-center rounded-[10px] border text-[length:var(--text-footnote)] font-[var(--weight-bold)]"
                          style={{ color: accent, borderColor: `${accent}66`, background: `${accent}22` }}
                        >
                          {agent.displayName.slice(0, 1)}
                        </span>
                        <div className="min-w-0">
                          <div className="truncate font-[var(--weight-semibold)] text-[var(--text-primary)]">{agent.displayName}</div>
                          <div className="truncate font-[family-name:var(--font-code)] text-[11px] text-[var(--text-tertiary)]">
                            {agent.engine} · {agent.model} · {usage.totalTurns.toLocaleString()} turns · ${usage.totalCostUsd.toFixed(2)}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
                          <span className="block h-full rounded-full" style={{ width, background: accent, boxShadow: `0 0 14px ${accent}` }} />
                        </div>
                        <span className="w-14 text-right font-[family-name:var(--font-code)] text-[length:var(--text-footnote)] text-[var(--text-primary)]">
                          {formatCompact(usage.totalTokens)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-[var(--radius-2xl)] border border-[var(--separator)] bg-[var(--material-regular)] p-5 shadow-[var(--shadow-card)]">
              <div className="mb-4 flex items-center gap-3">
                <div>
                  <h2 className="text-[length:var(--text-title3)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
                    Managers
                  </h2>
                  <p className="text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
                    Launch direct chats with the current leadership roster.
                  </p>
                </div>
                <div className="ml-auto text-[10px] uppercase tracking-[0.18em] text-[var(--text-tertiary)]">Tap to chat</div>
              </div>

              {isLoading ? (
                <div className="grid gap-3">
                  {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-20 rounded-[var(--radius-lg)]" />)}
                </div>
              ) : (
                <div className="space-y-3">
                  {data?.managers?.map((manager, index) => {
                    const badge = managerBadge(manager)
                    const accent = index % 4 === 0
                      ? 'var(--accent)'
                      : index % 4 === 1
                        ? 'var(--accent-2)'
                        : index % 4 === 2
                          ? 'var(--system-purple)'
                          : 'var(--system-orange)'

                    return (
                      <div
                        key={manager.employee}
                        className="flex items-center gap-3 rounded-[var(--radius-lg)] border border-[var(--separator)] bg-[var(--bg-secondary)] px-3 py-3"
                      >
                        <span
                          className="grid size-10 shrink-0 place-items-center rounded-[12px] border font-[var(--weight-bold)]"
                          style={{ color: accent, borderColor: `${accent}66`, background: `${accent}22` }}
                        >
                          {manager.displayName.slice(0, 1)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-[var(--weight-semibold)] text-[var(--text-primary)]">{manager.displayName}</span>
                            <span className="size-2 rounded-full" style={{ background: badge.color }} />
                          </div>
                          <div className="truncate font-[family-name:var(--font-code)] text-[11px] text-[var(--text-tertiary)]">
                            {manager.department ?? 'unassigned'} · {manager.rank} · {badge.label}
                          </div>
                        </div>
                        <Link
                          to={`/?employee=${encodeURIComponent(manager.employee)}`}
                          aria-label={`Start chat with ${manager.displayName}`}
                          className="inline-flex size-10 shrink-0 items-center justify-center rounded-[12px] border border-[color:color-mix(in_srgb,var(--accent)_45%,transparent)] bg-[color:color-mix(in_srgb,var(--accent-fill)_75%,var(--bg-secondary))] text-[var(--accent)] transition-transform duration-150 hover:scale-[0.98]"
                        >
                          <MessageSquarePlus size={18} />
                        </Link>
                      </div>
                    )
                  })}
                  <Link
                    to="/org"
                    className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-[var(--radius-lg)] border border-dashed border-[var(--separator-strong)] px-4 py-3 text-[length:var(--text-footnote)] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
                  >
                    View full org map <ArrowRight size={14} />
                  </Link>
                </div>
              )}
            </section>
          </div>

          <section className="grid gap-4 md:grid-cols-3">
            <Link to="/org" className="rounded-[var(--radius-xl)] border border-[var(--separator)] bg-[var(--material-regular)] p-4 shadow-[var(--shadow-card)] transition-transform duration-150 hover:-translate-y-0.5">
              <div className="mb-3 inline-flex size-10 items-center justify-center rounded-[12px] bg-[var(--fill-secondary)] text-[var(--accent)]">
                <Bot size={18} />
              </div>
              <div className="text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">Fleet routing</div>
              <p className="mt-1 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
                Inspect employees, hierarchy, engine assignments, and live states.
              </p>
            </Link>
            <Link to="/cron" className="rounded-[var(--radius-xl)] border border-[var(--separator)] bg-[var(--material-regular)] p-4 shadow-[var(--shadow-card)] transition-transform duration-150 hover:-translate-y-0.5">
              <div className="mb-3 inline-flex size-10 items-center justify-center rounded-[12px] bg-[var(--fill-secondary)] text-[var(--accent-2)]">
                <Zap size={18} />
              </div>
              <div className="text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">Automation load</div>
              <p className="mt-1 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
                Jump into schedules and recent runs when background work spikes.
              </p>
            </Link>
            <Link to="/kanban" className="rounded-[var(--radius-xl)] border border-[var(--separator)] bg-[var(--material-regular)] p-4 shadow-[var(--shadow-card)] transition-transform duration-150 hover:-translate-y-0.5">
              <div className="mb-3 inline-flex size-10 items-center justify-center rounded-[12px] bg-[var(--fill-secondary)] text-[var(--system-orange)]">
                <PlayCircle size={18} />
              </div>
              <div className="text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">Board triage</div>
              <p className="mt-1 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
                Move from aggregated board pressure to the detailed Kanban workflow.
              </p>
            </Link>
          </section>

          {!isLoading && !data?.availableAgents?.length && (
            <div className="rounded-[var(--radius-xl)] border border-[var(--separator)] bg-[var(--material-regular)] px-5 py-8 text-center shadow-[var(--shadow-card)]">
              <h2 className="text-[length:var(--text-title3)] font-[var(--weight-semibold)] text-[var(--text-primary)]">No agent activity yet</h2>
              <p className="mt-2 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
                Start a chat or schedule a cron job to light up the dashboard.
              </p>
            </div>
          )}
          </>
          )}
        </div>
      </div>
    </PageLayout>
  )
}
