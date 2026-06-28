import React, { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Search, X } from "lucide-react"
import { api, type Employee, type SessionsResponse } from "@/lib/api"
import { useOrg } from "@/hooks/use-employees"
import {
  useBulkDeleteSessions,
  useDeleteSession,
  useDuplicateSession,
  useSessionCounts,
  useSessionSearch,
  useSessions,
  useUpdateSession,
} from "@/hooks/use-sessions"
import { queryKeys } from "@/lib/query-keys"
import { useSettings } from "@/routes/settings-provider"
import { portalEmployeeSlug } from "@/lib/portal-slug"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { SidebarListSurface } from "./sidebar-list-surface"
import { ArchiveDialog, type ArchiveDialogTarget } from "./archive-dialog"
import type { SidebarDeleteTarget, SidebarSharedRowProps } from "./sidebar-row-components"
import {
  getPinnedSessions,
  getReadSessions,
  loadCollapsedState,
  loadExpandedState,
  markAllReadForEmployee,
  markSessionRead,
  saveCollapsedState,
  saveExpandedState,
  savePinnedSessions,
} from "./sidebar-storage"
import type { FlatItem, Session, SidebarOrder, ViewMode } from "./sidebar-types"
import {
  buildContactableEmployees,
  buildManagerEmployees,
  buildSidebarCollections,
  buildSidebarOrder,
  buildVirtualItems,
  buildVisibleSessions,
  CRON_GROUP,
  formatOlderLineLabel,
  VIRTUALIZE_THRESHOLD,
} from "./sidebar-view-model"

export type { SidebarOrder } from "./sidebar-types"
export {
  hasBackgroundActivity,
  isDirectSession,
  isRecentError,
  resolveRowIdentity,
} from "./sidebar-session-helpers"

interface ChatSidebarProps {
  selectedId: string | null
  onSelect: (id: string) => void
  onNewChat: () => void
  onDelete?: (id: string) => void
  onDuplicate?: (newSessionId: string) => void
  onSessionsLoaded?: (sessions: Session[]) => void
  onEmployeeSessionsAvailable?: (sessions: Session[]) => void
  onOrderComputed?: (order: SidebarOrder) => void
  onContactEmployee?: (name: string) => void
}

type FocusMode = Extract<ViewMode, "focused" | "all">

const OLDER_EXPANDED_STORAGE_KEY = "cuttlefish-sidebar-older-expanded"
const FOCUS_MODE_STORAGE_KEY = "cuttlefish-sidebar-focus-mode"

