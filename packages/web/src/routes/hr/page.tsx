import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { MessageSquare, GitPullRequestArrow, ChevronDown, ChevronRight, ShieldQuestion, Check, X, Archive } from 'lucide-react'
import { PageLayout } from '@/components/page-layout'
import { useBreadcrumbs } from '@/context/breadcrumb-context'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { useTheme } from '@/routes/providers'
import { useOrgChanges, useApproveOrgChange, useRejectOrgChange, useRetiredEmployees } from '@/hooks/use-org-changes'
import type { OrgChangeRequest, OrgChangeRiskLevel, OrgChangeStatus } from '@/lib/api-hr'
import { SyntaxHighlighter, syntaxTheme } from '@/lib/syntax-highlighter'

const HR_EMPLOYEE = 'hr-manager'

const STATUS_LABEL: Record<OrgChangeStatus, string> = {
  draft: 'Draft',
  pending_critique: 'Awaiting HR critique',
  pending_approval: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Rejected',
  applied: 'Applied',
  rolled_back: 'Rolled back',
}

const STATUS_CLASS: Record<OrgChangeStatus, string> = {
  draft: 'bg-muted text-muted-foreground',
  pending_critique: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  pending_approval: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  approved: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  rejected: 'bg-destructive/15 text-destructive',
  applied: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  rolled_back: 'bg-muted text-muted-foreground',
}

const RISK_CLASS: Record<OrgChangeRiskLevel, string> = {
  low: 'bg-muted text-muted-foreground',
  medium: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  high: 'bg-destructive/15 text-destructive',
}

