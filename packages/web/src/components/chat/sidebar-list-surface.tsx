import React from "react"
import type { Employee } from "@/lib/api"
import { cn } from "@/lib/utils"
import { ChevronDown, Clock3, Layers } from "lucide-react"
import { roomSelectionId } from "@/lib/rooms/grouping"
import {
  ContactRow,
  EmployeeRow,
  FlatSessionRow,
  SECTION_COUNT_CLASS,
  SECTION_LABEL_CLASS,
  SectionLabel,
  SessionRow,
  type SidebarEmployeeRowProps,
  type SidebarSharedRowProps,
} from "./sidebar-row-components"
import { formatTime } from "./sidebar-session-helpers"
import type { ViewMode } from "./sidebar-types"
import type { VirtualItem } from "./sidebar-view-model"
import type { SessionProject } from "./project-session-tree"
import { ProjectHeaderRow, ProjectSessionRow } from "./sidebar-project-row"

interface SidebarListSurfaceProps {
  loading: boolean
  search: string
  viewMode: ViewMode
  hiddenAutomated: number
  selectViewMode: (mode: ViewMode) => void
  virtualItems: VirtualItem[]
  sharedRowProps: SidebarSharedRowProps
  selectedId: string | null
  expandedRooms: Set<string>
  toggleRoomExpanded: (roomId: string) => void
  onSelectRoom?: (roomId: string) => void
  expandedProjects: Set<string>
  toggleProjectExpanded: (rootSessionId: string) => void
  handleProjectClick: (project: SessionProject) => void
  handleProjectSessionClick: (project: SessionProject, sessionId: string) => void
  expanded: Record<string, boolean>
  handleEmployeeClick: SidebarEmployeeRowProps["handleEmployeeClick"]
  handleMarkAllRead: SidebarEmployeeRowProps["handleMarkAllRead"]
  handleLoadMore: SidebarEmployeeRowProps["onLoadMore"]
  loadingMore: Set<string>
  olderSummaryChats: number
  olderLineLabel: string
  toggleOlderExpanded: () => void
  cronCollapsed: boolean
  toggleCronCollapsed: () => void
  cronTotal: number
  cronSessionsLength: number
  managerEmployees: Employee[]
  teamEmployees: Employee[]
  onContactEmployee?: (name: string) => void
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  handleListScroll: (event: React.UIEvent<HTMLDivElement>) => void
  shouldVirtualize: boolean
  totalSize: number
  virtualRows: Array<{ key: React.Key; index: number; start: number }>
  measureElement: (element: HTMLDivElement | null) => void
}

