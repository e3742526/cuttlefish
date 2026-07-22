import React from 'react'
import { Check } from 'lucide-react'
import { PageLayout } from '@/components/page-layout'
import { ChatSidebar, type SidebarOrder } from '@/components/chat/chat-sidebar'
import { ChatHeaderPills } from '@/components/chat/chat-tabs'
import { NavRibbon } from '@/components/pill-nav'
import { MobileTabBar } from '@/components/chat/mobile-tab-bar'
import { ChatPane } from '@/components/chat/chat-pane'
import { RoomTimeline } from '@/components/chat/room-timeline'
import { roomSelectionId } from '@/lib/rooms/grouping'
import type { DepartmentRoom, RoomEmployee, RoomSession } from '@/lib/rooms/types'
import { FileView } from '@/components/chat/file-view'
import { FileOpenContext } from '@/components/chat/file-open-context'
import { ShortcutOverlay } from '@/components/ui/shortcut-overlay'
import type { ShortcutDef } from '@/hooks/use-keyboard-shortcuts'
import type { Message } from '@/lib/conversations'
import type { ViewMode } from '@/lib/view-mode'
import type { ChatTab } from '@/hooks/use-chat-tabs'
import { cn } from '@/lib/utils'
import { CollaborationPane } from '@/components/chat/collaboration-pane'

interface ChatPageShellProps {
  openFile: (path: string) => void
  selectedId: string | null
  selectedRoomId: string | null
  selectedRoom: DepartmentRoom | null
  roomSessionsById: Map<string, RoomSession>
  employees: RoomEmployee[]
  mobileView: 'sidebar' | 'chat'
  onMobileList: boolean
  headerTitle: string
  moreMenu: React.ReactNode
  copiedField: string | null
  activeTab: ChatTab | null
  pendingEmployee: string | null
  pendingUserMessage: { sessionId: string; message: Message } | null
  portalName: string
  subscribe: (cb: (event: string, payload: unknown) => void) => () => void
  connectionSeq: number
  skillsVersion?: number
  events: Array<{ event: string; payload: unknown }>
  effectiveViewMode: ViewMode
  focusTrigger: number
  shortcuts: ShortcutDef[]
  showShortcutOverlay: boolean
  onSelect: (id: string) => void
  onNewChat: () => void
  onDeleteSession: (id: string) => void
  onDuplicateFromSidebar: (newSessionId: string) => void
  onSessionsLoaded: (sessions: { id: string }[]) => void
  onEmployeeSessionsAvailable: (sessions: Array<{ id: string; title?: string | null; lastActivity?: string; createdAt?: string }>) => void
  onOrderComputed: (order: SidebarOrder) => void
  onContactEmployee: (name: string) => void
  onFileBack: () => void
  onSessionCreated: (newId: string, pending?: Message) => void
  onSessionMetaChange: (meta: { title?: string; employee?: string; engine?: string; engineSessionId?: string; model?: string }) => void
  onRefresh: () => void
  onOpenShortcuts: () => void
  onCloseShortcuts: () => void
  onBackToList: () => void
  onSelectRoom: (roomId: string) => void
  collaborationMode: boolean
  collaborationLane: 'team' | 'management'
  projectRootSessionId: string | null
  sessionFilterId: string | null
  inspectorOpen: boolean
  onSelectProject: (rootSessionId: string) => void
  onSelectProjectSession: (rootSessionId: string, sessionId: string) => void
  onLaneChange: (lane: 'team' | 'management') => void
  onInspectSession: (sessionId: string) => void
  onCloseInspector: () => void
  onInvalidProject: () => void
  onInvalidSessionFilter: () => void
  onOpenUnderlyingSession: (sessionId: string) => void
  onProjectDeleted: (sessionIds: string[]) => void
}

