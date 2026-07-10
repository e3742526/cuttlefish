import { useEffect, useMemo, useState } from 'react'
import { safeHttpUrl } from '@/lib/safe-url'
import { Archive, CalendarDays, MessageSquareText, Trash2 } from 'lucide-react'
import { PageLayout } from '@/components/page-layout'
import { useBreadcrumbs } from '@/context/breadcrumb-context'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { useArchive, useArchives, useDeleteArchive } from '@/hooks/use-archives'
import type { ArchivedMessage, ArchivedSessionSnapshot, ProjectArchive } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function archiveTitle(archive: Pick<ProjectArchive, 'label'>): string {
  return archive.label?.trim() || 'Untitled project'
}

function MessageBubble({ message }: { message: ArchivedMessage }) {
  const isUser = message.role === 'user'
  const isAssistant = message.role === 'assistant'
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[min(760px,100%)] rounded-lg border px-3 py-2 text-sm',
          isUser
            ? 'bg-primary text-primary-foreground'
            : isAssistant
              ? 'bg-card text-card-foreground'
              : 'bg-muted text-muted-foreground',
        )}
      >
        <div className="mb-1 flex items-center gap-2 text-[11px] opacity-70">
          <span className="font-medium capitalize">{message.role}</span>
          {message.toolCall ? <span>{message.toolCall}</span> : null}
          <span>{formatDate(new Date(message.timestamp).toISOString())}</span>
        </div>
        {message.content ? (
          <div className="whitespace-pre-wrap break-words leading-relaxed">{message.content}</div>
        ) : null}
        {message.media && message.media.length > 0 ? (
          <div className="mt-2 flex flex-col gap-1 text-xs">
            {message.media.map((media, index) => {
              const safeUrl = safeHttpUrl(media.url)
              return (
                <a
                  key={`${media.url}-${index}`}
                  href={safeUrl ?? undefined}
                  rel="noopener noreferrer"
                  className={cn('underline-offset-2 hover:underline', isUser ? 'text-primary-foreground' : 'text-foreground')}
                >
                  {media.name || media.url}
                </a>
              )
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function SessionSnapshot({ session }: { session: ArchivedSessionSnapshot }) {
  const title = session.title || session.promptExcerpt || session.id.slice(0, 8)
  return (
    <Card className="rounded-lg">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>
          {[session.employee, session.engine, session.model, session.status].filter(Boolean).join(' · ')}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {session.messages.length === 0 ? (
          <EmptyState title="No transcript messages were captured." />
        ) : (
          session.messages.map((message, index) => (
            <MessageBubble key={`${session.id}-${message.timestamp}-${index}`} message={message} />
          ))
        )}
      </CardContent>
    </Card>
  )
}

function ArchiveListCard({
  archive,
  selected,
  onSelect,
}: {
  archive: ProjectArchive
  selected: boolean
  onSelect: () => void
}) {
  return (
    <Card className={cn('rounded-lg py-4 transition-colors', selected && 'border-primary')}>
      <button type="button" onClick={onSelect} className="text-left">
        <CardHeader className="px-4">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Archive />
            <span className="min-w-0 flex-1 truncate">{archiveTitle(archive)}</span>
          </CardTitle>
          <CardDescription className="flex items-center gap-2">
            <CalendarDays />
            {formatDate(archive.createdAt)}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 px-4 text-sm text-muted-foreground">
          <div>{archive.sessionCount} {archive.sessionCount === 1 ? 'chat' : 'chats'} · {archive.kind}</div>
          {archive.note ? <div className="line-clamp-3">{archive.note}</div> : null}
        </CardContent>
      </button>
    </Card>
  )
}

export default function ArchivePage() {
  useBreadcrumbs([{ label: 'Archive' }])
  const { data: archives, isLoading, error: archivesError, refetch: refetchArchives } = useArchives()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const activeId = selectedId ?? archives?.[0]?.id ?? null
  const { data: detail, isLoading: detailLoading, error: detailError, refetch: refetchDetail } = useArchive(activeId)
  const deleteArchive = useDeleteArchive()

  useEffect(() => {
    if (!archives || archives.length === 0) {
      setSelectedId(null)
      return
    }
    if (!activeId || !archives.some((archive) => archive.id === activeId)) {
      setSelectedId(archives[0].id)
    }
  }, [archives, activeId])

  const nextAfterDelete = useMemo(() => {
    if (!archives || !activeId) return null
    return archives.find((archive) => archive.id !== activeId)?.id ?? null
  }, [archives, activeId])

  async function handleDeleteArchive() {
    if (!activeId) return
    await deleteArchive.mutateAsync(activeId)
    setSelectedId(nextAfterDelete)
    setConfirmDeleteOpen(false)
  }

  return (
    <PageLayout>
      <div className="flex h-full flex-col gap-4 overflow-hidden p-4 sm:p-6">
        <div className="flex shrink-0 items-start justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">Previous Projects</h1>
            <p className="text-sm text-muted-foreground">Archived room, scheduled, and chat snapshots.</p>
          </div>
          {detail ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setConfirmDeleteOpen(true)}
              disabled={deleteArchive.isPending}
            >
              <Trash2 />
              Delete
            </Button>
          ) : null}
        </div>

        <ConfirmDialog
          open={confirmDeleteOpen}
          title="Delete archive?"
          description={`Permanently delete "${detail ? archiveTitle(detail) : "this archive"}"?`}
          confirmLabel={deleteArchive.isPending ? 'Deleting...' : 'Delete'}
          destructive
          busy={deleteArchive.isPending}
          onOpenChange={setConfirmDeleteOpen}
          onConfirm={() => {
            void handleDeleteArchive()
          }}
        />

        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[340px_1fr]">
          <div className="min-h-0 overflow-y-auto">
            {isLoading ? (
              <div className="flex flex-col gap-3">
                <Skeleton className="h-28 w-full" />
                <Skeleton className="h-28 w-full" />
              </div>
            ) : archivesError ? (
              <ErrorState
                message={archivesError instanceof Error ? archivesError.message : 'Failed to load previous projects.'}
                onRetry={() => void refetchArchives()}
              />
            ) : !archives || archives.length === 0 ? (
              <EmptyState icon={Archive} title="No previous projects." />
            ) : (
              <div className="flex flex-col gap-3">
                {archives.map((archive) => (
                  <ArchiveListCard
                    key={archive.id}
                    archive={archive}
                    selected={archive.id === activeId}
                    onSelect={() => setSelectedId(archive.id)}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="min-h-0 overflow-y-auto">
            {detailLoading ? (
              <div className="flex flex-col gap-3">
                <Skeleton className="h-36 w-full" />
                <Skeleton className="h-72 w-full" />
              </div>
            ) : detailError ? (
              <ErrorState
                message={detailError instanceof Error ? detailError.message : 'Failed to load archive detail.'}
                onRetry={() => void refetchDetail()}
              />
            ) : !detail ? (
              <EmptyState icon={MessageSquareText} title="Select a previous project." />
            ) : (
              <div className="flex flex-col gap-4">
                <Card className="rounded-lg">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <MessageSquareText />
                      {archiveTitle(detail)}
                    </CardTitle>
                    <CardDescription>
                      {formatDate(detail.createdAt)} · {detail.sessionCount} {detail.sessionCount === 1 ? 'chat' : 'chats'} · {detail.kind}
                    </CardDescription>
                    <CardAction className="text-xs text-muted-foreground">
                      {detail.sourceRef}
                    </CardAction>
                  </CardHeader>
                  {detail.note ? (
                    <CardContent className="whitespace-pre-wrap text-sm text-muted-foreground">
                      {detail.note}
                    </CardContent>
                  ) : null}
                </Card>

                {detail.sessions.map((session) => (
                  <SessionSnapshot key={session.id} session={session} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </PageLayout>
  )
}
