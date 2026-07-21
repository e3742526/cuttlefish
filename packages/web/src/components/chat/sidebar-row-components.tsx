import React from "react"
import { EllipsisVertical, Pin, Plus } from "lucide-react"
import type { Employee } from "@/lib/api"
import { EmployeeAvatar } from "@/components/ui/employee-avatar"
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
  SessionRow,
  StatusDot,
  type SidebarDeleteTarget,
  type SidebarSharedRowProps,
} from "./sidebar-session-rows"
import {
  formatTime,
  getSessionActivity,
  getStatusDot,
  titleCase,
} from "./sidebar-session-helpers"
import type { FlatItem, Session } from "./sidebar-types"
export { FlatSessionRow, SessionRow, StatusDot } from "./sidebar-session-rows"
export type { SidebarDeleteTarget, SidebarSharedRowProps } from "./sidebar-session-rows"

export interface SidebarEmployeeRowProps extends SidebarSharedRowProps {
  item: FlatItem
  expanded: Record<string, boolean>
  handleMarkAllRead: (sessions: Session[]) => void
  handleEmployeeClick: (item: FlatItem) => void
  onLoadMore: (groupKey: string, offset: number) => void
  loadingMore: Set<string>
}

export const SECTION_LABEL_CLASS =
  "text-[11px] font-[var(--weight-medium)] tracking-[0.06em] text-[var(--text-tertiary)]"
export const SECTION_COUNT_CLASS = "text-[10px] tabular-nums text-[var(--text-quaternary)]"

export function SectionLabel({
  label,
  count,
}: {
  label: string
  count?: number
}) {
  return (
    <div className="flex items-center gap-2 px-4 py-2">
      <span className={SECTION_LABEL_CLASS}>{label}</span>
      {typeof count === "number" ? (
        <span className={cn("ml-auto", SECTION_COUNT_CLASS)}>{count}</span>
      ) : null}
    </div>
  )
}


