import { useEffect, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { CollaborationFeedItem, CollaborationSendRequest, ProjectTreeNode } from "@cuttlefish/contracts"
import { AlertTriangle, Filter, RefreshCw, Trash2, Users, X } from "lucide-react"
import { api } from "@/lib/api"
import { useOrg } from "@/hooks/use-employees"
import { queryKeys } from "@/lib/query-keys"
import { Button } from "@/components/ui/button"
import { CollaborationComposer } from "./collaboration-composer"
import { CollaborationFeed } from "./collaboration-feed"
import { ProjectDeleteDialog } from "./project-delete-dialog"
import { SessionInspector } from "./session-inspector"

function flattenTree(nodes: ProjectTreeNode[]): ProjectTreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenTree(node.children)])
}

function mergeFeedItems(older: CollaborationFeedItem[], latest: CollaborationFeedItem[]): CollaborationFeedItem[] {
  const byId = new Map([...older, ...latest].map((item) => [item.id, item]))
  return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
}

export function CollaborationPane({
  lane,
  projectRootSessionId,
  sessionFilterId,
  inspectorOpen,
  connectionSeq,
  onInspectSession,
  onCloseInspector,
  onInvalidProject,
  onInvalidSessionFilter,
  onOpenUnderlyingSession,
  onProjectDeleted,
}: {
  lane: "team" | "management"
  projectRootSessionId: string | null
  sessionFilterId: string | null
  inspectorOpen: boolean
  connectionSeq: number
  onInspectSession: (sessionId: string) => void
  onCloseInspector: () => void
  onInvalidProject: () => void
  onInvalidSessionFilter: () => void
  onOpenUnderlyingSession: (sessionId: string) => void
  onProjectDeleted: (sessionIds: string[]) => void
}) {
  const qc = useQueryClient()
  const { data: org } = useOrg()
  const [olderItems, setOlderItems] = useState<CollaborationFeedItem[]>([])
  const [olderCursor, setOlderCursor] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [announcement, setAnnouncement] = useState("")
  const [projectionWarning, setProjectionWarning] = useState<string | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const treeQuery = useQuery({
    queryKey: ["collaboration", "project-tree", projectRootSessionId],
    queryFn: () => api.getProjectTree(projectRootSessionId!),
    enabled: lane === "team" && Boolean(projectRootSessionId),
    retry: false,
  })
  const feedQuery = useQuery({
    queryKey: ["collaboration", "feed", lane, projectRootSessionId, sessionFilterId],
    queryFn: () => lane === "team"
      ? api.getProjectFeed(projectRootSessionId!, { sessionId: sessionFilterId, limit: 100 })
      : api.getManagementFeed({ projectRootSessionId, limit: 100 }),
    enabled: lane === "management" || Boolean(projectRootSessionId),
    retry: false,
  })
  const recipientsQuery = useQuery({
    queryKey: ["collaboration", "management-recipients", projectRootSessionId],
    queryFn: () => api.getManagementRecipients(projectRootSessionId),
    enabled: lane === "management",
  })

  useEffect(() => {
    setOlderItems([])
    setOlderCursor(null)
    setProjectionWarning(null)
  }, [lane, projectRootSessionId, sessionFilterId])
  useEffect(() => {
    if (feedQuery.data) setOlderCursor(feedQuery.data.nextCursor)
  }, [feedQuery.data])
  useEffect(() => {
    if (treeQuery.error && (treeQuery.error as Error).message.toLowerCase().includes("not found")) onInvalidProject()
  }, [treeQuery.error, onInvalidProject])
  useEffect(() => {
    if (!sessionFilterId || !treeQuery.data) return
    if (!flattenTree(treeQuery.data.tree).some((node) => node.session.id === sessionFilterId)) onInvalidSessionFilter()
  }, [sessionFilterId, treeQuery.data, onInvalidSessionFilter])
  useEffect(() => {
    if (connectionSeq <= 0) return
    if (lane === "team") {
      if (!projectRootSessionId) return
      void feedQuery.refetch()
      void treeQuery.refetch()
      return
    }
    void feedQuery.refetch()
  }, [connectionSeq, lane, projectRootSessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo(() => mergeFeedItems(olderItems, feedQuery.data?.items ?? []), [olderItems, feedQuery.data?.items])
  const flatNodes = useMemo(() => flattenTree(treeQuery.data?.tree ?? []), [treeQuery.data?.tree])
  const selectedSession = sessionFilterId ? flatNodes.find((node) => node.session.id === sessionFilterId)?.session : undefined
  const employeeById = useMemo(() => new Map((org?.employees ?? []).map((employee) => [employee.name, employee])), [org])
  const teamRecipients = useMemo(() => {
    const ids = treeQuery.data?.project.participantIds ?? []
    return ids.flatMap((id) => {
      const employee = employeeById.get(id)
      if (!employee || employee.rank === "manager" || employee.rank === "executive" || employee.lifecycle === "disabled" || employee.lifecycle === "retired") return []
      return [{ id, displayName: employee.displayName, active: true }]
    })
  }, [employeeById, treeQuery.data?.project.participantIds])

  async function loadOlder() {
    if (!olderCursor || loadingOlder) return
    setLoadingOlder(true)
    try {
      const page = lane === "team"
        ? await api.getProjectFeed(projectRootSessionId!, { cursor: olderCursor, sessionId: sessionFilterId, limit: 100 })
        : await api.getManagementFeed({ cursor: olderCursor, projectRootSessionId, limit: 100 })
      setOlderItems((current) => mergeFeedItems(page.items, current))
      setOlderCursor(page.nextCursor)
    } finally {
      setLoadingOlder(false)
    }
  }

  async function send(request: CollaborationSendRequest) {
    const result = lane === "team"
      ? await api.sendProjectMessage(projectRootSessionId!, request)
      : await api.sendManagementMessage(request)
    const queued = result.receipts.filter((receipt) => receipt.state === "queued").length
    const failed = result.receipts.length - queued
    setAnnouncement(failed > 0 ? `${queued} recipients queued; ${failed} failed or unavailable` : `${queued} recipients queued`)
    setProjectionWarning(result.projectionWarning ?? null)
    await Promise.all([
      feedQuery.refetch(),
      qc.invalidateQueries({ queryKey: queryKeys.sessions.all }),
      lane === "team" ? treeQuery.refetch() : Promise.resolve(),
    ])
  }

  if (lane === "team" && !projectRootSessionId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <Users className="size-8 text-[var(--text-tertiary)]" />
        <h2 className="text-base font-semibold">Select a project</h2>
        <p className="max-w-md text-sm text-[var(--text-tertiary)]">Choose a root-session project in Team to open its unified message, delegation, callback, status, and error feed.</p>
      </div>
    )
  }

  const project = treeQuery.data?.project
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="z-20 mt-14 flex min-h-12 shrink-0 items-center gap-2 border-b border-[var(--separator)] bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] px-4 backdrop-blur-xl sm:px-6">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{lane === "team" ? project?.title ?? "Loading project…" : "Management feed"}</div>
          <div className="truncate text-[11px] text-[var(--text-tertiary)]">
            {lane === "team" && project ? `${project.sessionCount} sessions · ${project.participantIds.length} agents` : "Global operator conversations with managers and executives"}
          </div>
        </div>
        {sessionFilterId ? (
          <Button variant="outline" size="sm" onClick={onInvalidSessionFilter}><Filter className="mr-1 size-3.5" />Filtered session<X className="ml-1 size-3" /></Button>
        ) : null}
        <Button variant="ghost" size="icon" aria-label="Refresh collaboration feed" onClick={() => void feedQuery.refetch()}><RefreshCw className="size-4" /></Button>
        {lane === "team" && project ? (
          <Button variant="ghost" size="icon" aria-label="Delete project" onClick={() => setDeleteOpen(true)}><Trash2 className="size-4 text-[var(--system-red)]" /></Button>
        ) : null}
      </div>

      {project?.integrity && project.integrity !== "valid" ? (
        <div className="absolute inset-x-4 top-28 z-20 flex items-center gap-2 rounded-lg border border-[var(--system-orange)]/30 bg-[var(--material-thick)] px-3 py-2 text-xs text-[var(--system-orange)]">
          <AlertTriangle className="size-4" />Session graph integrity: {project.integrity}. The affected sessions remain visible and no parent was guessed.
        </div>
      ) : null}
      {projectionWarning ? (
        <div role="status" className="absolute inset-x-4 top-28 z-20 rounded-lg border border-[var(--system-orange)]/30 bg-[var(--material-thick)] px-3 py-2 text-xs text-[var(--system-orange)]">{projectionWarning}</div>
      ) : null}

      <CollaborationFeed
        items={items}
        loading={feedQuery.isLoading}
        error={feedQuery.error instanceof Error ? feedQuery.error.message : null}
        hasOlder={Boolean(olderCursor)}
        loadingOlder={loadingOlder}
        onLoadOlder={() => void loadOlder()}
        onRetry={() => void feedQuery.refetch()}
        onInspectSession={onInspectSession}
      />
      <CollaborationComposer
        lane={lane}
        recipients={lane === "team" ? teamRecipients : recipientsQuery.data?.recipients ?? []}
        defaultRecipientId={recipientsQuery.data?.defaultRecipientId}
        projectRootSessionId={lane === "management" ? projectRootSessionId : undefined}
        disabled={feedQuery.isLoading || (lane === "team" && !project)}
        onSend={send}
      />
      <div className="sr-only" aria-live="polite">{announcement}</div>

      {inspectorOpen && selectedSession ? (
        <SessionInspector session={selectedSession} onClose={onCloseInspector} onOpenSession={onOpenUnderlyingSession} />
      ) : null}
      {project ? (
        <ProjectDeleteDialog
          project={project}
          open={deleteOpen}
          deleting={deleting}
          onOpenChange={setDeleteOpen}
          onConfirm={async (confirmation) => {
            setDeleting(true)
            try {
              const result = await api.deleteProject(project.rootSessionId, {
                expectedTitle: project.title,
                expectedSessionCount: project.sessionCount,
                confirmation,
              })
              setDeleteOpen(false)
              onProjectDeleted(result.deletedIds)
              await qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
            } finally {
              setDeleting(false)
            }
          }}
        />
      ) : null}
    </div>
  )
}