export function SidebarListSurface({
  loading,
  search,
  viewMode,
  hiddenAutomated,
  selectViewMode,
  virtualItems,
  sharedRowProps,
  selectedId,
  expandedRooms,
  toggleRoomExpanded,
  onSelectRoom,
  expandedProjects,
  toggleProjectExpanded,
  handleProjectClick,
  handleProjectSessionClick,
  expanded,
  handleEmployeeClick,
  handleMarkAllRead,
  handleLoadMore,
  loadingMore,
  olderSummaryChats,
  olderLineLabel,
  toggleOlderExpanded,
  cronCollapsed,
  toggleCronCollapsed,
  cronTotal,
  cronSessionsLength,
  managerEmployees,
  teamEmployees,
  onContactEmployee,
  scrollContainerRef,
  handleListScroll,
  shouldVirtualize,
  totalSize,
  virtualRows,
  measureElement,
}: SidebarListSurfaceProps) {
  const cronHeader = (
    <button
      onClick={toggleCronCollapsed}
      className="flex w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-[var(--fill-tertiary)]"
    >
      <span className={SECTION_LABEL_CLASS}>Scheduled</span>
      <span className={cn("ml-auto", SECTION_COUNT_CLASS)}>{cronTotal}</span>
      <ChevronDown className={cn("size-3.5 shrink-0 text-[var(--text-quaternary)] transition-transform", cronCollapsed && "-rotate-90")} />
    </button>
  )

  const renderItem = (item: VirtualItem): React.ReactNode => {
    switch (item.kind) {
      case "section":
        return (
          <div className="flex items-center gap-2 px-4 pb-1 pt-3">
            <span className={SECTION_LABEL_CLASS}>{item.label}</span>
            {typeof item.count === "number" ? (
              <span className={SECTION_COUNT_CLASS}>{item.count}</span>
            ) : null}
          </div>
        )
      case "flat":
        return (
          <FlatSessionRow
            session={item.row.session}
            avatarName={item.row.avatarName}
            avatar={item.row.avatar}
            emoji={item.row.emoji}
            displayName={item.row.displayName}
            {...sharedRowProps}
          />
        )
      case "older-line":
        return (
          <button
            onClick={toggleOlderExpanded}
            className="mt-1 flex w-full items-center gap-2 px-4 py-2.5 text-left text-[12px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-tertiary)] hover:text-[var(--text-secondary)]"
          >
            <Clock3 className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{olderLineLabel}</span>
            <ChevronDown className="size-3.5 shrink-0 -rotate-90" />
          </button>
        )
      case "older-header":
        return (
          <button
            onClick={toggleOlderExpanded}
            className="mt-1 flex w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-[var(--fill-tertiary)]"
          >
            <span className={SECTION_LABEL_CLASS}>Older</span>
            <span className={cn("ml-auto", SECTION_COUNT_CLASS)}>{olderSummaryChats}</span>
            <ChevronDown className="size-3.5 shrink-0 text-[var(--text-quaternary)]" />
          </button>
        )
      case "employee":
        return (
          <EmployeeRow
            item={item.item}
            expanded={expanded}
            handleEmployeeClick={handleEmployeeClick}
            handleMarkAllRead={handleMarkAllRead}
            onLoadMore={handleLoadMore}
            loadingMore={loadingMore}
            {...sharedRowProps}
          />
        )
      case "project-header":
        return (
          <ProjectHeaderRow
            project={item.project}
            expanded={expandedProjects.has(item.project.rootSessionId)}
            selectedId={selectedId}
            readSessions={sharedRowProps.readSessions}
            onOpen={handleProjectClick}
            onToggle={toggleProjectExpanded}
          />
        )
      case "project-session":
        return (
          <ProjectSessionRow
            project={item.project}
            session={item.node.session}
            depth={item.node.depth}
            sharedRowProps={sharedRowProps}
            onSelect={() => handleProjectSessionClick(item.project, item.node.session.id)}
          />
        )
      case "cron-header":
        return <div className={cn(virtualItems[0]?.kind === "cron-header" && "mt-0")}>{cronHeader}</div>
      case "cron-session":
        return <SessionRow session={item.session} {...sharedRowProps} />
      case "cron-more":
        return (
          <button
            onClick={() => handleLoadMore("__cron__", cronSessionsLength)}
            disabled={loadingMore.has("__cron__")}
            className="w-full cursor-pointer px-4 pb-2 pl-11 text-left text-[10px] text-[var(--text-quaternary)] transition-colors hover:text-[var(--text-secondary)] disabled:opacity-50"
          >
            {loadingMore.has("__cron__") ? "Loading…" : `+${cronTotal - cronSessionsLength} more`}
          </button>
        )
      case "room-header": {
        const { room } = item
        const isExpanded = expandedRooms.has(room.id)
        const isSelected = selectedId === roomSelectionId(room.id)
        const timeLabel = formatTime(room.lastActivity)
        return (
          <div
            className={cn(
              "group/room relative flex w-full items-center gap-2 border-l-2 px-4 py-3 text-left transition-colors",
              isSelected
                ? "border-l-[var(--text-tertiary)] bg-[var(--fill-secondary)]"
                : "border-l-transparent hover:bg-[var(--fill-tertiary)]",
            )}
          >
            <button
              type="button"
              onClick={() => onSelectRoom?.(room.id)}
              aria-current={isSelected ? "page" : undefined}
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--fill-tertiary)] text-[var(--text-secondary)]">
                <Layers className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="mb-0.5 flex items-baseline gap-2">
                  <span className={cn(
                    "min-w-0 flex-1 truncate text-[13px] text-foreground",
                    isSelected ? "font-semibold" : "font-medium",
                  )}>
                    {room.name}
                  </span>
                  {timeLabel ? (
                    <span className="shrink-0 text-[10px] text-[var(--text-tertiary)]">
                      {timeLabel}
                    </span>
                  ) : null}
                </span>
                <span className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[11px] text-[var(--text-tertiary)]">
                  <span className="shrink-0 rounded bg-[var(--fill-tertiary)] px-1.5 py-0.5 text-[10px]">
                    {room.sessionCount} {room.sessionCount === 1 ? "chat" : "chats"}
                  </span>
                  <span className="shrink-0 rounded bg-[var(--fill-tertiary)] px-1.5 py-0.5 text-[10px]">
                    {room.participantCount} {room.participantCount === 1 ? "person" : "people"}
                  </span>
                  {room.needsAttentionCount > 0 ? (
                    <span className="shrink-0 rounded bg-[var(--fill-secondary)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--system-orange)]">
                      {room.needsAttentionCount} need you
                    </span>
                  ) : null}
                  {room.runningCount > 0 ? (
                    <span className="shrink-0 rounded bg-[var(--fill-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--accent)]">
                      {room.runningCount} running
                    </span>
                  ) : null}
                </span>
              </span>
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                toggleRoomExpanded(room.id)
              }}
              aria-label={`${isExpanded ? "Collapse" : "Expand"} ${room.name}`}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-foreground"
            >
              <ChevronDown className={cn("size-3.5 transition-transform", !isExpanded && "-rotate-90")} />
            </button>
          </div>
        )
      }
      default:
        return null
    }
  }

  const emptyState = (
    <div className="px-4 py-8 text-center text-xs text-[var(--text-quaternary)]">
      {search.trim() ? (
        "No matching chats"
      ) : viewMode === "management" ? (
        "No manager conversations yet"
      ) : viewMode === "focused" && hiddenAutomated > 0 ? (
        <>
          No personal chats here.{" "}
          <button onClick={() => selectViewMode("all")} className="text-[var(--accent)] hover:underline">
            View all ({hiddenAutomated} automated)
          </button>
        </>
      ) : (
        "No conversations yet"
      )}
    </div>
  )

  return (
    <div className="relative min-h-0 flex-1">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-10 h-3"
        style={{ background: "linear-gradient(to bottom, var(--sidebar-bg), transparent)" }}
      />
      <div
        ref={scrollContainerRef}
        onScroll={handleListScroll}
        className="h-full overflow-y-auto pb-[calc(49px+var(--safe-bottom))] lg:pb-0"
      >
        {loading ? (
          <div className="px-4 py-8 text-center text-xs text-[var(--text-quaternary)]">
            Loading sessions...
          </div>
        ) : virtualItems.length === 0 ? (
          emptyState
        ) : shouldVirtualize ? (
          <div style={{ height: `${totalSize}px`, position: "relative" }}>
            {virtualRows.map((row) => {
              const item = virtualItems[row.index]
              return (
                <div
                  key={row.key}
                  ref={measureElement}
                  data-index={row.index}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${row.start}px)`,
                  }}
                >
                  {renderItem(item)}
                </div>
              )
            })}
          </div>
        ) : (
          <>
            {virtualItems.map((item, index) => (
              <React.Fragment
                key={
                  item.kind === "flat" ? item.row.session.id
                  : item.kind === "employee" ? item.item.pinKey
                  : item.kind === "project-header" ? `project:${item.project.rootSessionId}`
                  : item.kind === "project-session" ? `project-session:${item.node.session.id}`
                  : item.kind === "cron-session" ? item.session.id
                  : item.kind === "room-header" ? `room:${item.room.id}`
                  : item.kind === "section" ? `section:${item.id}`
                  : `${item.kind}:${index}`
                }
              >
                {renderItem(item)}
              </React.Fragment>
            ))}
          </>
        )}

        {!loading && viewMode === "management" && onContactEmployee && managerEmployees.length > 0 ? (
          <div className="mt-3 pt-1">
            <SectionLabel label="Managers" count={managerEmployees.length} />
            {managerEmployees.map((employee) => (
              <ContactRow key={employee.name} emp={employee} onContact={onContactEmployee} />
            ))}
          </div>
        ) : null}

        {!loading && viewMode === "projects" && onContactEmployee && teamEmployees.length > 0 ? (
          <div className="pt-1">
            <SectionLabel label="Team" count={teamEmployees.length} />
            {teamEmployees.map((employee) => (
              <ContactRow key={employee.name} emp={employee} onContact={onContactEmployee} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}
