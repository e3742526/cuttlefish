import React from "react"
import { EllipsisVertical, Pin } from "lucide-react"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
import { cleanPreview } from "@/lib/clean-preview"
import { cn } from "@/lib/utils"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  formatTime,
  getJobStateLabel,
  getSessionActivity,
  getStatusDot,
} from "./sidebar-session-helpers"
import type { Session } from "./sidebar-types"

export interface SidebarDeleteTarget {
  type: "session" | "employee"
  id: string
  label: string
  sessions?: Session[]
}

export interface SidebarSharedRowProps {
  selectedId: string | null
  readSessions: Set<string>
  pinnedSessions: Set<string>
  renamingSessionId: string | null
  renameCancelledRef: React.MutableRefObject<boolean>
  fixTitle: (title: string | undefined, employee: string | undefined) => string
  onSelect: (id: string) => void
  onEmployeeSessionsAvailable?: (sessions: Session[]) => void
  togglePin: (pinKey: string) => void
  handleDuplicate: (sessionId: string) => void
  setArchiveTarget: (target: {
    kind: "chat" | "room" | "scheduled"
    title: string
    sessionIds: string[]
    sourceRef?: string
    sessions: Pick<Session, "id" | "status" | "transportState">[]
  } | null) => void
  setDeleteTarget: (target: SidebarDeleteTarget | null) => void
  setRenamingSessionId: (id: string | null) => void
  updateSessionTitle: (id: string, title: string) => void
}

export function StatusDot({
  color,
  pulse = false,
  className,
  title,
}: {
  color: string
  pulse?: boolean
  className?: string
  title?: string
}) {
  return (
    <span
      className={cn("shrink-0 rounded-full", className)}
      title={title}
      role={title ? "img" : undefined}
      aria-label={title}
      style={{
        background: color,
        animation: pulse ? "sidebar-pulse 2s ease-in-out infinite" : "none",
        boxShadow: pulse ? `0 0 8px ${color}` : "none",
      }}
    />
  )
}

function SessionActionsMenu({
  pinned,
  onRename,
  onTogglePin,
  onDuplicate,
  onArchive,
  onDelete,
  label,
}: {
  pinned: boolean
  onRename: () => void
  onTogglePin: () => void
  onDuplicate: () => void
  onArchive: () => void
  onDelete: () => void
  label: string
}) {
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground lg:size-7 lg:hidden group-hover/session:lg:flex group-has-[[data-state=open]]/session:lg:flex group-hover/flat:lg:flex group-has-[[data-state=open]]/flat:lg:flex"
          >
            <EllipsisVertical className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onRename}>Rename</DropdownMenuItem>
          <DropdownMenuItem onClick={onTogglePin}>{pinned ? "Unpin" : "Pin"}</DropdownMenuItem>
          <DropdownMenuItem onClick={onDuplicate}>Duplicate...</DropdownMenuItem>
          <DropdownMenuItem onClick={onArchive}>Archive...</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            Delete session
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

