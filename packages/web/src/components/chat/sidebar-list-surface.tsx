import React from "react"
import type { Employee } from "@/lib/api"
import { cn } from "@/lib/utils"
import { ChevronDown, Clock3 } from "lucide-react"
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
import type { VirtualItem } from "./sidebar-view-model"

interface SidebarListSurfaceProps {
  loading: boolean
  search: string
  focusMode: "focused" | "all"
  hiddenAutomated: number
  selectFocusMode: (mode: "focused" | "all") => void
  virtualItems: VirtualItem[]
  sharedRowProps: SidebarSharedRowProps
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
  focusMode,
  hiddenAutomated,
  selectFocusMode,
  virtualItems,
  sharedRowProps,
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
      case "room-header":
        return null
      default:
        return null
    }
  }

  const emptyState = (
    <div className="px-4 py-8 text-center text-xs text-[var(--text-quaternary)]">
      {search.trim() ? (
        "No matching chats"
      ) : focusMode === "focused" && hiddenAutomated > 0 ? (
        <>
          No personal chats here.{" "}
          <button onClick={() => selectFocusMode("all")} className="text-[var(--accent)] hover:underline">
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
                  : item.kind === "cron-session" ? item.session.id
                  : item.kind === "section" ? `section:${item.id}`
                  : `${item.kind}:${index}`
                }
              >
                {renderItem(item)}
              </React.Fragment>
            ))}
          </>
        )}

        {!loading && onContactEmployee && managerEmployees.length > 0 ? (
          <div className="mt-3 pt-1">
            <SectionLabel label="Managers" count={managerEmployees.length} />
            {managerEmployees.map((employee) => (
              <ContactRow key={employee.name} emp={employee} onContact={onContactEmployee} />
            ))}
          </div>
        ) : null}

        {!loading && onContactEmployee && teamEmployees.length > 0 ? (
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
