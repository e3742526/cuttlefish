
import { lazy, Suspense, useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { api } from '@/lib/api'
import { useOrg, useWorkspaceProfiles } from '@/hooks/use-employees'
import { ChatMessages } from '@/components/chat/chat-messages'
import { ChatInput } from '@/components/chat/chat-input'
import { CliKeybar } from '@/components/chat/cli-keybar'
import { ChatEmployeePicker } from '@/components/chat/chat-employee-picker'
import { QueuePanel } from '@/components/chat/queue-panel'
import { BackgroundActivityPill } from '@/components/chat/background-activity-pill'
import { SessionHumanReview } from '@/components/chat/session-human-review'
import { ModelSelectorRow, type SelectorValue } from '@/components/chat/model-selector-row'
import { FolderPicker } from '@/components/chat/folder-picker'
import { useLiveSession } from '@/hooks/use-live-session'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const CliTerminal = lazy(() => import('@/components/cli-terminal').then(m => ({ default: m.CliTerminal })))
import type { CliTerminalHandle } from '@/components/cli-terminal'
import { buildNewSessionParams, resolveNewSessionSelector, shouldPersistNewSessionSelector } from '@/components/chat/new-chat-helpers'
import type { Employee } from '@/lib/api'
import type { Message, MediaAttachment } from '@/lib/conversations'

// The live read pipeline (load/WS/reconnect/watchdog) now lives in
// useLiveSession; shouldRecoverStuckTurn moved there too. Re-export it so the
// existing completion-watchdog test (imports from this module) keeps working.
export { shouldRecoverStuckTurn } from '@/hooks/use-live-session'

type Listener = (event: string, payload: unknown) => void

const NEW_SESSION_SELECTOR_KEY = 'cuttlefish-chat-new-session-selector'
const WORKSPACE_PROFILE_NONE = '__none__'
const CLI_CAPABLE_ENGINES = new Set(['claude', 'codex', 'antigravity', 'grok'])

function readNewSessionSelector(): SelectorValue {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(NEW_SESSION_SELECTOR_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as SelectorValue
    return {
      engine: typeof parsed.engine === 'string' ? parsed.engine : undefined,
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
      effortLevel: typeof parsed.effortLevel === 'string' ? parsed.effortLevel : undefined,
    }
  } catch {
    return {}
  }
}

function writeNewSessionSelector(value: SelectorValue): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(NEW_SESSION_SELECTOR_KEY, JSON.stringify({
    engine: value.engine,
    model: value.model,
    effortLevel: value.effortLevel,
  }))
}

function supportsCli(engine: string | undefined): boolean {
  return !!engine && CLI_CAPABLE_ENGINES.has(engine)
}

function supportsCliPreference(engine: string | undefined): boolean {
  return !engine || supportsCli(engine)
}

interface ChatPaneProps {
  sessionId: string | null
  isActive: boolean
  onFocus: () => void
  /** Notify parent when a new session is created (e.g. first message in new chat) */
  onSessionCreated?: (sessionId: string, pendingUserMessage?: Message) => void
  /** Open the parent-level new-chat composer. */
  onNewChat?: () => void
  /** If set on mount, used as the initial user message before loadSession resolves — for the just-created-from-new-chat case. */
  pendingUserMessage?: Message
  /** Notify parent when session meta changes */
  onSessionMetaChange?: (meta: { title?: string; employee?: string; engine?: string; engineSessionId?: string; model?: string }) => void
  /** Notify parent to refresh sidebar */
  onRefresh?: () => void
  /** Portal name from settings */
  portalName?: string
  /** Gateway subscribe function for WS events */
  subscribe: (fn: Listener) => () => void
  /** Gateway connection seq number - triggers reload on reconnect */
  connectionSeq?: number
  /** Gateway skills version */
  skillsVersion?: number
  /** Gateway events array */
  events: Array<{ event: string; payload: unknown }>
  /** View mode: chat or cli transcript */
  viewMode?: 'chat' | 'cli'
  /** Incrementing counter that triggers input focus */
  focusTrigger?: number
  /** Callback to open keyboard shortcuts overlay */
  onShortcutsClick?: () => void
  /** Pre-selected employee for a NEW chat (e.g. contacting a session-less employee or an ?employee= deep-link). */
  initialEmployee?: string | null
}