export function ChatSidebar({
  selectedId,
  onSelect,
  onNewChat,
  onDelete,
  onDuplicate,
  onSessionsLoaded,
  onEmployeeSessionsAvailable,
  onOrderComputed,
  onContactEmployee,
}: ChatSidebarProps) {
  const { settings } = useSettings()
  const portalName = settings.portalName ?? "Cuttlefish"
  const portalSlug = portalEmployeeSlug(portalName)

  const qc = useQueryClient()
  const { data: rawSessions, isLoading: loading } = useSessions()
  const { data: meta } = useSessionCounts()
  const counts = meta?.counts ?? {}
  const updateSessionMutation = useUpdateSession()
  const deleteSessionMutation = useDeleteSession()
  const bulkDeleteMutation = useBulkDeleteSessions()
  const duplicateSessionMutation = useDuplicateSession()
  const { data: orgData } = useOrg()
  const orgEmployees = orgData?.employees ?? []

  const sessions = useMemo(
    () => buildVisibleSessions(rawSessions as Session[] | undefined),
    [rawSessions],
  )

  const [search, setSearch] = useState("")
  const { data: searchResults } = useSessionSearch(search)
  const [searchOpen, setSearchOpen] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setSearch("")
  }, [])

  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)
  const renameCancelledRef = useRef(false)
  const [readSessions, setReadSessions] = useState<Set<string>>(new Set())
  const [pinnedSessions, setPinnedSessions] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [olderExpanded, setOlderExpanded] = useState(false)
  const [focusMode, setFocusMode] = useState<FocusMode>("all")
  const [loadingMore, setLoadingMore] = useState<Set<string>>(new Set())
  const [deleteTarget, setDeleteTarget] = useState<SidebarDeleteTarget | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<ArchiveDialogTarget | null>(null)
  const deleteButtonRef = useRef<HTMLButtonElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [listScrolled, setListScrolled] = useState(false)

  const employeeData = useMemo(() => {
    const map = new Map<string, Employee>()
    for (const employee of orgEmployees) {
      map.set(employee.name, employee)
    }
    return map
  }, [orgEmployees])

  const onSessionsLoadedRef = useRef(onSessionsLoaded)
  useEffect(() => {
    onSessionsLoadedRef.current = onSessionsLoaded
  }, [onSessionsLoaded])

  useEffect(() => {
    if (sessions.length > 0) {
      startTransition(() => {
        onSessionsLoadedRef.current?.(sessions)
      })
    }
  }, [sessions])

  useEffect(() => {
    setReadSessions(getReadSessions())
    setPinnedSessions(getPinnedSessions())
    setCollapsed(loadCollapsedState())
    setExpanded(loadExpandedState())
    try {
      setOlderExpanded(localStorage.getItem(OLDER_EXPANDED_STORAGE_KEY) === "true")
      const stored = localStorage.getItem(FOCUS_MODE_STORAGE_KEY)
      if (stored === "focused" || stored === "all") setFocusMode(stored)
    } catch {}
  }, [])

  useEffect(() => {
    if (selectedId) {
      markSessionRead(selectedId)
      setReadSessions((prev) => {
        const next = new Set(prev)
        next.add(selectedId)
        return next
      })
    }
  }, [selectedId])

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  const selectFocusMode = useCallback((mode: FocusMode) => {
    setFocusMode(mode)
    try {
      localStorage.setItem(FOCUS_MODE_STORAGE_KEY, mode)
    } catch {}
  }, [])

  const toggleOlderExpanded = useCallback(() => {
    setOlderExpanded((prev) => {
      const next = !prev
      try {
        localStorage.setItem(OLDER_EXPANDED_STORAGE_KEY, String(next))
      } catch {}
      return next
    })
  }, [])

  const toggleCronCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has("cron")) next.delete("cron")
      else next.add("cron")
      saveCollapsedState(next)
      return next
    })
  }, [])

  const handleLoadMore = useCallback(async (groupKey: string, offset: number) => {
    if (loadingMore.has(groupKey)) return
    setLoadingMore((prev) => new Set(prev).add(groupKey))
    try {
      const more = await api.getSessionsForGroup(groupKey, offset, 50)
      qc.setQueryData<SessionsResponse>(queryKeys.sessions.all, (old) => {
        if (!old) return old
        const seen = new Set(old.sessions.map((session) => session.id as string))
        const merged = [...old.sessions, ...more.filter((session) => !seen.has(session.id as string))]
        return { ...old, sessions: merged }
      })
    } catch {
      // Non-fatal; the UI re-enables the load-more button in finally.
    } finally {
      setLoadingMore((prev) => {
        const next = new Set(prev)
        next.delete(groupKey)
        return next
      })
    }
  }, [loadingMore, qc])

  const toggleEmployeeExpanded = useCallback((employeeName: string) => {
    setExpanded((prev) => {
      const next = { ...prev, [employeeName]: !prev[employeeName] }
      saveExpandedState(next)
      return next
    })
  }, [])

  const togglePin = useCallback((pinKey: string) => {
    setPinnedSessions((prev) => {
      const next = new Set(prev)
      if (next.has(pinKey)) next.delete(pinKey)
      else next.add(pinKey)
      savePinnedSessions(next)
      return next
    })
  }, [])

  const handleMarkAllRead = useCallback((employeeSessions: Session[]) => {
    markAllReadForEmployee(employeeSessions)
    setReadSessions((prev) => {
      const next = new Set(prev)
      for (const session of employeeSessions) next.add(session.id)
      return next
    })
  }, [])

  async function handleDeleteEmployee(employeeName: string, employeeSessions: Session[]) {
    const ids = employeeSessions.map((session) => session.id)
    try {
      await bulkDeleteMutation.mutateAsync(ids)
      setPinnedSessions((prev) => {
        const next = new Set(prev)
        next.delete(`emp:${employeeName}`)
        for (const id of ids) next.delete(id)
        savePinnedSessions(next)
        return next
      })
      startTransition(() => {
        if (selectedId && ids.includes(selectedId)) onNewChat()
      })
    } catch {}
  }

  const {
    searching,
    searchRows,
    todayRows,
    yesterdayRows,
    olderSummary,
    olderFocusedRows,
    hiddenAutomated,
    olderPinned,
    olderUnpinned,
    pinnedFlat,
    unpinnedFlat,
    sortedCron,
    cronSessions,
    cronTotal,
  } = useMemo(() => buildSidebarCollections({
    sessions,
    search,
    searchResults: searchResults as Session[] | undefined,
    employeeData,
    portalSlug,
    portalName,
    pinnedSessions,
    counts,
    viewMode: focusMode,
  }), [sessions, search, searchResults, employeeData, portalSlug, portalName, pinnedSessions, counts, focusMode])

  const cronCollapsed = collapsed.has("cron")

  const contactableEmployees = useMemo(() => buildContactableEmployees({
    search,
    pinnedFlat,
    unpinnedFlat,
    orgEmployees,
    employeeData,
    portalSlug,
  }), [search, pinnedFlat, unpinnedFlat, orgEmployees, employeeData, portalSlug])

  const managerEmployees = useMemo(
    () => buildManagerEmployees({
      search,
      orgEmployees: contactableEmployees,
      portalSlug,
    }),
    [search, contactableEmployees, portalSlug],
  )
  const managerEmployeeNames = useMemo(
    () => new Set(managerEmployees.map((employee) => employee.name)),
    [managerEmployees],
  )
  const teamEmployees = useMemo(
    () => contactableEmployees.filter((employee) => !managerEmployeeNames.has(employee.name)),
    [contactableEmployees, managerEmployeeNames],
  )

  const allFlatIds = useMemo(() => buildSidebarOrder({
    searching,
    searchRows,
    viewMode: focusMode,
    rooms: [],
    sortedCron,
    pinnedFlat,
    unpinnedFlat,
    todayRows,
    yesterdayRows,
    olderExpanded,
    olderFocusedRows,
    olderPinned,
    olderUnpinned,
    expanded,
  }), [
    searching,
    searchRows,
    focusMode,
    sortedCron,
    pinnedFlat,
    unpinnedFlat,
    todayRows,
    yesterdayRows,
    olderExpanded,
    olderFocusedRows,
    olderPinned,
    olderUnpinned,
    expanded,
  ])

  const orderRef = useRef("")
  useEffect(() => {
    const key = allFlatIds.sessionIds.join(",")
    if (key !== orderRef.current) {
      orderRef.current = key
      onOrderComputed?.(allFlatIds)
    }
  }, [allFlatIds, onOrderComputed])

  const handleEmployeeClick = useCallback((item: FlatItem) => {
    const employeeName = item.employeeName!
    const employeeSessions = item.sessions!
    if (employeeSessions.length > 1) {
      const wasExpanded = expanded[employeeName] || false
      toggleEmployeeExpanded(employeeName)
      if (!wasExpanded) {
        onSelect(employeeSessions[0].id)
        onEmployeeSessionsAvailable?.(employeeSessions)
      }
    } else {
      onSelect(employeeSessions[0].id)
      onEmployeeSessionsAvailable?.(employeeSessions)
    }
  }, [expanded, onEmployeeSessionsAvailable, onSelect, toggleEmployeeExpanded])

  const fixTitle = useCallback((title: string | undefined, employee: string | undefined) => {
    if (!title) return employee || portalName
    if (portalName !== "Cuttlefish" && title.startsWith("Cuttlefish - ")) {
      return portalName + title.slice(4)
    }
    return title
  }, [portalName])

  const updateSessionTitle = useCallback((id: string, title: string) => {
    updateSessionMutation.mutate({ id, data: { title } })
  }, [updateSessionMutation])

  const handleDuplicate = useCallback(async (sessionId: string) => {
    try {
      const result = await duplicateSessionMutation.mutateAsync(sessionId) as { id?: string }
      if (result?.id) {
        onDuplicate?.(result.id)
        onSelect(result.id)
        setRenamingSessionId(result.id)
        renameCancelledRef.current = false
      }
    } catch (err: any) {
      window.alert(`Duplicate failed: ${err.message || "Unknown error"}`)
    }
  }, [duplicateSessionMutation, onDuplicate, onSelect])

  const sharedRowProps = useMemo<SidebarSharedRowProps>(() => ({
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
  }), [
    selectedId,
    readSessions,
    pinnedSessions,
    renamingSessionId,
    fixTitle,
    onSelect,
    onEmployeeSessionsAvailable,
    togglePin,
    handleDuplicate,
    updateSessionTitle,
  ])

  const handleListScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const next = event.currentTarget.scrollTop > 2
    setListScrolled((prev) => (prev === next ? prev : next))
  }, [])

  const virtualItems = useMemo(() => buildVirtualItems({
    searching,
    searchRows,
    viewMode: focusMode,
    rooms: [],
    expandedRooms: new Set(),
    cronSessions,
    cronCollapsed,
    sortedCron,
    cronTotal,
    todayRows,
    yesterdayRows,
    olderSummary,
    olderExpanded,
    olderFocusedRows,
    olderPinned,
    olderUnpinned,
    portalSlug,
    portalName,
    employeeData,
  }), [
    searching,
    searchRows,
    focusMode,
    cronSessions,
    cronCollapsed,
    sortedCron,
    cronTotal,
    todayRows,
    yesterdayRows,
    olderSummary,
    olderExpanded,
    olderFocusedRows,
    olderPinned,
    olderUnpinned,
    portalSlug,
    portalName,
    employeeData,
  ])

  const shouldVirtualize = virtualItems.length >= VIRTUALIZE_THRESHOLD
  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualize ? virtualItems.length : 0,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => {
      if (!shouldVirtualize) return 52
      const item = virtualItems[index]
      switch (item.kind) {
        case "section":
          return 32
        case "older-header":
          return 36
        case "older-line":
          return 40
        case "cron-header":
          return 36
        case "cron-session":
          return 36
        case "cron-more":
          return 28
        case "flat":
          return 52
        default:
          return 64
      }
    },
    overscan: 5,
    enabled: shouldVirtualize,
  })

  const virtualRows = shouldVirtualize
    ? rowVirtualizer.getVirtualItems().map((item) => ({
        key: item.key,
        index: item.index,
        start: item.start,
      }))
    : []

  async function handleDelete(sessionId: string) {
    let nextSelectId: string | null = null
    if (selectedId === sessionId) {
      const allVisible = allFlatIds.sessionIds
      const idx = allVisible.indexOf(sessionId)
      if (idx !== -1) {
        if (idx + 1 < allVisible.length) nextSelectId = allVisible[idx + 1]
        else if (idx - 1 >= 0) nextSelectId = allVisible[idx - 1]
      }
    }

    try {
      await deleteSessionMutation.mutateAsync(sessionId)
      setPinnedSessions((prev) => {
        if (!prev.has(sessionId)) return prev
        const next = new Set(prev)
        next.delete(sessionId)
        savePinnedSessions(next)
        return next
      })
      startTransition(() => {
        if (nextSelectId) {
          onSelect(nextSelectId)
        } else if (onDelete) {
          onDelete(sessionId)
        } else if (selectedId === sessionId) {
          onNewChat()
        }
      })
    } catch {}
  }

  return (
    <div className="relative z-10 flex h-full flex-col bg-[var(--sidebar-bg)] shadow-[var(--shadow-card)]">
      <div
        className={cn(
          "shrink-0 bg-[var(--sidebar-bg)] px-3 py-2 transition-shadow duration-150",
          listScrolled && "shadow-[0_1px_0_0_var(--separator)]",
        )}
      >
        <div className="relative flex h-9 items-center">
          <div
            className={cn(
              "flex w-full items-center gap-2 transition-opacity duration-200 [transition-timing-function:var(--ease-smooth)] motion-reduce:transition-none",
              searchOpen ? "pointer-events-none opacity-0" : "opacity-100",
            )}
            aria-hidden={searchOpen}
          >
            <div className="flex items-center gap-0.5 rounded-full bg-[var(--fill-tertiary)] p-0.5 text-[11px] font-medium">
              {(["focused", "all"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => selectFocusMode(mode)}
                  aria-pressed={focusMode === mode}
                  title={mode === "focused" ? "Only chats you started" : "Include automated & delegated sessions"}
                  className={cn(
                    "rounded-full px-2.5 py-1 capitalize transition-all",
                    focusMode === mode
                      ? "bg-[var(--bg-secondary)] text-foreground shadow-[var(--shadow-subtle)]"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {mode}
                </button>
              ))}
            </div>

            <div className="flex-1" />

            <button
              onClick={() => setSearchOpen(true)}
              title="Search chats"
              aria-label="Search chats"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-foreground"
            >
              <Search className="size-[18px]" />
            </button>
          </div>

          <div
            className={cn(
              "absolute inset-y-0 right-0 flex items-center gap-2 overflow-hidden rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] transition-[width,opacity] duration-200 [transition-timing-function:var(--ease-smooth)] motion-reduce:transition-none",
              searchOpen ? "w-full px-3 opacity-100" : "w-0 px-0 opacity-0",
            )}
          >
            <Search className="size-3.5 shrink-0 text-[var(--text-tertiary)]" />
            <input
              id="chat-search"
              ref={searchInputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault()
                  closeSearch()
                }
              }}
              placeholder="Search..."
              aria-label="Search chats"
              tabIndex={searchOpen ? 0 : -1}
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-[var(--text-tertiary)]"
            />
            <button
              onClick={closeSearch}
              tabIndex={searchOpen ? 0 : -1}
              aria-label="Close search"
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--fill-secondary)] hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      </div>

      <SidebarListSurface
        loading={loading}
        search={search}
        focusMode={focusMode}
        hiddenAutomated={hiddenAutomated}
        selectFocusMode={selectFocusMode}
        virtualItems={virtualItems}
        sharedRowProps={sharedRowProps}
        expanded={expanded}
        handleEmployeeClick={handleEmployeeClick}
        handleMarkAllRead={handleMarkAllRead}
        handleLoadMore={handleLoadMore}
        loadingMore={loadingMore}
        olderSummaryChats={olderSummary.chats}
        olderLineLabel={formatOlderLineLabel(olderSummary)}
        toggleOlderExpanded={toggleOlderExpanded}
        cronCollapsed={cronCollapsed}
        toggleCronCollapsed={toggleCronCollapsed}
        cronTotal={cronTotal}
        cronSessionsLength={cronSessions.length}
        managerEmployees={managerEmployees}
        teamEmployees={teamEmployees}
        onContactEmployee={onContactEmployee}
        scrollContainerRef={scrollContainerRef}
        handleListScroll={handleListScroll}
        shouldVirtualize={shouldVirtualize}
        totalSize={rowVirtualizer.getTotalSize()}
        virtualRows={virtualRows}
        measureElement={rowVirtualizer.measureElement}
      />

      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <DialogContent
          showCloseButton={false}
          className="max-w-sm"
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            deleteButtonRef.current?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {deleteTarget?.type === "employee"
                ? `Delete all chats with "${deleteTarget.label}"?`
                : `Delete "${deleteTarget?.label}"?`}
            </DialogTitle>
            <DialogDescription>
              {deleteTarget?.type === "employee"
                ? `This will permanently delete ${deleteTarget.sessions?.length ?? 0} session(s) and all their messages. This cannot be undone.`
                : "This will permanently delete the session and all its messages. This cannot be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button
              ref={deleteButtonRef}
              variant="destructive"
              onClick={() => {
                if (!deleteTarget) return
                if (deleteTarget.type === "employee" && deleteTarget.sessions) {
                  handleDeleteEmployee(deleteTarget.id, deleteTarget.sessions)
                } else {
                  handleDelete(deleteTarget.id)
                }
                setDeleteTarget(null)
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ArchiveDialog
        target={archiveTarget}
        onOpenChange={(open) => {
          if (!open) setArchiveTarget(null)
        }}
        onArchived={(sessionIds) => {
          if (selectedId && sessionIds.includes(selectedId)) onDelete?.(selectedId)
          setArchiveTarget(null)
        }}
      />

      <style>{`
        @keyframes sidebar-pulse {
          0%,
          100% {
            opacity: 1;
            transform: scale(1);
          }
          50% {
            opacity: 0.55;
            transform: scale(0.85);
          }
        }
      `}</style>
    </div>
  )
}
