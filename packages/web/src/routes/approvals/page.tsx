import { useState, useEffect, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  Check,
  X,
  ShieldQuestion,
  ArrowRight,
  PauseCircle,
  FileText,
  FolderArchive,
  Wrench,
  CheckCircle2,
  XCircle,
  Clock,
  RotateCcw,
  MousePointerClick,
} from 'lucide-react'
import { PageLayout } from '@/components/page-layout'
import { useBreadcrumbs } from '@/context/breadcrumb-context'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useApprovals, useApproveApproval, useRejectApproval } from '@/hooks/use-approvals'
import { useCheckpoints, useDecideCheckpoint } from '@/hooks/use-checkpoints'
import { cn } from '@/lib/utils'
import type { Approval, ApprovalDecision, Checkpoint } from '@/lib/api'

// --- helpers ---

function fallbackSummary(payload: Record<string, unknown>): { from: string; to: string; reason?: string } {
  const from = payload.from as { engine?: string; model?: string } | undefined
  const to = payload.to as { engine?: string; model?: string } | undefined
  const fmt = (e?: { engine?: string; model?: string }) =>
    e ? `${e.engine ?? '?'}${e.model ? `/${e.model}` : ''}` : '?'
  return { from: fmt(from), to: fmt(to), reason: typeof payload.reason === 'string' ? payload.reason : undefined }
}

type SelectionKind = 'approval' | 'checkpoint'

// --- Decision badge ---

const DECISION_META: Record<string, { icon: ReactNode; label: string; className: string }> = {
  approved: {
    icon: <CheckCircle2 className="size-3" />,
    label: 'Approved',
    className: 'text-emerald-600 bg-emerald-500/10',
  },
  rejected: {
    icon: <XCircle className="size-3" />,
    label: 'Rejected',
    className: 'text-destructive bg-destructive/10',
  },
  deferred: {
    icon: <Clock className="size-3" />,
    label: 'Deferred',
    className: 'text-amber-600 bg-amber-500/10',
  },
  revised: {
    icon: <RotateCcw className="size-3" />,
    label: 'Revised',
    className: 'text-blue-600 bg-blue-500/10',
  },
}

function DecisionBadge({ state }: { state: string }) {
  const meta = DECISION_META[state]
  if (!meta) return null
  return (
    <span className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium', meta.className)}>
      {meta.icon}
      {meta.label}
    </span>
  )
}

// --- Compact list items ---

function PendingListItem({
  kind,
  item,
  isSelected,
  onClick,
}: {
  kind: SelectionKind
  item: Approval | Checkpoint
  isSelected: boolean
  onClick: () => void
}) {
  const isCheckpoint = kind === 'checkpoint'
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full rounded-md p-2.5 text-left text-xs transition-colors hover:bg-accent',
        isSelected && 'bg-accent ring-1 ring-inset ring-border',
      )}
    >
      <div className="flex items-center gap-1.5 mb-1">
        {isCheckpoint ? (
          <PauseCircle className="size-3.5 shrink-0 text-amber-500" />
        ) : (
          <ShieldQuestion className="size-3.5 shrink-0 text-amber-500" />
        )}
        <span className="font-medium truncate">
          {isCheckpoint
            ? (item as Checkpoint).payload.decisionNeeded
            : `${item.type} approval`}
        </span>
      </div>
      <div className="text-muted-foreground">
        Session {item.sessionId.slice(0, 8)} · {new Date(item.createdAt).toLocaleTimeString()}
      </div>
    </button>
  )
}

function ResolvedListItem({
  kind,
  item,
  isSelected,
  onClick,
}: {
  kind: SelectionKind
  item: Approval | Checkpoint
  isSelected: boolean
  onClick: () => void
}) {
  const isCheckpoint = kind === 'checkpoint'
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full rounded-md p-2.5 text-left text-xs transition-colors hover:bg-accent',
        isSelected && 'bg-accent ring-1 ring-inset ring-border',
      )}
    >
      <div className="flex items-center gap-1.5 mb-1">
        {isCheckpoint ? (
          <PauseCircle className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ShieldQuestion className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="font-medium truncate">
          {isCheckpoint
            ? (item as Checkpoint).payload.decisionNeeded
            : `${item.type} approval`}
        </span>
      </div>
      <div className="flex items-center justify-between gap-1">
        <span className="text-muted-foreground">
          {item.sessionId.slice(0, 8)}
        </span>
        <DecisionBadge state={item.state} />
      </div>
    </button>
  )
}