export function ChatPageShell(props: ChatPageShellProps) {
  return (
    <FileOpenContext.Provider value={props.openFile}>
      <PageLayout chromeless mainLabel="Chat">
        <div className="flex overflow-hidden h-full">
          <div className="hidden h-full shrink-0 lg:flex">
            <NavRibbon />
            <div className="h-full w-[280px] overflow-hidden">
              <ChatSidebar
                selectedId={props.selectedRoomId ? roomSelectionId(props.selectedRoomId) : props.selectedId}
                onSelect={props.onSelect}
                onSelectRoom={props.onSelectRoom}
                onNewChat={props.onNewChat}
                onDelete={props.onDeleteSession}
                onDuplicate={props.onDuplicateFromSidebar}
                onSessionsLoaded={props.onSessionsLoaded}
                onEmployeeSessionsAvailable={props.onEmployeeSessionsAvailable}
                onOrderComputed={props.onOrderComputed}
                onContactEmployee={props.onContactEmployee}
                lane={props.collaborationLane}
                onLaneChange={props.onLaneChange}
                onSelectProject={props.onSelectProject}
                onSelectProjectSession={props.onSelectProjectSession}
              />
            </div>
          </div>

          <div className="chat-pills-layout relative min-w-0 flex-1 flex-col overflow-hidden bg-background flex">
            <div
              aria-hidden
              className={cn(
                "pointer-events-none absolute inset-x-0 top-0 z-[5] h-[88px]",
                props.onMobileList && "hidden lg:block",
              )}
              style={{ background: 'linear-gradient(to bottom, var(--bg) 0, var(--bg) 52px, color-mix(in srgb, var(--bg) 68%, transparent) 68px, transparent 100%)' }}
            />

            <ChatHeaderPills
              hideOnMobile={props.onMobileList}
              title={props.headerTitle}
              onBack={props.onBackToList}
              onNew={props.onNewChat}
              moreMenu={props.moreMenu}
            />

            {props.copiedField && (
              <div className="absolute right-4 top-[58px] z-10 flex items-center gap-1 rounded-full bg-[var(--material-thick)] px-2.5 py-1 text-xs font-medium text-[var(--accent)] shadow-[var(--shadow-overlay)]">
                <Check className="size-3" /> Copied!
              </div>
            )}

            <div className={props.mobileView === 'sidebar' ? 'flex-1 overflow-hidden lg:hidden' : 'hidden'}>
              <ChatSidebar
                selectedId={props.selectedRoomId ? roomSelectionId(props.selectedRoomId) : props.selectedId}
                onSelect={props.onSelect}
                onSelectRoom={props.onSelectRoom}
                onNewChat={props.onNewChat}
                onDelete={props.onDeleteSession}
                onDuplicate={props.onDuplicateFromSidebar}
                onSessionsLoaded={props.onSessionsLoaded}
                onEmployeeSessionsAvailable={props.onEmployeeSessionsAvailable}
                onOrderComputed={props.onOrderComputed}
                onContactEmployee={props.onContactEmployee}
                lane={props.collaborationLane}
                onLaneChange={props.onLaneChange}
                onSelectProject={props.onSelectProject}
                onSelectProjectSession={props.onSelectProjectSession}
              />
            </div>

            <div className={cn(
              "flex-1 overflow-hidden flex flex-col",
              props.mobileView === 'sidebar' ? 'hidden lg:flex' : 'flex'
            )}>
              {props.activeTab?.kind === 'file' ? (
                <FileView path={props.activeTab.path} embedded onBack={props.onFileBack} />
              ) : props.collaborationMode ? (
                <CollaborationPane
                  lane={props.collaborationLane}
                  projectRootSessionId={props.projectRootSessionId}
                  sessionFilterId={props.sessionFilterId}
                  inspectorOpen={props.inspectorOpen}
                  connectionSeq={props.connectionSeq}
                  onInspectSession={props.onInspectSession}
                  onCloseInspector={props.onCloseInspector}
                  onInvalidProject={props.onInvalidProject}
                  onInvalidSessionFilter={props.onInvalidSessionFilter}
                  onOpenUnderlyingSession={props.onOpenUnderlyingSession}
                  onProjectDeleted={props.onProjectDeleted}
                />
              ) : props.selectedRoomId ? (
                props.selectedRoom ? (
                  <RoomTimeline
                    room={props.selectedRoom}
                    employees={props.employees}
                    sessionsById={props.roomSessionsById}
                    onOpenSession={props.onSelect}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--text-tertiary)]">
                    This room has no conversations yet.
                  </div>
                )
              ) : (
                <ChatPane
                  key={props.selectedId ?? `__new__:${props.pendingEmployee ?? ''}`}
                  sessionId={props.selectedId}
                  initialEmployee={props.selectedId ? undefined : props.pendingEmployee}
                  isActive={true}
                  onFocus={() => {}}
                  onSessionCreated={props.onSessionCreated}
                  onNewChat={props.onNewChat}
                  onSessionMetaChange={props.onSessionMetaChange}
                  onRefresh={props.onRefresh}
                  portalName={props.portalName}
                  subscribe={props.subscribe}
                  connectionSeq={props.connectionSeq}
                  skillsVersion={props.skillsVersion}
                  events={props.events}
                  viewMode={props.effectiveViewMode}
                  focusTrigger={props.focusTrigger}
                  onShortcutsClick={props.onOpenShortcuts}
                  pendingUserMessage={
                    props.pendingUserMessage && props.pendingUserMessage.sessionId === props.selectedId
                      ? props.pendingUserMessage.message
                      : undefined
                  }
                />
              )}
            </div>
          </div>
        </div>

        {props.onMobileList && <MobileTabBar />}

        {props.showShortcutOverlay && (
          <ShortcutOverlay
            shortcuts={props.shortcuts}
            onClose={props.onCloseShortcuts}
          />
        )}

        <style>{`
          .chat-pills-layout .chat-messages-scroll {
            padding-top: var(--chat-top-clearance);
            scroll-padding-top: var(--chat-top-clearance);
          }
        `}</style>
      </PageLayout>
    </FileOpenContext.Provider>
  )
}