function SessionContextMenu({
  pinned,
  onRename,
  onTogglePin,
  onDuplicate,
  onArchive,
  onDelete,
  children,
}: {
  pinned: boolean
  onRename: () => void
  onTogglePin: () => void
  onDuplicate: () => void
  onArchive: () => void
  onDelete: () => void
  children: React.ReactNode
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onRename}>Rename</ContextMenuItem>
        <ContextMenuItem onClick={onTogglePin}>{pinned ? "Unpin" : "Pin"}</ContextMenuItem>
        <ContextMenuItem onClick={onDuplicate}>Duplicate...</ContextMenuItem>
        <ContextMenuItem onClick={onArchive}>Archive...</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={onDelete}>
          <span className="flex-1">Delete session</span>
          <kbd className="ml-auto pl-3 font-mono text-[10px] text-[var(--text-quaternary)]">⌫</kbd>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

interface SessionRowProps extends SidebarSharedRowProps {
  session: Session
  parentSessions?: Session[]
}

export const SessionRow = React.memo(function SessionRow({
  session,
  parentSessions,
  selectedId,
  readSessions,
  pinnedSessions,
  renamingSessionId,
  renameCancelledRef,
  fixTitle,
  onSelect,
  onEmployeeSessionsAvailable,
  togglePin,
  handleDuplicate,
  setArchiveTarget,
  setDeleteTarget,
  setRenamingSessionId,
  updateSessionTitle,
}: SessionRowProps) {
  const sessionIsActive = session.id === selectedId
  const sessionDot = getStatusDot(session, readSessions)
  const jobStateLabel = getJobStateLabel(session, Boolean(session.lastAgentMessageAt && !readSessions.has(session.id)))
  const sessionTitle = fixTitle(session.title ?? undefined, session.employee ?? undefined)
  const displayTitle = cleanPreview(sessionTitle) || sessionTitle
  const sessionTime = formatTime(getSessionActivity(session))
  const isPinned = pinnedSessions.has(session.id)
  const isRenaming = renamingSessionId === session.id

  const actions = {
    onRename: () => {
      renameCancelledRef.current = false
      setRenamingSessionId(session.id)
    },
    onTogglePin: () => togglePin(session.id),
    onDuplicate: () => handleDuplicate(session.id),
    onArchive: () =>
      setArchiveTarget({
        kind: "chat",
        title: cleanPreview(sessionTitle) || "Untitled",
        sessionIds: [session.id],
        sourceRef: session.sourceRef,
        sessions: [
          {
            id: session.id,
            status: session.status,
            transportState: session.transportState,
          },
        ],
      }),
    onDelete: () => setDeleteTarget({ type: "session", id: session.id, label: cleanPreview(sessionTitle) || "Untitled" }),
  }

  return (
    <SessionContextMenu pinned={isPinned} {...actions}>
      <div
        className={cn(
          "group/session relative flex w-full items-center gap-2.5 border-l-2 px-4 py-2 text-left transition-colors",
          parentSessions ? "pl-11" : "pl-6",
          sessionIsActive
            ? "border-l-[var(--text-tertiary)] bg-[var(--fill-secondary)]"
            : "border-l-transparent hover:bg-[var(--fill-tertiary)]",
        )}
      >
        <button
          type="button"
          onClick={() => {
            onSelect(session.id)
            onEmployeeSessionsAvailable?.(parentSessions ?? [session])
          }}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          {sessionDot ? (
            <StatusDot
              color={sessionDot.color}
              pulse={sessionDot.pulse}
              title={sessionDot.label}
              className="size-1.5"
            />
          ) : null}
          {isRenaming ? (
            <input
              autoFocus
              maxLength={200}
              defaultValue={displayTitle}
              className={cn(
                "min-w-0 flex-1 truncate rounded border-none bg-transparent px-0.5 text-xs outline-none ring-1 ring-[var(--text-quaternary)]",
                sessionIsActive ? "font-semibold text-foreground" : "text-[var(--text-secondary)]",
              )}
              onFocus={(e) => e.target.select()}
              onClick={(e) => {
                e.stopPropagation()
                e.preventDefault()
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.currentTarget.blur()
                } else if (e.key === "Escape") {
                  renameCancelledRef.current = true
                  setRenamingSessionId(null)
                }
              }}
              onBlur={(e) => {
                if (renameCancelledRef.current) {
                  renameCancelledRef.current = false
                  return
                }
                const val = e.target.value.trim()
                if (val && val !== displayTitle) {
                  updateSessionTitle(session.id, val)
                }
                setRenamingSessionId(null)
              }}
            />
          ) : (
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-xs",
                sessionIsActive ? "font-semibold text-foreground" : "text-[var(--text-secondary)]",
              )}
            >
              {jobStateLabel ? `${jobStateLabel} · ` : ""}{cleanPreview(sessionTitle) || "Untitled"}
            </span>
          )}
          {isPinned ? (
            <Pin className="size-3 shrink-0 text-[var(--text-tertiary)] group-hover/session:lg:hidden group-has-[[data-state=open]]/session:lg:hidden" />
          ) : null}
          <span className="shrink-0 text-[10px] text-[var(--text-quaternary)] group-hover/session:lg:hidden group-has-[[data-state=open]]/session:lg:hidden">
            {sessionTime}
          </span>
        </button>
        <SessionActionsMenu pinned={isPinned} label="Session actions" {...actions} />
      </div>
    </SessionContextMenu>
  )
})

interface FlatSessionRowProps extends SidebarSharedRowProps {
  session: Session
  avatarName: string
  avatar?: string
  emoji?: string
  displayName: string
}