export const EmployeeRow = React.memo(function EmployeeRow({
  item,
  selectedId,
  readSessions,
  pinnedSessions,
  expanded,
  renamingSessionId,
  renameCancelledRef,
  fixTitle,
  onSelect,
  onEmployeeSessionsAvailable,
  togglePin,
  handleMarkAllRead,
  handleEmployeeClick,
  setArchiveTarget,
  setDeleteTarget,
  onLoadMore,
  loadingMore,
  setRenamingSessionId,
  updateSessionTitle,
  handleDuplicate,
}: SidebarEmployeeRowProps) {
  const empName = item.employeeName!
  const empSessions = item.sessions!
  const latestSession = empSessions[0]
  const empInfo = item.employeeData
  const displayName = empInfo?.displayName || titleCase(empName)
  const department = empInfo?.department || ""
  const timeLabel = formatTime(getSessionActivity(latestSession))
  const isActive = empSessions.some((session) => session.id === selectedId)
  const isPinned = pinnedSessions.has(item.pinKey)
  const loadedCount = empSessions.length
  const sessionCount = item.total ?? loadedCount
  const groupKey = item.groupKey ?? empName
  const isLoadingMore = loadingMore.has(groupKey)
  const isExpanded = expanded[empName] || false
  const hasUnread = empSessions.some(
    (session) => !readSessions.has(session.id) && session.status !== "running" && session.status !== "error",
  )
  const unreadAgentSession = empSessions.find(
    (session) => Boolean(session.lastAgentMessageAt) && !readSessions.has(session.id),
  )
  const empDot = getStatusDot(unreadAgentSession ?? latestSession, readSessions, hasUnread)

  const sessionRowProps: SidebarSharedRowProps = {
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
  }

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              "group/emp relative flex w-full items-center gap-3 border-l-2 px-4 py-3 text-left transition-colors",
              isActive
                ? "border-l-[var(--text-tertiary)] bg-[var(--fill-secondary)]"
                : "border-l-transparent hover:bg-[var(--fill-tertiary)]",
            )}
          >
            <button
              type="button"
              onClick={() => handleEmployeeClick(item)}
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
            >
              <div className="relative flex size-9 shrink-0 items-center justify-center">
                <EmployeeAvatar name={empName} avatar={empInfo?.avatar} emoji={empInfo?.emoji} size={36} />
                {empDot ? (
                  <StatusDot
                    color={empDot.color}
                    pulse={empDot.pulse}
                    title={empDot.label}
                    className="absolute -bottom-0.5 -right-0 size-2.5 border-2 border-[var(--sidebar-bg)]"
                  />
                ) : null}
              </div>

              <div className="min-w-0 flex-1">
                <div className="mb-0.5 flex items-baseline gap-2">
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-[13px] tracking-[-0.2px] text-foreground",
                      hasUnread || isActive ? "font-semibold" : "font-medium",
                    )}
                  >
                    {displayName}
                  </span>
                  <span className="shrink-0 text-[10px] text-[var(--text-tertiary)] group-hover/emp:lg:hidden group-has-[[data-state=open]]/emp:lg:hidden">
                    {timeLabel}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 overflow-hidden text-[11px] text-[var(--text-tertiary)]">
                  {unreadAgentSession ? (
                    <span className="shrink-0 font-medium text-[var(--system-blue)]">New agent message</span>
                  ) : null}
                  {unreadAgentSession && department ? <span aria-hidden="true">·</span> : null}
                  {department ? <span className="truncate">{department}</span> : null}
                  {sessionCount > 1 ? (
                    <span className="shrink-0 rounded bg-[var(--fill-tertiary)] px-1.5 py-0.5 text-[10px]">
                      {sessionCount} chats
                    </span>
                  ) : null}
                  {isPinned ? (
                    <Pin className="size-3 shrink-0 text-[var(--text-tertiary)]" />
                  ) : null}
                </div>
              </div>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Employee chat actions"
                  className="absolute right-1 top-1/2 flex size-9 shrink-0 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground lg:static lg:size-7 lg:translate-y-0 lg:hidden group-hover/emp:lg:flex group-has-[[data-state=open]]/emp:lg:flex"
                >
                  <EllipsisVertical className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => togglePin(item.pinKey)}>
                  {isPinned ? "Unpin" : "Pin"}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleMarkAllRead(empSessions)}>
                  Mark all as read
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setDeleteTarget({ type: "employee", id: empName, label: displayName, sessions: empSessions })}
                >
                  Delete all chats
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => togglePin(item.pinKey)}>
            {isPinned ? "Unpin" : "Pin"}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => handleMarkAllRead(empSessions)}>
            Mark all as read
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            onClick={() => setDeleteTarget({ type: "employee", id: empName, label: displayName, sessions: empSessions })}
          >
            Delete all chats
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {isExpanded && loadedCount > 1
        ? empSessions.map((session) => (
            <SessionRow key={session.id} session={session} parentSessions={empSessions} {...sessionRowProps} />
          ))
        : null}
      {isExpanded && loadedCount < sessionCount ? (
        <button
          onClick={() => onLoadMore(groupKey, loadedCount)}
          disabled={isLoadingMore}
          className="w-full cursor-pointer px-4 pb-2 pl-11 text-left text-[10px] text-[var(--text-quaternary)] transition-colors hover:text-[var(--text-secondary)] disabled:opacity-50"
        >
          {isLoadingMore ? "Loading…" : `+${sessionCount - loadedCount} more`}
        </button>
      ) : null}
    </div>
  )
})

export function ContactRow({
  emp,
  onContact,
}: {
  emp: Employee
  onContact: (name: string) => void
}) {
  return (
    <button
      onClick={() => onContact(emp.name)}
      title={`Start a chat with ${emp.displayName || titleCase(emp.name)}`}
      className="group/contact relative flex w-full items-center gap-3 border-l-2 border-l-transparent px-4 py-2.5 text-left transition-colors hover:bg-[var(--fill-tertiary)]"
    >
      <div className="relative flex size-9 shrink-0 items-center justify-center">
        <EmployeeAvatar name={emp.name} avatar={emp.avatar} emoji={emp.emoji} size={36} />
      </div>
      <div className="min-w-0 flex-1">
        <span className="block min-w-0 truncate text-[13px] font-medium tracking-[-0.2px] text-foreground">
          {emp.displayName || titleCase(emp.name)}
        </span>
        {emp.department ? (
          <span className="block truncate text-[11px] text-[var(--text-tertiary)]">{emp.department}</span>
        ) : null}
      </div>
      <Plus className="size-3.5 shrink-0 text-[var(--text-quaternary)] transition-colors group-hover/contact:text-[var(--accent)]" />
    </button>
  )
}
