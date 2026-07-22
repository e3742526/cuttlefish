import { useState, useCallback, useEffect, useRef, useMemo, Suspense } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '@/lib/api'
import { resolveDeepLink } from '@/components/chat/chat-route-helpers'
import { useGateway } from '@/hooks/use-gateway'
import { PageLayout } from '@/components/page-layout'
import type { SidebarOrder } from '@/components/chat/chat-sidebar'
import { groupSessionsByDepartment, indexSessionsById } from '@/lib/rooms/grouping'
import type { RoomSession, RoomEmployee } from '@/lib/rooms/types'
import { useOrg } from '@/hooks/use-employees'
import { useChatTabs } from '@/hooks/use-chat-tabs'
import { useKeyboardShortcuts, type ShortcutDef } from '@/hooks/use-keyboard-shortcuts'
import { useDeleteSession, useDuplicateSession, useSessions } from '@/hooks/use-sessions'
import { clearIntermediateMessages } from '@/lib/conversations'
import type { Message } from '@/lib/conversations'
import { useSettings } from '@/routes/settings-provider'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { writeViewMode, type ViewMode } from '@/lib/view-mode'
import { useToast } from '@/components/ui/toast'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { clearDebugLog, shareDebugLog } from '@/lib/debug-log'
import { ChatErrorBoundary } from './chat-page-error-boundary'
import { ChatMoreMenu } from './chat-more-menu'
import { ChatPageShell } from './chat-page-shell'
import { clearSelectedRoomId, loadSelectedRoomId, saveSelectedRoomId } from './room-selection-storage'
import { groupSessionsByProject } from '@/components/chat/project-session-tree'
import { readCollaborationRouteState, writeCollaborationRouteState } from './collaboration-route-state'

export default function ChatPageWrapper() {
  return (
    <ChatErrorBoundary>
      <Suspense fallback={
        <PageLayout>
          <div className="flex h-full items-center justify-center text-muted-foreground">
            Loading...
          </div>
        </PageLayout>
      }>
        <ChatPage />
      </Suspense>
    </ChatErrorBoundary>
  )
}