export const FlatSessionRow = React.memo(function FlatSessionRow({
  session,
  avatarName,
  avatar,
  emoji,
  displayName,
  selectedId,
  readSessions,
  pinnedSessions,
  renamingSessionId,
  renameCancelledRef,
  fixTitle,
  onSelect,
  onEmployeeSessionsAvailable,
  togglePin,
  handleDuplicate,
  setArchiveTarget,
  setDeleteTarget,
  setRenamingSessionId,
  updateSessionTitle,
}: FlatSessionRowProps) {
  const isActive = session.id === selectedId
  const dot = getStatusDot(session, readSessions)
  const jobStateLabel = getJobStateLabel(session, Boolean(session.lastAgentMessageAt && !readSessions.has(session.id)))
  const rawTitle = fixTitle(session.title ?? undefined, session.employee ?? undefined)
  const displayTitle = cleanPreview(rawTitle) || "Untitled"
  const time = formatTime(getSessionActivity(session))
  const isPinned = pinnedSessions.has(session.id)
  const isRenaming = renamingSessionId === session.id
  const isUnread =
    !readSessions.has(session.id) && session.status !== "running" && session.status !== "error"

  const actions = {
    onRename: () => {
      renameCancelledRef.current = false
      setRenamingSessionId(session.id)
    },
    onTogglePin: () => togglePin(session.id),
    onDuplicate: () => handleDuplicate(session.id),
    onArchive: () =>
      setArchiveTarget({
        kind: "chat",
        title: displayTitle,
        sessionIds: [session.id],
        sourceRef: session.sourceRef,
        sessions: [
          {
            id: session.id,
            status: session.status,
            transportState: session.transportState,
          },
        ],
      }),
    onDelete: () => setDeleteTarget({ type: "session", id: session.id, label: displayTitle }),
  }

  return (
    <SessionContextMenu pinned={isPinned} {...actions}>
      <div
        className={cn(
          "group/flat relative flex w-full items-center gap-3 border-l-2 px-4 py-2 text-left transition-colors",
          isActive
            ? "border-l-[var(--text-tertiary)] bg-[var(--fill-secondary)]"
            : "border-l-transparent hover:bg-[var(--fill-tertiary)]",
        )}
      >
        <button
          type="button"
          onClick={() => {
            onSelect(session.id)
            onEmployeeSessionsAvailable?.([session])
          }}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <div className="relative flex size-9 shrink-0 items-center justify-center">
            <EmployeeAvatar name={avatarName} avatar={avatar} emoji={emoji} size={36} />
            {dot ? (
              <StatusDot
                color={dot.color}
                pulse={dot.pulse}
                title={dot.label}
                className="absolute -bottom-0.5 -right-0 size-2.5 border-2 border-[var(--sidebar-bg)]"
              />
            ) : null}
          </div>

          <div className="min-w-0 flex-1">
            <div className="mb-0.5 flex items-baseline gap-2">
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[13px] tracking-[-0.2px] text-foreground",
                  isUnread || isActive ? "font-semibold" : "font-medium",
                )}
              >
                {displayName}
              </span>
              <span className="shrink-0 text-[10px] text-[var(--text-tertiary)]">{time}</span>
            </div>
            {isRenaming ? (
              <input
                autoFocus
                maxLength={200}
                defaultValue={displayTitle}
                className="min-w-0 w-full truncate rounded border-none bg-transparent px-0.5 text-[11px] text-[var(--text-secondary)] outline-none ring-1 ring-[var(--text-quaternary)]"
                onFocus={(e) => e.target.select()}
                onClick={(e) => {
                  e.stopPropagation()
                  e.preventDefault()
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur()
                  else if (e.key === "Escape") {
                    renameCancelledRef.current = true
                    setRenamingSessionId(null)
                  }
                }}
                onBlur={(e) => {
                  if (renameCancelledRef.current) {
                    renameCancelledRef.current = false
                    return
                  }
                  const val = e.target.value.trim()
                  if (val && val !== displayTitle) updateSessionTitle(session.id, val)
                  setRenamingSessionId(null)
                }}
              />
            ) : (
              <div className="flex min-w-0 items-center gap-1 truncate text-[11px] text-[var(--text-tertiary)]">
                {jobStateLabel ? (
                  <>
                    <span
                      className={cn(
                        "shrink-0 font-medium",
                        jobStateLabel === "Needs your attention" && "text-[var(--system-orange)]",
                        jobStateLabel === "Job finished" && "text-[var(--system-green)]",
                        jobStateLabel === "Job failed" && "text-[var(--system-red)]",
                        jobStateLabel === "New agent message" && "text-[var(--system-blue)]",
                      )}
                    >
                      {jobStateLabel}
                    </span>
                    <span aria-hidden="true">·</span>
                  </>
                ) : null}
                <span className="truncate">{displayTitle}</span>
              </div>
            )}
          </div>
        </button>

        {isPinned ? (
          <Pin className="size-3 shrink-0 text-[var(--text-tertiary)] group-hover/flat:lg:hidden group-has-[[data-state=open]]/flat:lg:hidden" />
        ) : null}
        <SessionActionsMenu pinned={isPinned} label="Chat actions" {...actions} />
      </div>
    </SessionContextMenu>
  )
})
