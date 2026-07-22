import React, { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useToast } from "@/components/ui/toast"
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
import { SidebarListSurface } from "./sidebar-list-surface"
import { ArchiveDialog, type ArchiveDialogTarget } from "./archive-dialog"
import { type SidebarDeleteTarget, type SidebarSharedRowProps } from "./sidebar-row-components"
import { useSidebarViewPreferences } from "./use-sidebar-view-preferences"
import {
  getPinnedSessions,
  getReadSessionWatermarks,
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
import { isNeedsAttention, resolveReadSessions } from "./sidebar-session-helpers"
import { groupSessionsByProject, type SessionProject } from "./project-session-tree"
import { SidebarHeader } from "./sidebar-header"

export type { SidebarOrder } from "./sidebar-types"
export {
  getJobStateLabel,
  getStatusDot,
  hasBackgroundActivity,
  isDirectSession,
  isNeedsAttention,
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
  onSelectRoom?: (roomId: string) => void
  onSelectProject?: (rootSessionId: string) => void
  onSelectProjectSession?: (rootSessionId: string, sessionId: string) => void
  onLaneChange?: (lane: "team" | "management") => void
  lane?: "team" | "management"
}

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
  onSelectRoom,
  onSelectProject,
  onSelectProjectSession,
  onLaneChange,
  lane,
}: ChatSidebarProps) {
  const { pushToast } = useToast()
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

  // Surfaced regardless of view mode/scroll position: which mode you're in and
  // how deep a chat is nested shouldn't determine whether you notice a session
  // is blocked on you.
  const needsAttentionSessions = useMemo(
    () => sessions.filter(isNeedsAttention),
    [sessions],
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
  const [readWatermarks, setReadWatermarks] = useState<Record<string, number>>({})
  const [pinnedSessions, setPinnedSessions] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const {
    viewMode,
    selectViewMode,
    olderExpanded,
    toggleOlderExpanded,
    expandedProjects,
    toggleProjectExpanded,
  } = useSidebarViewPreferences()
  const [loadingMore, setLoadingMore] = useState<Set<string>>(new Set())
  const [deleteTarget, setDeleteTarget] = useState<SidebarDeleteTarget | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<ArchiveDialogTarget | null>(null)
  const deleteButtonRef = useRef<HTMLButtonElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [listScrolled, setListScrolled] = useState(false)

  useEffect(() => {
    if (!lane) return
    const expected = lane === "team" ? "projects" : "management"
    if (viewMode !== expected) selectViewMode(expected)
  }, [lane, selectViewMode, viewMode])

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
    const read = getReadSessions()
    setReadSessions(read)
    setReadWatermarks(getReadSessionWatermarks(read))
    setPinnedSessions(getPinnedSessions())
    setCollapsed(loadCollapsedState())
    setExpanded(loadExpandedState())
  }, [])

  const selectedLastAgentMessageAt = useMemo(
    () => sessions.find((session) => session.id === selectedId)?.lastAgentMessageAt ?? null,
    [sessions, selectedId],
  )

  useEffect(() => {
    if (selectedId) {
      const latestAgentMessageAt = selectedLastAgentMessageAt ? Date.parse(selectedLastAgentMessageAt) : Number.NaN
      const readAt = Number.isFinite(latestAgentMessageAt) ? latestAgentMessageAt : Date.now()
      markSessionRead(selectedId, readAt)
      setReadSessions((prev) => {
        const next = new Set(prev)
        next.add(selectedId)
        return next
      })
      setReadWatermarks((prev) => ({ ...prev, [selectedId]: Math.max(prev[selectedId] ?? 0, readAt) }))
    }
  }, [selectedId, selectedLastAgentMessageAt])

  const effectiveReadSessions = useMemo(() => {
    return resolveReadSessions(sessions, readSessions, readWatermarks)
  }, [readSessions, readWatermarks, sessions])

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

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
    const readAt = Date.now()
    markAllReadForEmployee(employeeSessions, readAt)
    setReadSessions((prev) => {
      const next = new Set(prev)
      for (const session of employeeSessions) next.add(session.id)
      return next
    })
    setReadWatermarks((prev) => {
      const next = { ...prev }
      for (const session of employeeSessions) {
        const latestAgentMessageAt = session.lastAgentMessageAt ? Date.parse(session.lastAgentMessageAt) : Number.NaN
        const sessionReadAt = Number.isFinite(latestAgentMessageAt) ? latestAgentMessageAt : readAt
        next[session.id] = Math.max(next[session.id] ?? 0, sessionReadAt)
      }
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
    } catch (err: any) {
      // WFG-CF-001: a bulk delete can partially fail (e.g. 409); surface it to
      // the operator instead of swallowing it so it doesn't read as success.
      pushToast({
        tone: "error",
        title: "Delete failed",
        description: err?.message || "Some sessions could not be deleted",
      })
    }
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
    viewMode,
  }), [sessions, search, searchResults, employeeData, portalSlug, portalName, pinnedSessions, counts, viewMode])

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
    () => new Set(
      orgEmployees
        .filter((employee) => employee.rank === "manager" || employee.rank === "executive")
        .map((employee) => employee.name),
    ),
    [orgEmployees],
  )
  const teamEmployees = useMemo(
    () => contactableEmployees.filter((employee) => !managerEmployeeNames.has(employee.name)),
    [contactableEmployees, managerEmployeeNames],
  )

  const projects = useMemo(() => groupSessionsByProject(sessions), [sessions])
  const managementItems = useMemo(
    () => [...pinnedFlat, ...unpinnedFlat].filter((item) =>
      item.employeeName === portalSlug || managerEmployeeNames.has(item.employeeName ?? ""),
    ),
    [managerEmployeeNames, pinnedFlat, portalSlug, unpinnedFlat],
  )

  const allFlatIds = useMemo(() => buildSidebarOrder({
    searching,
    searchRows,
    viewMode,
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
    projects,
    expandedProjects,
    managementItems,
  }), [
    searching,
    searchRows,
    viewMode,
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
    projects,
    expandedProjects,
    managementItems,
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
    if (lane === "management") {
      onLaneChange?.("management")
      return
    }
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
  }, [expanded, lane, onEmployeeSessionsAvailable, onLaneChange, onSelect, toggleEmployeeExpanded])

  const handleProjectClick = useCallback((project: SessionProject) => {
    if (onSelectProject) onSelectProject(project.rootSessionId)
    else onSelect(project.rootSessionId)
    onEmployeeSessionsAvailable?.(project.sessions)
  }, [onEmployeeSessionsAvailable, onSelect, onSelectProject])

  const handleProjectSessionClick = useCallback((project: SessionProject, sessionId: string) => {
    if (onSelectProjectSession) onSelectProjectSession(project.rootSessionId, sessionId)
    else onSelect(sessionId)
    onEmployeeSessionsAvailable?.(project.sessions)
  }, [onEmployeeSessionsAvailable, onSelect, onSelectProjectSession])

  const handleViewModeSelect = useCallback((mode: ViewMode) => {
    selectViewMode(mode)
    if (mode === "projects") onLaneChange?.("team")
    if (mode === "management") onLaneChange?.("management")
  }, [onLaneChange, selectViewMode])

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
      pushToast({
        tone: "error",
        title: "Duplicate failed",
        description: err?.message || "Unknown error",
      })
    }
  }, [duplicateSessionMutation, onDuplicate, onSelect, pushToast])

  const sharedRowProps = useMemo<SidebarSharedRowProps>(() => ({
    selectedId,
    readSessions: effectiveReadSessions,
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
    effectiveReadSessions,
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
    viewMode,
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
    pinnedFlat,
    unpinnedFlat,
    portalSlug,
    portalName,
    employeeData,
    projects,
    expandedProjects,
    managementItems,
  }), [
    searching,
    searchRows,
    viewMode,
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
    pinnedFlat,
    unpinnedFlat,
    portalSlug,
    portalName,
    employeeData,
    projects,
    expandedProjects,
    managementItems,
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
    } catch (err: any) {
      // WFG-CF-002: don't silently swallow a failed delete.
      pushToast({
        tone: "error",
        title: "Delete failed",
        description: err?.message || "The session could not be deleted",
      })
    }
  }

  return (
    <div className="relative z-10 flex h-full flex-col bg-[var(--sidebar-bg)] shadow-[var(--shadow-card)]">
      <SidebarHeader
        listScrolled={listScrolled}
        viewMode={viewMode}
        selectViewMode={handleViewModeSelect}
        needsAttentionCount={needsAttentionSessions.length}
        onOpenAttention={() => onSelect(needsAttentionSessions[0].id)}
        searchOpen={searchOpen}
        onOpenSearch={() => setSearchOpen(true)}
        closeSearch={closeSearch}
        search={search}
        setSearch={setSearch}
        searchInputRef={searchInputRef}
      />

      <SidebarListSurface
        loading={loading}
        search={search}
        viewMode={viewMode}
        hiddenAutomated={hiddenAutomated}
        selectViewMode={handleViewModeSelect}
        virtualItems={virtualItems}
        sharedRowProps={sharedRowProps}
        selectedId={selectedId}
        expandedRooms={new Set()}
        toggleRoomExpanded={() => {}}
        onSelectRoom={onSelectRoom}
        expandedProjects={expandedProjects}
        toggleProjectExpanded={toggleProjectExpanded}
        handleProjectClick={handleProjectClick}
        handleProjectSessionClick={handleProjectSessionClick}
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