function Badge({ className, children }: { className: string; children: React.ReactNode }) {
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${className}`}>{children}</span>
}

function YamlBlock({ label, yaml, isDark }: { label: string; yaml: string | null | undefined; isDark: boolean }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1 text-xs font-medium text-muted-foreground">{label}</div>
      {yaml ? (
        <SyntaxHighlighter
          language="yaml"
          style={syntaxTheme(isDark)}
          customStyle={{ margin: 0, borderRadius: 8, fontSize: 12, maxHeight: 360, overflow: 'auto' }}
        >
          {yaml}
        </SyntaxHighlighter>
      ) : (
        <div className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
          (nothing yet — new employee)
        </div>
      )}
    </div>
  )
}

function ChangeActions({ request }: { request: OrgChangeRequest }) {
  const approve = useApproveOrgChange()
  const reject = useRejectOrgChange()
  const busy = approve.isPending || reject.isPending
  if (request.status !== 'pending_approval') return null
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => approve.mutate(request.id)}>
          <Check className="size-3.5" /> Approve &amp; apply
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => reject.mutate(request.id)}>
          <X className="size-3.5" /> Reject
        </Button>
      </div>
      {(approve.error || reject.error) && (
        <div className="text-xs text-destructive">
          {(approve.error as Error)?.message || (reject.error as Error)?.message}
        </div>
      )}
    </div>
  )
}

function ChangeCard({ request, isDark }: { request: OrgChangeRequest; isDark: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-lg border bg-card p-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        {open ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
        <span className="font-mono text-sm font-medium">{request.changeType}</span>
        <span className="text-sm text-muted-foreground">·</span>
        <span className="text-sm">{request.employeeName}</span>
        <span className="ml-auto flex items-center gap-1.5">
          <Badge className={RISK_CLASS[request.riskLevel]}>{request.riskLevel} risk</Badge>
          <Badge className={STATUS_CLASS[request.status]}>{STATUS_LABEL[request.status]}</Badge>
        </span>
      </button>

      {request.rationale && (
        <p className="mt-2 pl-6 text-sm text-muted-foreground">{request.rationale}</p>
      )}

      {request.status === 'pending_approval' && (
        <div className="mt-3 pl-6">
          <ChangeActions request={request} />
        </div>
      )}

      {open && (
        <div className="mt-3 flex flex-col gap-3 pl-6">
          {request.hrCritique && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                <ShieldQuestion className="size-3.5" /> HR critique
              </div>
              <div className="whitespace-pre-wrap text-sm text-foreground">{request.hrCritique}</div>
            </div>
          )}
          <div className="flex flex-col gap-3 lg:flex-row">
            <YamlBlock label="Before" yaml={request.beforeYaml} isDark={isDark} />
            <YamlBlock label="After" yaml={request.afterYaml} isDark={isDark} />
          </div>
          <div className="text-xs text-muted-foreground">
            Proposed by {request.proposedBy} · {new Date(request.createdAt).toLocaleString()}
          </div>
        </div>
      )}
    </div>
  )
}

function ChatTab() {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 py-12 text-center">
      <div className="flex size-14 items-center justify-center rounded-full bg-muted">
        <MessageSquare className="size-7 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Chat with the HR / Org Steward</h2>
        <p className="text-sm text-muted-foreground">
          Ask HR to propose a new agent, critique a hire, or review the roster. HR validates every
          proposal against the live engine/model registry and files it as a reviewable change request
          — it never silently edits the org.
        </p>
      </div>
      <Button asChild>
        <Link to={`/?employee=${HR_EMPLOYEE}`}>
          <MessageSquare className="size-4" /> Open chat with HR Manager
        </Link>
      </Button>
    </div>
  )
}

function ChangesTab({ isDark }: { isDark: boolean }) {
  const { data, isLoading, error } = useOrgChanges()
  const requests = useMemo(() => data?.changeRequests ?? [], [data])

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 py-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    )
  }
  if (error) {
    return <div className="py-8 text-center text-sm text-destructive">{(error as Error).message}</div>
  }
  if (requests.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        No org change requests yet. Ask HR to propose one from the Chat tab.
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3 py-4">
      {requests.map((request) => (
        <ChangeCard key={request.id} request={request} isDark={isDark} />
      ))}
    </div>
  )
}

function RetiredTab() {
  const { data, isLoading, error } = useRetiredEmployees()
  const employees = useMemo(() => data?.employees ?? [], [data])

  if (isLoading) return <div className="py-4"><Skeleton className="h-16 w-full" /></div>
  if (error) return <div className="py-8 text-center text-sm text-destructive">{(error as Error).message}</div>
  if (employees.length === 0) {
    return <div className="py-12 text-center text-sm text-muted-foreground">No retired employees.</div>
  }
  return (
    <div className="flex flex-col gap-2 py-4">
      {employees.map((emp) => (
        <div key={emp.name} className="flex items-center gap-2 rounded-lg border bg-card p-3 text-sm">
          <Archive className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-medium">{emp.displayName || emp.name}</span>
          <span className="text-muted-foreground">· {emp.rank} in {emp.department}</span>
          <span className="ml-auto font-mono text-xs text-muted-foreground">{emp.engine}/{emp.model}</span>
        </div>
      ))}
    </div>
  )
}

export default function HrPage() {
  useBreadcrumbs([{ label: 'HR / Org Steward' }])
  const { theme } = useTheme()
  const isDark = theme !== 'light'
  const [tab, setTab] = useState('chat')

  return (
    <PageLayout>
      <div className="mx-auto flex h-full w-full max-w-4xl flex-col overflow-y-auto px-4 py-4">
        <h1 className="mb-3 text-xl font-semibold">HR / Org Steward</h1>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="chat">
              <MessageSquare className="size-4" /> Chat
            </TabsTrigger>
            <TabsTrigger value="changes">
              <GitPullRequestArrow className="size-4" /> Org changes
            </TabsTrigger>
            <TabsTrigger value="retired">
              <Archive className="size-4" /> Retired
            </TabsTrigger>
          </TabsList>
          <TabsContent value="chat">
            <ChatTab />
          </TabsContent>
          <TabsContent value="changes">
            <ChangesTab isDark={isDark} />
          </TabsContent>
          <TabsContent value="retired">
            <RetiredTab />
          </TabsContent>
        </Tabs>
      </div>
    </PageLayout>
  )
}