// --- Detail: CheckpointList ---

function CheckpointList({
  icon,
  label,
  items,
}: {
  icon: ReactNode
  label: string
  items?: string[]
}) {
  if (!items || items.length === 0) return null
  return (
    <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
      <div className="mb-2 flex items-center gap-2 font-medium text-foreground">
        {icon}
        {label}
      </div>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item} className="break-words">{item}</li>
        ))}
      </ul>
    </div>
  )
}

// --- Detail: ApprovalCard ---

function ApprovalDetail({ approval, readOnly }: { approval: Approval; readOnly?: boolean }) {
  const approve = useApproveApproval()
  const reject = useRejectApproval()
  const busy = approve.isPending || reject.isPending
  const { from, to, reason } = fallbackSummary(approval.payload)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <ShieldQuestion className="size-5 text-amber-500" />
        <h2 className="text-base font-semibold capitalize">{approval.type} approval</h2>
        {reason && (
          <span className="text-xs rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{reason}</span>
        )}
        {readOnly && <DecisionBadge state={approval.state} />}
      </div>

      {approval.type === 'fallback' && (
        <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-3 text-sm font-mono">
          <span className="text-muted-foreground">{from}</span>
          <ArrowRight className="size-3.5 shrink-0" />
          <span className="text-foreground">{to}</span>
        </div>
      )}

      <div className="text-xs text-muted-foreground">
        Session{' '}
        <Link to={`/?session=${approval.sessionId}`} className="underline hover:text-foreground">
          {approval.sessionId.slice(0, 8)}
        </Link>{' '}
        · {new Date(approval.createdAt).toLocaleString()}
        {approval.resolvedAt && (
          <> · resolved {new Date(approval.resolvedAt).toLocaleString()}</>
        )}
      </div>

      {approval.decisionNotes && (
        <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Notes: </span>
          {approval.decisionNotes}
        </div>
      )}

      {!readOnly && (
        <>
          {(approve.error || reject.error) && (
            <div className="text-xs text-destructive">
              {(approve.error as Error)?.message || (reject.error as Error)?.message}
            </div>
          )}
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => approve.mutate(approval.id)}>
              <Check className="size-3.5" /> Approve &amp; resume
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => reject.mutate(approval.id)}>
              <X className="size-3.5" /> Reject
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

// --- Detail: CheckpointDetail ---

function CheckpointDetail({ checkpoint, readOnly }: { checkpoint: Checkpoint; readOnly?: boolean }) {
  const decide = useDecideCheckpoint()
  const [revisionNotes, setRevisionNotes] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const busy = decide.isPending
  const options = checkpoint.payload.options ?? ['approved', 'rejected', 'deferred', 'revised']

  async function submit(decision: ApprovalDecision) {
    setLocalError(null)
    const trimmed = revisionNotes.trim()
    if (decision === 'revised' && trimmed.length === 0) {
      setLocalError('Revision notes are required to revise and resume.')
      return
    }
    await decide.mutateAsync({
      id: checkpoint.id,
      body: {
        decision,
        notes: trimmed || undefined,
        resumePrompt: decision === 'revised' ? trimmed : undefined,
      },
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <PauseCircle className="size-5 text-amber-500" />
        <h2 className="text-base font-semibold">Human checkpoint</h2>
        {readOnly && <DecisionBadge state={checkpoint.state} />}
      </div>

      <div className="space-y-1">
        <div className="text-sm font-medium text-foreground">{checkpoint.payload.decisionNeeded}</div>
        <div className="text-sm text-muted-foreground">{checkpoint.payload.why}</div>
      </div>

      <div className="text-xs text-muted-foreground">
        Session{' '}
        <Link to={`/?session=${checkpoint.sessionId}`} className="underline hover:text-foreground">
          {checkpoint.sessionId.slice(0, 8)}
        </Link>{' '}
        · {new Date(checkpoint.createdAt).toLocaleString()}
        {checkpoint.resolvedAt && (
          <> · resolved {new Date(checkpoint.resolvedAt).toLocaleString()}</>
        )}
      </div>

      <div className="grid gap-2 md:grid-cols-3">
        <CheckpointList icon={<FileText className="size-3.5" />} label="Files" items={checkpoint.payload.affectedFiles} />
        <CheckpointList icon={<FolderArchive className="size-3.5" />} label="Artifacts" items={checkpoint.payload.affectedArtifacts} />
        <CheckpointList icon={<Wrench className="size-3.5" />} label="Actions" items={checkpoint.payload.affectedActions} />
      </div>

      {checkpoint.decisionNotes && (
        <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Notes: </span>
          {checkpoint.decisionNotes}
        </div>
      )}

      {!readOnly && (
        <>
          {options.includes('revised') && (
            <div className="space-y-2">
              <label className="text-xs font-medium text-foreground">Revision notes</label>
              <Textarea
                rows={3}
                value={revisionNotes}
                onChange={(e) => setRevisionNotes(e.target.value)}
                placeholder="Tell the agent what to change before continuing."
              />
            </div>
          )}

          {(localError || decide.error) && (
            <div className="text-xs text-destructive">
              {localError || (decide.error as Error)?.message}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {options.includes('approved') && (
              <Button size="sm" disabled={busy} onClick={() => void submit('approved')}>
                <Check className="size-3.5" /> Approve
              </Button>
            )}
            {options.includes('revised') && (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void submit('revised')}>
                <FileText className="size-3.5" /> Revise &amp; resume
              </Button>
            )}
            {options.includes('deferred') && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void submit('deferred')}>
                Defer
              </Button>
            )}
            {options.includes('rejected') && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void submit('rejected')}>
                <X className="size-3.5" /> Reject
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// --- Main page ---

export default function ApprovalsPage() {
  useBreadcrumbs([{ label: 'Approvals' }])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedKind, setSelectedKind] = useState<SelectionKind | null>(null)

  const { data: allApprovals, isLoading: approvalsLoading, error: approvalsError } = useApprovals('all')
  const { data: allCheckpoints, isLoading: checkpointsLoading, error: checkpointsError } = useCheckpoints('all')

  const isLoading = approvalsLoading || checkpointsLoading

  const pendingApprovals = allApprovals?.filter((a) => a.state === 'pending') ?? []
  const pendingCheckpoints = allCheckpoints?.filter((c) => c.state === 'pending') ?? []
  const resolvedApprovals = allApprovals?.filter((a) => a.state !== 'pending') ?? []
  const resolvedCheckpoints = allCheckpoints?.filter((c) => c.state !== 'pending') ?? []

  // Merge and sort resolved items newest first
  type ResolvedEntry = { kind: SelectionKind; item: Approval | Checkpoint }
  const resolvedItems: ResolvedEntry[] = [
    ...resolvedApprovals.map((a) => ({ kind: 'approval' as SelectionKind, item: a as Approval | Checkpoint })),
    ...resolvedCheckpoints.map((c) => ({ kind: 'checkpoint' as SelectionKind, item: c as Approval | Checkpoint })),
  ].sort((a, b) => {
    const ta = a.item.resolvedAt ? new Date(a.item.resolvedAt).getTime() : 0
    const tb = b.item.resolvedAt ? new Date(b.item.resolvedAt).getTime() : 0
    return tb - ta
  })

  // Auto-select first pending item when list loads
  useEffect(() => {
    if (selectedId !== null) return
    if (pendingApprovals.length > 0) {
      setSelectedId(pendingApprovals[0].id)
      setSelectedKind('approval')
    } else if (pendingCheckpoints.length > 0) {
      setSelectedId(pendingCheckpoints[0].id)
      setSelectedKind('checkpoint')
    }
  }, [pendingApprovals.length, pendingCheckpoints.length, selectedId])

  // If selected item was actioned (moved to resolved), keep it selected as read-only
  const selectedApproval =
    selectedKind === 'approval' ? allApprovals?.find((a) => a.id === selectedId) : undefined
  const selectedCheckpoint =
    selectedKind === 'checkpoint' ? allCheckpoints?.find((c) => c.id === selectedId) : undefined
  const selectedIsResolved =
    (selectedApproval?.state !== 'pending' && !!selectedApproval) ||
    (selectedCheckpoint?.state !== 'pending' && !!selectedCheckpoint)

  function selectItem(id: string, kind: SelectionKind) {
    setSelectedId(id)
    setSelectedKind(kind)
  }

  return (
    <PageLayout>
      <div className="flex h-full min-h-0">
        {/* Panel 2 — pending queue */}
        <div className="flex w-64 shrink-0 flex-col border-r min-h-0">
          <div className="shrink-0 border-b px-3 py-2.5">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <ShieldQuestion className="size-3.5" />
              Pending
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-0.5">
            {isLoading ? (
              <div className="flex flex-col gap-2 p-1">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : (approvalsError || checkpointsError) ? (
              <p className="p-2 text-xs text-destructive">
                {approvalsError instanceof Error
                  ? approvalsError.message
                  : checkpointsError instanceof Error
                    ? checkpointsError.message
                    : 'Failed to load approvals.'}
              </p>
            ) : pendingApprovals.length === 0 && pendingCheckpoints.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">No pending approvals.</p>
            ) : (
              <>
                {pendingApprovals.map((a) => (
                  <PendingListItem
                    key={a.id}
                    kind="approval"
                    item={a}
                    isSelected={selectedId === a.id && selectedKind === 'approval'}
                    onClick={() => selectItem(a.id, 'approval')}
                  />
                ))}
                {pendingCheckpoints.map((c) => (
                  <PendingListItem
                    key={c.id}
                    kind="checkpoint"
                    item={c}
                    isSelected={selectedId === c.id && selectedKind === 'checkpoint'}
                    onClick={() => selectItem(c.id, 'checkpoint')}
                  />
                ))}
              </>
            )}
          </div>
        </div>

        {/* Panel 3 — detail view */}
        <div data-testid="approvals-scroll-region" className="flex-1 overflow-y-auto p-6 min-w-0">
          {isLoading ? (
            <div className="flex flex-col gap-3 max-w-xl">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-8 w-32" />
            </div>
          ) : !selectedId || (!selectedApproval && !selectedCheckpoint) ? (
            <div className="flex h-full items-center justify-center">
              <div className="flex flex-col items-center gap-2 text-center text-sm text-muted-foreground">
                <MousePointerClick className="size-8 opacity-30" />
                <p>Select a pending approval to review it</p>
              </div>
            </div>
          ) : selectedApproval ? (
            <ApprovalDetail approval={selectedApproval} readOnly={selectedIsResolved} />
          ) : selectedCheckpoint ? (
            <CheckpointDetail checkpoint={selectedCheckpoint} readOnly={selectedIsResolved} />
          ) : null}
        </div>

        {/* Panel 4 — resolved history */}
        <div className="flex w-64 shrink-0 flex-col border-l min-h-0">
          <div className="shrink-0 border-b px-3 py-2.5">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <CheckCircle2 className="size-3.5" />
              Recently handled
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-0.5">
            {isLoading ? (
              <div className="flex flex-col gap-2 p-1">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : resolvedItems.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">No resolved approvals yet.</p>
            ) : (
              resolvedItems.map(({ kind, item }) => (
                <ResolvedListItem
                  key={item.id}
                  kind={kind}
                  item={item}
                  isSelected={selectedId === item.id && selectedKind === kind}
                  onClick={() => selectItem(item.id, kind)}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </PageLayout>
  )
}