function ChatPage() {
  const { settings } = useSettings()
  const portalName = settings.portalName ?? 'Cuttlefish'
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(() => loadSelectedRoomId())
  const initialSearch = useMemo(() => new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search), [])
  const initialCollaborationState = useMemo(
    () => readCollaborationRouteState(initialSearch), [initialSearch],
  )
  const [collaborationMode, setCollaborationMode] = useState(() => !selectedRoomId && (!initialSearch.has('session') || initialSearch.has('lane') || initialSearch.has('project')))
  const [collaborationLane, setCollaborationLane] = useState<'team' | 'management'>(initialCollaborationState.lane)
  const [projectRootSessionId, setProjectRootSessionId] = useState<string | null>(initialCollaborationState.projectRootSessionId)
  const [sessionFilterId, setSessionFilterId] = useState<string | null>(initialCollaborationState.sessionId)
  const [inspectorOpen, setInspectorOpen] = useState(initialCollaborationState.inspectorOpen)
  // When set, the main surface shows a department project-room's merged timeline
  // (read-only) instead of a single session's ChatPane. Mutually exclusive with
  // selectedId — selecting a session clears the room, and vice-versa.
  const [mobileView, setMobileView] = useState<'sidebar' | 'chat'>('sidebar')
  // sessionMeta carries the sessionId it belongs to so the tab-label effect
  // can ignore stale meta from a previous session mid-switch (title flash fix).
  const [sessionMeta, setSessionMeta] = useState<{ sessionId: string; engine?: string; engineSessionId?: string; model?: string; title?: string; employee?: string } | null>(null)
  // Sibling sessions for the currently selected employee (empty if direct/single session)
  const [employeeSessions, setEmployeeSessions] = useState<Array<{ id: string; title?: string | null; lastActivity?: string; createdAt?: string }>>([])
  // When true, user explicitly started a new chat — don't auto-select first session
  const newChatIntentRef = useRef(false)
  // Employee to preselect for a brand-new chat (contacting a session-less
  // employee from the sidebar, or via an ?employee= deep-link). Null = none.
  const [pendingEmployee, setPendingEmployee] = useState<string | null>(null)
  // Mobile: pop from the thread back to the chat list (the tab bar's Chat screen).
  const backToList = useCallback(() => setMobileView('sidebar'), [])
  const [viewMode, setViewMode] = useState<ViewMode>('chat')
  // Pending user message from new-chat send — passed to the new ChatPane so the user bubble appears before loadSession resolves
  const [pendingUserMessage, setPendingUserMessage] = useState<{ sessionId: string; message: Message } | null>(null)

  // Persist view mode per session
  const setAndPersistViewMode = useCallback((mode: ViewMode) => {
    setViewMode(mode)
    if (selectedId) writeViewMode(selectedId, mode)
  }, [selectedId])

  const viewModeRef = useRef(viewMode)
  useEffect(() => { viewModeRef.current = viewMode }, [viewMode])
  useEffect(() => {
    if (!selectedId) return
    const raw = typeof window !== 'undefined'
      ? window.localStorage.getItem(`cuttlefish-view-mode-${selectedId}`)
      : null
    if (raw === 'cli' || raw === 'chat') {
      setViewMode(raw)
    } else {
      writeViewMode(selectedId, viewModeRef.current)
    }
  }, [selectedId])
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [showSessionPicker, setShowSessionPicker] = useState(false)
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [focusTrigger, setFocusTrigger] = useState(0)
  const sessionPickerRef = useRef<HTMLDivElement>(null)
  const { events, connectionSeq, skillsVersion, subscribe } = useGateway()
  const chatTabs = useChatTabs()
  const restoredRoomIdRef = useRef(selectedRoomId)
  const clearedRestoredRoomTabRef = useRef(false)
  useEffect(() => {
    if (!restoredRoomIdRef.current || clearedRestoredRoomTabRef.current) return
    clearedRestoredRoomTabRef.current = true
    chatTabs.clearActiveTab()
  }, [chatTabs])
  const deleteSessionMutation = useDeleteSession()
  const duplicateSessionMutation = useDuplicateSession()
  const sessionsQuery = useSessions()
  const { data: orgData } = useOrg()
  const qc = useQueryClient()
  const { pushToast } = useToast()
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null)

  const roomSessions = useMemo(
    () => (sessionsQuery.data ?? []) as unknown as RoomSession[],
    [sessionsQuery.data],
  )
  const rooms = useMemo(
    () => groupSessionsByDepartment(roomSessions, (orgData?.employees ?? []) as RoomEmployee[]),
    [roomSessions, orgData],
  )
  const selectedRoom = useMemo(
    () => (selectedRoomId ? rooms.find((r) => r.id === selectedRoomId) ?? null : null),
    [rooms, selectedRoomId],
  )
  useEffect(() => {
    if (!selectedRoomId || !sessionsQuery.data || !orgData) return
    if (rooms.some((room) => room.id === selectedRoomId)) return
    clearSelectedRoomId()
    setSelectedRoomId(null)
  }, [selectedRoomId, rooms, sessionsQuery.data, orgData])
  const roomSessionsById = useMemo(() => indexSessionsById(roomSessions), [roomSessions])
  const [showShortcutOverlay, setShowShortcutOverlay] = useState(false)
  const sidebarOrderRef = useRef<SidebarOrder>({ sessionIds: [], employeeNames: [], employeeSessionMap: {} })
  const handleOrderComputed = useCallback((order: SidebarOrder) => { sidebarOrderRef.current = order }, [])
  useEffect(() => {
    if (!showMoreMenu && !showSessionPicker) return
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null
      if (showMoreMenu && target && !target.closest('[data-more-menu]')) {
        setShowMoreMenu(false)
      }
      if (showSessionPicker && sessionPickerRef.current && !sessionPickerRef.current.contains(e.target as Node)) {
        setShowSessionPicker(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showMoreMenu, showSessionPicker])

  const copyToClipboard = useCallback((text: string, field: string) => {
    navigator.clipboard.writeText(text)
    setCopiedField(field)
    setShowMoreMenu(false)
    setTimeout(() => setCopiedField(null), 1500)
  }, [])

  const openGlobalSearch = useCallback(() => {
    setShowMoreMenu(false)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true, bubbles: true }))
  }, [])

  // Update tab label/status when session meta changes.
  // Guarded by `sessionMeta.sessionId === selectedId` so we never cross-write
  // the previous session's meta onto the newly active tab during a switch
  // (ChatPane is `key={selectedId}` — it remounts and re-emits meta).
  const { updateTabStatus, closeTabBySessionId, reconcileTabs } = chatTabs
  useEffect(() => {
    if (!selectedId || !sessionMeta) return
    if (sessionMeta.sessionId !== selectedId) return
    updateTabStatus(selectedId, {
      label: sessionMeta.title || sessionMeta.employee || portalName,
      employeeName: sessionMeta.employee || undefined,
    })
  }, [selectedId, sessionMeta, portalName, updateTabStatus])

  // Clear sessionMeta synchronously when the active session changes — the new
  // ChatPane will repopulate it via onSessionMetaChange once it loads. This
  // prevents the title-flash where the effect above would otherwise stamp the
  // OLD session's title onto the NEW tab between switch and ChatPane mount.
  useEffect(() => {
    setSessionMeta((current) => (current && current.sessionId !== selectedId ? null : current))
  }, [selectedId])

  // Subscribe to session lifecycle events so chat tabs reflect real-time
  // running/idle/error status, get their label updated on rename, and close
  // automatically when the underlying session is deleted (e.g. from sidebar
  // bulk-delete or another client). Without this, `status: 'running'` set by
  // handleSessionCreated never flips back, leaving a stale blue dot.
  useEffect(() => {
    const unsub = subscribe((event: string, payload: unknown) => {
      const p = (payload || {}) as { sessionId?: string; title?: string }
      const sid = p.sessionId
      if (!sid) return
      switch (event) {
        case 'session:started':
          updateTabStatus(sid, { status: 'running' })
          break
        case 'session:completed':
        case 'session:stopped':
          updateTabStatus(sid, { status: 'idle' })
          break
        case 'session:error':
          updateTabStatus(sid, { status: 'error' })
          break
        case 'session:deleted':
          closeTabBySessionId(sid)
          break
        case 'session:updated':
          // Gateway currently emits {sessionId} only — handle title defensively
          // in case future emitters carry it. Stale labels after rename are
          // also reconciled via the useSessions() effect below.
          if (p.title) updateTabStatus(sid, { label: p.title })
          break
      }
    })
    return unsub
  }, [subscribe, updateTabStatus, closeTabBySessionId])

  // Reconcile persisted tabs against the authoritative sessions list:
  //   - drop orphan tabs whose sessions were deleted while the app was closed
  //     (or by another client before our WS reconnected)
  //   - normalize stale `status: 'running'` (persists across reloads otherwise)
  //   - pick up renames the WS event didn't carry a title for
  useEffect(() => {
    const sessions = sessionsQuery.data as
      | Array<{ id: string; title?: string; status?: string; employee?: string }>
      | undefined
    if (!sessions) return
    reconcileTabs(sessions)
  }, [sessionsQuery.data, reconcileTabs])

  const handleEmployeeSessionsAvailable = useCallback(
    (sessions: Array<{ id: string; title?: string | null; lastActivity?: string; createdAt?: string }>) => {
      setEmployeeSessions(sessions.length > 1 ? sessions : [])
    },
    []
  )

  const handleSelect = useCallback(
    (id: string) => {
      newChatIntentRef.current = false
      setCollaborationMode(false)
      clearSelectedRoomId()
      setSelectedRoomId(null)
      setSelectedId(id)
      setMobileView('chat')
      // Open a tab — label will be updated once session meta loads
      chatTabs.openTab({ sessionId: id, label: 'Loading...', status: 'idle', unread: false })
    },
    [chatTabs]
  )

  const handleSelectRoom = useCallback((roomId: string) => {
    newChatIntentRef.current = false
    setPendingEmployee(null)
    saveSelectedRoomId(roomId)
    setSelectedRoomId(roomId)
    setSelectedId(null)
    setSessionMeta(null)
    setEmployeeSessions([])
    setMobileView('chat')
    chatTabs.clearActiveTab()
  }, [chatTabs])

  // Auto-focus the input on any session change (sidebar click, tab switch,
  // keyboard nav, "+ New"). Effect runs after ChatPane (key=selectedId)
  // remounts, so the bumped focusTrigger reaches the fresh ChatInput.
  useEffect(() => {
    setFocusTrigger(prev => prev + 1)
  }, [selectedId])

  const handleNewChat = useCallback(() => {
    newChatIntentRef.current = true
    setCollaborationMode(false)
    setPendingEmployee(null)
    clearSelectedRoomId()
    setSelectedRoomId(null)
    setSelectedId(null)
    setSessionMeta(null)
    setMobileView('chat')
    setEmployeeSessions([])
    chatTabs.clearActiveTab()
  }, [chatTabs])

  // Start a new chat with a specific employee preselected — used when contacting
  // a session-less employee from the sidebar roster or via an ?employee= deep-link.
  // The actual session is created on first send (ChatPane → buildNewSessionParams).
  const contactEmployee = useCallback((name: string) => {
    newChatIntentRef.current = true
    setCollaborationMode(false)
    setPendingEmployee(name)
    clearSelectedRoomId()
    setSelectedRoomId(null)
    setSelectedId(null)
    setSessionMeta(null)
    setMobileView('chat')
    setEmployeeSessions([])
    chatTabs.clearActiveTab()
  }, [chatTabs])

  // Deep-links: ?session=<id> focuses/opens that session's tab; ?employee=<name>
  // opens a new chat with that employee preselected. The param is consumed once
  // (cleared from the URL) so it doesn't re-fire on unrelated re-renders or stick
  // across navigation. Mirrors routes/file/page.tsx's useSearchParams usage.
  const [searchParams, setSearchParams] = useSearchParams()
  const persistCollaborationState = useCallback((state: ReturnType<typeof readCollaborationRouteState>, replace = false) => {
    setSearchParams(writeCollaborationRouteState(searchParams, state), { replace })
  }, [searchParams, setSearchParams])

  const handleSelectProject = useCallback((rootSessionId: string) => {
    newChatIntentRef.current = false
    clearSelectedRoomId()
    setSelectedRoomId(null)
    setCollaborationMode(true)
    setCollaborationLane('team')
    setProjectRootSessionId(rootSessionId)
    setSessionFilterId(null)
    setInspectorOpen(false)
    setSelectedId(rootSessionId)
    setMobileView('chat')
    chatTabs.openProjectTab({ rootSessionId, label: 'Project', status: 'idle', unread: false })
    persistCollaborationState({ lane: 'team', projectRootSessionId: rootSessionId, sessionId: null, inspectorOpen: false })
  }, [chatTabs, persistCollaborationState])

  const handleSelectProjectSession = useCallback((rootSessionId: string, sessionId: string) => {
    newChatIntentRef.current = false
    clearSelectedRoomId()
    setSelectedRoomId(null)
    setCollaborationMode(true)
    setCollaborationLane('team')
    setProjectRootSessionId(rootSessionId)
    setSessionFilterId(sessionId)
    setInspectorOpen(true)
    setSelectedId(sessionId)
    setMobileView('chat')
    chatTabs.openProjectTab({ rootSessionId, label: 'Project', status: 'idle', unread: false })
    persistCollaborationState({ lane: 'team', projectRootSessionId: rootSessionId, sessionId, inspectorOpen: true })
  }, [chatTabs, persistCollaborationState])

  const handleLaneChange = useCallback((lane: 'team' | 'management') => {
    newChatIntentRef.current = false
    setCollaborationMode(true)
    setCollaborationLane(lane)
    setSessionFilterId(null)
    setInspectorOpen(false)
    setMobileView('chat')
    if (lane === 'management') {
      setSelectedId(null)
      chatTabs.clearActiveTab()
      persistCollaborationState({ lane, projectRootSessionId, sessionId: null, inspectorOpen: false })
    } else {
      persistCollaborationState({ lane, projectRootSessionId, sessionId: null, inspectorOpen: false })
    }
  }, [chatTabs, persistCollaborationState, projectRootSessionId])

  useEffect(() => {
    if (!searchParams.has('lane') && !searchParams.has('project')) return
    const state = readCollaborationRouteState(searchParams)
    setCollaborationMode(true)
    setCollaborationLane(state.lane)
    setProjectRootSessionId(state.projectRootSessionId)
    setSessionFilterId(state.sessionId)
    setInspectorOpen(state.inspectorOpen)
    if (state.sessionId) setSelectedId(state.sessionId)
    else if (state.projectRootSessionId) setSelectedId(state.projectRootSessionId)
    else setSelectedId(null)
  }, [searchParams])

  useEffect(() => {
    if (searchParams.has('lane') || searchParams.has('project')) return
    const link = resolveDeepLink(searchParams)
    if (!link) return
    if (link.kind === 'session') handleSelect(link.id)
    else contactEmployee(link.name)
    const next = new URLSearchParams(searchParams)
    next.delete('session')
    next.delete('employee')
    setSearchParams(next, { replace: true })
  }, [searchParams, handleSelect, contactEmployee, setSearchParams])

  // Back target for the mobile file-view "back" button: the session that was
  // active when a file link was clicked. selectedIdRef (declared below) is read
  // at call time so the callback stays stable.
  const fileBackTargetRef = useRef<string | null>(null)

  // Open a file in an in-app tab (used by message path-links via FileOpenContext).
  const openFile = useCallback((path: string) => {
    fileBackTargetRef.current = selectedIdRef.current
    chatTabs.openFileTab(path)
    setMobileView('chat')
  }, [chatTabs])

  // Mobile-only: return from a file tab to the chat it was opened from. Switch
  // to that session's tab if it still exists; otherwise fall back to the sidebar.
  const handleFileBack = useCallback(() => {
    const backId = fileBackTargetRef.current
    if (backId) {
      const idx = chatTabs.tabs.findIndex((t) => t.kind === 'session' && t.sessionId === backId)
      if (idx >= 0) {
        chatTabs.switchTab(idx)
        setMobileView('chat')
        return
      }
    }
    setMobileView('sidebar')
  }, [chatTabs])

  const handleSessionsLoaded = useCallback(
    (sessions: Array<{ id: string; parentSessionId?: string | null; lastActivity?: string; title?: string | null; employee?: string | null; status?: string }>) => {
      // Don't auto-open the first session while a room timeline is showing
      // (read the room from a ref so a refetch can't fire a stale guard).
      if (collaborationMode && collaborationLane === 'team' && !projectRootSessionId && !newChatIntentRef.current && sessions.length > 0) {
        const project = groupSessionsByProject(sessions as never).at(0)
        if (project) handleSelectProject(project.rootSessionId)
      } else if (!collaborationMode && !selectedId && !selectedRoomIdRef.current && !newChatIntentRef.current && sessions.length > 0) {
        handleSelect(sessions[0].id)
      }
    },
    [collaborationLane, collaborationMode, handleSelect, handleSelectProject, projectRootSessionId, selectedId]
  )

  const handleDeleteSession = useCallback(async (id: string) => {
    try {
      await deleteSessionMutation.mutateAsync(id)
    } catch { /* sidebar may have already deleted it */ }
    if (selectedId === id) {
      setSelectedId(null)
      setSessionMeta(null)
    }
    clearIntermediateMessages(id)
    chatTabs.closeTab(chatTabs.tabs.findIndex(t => t.kind === 'session' && t.sessionId === id))
    setShowMoreMenu(false)
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [selectedId, chatTabs, deleteSessionMutation, qc])

  const handleDuplicate = useCallback(async (id: string) => {
    try {
      const result = await duplicateSessionMutation.mutateAsync(id) as { id?: string; title?: string; employee?: string }
      if (result?.id) {
        clearSelectedRoomId()
        setSelectedRoomId(null)
        setSelectedId(result.id)
        chatTabs.openTab({
          sessionId: result.id,
          label: result.title || 'Duplicated Chat',
          status: 'idle',
          unread: false,
          pinned: true,
          employeeName: result.employee || undefined,
        })
        setShowMoreMenu(false)
        qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
      }
    } catch (err: any) {
      pushToast({
        tone: 'error',
        title: 'Duplicate failed',
        description: err?.message || 'Unknown error',
      })
    }
  }, [chatTabs, duplicateSessionMutation, pushToast, qc])

  const handleDuplicateFromSidebar = useCallback((newSessionId: string) => {
    chatTabs.openTab({ sessionId: newSessionId, label: 'Duplicated Chat', status: 'idle', unread: false, pinned: true })
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [chatTabs, qc])

  // ChatPane callbacks
  const handleSessionCreated = useCallback((newId: string, pending?: Message) => {
    if (pending) setPendingUserMessage({ sessionId: newId, message: pending })
    clearSelectedRoomId()
    setSelectedId(newId)
    chatTabs.openTab({ sessionId: newId, label: 'New Chat', status: 'running', unread: false, pinned: true })
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [chatTabs, qc])

  // Clear pendingUserMessage when selectedId moves away from the session it was created for
  useEffect(() => {
    if (pendingUserMessage && pendingUserMessage.sessionId !== selectedId) {
      setPendingUserMessage(null)
    }
  }, [selectedId, pendingUserMessage])

  // Tag incoming meta with the sessionId it belongs to so consumers (e.g.
  // the tab-label effect) can ignore stale meta from a previous session.
  // We read selectedId via a ref so this callback stays stable.
  const selectedIdRef = useRef<string | null>(selectedId)
  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])
  // Mirror selectedRoomId into a ref so the sidebar's ref-captured
  // onSessionsLoaded guard always reads the live value (no stale-closure window
  // that could auto-open a session while a room timeline is shown).
  const selectedRoomIdRef = useRef<string | null>(selectedRoomId)
  useEffect(() => { selectedRoomIdRef.current = selectedRoomId }, [selectedRoomId])
  const handleSessionMetaChange = useCallback((meta: { title?: string; employee?: string; engine?: string; engineSessionId?: string; model?: string }) => {
    const sid = selectedIdRef.current
    if (!sid) return
    setSessionMeta({ sessionId: sid, ...meta })
  }, [])

  const handleRefresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: queryKeys.sessions.all })
  }, [qc])

  // Navigation helpers for keyboard shortcuts
  const navigateSession = useCallback((direction: 1 | -1) => {
    const { sessionIds } = sidebarOrderRef.current
    if (sessionIds.length === 0) return
    if (!selectedId) {
      handleSelect(direction === 1 ? sessionIds[0] : sessionIds[sessionIds.length - 1])
      return
    }
    const idx = sessionIds.indexOf(selectedId)
    if (idx === -1) {
      handleSelect(direction === 1 ? sessionIds[0] : sessionIds[sessionIds.length - 1])
      return
    }
    const next = (idx + direction + sessionIds.length) % sessionIds.length
    handleSelect(sessionIds[next])
  }, [selectedId, handleSelect])

  const cycleEmployee = useCallback(() => {
    const { employeeNames, employeeSessionMap } = sidebarOrderRef.current
    if (employeeNames.length === 0) return
    const currentEmployee = sessionMeta?.employee ?? null
    const currentIdx = currentEmployee ? employeeNames.indexOf(currentEmployee) : -1
    const nextIdx = (currentIdx + 1) % employeeNames.length
    const nextEmployee = employeeNames[nextIdx]
    const firstSession = employeeSessionMap[nextEmployee]?.[0]
    if (firstSession) handleSelect(firstSession)
  }, [sessionMeta, handleSelect])

  const copyChat = useCallback(async () => {
    if (!selectedId) return
    try {
      const session = await api.getSession(selectedId) as { messages?: Array<{ role: string; content: string }> }
      const messages = session.messages ?? []
      const text = messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => `[${m.role}]: ${m.content}`)
        .join('\n\n')
      await navigator.clipboard.writeText(text)
      setCopiedField('chat')
      setTimeout(() => setCopiedField(null), 1500)
    } catch { /* silently fail */ }
  }, [selectedId])

  // Centralized keyboard shortcut registry
  const shortcuts = useMemo<ShortcutDef[]>(() => [
    { key: 'n', category: 'Actions', description: 'New chat', action: handleNewChat },
    { key: 'j', category: 'Navigation', description: 'Next session', action: () => navigateSession(1) },
    { key: 'k', category: 'Navigation', description: 'Previous session', action: () => navigateSession(-1) },
    { key: 'e', category: 'Navigation', description: 'Next employee', action: cycleEmployee },
    { key: 'Backspace', category: 'Actions', description: 'Delete session', action: () => { if (selectedId) setDeleteTargetId(selectedId) }, enabled: !!selectedId },
    { key: 'Delete', category: 'Actions', description: 'Delete session', action: () => { if (selectedId) setDeleteTargetId(selectedId) }, enabled: !!selectedId },
    { key: 'c', category: 'Actions', description: 'Copy chat', action: copyChat, enabled: !!selectedId },
    { key: 'Escape', category: 'Navigation', description: 'Close overlay', action: () => {
      if (showShortcutOverlay) setShowShortcutOverlay(false)
      else if (showMoreMenu) setShowMoreMenu(false)
    }},
    { key: '/', category: 'Actions', description: 'Focus chat', action: () => {
      const el = document.getElementById('chat-textarea')
      if (el) el.focus()
    }},
    { key: '?', category: 'Help', description: 'Keyboard shortcuts', action: () => setShowShortcutOverlay(v => !v) },
    { key: 'w', modifiers: ['meta'], category: 'Actions', description: 'Close tab', action: () => {
      if (chatTabs.activeIndex >= 0) chatTabs.closeTab(chatTabs.activeIndex)
    }},
    { key: '[', modifiers: ['meta', 'shift'], category: 'Navigation', description: 'Previous tab', action: () => chatTabs.prevTab() },
    { key: ']', modifiers: ['meta', 'shift'], category: 'Navigation', description: 'Next tab', action: () => chatTabs.nextTab() },
    ...Array.from({ length: 9 }, (_, i) => ({
      key: String(i + 1),
      modifiers: ['meta' as const, 'alt' as const],
      category: 'Navigation' as const,
      description: `Tab ${i + 1}`,
      action: () => chatTabs.switchTab(i),
    })),
  ], [handleNewChat, navigateSession, cycleEmployee, copyChat, selectedId, showShortcutOverlay, showMoreMenu, chatTabs])

  useKeyboardShortcuts(shortcuts)

  // When active tab changes, sync selectedId
  useEffect(() => {
    const at = chatTabs.activeTab
    if (at?.kind === 'project' && at.rootSessionId !== projectRootSessionId) {
      handleSelectProject(at.rootSessionId)
      return
    }
    if (at && at.kind === 'session' && at.sessionId !== selectedId) {
      clearSelectedRoomId()
      setSelectedRoomId(null) // a session tab takes over the surface from a room
      setSelectedId(at.sessionId)
      return
    }

    if (!at && selectedId && !newChatIntentRef.current) {
      setSelectedId(null)
      setSessionMeta(null)
      setEmployeeSessions([])
    }
    // When at.kind === 'file', leave selectedId untouched — we render FileView
    // instead of ChatPane, but the underlying session selection is preserved.
  }, [chatTabs.activeTab, handleSelectProject, projectRootSessionId, selectedId])

  const cliModeAvailable = !sessionMeta?.engine || ['claude', 'codex', 'antigravity', 'grok'].includes(sessionMeta.engine)
  const activeSessionTab = chatTabs.activeTab?.kind === 'session' ? chatTabs.activeTab : null
  const viewSwitchLocked = sessionMeta?.engine === 'codex' && activeSessionTab?.sessionId === selectedId && activeSessionTab.status === 'running'
  const cliTitle = viewSwitchLocked
    ? 'Codex view switching is locked while a turn is running'
    : cliModeAvailable ? undefined : 'CLI view is not available for this engine'
  const effectiveViewMode: ViewMode = cliModeAvailable ? viewMode : 'chat'

  const moreMenu = (
    <ChatMoreMenu
      open={showMoreMenu}
      selectedId={selectedId}
      sessionMeta={sessionMeta}
      effectiveViewMode={effectiveViewMode}
      cliModeAvailable={cliModeAvailable}
      viewSwitchLocked={viewSwitchLocked}
      cliTitle={cliTitle}
      duplicatePending={duplicateSessionMutation.isPending}
      onToggle={() => setShowMoreMenu((v) => !v)}
      onClose={() => setShowMoreMenu(false)}
      onSetViewMode={setAndPersistViewMode}
      onOpenGlobalSearch={openGlobalSearch}
      onDuplicate={handleDuplicate}
      onRequestDelete={setDeleteTargetId}
      onCopy={copyToClipboard}
      onShareDebugLog={async () => {
        const result = await shareDebugLog()
        pushToast({
          title: result === 'shared' ? 'Debug log shared' : 'Debug log copied',
          description:
            result === 'shared'
              ? 'The native share sheet handled the debug log.'
              : 'The debug log was copied to your clipboard.',
        })
      }}
      onClearDebugLog={() => {
        clearDebugLog()
        pushToast({ title: 'Debug log cleared' })
      }}
    />
  )

  const headerTitle = collaborationMode
    ? collaborationLane === 'management' ? 'Management' : 'Team'
    : sessionMeta?.title?.trim() || (selectedId ? '' : 'New chat')

  const onMobileList = mobileView === 'sidebar'

  const handleInspectSession = useCallback((sessionId: string) => {
    if (!projectRootSessionId) return
    setSessionFilterId(sessionId)
    setInspectorOpen(true)
    setSelectedId(sessionId)
    persistCollaborationState({ lane: 'team', projectRootSessionId, sessionId, inspectorOpen: true })
  }, [persistCollaborationState, projectRootSessionId])

  const handleCloseInspector = useCallback(() => {
    setInspectorOpen(false)
    persistCollaborationState({ lane: collaborationLane, projectRootSessionId, sessionId: sessionFilterId, inspectorOpen: false }, true)
  }, [collaborationLane, persistCollaborationState, projectRootSessionId, sessionFilterId])

  const handleInvalidProject = useCallback(() => {
    setProjectRootSessionId(null)
    setSessionFilterId(null)
    setInspectorOpen(false)
    setSelectedId(null)
    persistCollaborationState({ lane: 'team', projectRootSessionId: null, sessionId: null, inspectorOpen: false }, true)
  }, [persistCollaborationState])

  const handleInvalidSessionFilter = useCallback(() => {
    setSessionFilterId(null)
    setInspectorOpen(false)
    setSelectedId(projectRootSessionId)
    persistCollaborationState({ lane: 'team', projectRootSessionId, sessionId: null, inspectorOpen: false }, true)
  }, [persistCollaborationState, projectRootSessionId])

  const handleOpenUnderlyingSession = useCallback((sessionId: string) => {
    const next = new URLSearchParams(searchParams)
    next.delete('lane')
    next.delete('project')
    next.delete('session')
    next.delete('inspector')
    setSearchParams(next)
    handleSelect(sessionId)
  }, [handleSelect, searchParams, setSearchParams])

  const handleProjectDeleted = useCallback((sessionIds: string[]) => {
    for (const id of sessionIds) {
      clearIntermediateMessages(id)
      chatTabs.closeTabBySessionId(id)
    }
    setProjectRootSessionId(null)
    setSessionFilterId(null)
    setInspectorOpen(false)
    setSelectedId(null)
    persistCollaborationState({ lane: 'team', projectRootSessionId: null, sessionId: null, inspectorOpen: false }, true)
  }, [chatTabs, persistCollaborationState])

  return (
    <>
      <ChatPageShell
        openFile={openFile}
        selectedId={selectedId}
        selectedRoomId={selectedRoomId}
        selectedRoom={selectedRoom}
        roomSessionsById={roomSessionsById}
        employees={(orgData?.employees ?? []) as RoomEmployee[]}
        mobileView={mobileView}
        onMobileList={onMobileList}
        headerTitle={headerTitle}
        moreMenu={moreMenu}
        copiedField={copiedField}
        activeTab={chatTabs.activeTab}
        pendingEmployee={pendingEmployee}
        pendingUserMessage={pendingUserMessage}
        portalName={portalName}
        subscribe={subscribe}
        connectionSeq={connectionSeq}
        skillsVersion={skillsVersion}
        events={events}
        effectiveViewMode={effectiveViewMode}
        focusTrigger={focusTrigger}
        shortcuts={shortcuts}
        showShortcutOverlay={showShortcutOverlay}
        onSelect={handleSelect}
        onSelectRoom={handleSelectRoom}
        collaborationMode={collaborationMode}
        collaborationLane={collaborationLane}
        projectRootSessionId={projectRootSessionId}
        sessionFilterId={sessionFilterId}
        inspectorOpen={inspectorOpen}
        onSelectProject={handleSelectProject}
        onSelectProjectSession={handleSelectProjectSession}
        onLaneChange={handleLaneChange}
        onInspectSession={handleInspectSession}
        onCloseInspector={handleCloseInspector}
        onInvalidProject={handleInvalidProject}
        onInvalidSessionFilter={handleInvalidSessionFilter}
        onOpenUnderlyingSession={handleOpenUnderlyingSession}
        onProjectDeleted={handleProjectDeleted}
        onNewChat={handleNewChat}
        onDeleteSession={handleDeleteSession}
        onDuplicateFromSidebar={handleDuplicateFromSidebar}
        onSessionsLoaded={handleSessionsLoaded}
        onEmployeeSessionsAvailable={handleEmployeeSessionsAvailable}
        onOrderComputed={handleOrderComputed}
        onContactEmployee={contactEmployee}
        onFileBack={handleFileBack}
        onSessionCreated={handleSessionCreated}
        onSessionMetaChange={handleSessionMetaChange}
        onRefresh={handleRefresh}
        onOpenShortcuts={() => setShowShortcutOverlay(true)}
        onCloseShortcuts={() => setShowShortcutOverlay(false)}
        onBackToList={backToList}
      />

      <ConfirmDialog
        open={!!deleteTargetId}
        title="Delete this session?"
        description="This permanently removes the session and all of its messages."
        confirmLabel="Delete"
        destructive
        onOpenChange={(open) => {
          if (!open) setDeleteTargetId(null)
        }}
        onConfirm={() => {
          if (!deleteTargetId) return
          void handleDeleteSession(deleteTargetId)
          setDeleteTargetId(null)
        }}
      />
    </>
  )
}
