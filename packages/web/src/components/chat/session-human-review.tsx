import { useMemo, useState } from 'react'
import { AlertTriangle, Check, FileText, PauseCircle, ShieldQuestion, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useApprovals, useApproveApproval, useRejectApproval } from '@/hooks/use-approvals'
import { useCheckpoints, useDecideCheckpoint } from '@/hooks/use-checkpoints'
import type { Approval, ApprovalDecision, Checkpoint } from '@/lib/api'

function fallbackSummary(payload: Record<string, unknown>): { from: string; to: string; reason?: string } {
  const from = payload.from as { engine?: string; model?: string } | undefined
  const to = payload.to as { engine?: string; model?: string } | undefined
  const fmt = (e?: { engine?: string; model?: string }) =>
    e ? `${e.engine ?? '?'}${e.model ? `/${e.model}` : ''}` : '?'
  return { from: fmt(from), to: fmt(to), reason: typeof payload.reason === 'string' ? payload.reason : undefined }
}

function orgChangeSummary(payload: Record<string, unknown>): {
  changeRequestId: string | null
  changeType: string | null
  employeeName: string | null
  riskLevel: string | null
} {
  return {
    changeRequestId: typeof payload.changeRequestId === 'string' ? payload.changeRequestId : null,
    changeType: typeof payload.changeType === 'string' ? payload.changeType : null,
    employeeName: typeof payload.employeeName === 'string' ? payload.employeeName : null,
    riskLevel: typeof payload.riskLevel === 'string' ? payload.riskLevel : null,
  }
}

function FallbackApprovalCard({ approval }: { approval: Approval }) {
  const approve = useApproveApproval()
  const reject = useRejectApproval()
  const busy = approve.isPending || reject.isPending
  const { from, to, reason } = fallbackSummary(approval.payload)

  return (
    <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <ShieldQuestion className="size-4 text-amber-500" />
        Model fallback approval
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs font-mono text-muted-foreground">
        <span>{from}</span>
        <span aria-hidden>→</span>
        <span className="text-foreground">{to}</span>
      </div>
      {reason ? (
        <div className="mt-1 text-xs text-muted-foreground">{reason}</div>
      ) : null}
      {(approve.error || reject.error) ? (
        <div className="mt-2 text-xs text-destructive">
          {(approve.error as Error)?.message || (reject.error as Error)?.message}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => approve.mutate(approval.id)}>
          <Check className="size-3.5" /> Approve &amp; resume
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => reject.mutate(approval.id)}>
          <X className="size-3.5" /> Reject
        </Button>
      </div>
    </div>
  )
}

function OrgChangeApprovalCard({ approval }: { approval: Approval }) {
  const approve = useApproveApproval()
  const reject = useRejectApproval()
  const busy = approve.isPending || reject.isPending
  const { changeRequestId, changeType, employeeName, riskLevel } = orgChangeSummary(approval.payload)

  if (!changeRequestId) return null

  return (
    <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <ShieldQuestion className="size-4 text-emerald-500" />
        HR change approval
      </div>
      <div className="mt-2 text-sm text-foreground">
        {changeType ?? 'change'} for <span className="font-medium">{employeeName ?? 'employee'}</span>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {riskLevel ? `${riskLevel} risk` : 'Review required'} · request {changeRequestId.slice(0, 8)}
      </div>
      {(approve.error || reject.error) ? (
        <div className="mt-2 text-xs text-destructive">
          {(approve.error as Error)?.message || (reject.error as Error)?.message}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => approve.mutate(approval.id)}>
          <Check className="size-3.5" /> Approve &amp; apply
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => reject.mutate(approval.id)}>
          <X className="size-3.5" /> Reject
        </Button>
      </div>
    </div>
  )
}

function CheckpointCard({ checkpoint }: { checkpoint: Checkpoint }) {
  const decide = useDecideCheckpoint()
  const [revisionNotes, setRevisionNotes] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const options = checkpoint.payload.options ?? ['approved', 'rejected', 'deferred', 'revised']
  const busy = decide.isPending

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
    <div className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-3">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <PauseCircle className="size-4 text-sky-500" />
        Human checkpoint
      </div>
      <div className="mt-2 text-sm text-foreground">{checkpoint.payload.decisionNeeded}</div>
      <div className="mt-1 text-xs text-muted-foreground">{checkpoint.payload.why}</div>
      {options.includes('revised') ? (
        <div className="mt-3 space-y-2">
          <label className="text-xs font-medium text-foreground">Revision notes</label>
          <Textarea
            rows={3}
            value={revisionNotes}
            onChange={(e) => setRevisionNotes(e.target.value)}
            placeholder="Tell the agent what to change before continuing."
          />
        </div>
      ) : null}
      {(localError || decide.error) ? (
        <div className="mt-2 text-xs text-destructive">
          {localError || (decide.error as Error)?.message}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {options.includes('approved') ? (
          <Button size="sm" disabled={busy} onClick={() => void submit('approved')}>
            <Check className="size-3.5" /> Approve
          </Button>
        ) : null}
        {options.includes('revised') ? (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void submit('revised')}>
            <FileText className="size-3.5" /> Revise &amp; resume
          </Button>
        ) : null}
        {options.includes('deferred') ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void submit('deferred')}>
            Defer
          </Button>
        ) : null}
        {options.includes('rejected') ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void submit('rejected')}>
            <X className="size-3.5" /> Reject
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export function SessionHumanReview({ sessionId }: { sessionId: string | null }) {
  const {
    data: approvals,
    isLoading: approvalsLoading,
    error: approvalsError,
  } = useApprovals('pending', sessionId)
  const {
    data: checkpoints,
    isLoading: checkpointsLoading,
    error: checkpointsError,
  } = useCheckpoints('pending', sessionId)

  const visibleApprovals = useMemo(
    () => (approvals ?? []).filter((approval) => approval.type === 'fallback' || approval.type === 'org-change'),
    [approvals],
  )
  const hasItems = visibleApprovals.length > 0 || (checkpoints?.length ?? 0) > 0

  if (!sessionId) return null
  if (!approvalsLoading && !checkpointsLoading && !hasItems && !approvalsError && !checkpointsError) return null

  return (
    <div className="mx-[var(--space-4)] mb-[var(--space-3)] rounded-[var(--radius-lg)] border border-[color-mix(in_srgb,var(--accent)_18%,transparent)] bg-[color-mix(in_srgb,var(--accent)_6%,transparent)] p-[var(--space-3)]">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <AlertTriangle className="size-4 text-[var(--accent)]" />
        Human review needed in this chat
      </div>
      {(approvalsError || checkpointsError) ? (
        <div className="mt-2 text-xs text-destructive">
          {(approvalsError as Error)?.message || (checkpointsError as Error)?.message}
        </div>
      ) : approvalsLoading || checkpointsLoading ? (
        <div className="mt-2 text-xs text-muted-foreground">Loading approval requests…</div>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {visibleApprovals.map((approval) =>
            approval.type === 'org-change'
              ? <OrgChangeApprovalCard key={approval.id} approval={approval} />
              : <FallbackApprovalCard key={approval.id} approval={approval} />,
          )}
          {(checkpoints ?? []).map((checkpoint) => (
            <CheckpointCard key={checkpoint.id} checkpoint={checkpoint} />
          ))}
        </div>
      )}
    </div>
  )
}