export function ChatPane({
  sessionId,
  isActive,
  onFocus,
  onSessionCreated,
  onNewChat,
  onSessionMetaChange,
  onRefresh,
  portalName = 'Cuttlefish',
  subscribe,
  connectionSeq,
  skillsVersion,
  events,
  viewMode = 'chat',
  focusTrigger,
  onShortcutsClick,
  pendingUserMessage,
  initialEmployee,
}: ChatPaneProps) {
  // If this pane was opened from the onboarding wizard, the wizard stored the
  // seed user message in sessionStorage so we can display it immediately
  // (loading=true + seed bubble) without waiting for useLiveSession's first
  // network fetch. Content-identity reconcile in conversations.ts merges it
  // with the server-persisted twin once the fetch returns (no duplicate).
  const seedFromOnboarding = useMemo<Message | undefined>(() => {
    if (!sessionId || pendingUserMessage) return undefined
    try {
      const raw = sessionStorage.getItem('cuttlefish-onboarding-seed')
      if (!raw) return undefined
      const data = JSON.parse(raw) as { sessionId: string; message: Message }
      if (data.sessionId === sessionId) return data.message
    } catch { /* ignore */ }
    return undefined
  }, [sessionId, pendingUserMessage]) // eslint-disable-line react-hooks/exhaustive-deps
  // Consume the storage entry once detected so a page refresh doesn't re-show
  // the seed as an optimistic bubble on top of the already-loaded messages.
  useEffect(() => {
    if (seedFromOnboarding) sessionStorage.removeItem('cuttlefish-onboarding-seed')
  }, [seedFromOnboarding])

  // Live read pipeline (messages, streaming, loading, session, reconnect/watchdog)
  // is owned by useLiveSession; this pane keeps the composer + send on top and
  // drives optimistic writes through the hook's write API.
  const live = useLiveSession(sessionId, {
    subscribe,
    connectionSeq,
    pendingUserMessage: pendingUserMessage ?? seedFromOnboarding,
    onMeta: onSessionMetaChange,
    onRefresh,
  })
  const {
    messages,
    streamingText,
    loading,
    hydrating,
    session: currentSession,
    liveContextTokens,
    backgroundActivity,
    beginSend,
    failSend,
    appendLocal,
    reset: resetPane,
    reload: reloadSession,
  } = live

  // Kept local for handleSelectorChange so it stays a stable ([]) callback that
  // reads the current session id at call time (mirrors the previous behaviour).
  const sessionIdRef = useRef(sessionId)
  const selectorPatchSeq = useRef(0)
  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])

  // CLI → chat view switch: turns typed directly into the xterm may never have
  // reached the chat transcript (or a session:external-turn WS frame was
  // missed while the chat view was unmounted), so run a cheap one-shot
  // reconcile through the same load path session:external-turn uses.
  const prevViewModeRef = useRef(viewMode)
  useEffect(() => {
    const prev = prevViewModeRef.current
    prevViewModeRef.current = viewMode
    if (prev === 'cli' && viewMode === 'chat' && sessionId) {
      reloadSession(sessionId)
    }
  }, [viewMode, sessionId, reloadSession])

  // Employee picker state for new chat. Seeded from initialEmployee so a
  // "contact this employee" click / ?employee= deep-link opens the new chat
  // with that employee preselected (the pane is remounted via key on change).
  const [selectedEmployee, setSelectedEmployee] = useState<string | null>(initialEmployee ?? null)
  const { data: orgData } = useOrg()
  const { data: workspaceProfileData } = useWorkspaceProfiles()
  const workspaceProfiles = workspaceProfileData?.profiles ?? []
  const [selectedWorkspaceProfile, setSelectedWorkspaceProfile] = useState<string | null>(null)
  const pickerEmployees = Array.isArray(orgData?.employees)
    ? orgData.employees.map((emp) => ({
        name: emp.name,
        displayName: emp.displayName,
        department: emp.department,
        rank: emp.rank,
        engine: emp.engine,
        model: emp.model,
        effortLevel: emp.effortLevel,
        avatar: emp.avatar,
        emoji: emp.emoji,
      }))
    : []
  // Reset the employee picker when there is no session (the live read pipeline
  // clears its own state on a null sessionId; this is the pane-local part).
  // Falls back to initialEmployee so a preselected contact survives the reset.
  useEffect(() => { if (!sessionId) setSelectedEmployee(initialEmployee ?? null) }, [sessionId, initialEmployee])

  const handleWorkspaceProfileChange = useCallback((value: string) => {
    const next = value === WORKSPACE_PROFILE_NONE ? null : value
    setSelectedWorkspaceProfile(next)
    if (!next || sessionId) return
    const profile = workspaceProfiles.find((entry) => entry.id === next)
    if (profile?.employee) setSelectedEmployee(profile.employee)
  }, [sessionId, workspaceProfiles])

  // Engine/Model/Effort selector state (composer). Engine is editable on a new
  // chat only; model + effort are editable in existing chats too.
  const [selector, setSelector] = useState<SelectorValue>(() => readNewSessionSelector())
  const selectorRef = useRef(selector)
  const newSessionSelectorDirtyRef = useRef(false)
  const previousSessionIdForSelectorRef = useRef(sessionId)
  useEffect(() => { selectorRef.current = selector }, [selector])
  useEffect(() => {
    if (previousSessionIdForSelectorRef.current && !sessionId) {
      newSessionSelectorDirtyRef.current = false
    }
    previousSessionIdForSelectorRef.current = sessionId
  }, [sessionId])
  const [effortPendingNote, setEffortPendingNote] = useState(false)
  const [selectorError, setSelectorError] = useState<string | null>(null)
  const [interruptError, setInterruptError] = useState<string | null>(null)
  const cliTerminalRef = useRef<CliTerminalHandle | null>(null)

  // Pre-fill for a NEW chat. Explicit employee selection uses employee config;
  // direct/COO chats reuse the operator's last composer choice.
  useEffect(() => {
    if (sessionId) return
    const emp = selectedEmployee && Array.isArray(orgData?.employees)
      ? orgData.employees.find((e) => e.name === selectedEmployee)
      : undefined
    setSelector(resolveNewSessionSelector({
      selectedEmployee: emp ?? null,
      storedSelector: readNewSessionSelector(),
      currentSelector: selectorRef.current,
      manuallyChanged: newSessionSelectorDirtyRef.current,
    }))
    setEffortPendingNote(false)
    setSelectorError(null)
  }, [selectedEmployee, sessionId, orgData])

  // Pre-fill for an EXISTING chat from the loaded session.
  useEffect(() => {
    if (!sessionId || !currentSession) return
    setSelector({
      engine: currentSession.engine as string | undefined,
      model: currentSession.model as string | undefined,
      effortLevel: (currentSession.effortLevel ?? currentSession.effort_level) as string | undefined,
    })
    setEffortPendingNote(false)
    setSelectorError(null)
  }, [sessionId, currentSession])

  // Apply a selector change. New chat: just track it (sent on first message).
  // Existing chat: persist model/effort via PATCH (engine is fixed mid-chat).
  const handleSelectorChange = useCallback((next: SelectorValue) => {
    const sid = sessionIdRef.current
    if (sid) {
      const previous = selector
      const lockedGrokModel =
        currentSession?.engine === 'grok' &&
        Boolean(currentSession.engineSessionId) &&
        Boolean(next.model) &&
        Boolean(previous.model) &&
        next.model !== previous.model

      if (lockedGrokModel) {
        setSelectorError('Grok model changes require a new session.')
        setEffortPendingNote(false)
        return
      }

      const seq = ++selectorPatchSeq.current
      setSelector(next)
      setSelectorError(null)
      setEffortPendingNote(false)
      api.updateSession(sid, { model: next.model, effortLevel: next.effortLevel })
        .then(() => {
          if (selectorPatchSeq.current === seq) setEffortPendingNote(true)
        })
        .catch((err) => {
          if (selectorPatchSeq.current !== seq) return
          setSelector(previous)
          setEffortPendingNote(false)
          setSelectorError(err instanceof Error ? err.message : 'Model/effort update failed')
        })
    } else {
      newSessionSelectorDirtyRef.current = true
      setSelector(next)
      setSelectorError(null)
      writeNewSessionSelector(next)
    }
  }, [selector, currentSession?.engine, currentSession?.engineSessionId])


  const handleInterrupt = useCallback(async () => {
    if (!sessionId) return
    try {
      setInterruptError(null)
      const result = await api.stopSession(sessionId)
      if (!result.stopped) {
        setInterruptError(result.interruptible ? 'Stop request did not interrupt the session.' : 'This session is not currently interruptible.')
      }
    } catch (err) {
      setInterruptError(err instanceof Error ? err.message : 'Failed to stop session.')
    }
  }, [sessionId])

  const handleSend = useCallback(
    async (message: string, media?: MediaAttachment[], interrupt?: boolean) => {
      const userMsg: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content: message,
        timestamp: Date.now(),
        media,
      }
      // Optimistic append + arm loading + mark activity (for the watchdog).
      setInterruptError(null)
      beginSend(userMsg)

      try {
        // Upload any attached files to the server in parallel and collect file IDs
        let attachmentIds: string[] | undefined
        if (media && media.length > 0) {
          const uploadPromises = media
            .filter((att) => att.file)
            .map((att) => api.uploadFile(att.file!, sessionIdRef.current || undefined))
          if (uploadPromises.length > 0) {
            const uploaded = await Promise.all(uploadPromises)
            attachmentIds = uploaded.map((u) => u.id)
          }
        }

        let sid = sessionId

        if (!sid) {
          const params = buildNewSessionParams({
            message,
            selectedEmployee,
            attachmentIds,
            engine: selector.engine,
            model: selector.model,
            effortLevel: selector.effortLevel,
            cwd: undefined,
            workspaceProfile: selectedWorkspaceProfile,
          })
          if (viewMode === 'cli' && supportsCliPreference(selector.engine)) (params as Record<string, unknown>).mode = 'interactive'
          const session = (await api.createSession(params)) as Record<string, unknown>
          if (shouldPersistNewSessionSelector({ selectedEmployee, manuallyChanged: newSessionSelectorDirtyRef.current })) {
            writeNewSessionSelector(selector)
          }
          sid = String(session.id)
          onSessionCreated?.(sid, userMsg)
          onRefresh?.()
        } else {
          // CLI view → route to the interactive PTY engine so the user sees the prompt
          // get injected into the live xterm + claude's streaming response.
          const mode = viewMode === 'cli' && supportsCli(currentSession?.engine as string | undefined) ? 'interactive' : undefined
          await api.sendMessage(sid, { message, interrupt: interrupt || undefined, attachments: attachmentIds, mode })
          onRefresh?.()
        }
      } catch (err) {
        failSend(`Error: ${err instanceof Error ? err.message : 'Failed to send message'}`)
      }
    },
    // viewMode MUST be in deps — without it, toggling chat↔CLI keeps the stale
    // closure value and routes CLI sends to the headless engine, which is
    // exactly what made "the xterm shows stale content" reproducible.
    [sessionId, selectedEmployee, onSessionCreated, onRefresh, viewMode, selector, selectedWorkspaceProfile, currentSession?.engine, beginSend, failSend]
  )

  const handleStatusRequest = useCallback(async () => {
    if (!sessionId) {
      appendLocal({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: 'No active session. Send a message to start one.',
        timestamp: Date.now(),
      })
      return
    }

    try {
      const session = (await api.getSession(sessionId)) as Record<string, unknown>
      const info = [
        '**Session Info**',
        `ID: \`${session.id}\``,
        `Status: ${session.status || 'unknown'}`,
        session.employee ? `Employee: ${session.employee}` : null,
        session.engine ? `Engine: ${session.engine}` : null,
        session.model ? `Model: ${session.model}` : null,
        session.cwd ? `Working folder: \`${session.cwd}\`` : null,
        session.createdAt ? `Created: ${session.createdAt}` : null,
      ]
        .filter(Boolean)
        .join('\n')

      appendLocal({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: info,
        timestamp: Date.now(),
      })
    } catch {
      appendLocal({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: 'Failed to fetch session status.',
        timestamp: Date.now(),
      })
    }
  }, [sessionId, appendLocal])

  const handleNewSession = useCallback(() => {
    // This just clears the pane state — parent handles actual new session flow
    resetPane()
  }, [resetPane])

  // Drag & drop state
  const [dragOver, setDragOver] = useState(false)
  const [droppedFiles, setDroppedFiles] = useState<File[]>()
  const dragCounter = useRef(0)
  const showSessionHydration = Boolean(sessionId && hydrating && messages.length === 0 && !streamingText)

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current++
    if (e.dataTransfer.types.includes('Files')) {
      setDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current--
    if (dragCounter.current === 0) {
      setDragOver(false)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current = 0
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
      setDroppedFiles(files)
    }
  }, [])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        overflow: 'hidden',
        background: 'var(--bg)',
        position: 'relative',
      }}
      onClick={onFocus}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drop zone overlay */}
      {dragOver && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 50,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'color-mix(in srgb, var(--bg) 85%, transparent)',
            backdropFilter: 'blur(4px)',
            transition: 'opacity 150ms ease-in-out',
          }}
        >
          <div
            style={{
              border: '2px dashed var(--accent)',
              borderRadius: 'var(--radius-lg)',
              padding: '48px 64px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '12px',
            }}
          >
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-body)' }}>
              Drop files here
            </span>
          </div>
        </div>
      )}
      {showSessionHydration && (
        <div className="flex flex-1 items-center justify-center" role="status" aria-label="Loading chat">
          <div className="size-5 animate-spin rounded-full border-2 border-[var(--fill-tertiary)] border-t-[var(--accent)]" />
        </div>
      )}

      {/* Employee picker for new chat (any view mode — the CLI terminal mounts after first message creates the session) */}
      {!sessionId && messages.length === 0 && (
        <div className="flex flex-1 items-center justify-center">
          <ChatEmployeePicker
            employees={pickerEmployees}
            selectedEmployee={selectedEmployee}
            onSelect={setSelectedEmployee}
            portalName={portalName}
          />
        </div>
      )}

      {/* Messages / CLI transcript — CliTerminal is display-only; ChatInput below sends. */}
      {viewMode === 'cli' && sessionId ? (
        // Reserve flex space during lazy-chunk load so the ChatInput below stays
        // pinned to the bottom instead of flashing to the top for a frame.
        <Suspense fallback={<div style={{ flex: 1, minHeight: 0, background: 'var(--bg)' }} />}>
          <CliTerminal ref={cliTerminalRef} sessionId={sessionId} />
        </Suspense>
      ) : !showSessionHydration && (sessionId || messages.length > 0) ? (
        <ChatMessages messages={messages} loading={loading} streamingText={streamingText} onRetry={(t) => void handleSend(t)} />
      ) : null}

      {/* Queue panel — hidden in the live xterm view (noise on top of the PTY). */}
      {!(viewMode === 'cli' && sessionId) && (
        <QueuePanel
          sessionId={sessionId}
          events={events}
          paused={currentSession?.paused as boolean ?? false}
        />
      )}

      {/* Background-work indicator — the session is officially idle but subagents /
          background tasks are still running. Informational only (input stays live);
          hidden while a foreground turn is streaming and in the CLI view. */}
      {!(viewMode === 'cli' && sessionId) && !loading && (
        <BackgroundActivityPill activity={backgroundActivity} />
      )}

      <SessionHumanReview sessionId={sessionId} />

      {interruptError && (
        <div className="mx-[var(--space-4)] mb-[var(--space-2)] rounded-[var(--radius-md)] border border-[color-mix(in_srgb,var(--system-red)_35%,transparent)] bg-[color-mix(in_srgb,var(--system-red)_10%,transparent)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--system-red)] flex items-center justify-between gap-[var(--space-3)]">
          <span className="min-w-0 break-words">{interruptError}</span>
          <button
            onClick={() => setInterruptError(null)}
            className="shrink-0 rounded-[var(--radius-sm)] border border-current bg-transparent px-[var(--space-2)] py-[2px] text-[length:var(--text-caption2)] font-semibold cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Input — chat-style composer for every view, including CLI (the PTY engine
          accepts attachments + the prompt is injected into xterm via bracketed-paste). */}
      <ChatInput
        disabled={false}
        loading={loading}
        onSend={handleSend}
        onInterrupt={handleInterrupt}
        onNewSession={handleNewSession}
        onStatusRequest={handleStatusRequest}
        skillsVersion={skillsVersion}
        events={events}
        droppedFiles={droppedFiles}
        onDroppedFilesConsumed={() => setDroppedFiles(undefined)}
        focusTrigger={focusTrigger}
        onShortcutsClick={onShortcutsClick}
        selectorSlot={
          <div className="flex flex-col gap-[var(--space-2)]">
            {!sessionId && workspaceProfiles.length > 0 && (
              <Select value={selectedWorkspaceProfile ?? WORKSPACE_PROFILE_NONE} onValueChange={handleWorkspaceProfileChange}>
                <SelectTrigger aria-label="Workspace profile" className="h-8">
                  <SelectValue placeholder="Workspace" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={WORKSPACE_PROFILE_NONE}>No workspace profile</SelectItem>
                  {workspaceProfiles.map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <ModelSelectorRow
              mode={sessionId ? 'existing' : 'new'}
              value={selector}
              onChange={handleSelectorChange}
              pendingNote={effortPendingNote}
              errorNote={selectorError ?? undefined}
              disabled={loading}
              contextTokens={liveContextTokens ?? (currentSession?.lastContextTokens as number | null | undefined) ?? undefined}
              onNewChat={sessionId ? onNewChat : handleNewSession}
            />
          </div>
        }
        terminalActionsSlot={
          viewMode === 'cli' && sessionId ? (
            <CliKeybar variant="hint" onKey={(data) => cliTerminalRef.current?.sendKey(data)} />
          ) : undefined
        }
        mobileTerminalActionsSlot={
          viewMode === 'cli' && sessionId ? (
            <CliKeybar onKey={(data) => cliTerminalRef.current?.sendKey(data)} />
          ) : undefined
        }
        reserveTerminalActions={Boolean(sessionId)}
      />
    </div>
  )
}
