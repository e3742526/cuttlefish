import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type { ShortcutDef } from "@/hooks/use-keyboard-shortcuts"
import { ChatPageShell } from "./chat-page-shell"

const navRibbonSpy = vi.fn((props: Record<string, unknown>) => (
  <div data-testid="nav-ribbon-props">{JSON.stringify(props)}</div>
))
const chatSidebarSpy = vi.fn((props: Record<string, unknown>) => (
  <div data-testid="chat-sidebar" data-selected-id={String(props.selectedId ?? "")}>sidebar</div>
))

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock("@/components/pill-nav", () => ({
  NavRibbon: (props: Record<string, unknown>) => navRibbonSpy(props),
}))

vi.mock("@/components/chat/chat-sidebar", () => ({
  ChatSidebar: (props: Record<string, unknown>) => chatSidebarSpy(props),
}))

vi.mock("@/components/chat/chat-tabs", () => ({
  ChatHeaderPills: () => <div data-testid="chat-header-pills">header</div>,
}))

vi.mock("@/components/chat/chat-pane", () => ({
  ChatPane: () => <div data-testid="chat-pane">pane</div>,
}))

vi.mock("@/components/chat/room-timeline", () => ({
  RoomTimeline: () => <div data-testid="room-timeline">room</div>,
}))

vi.mock("@/components/chat/file-view", () => ({
  FileView: () => <div data-testid="file-view">file</div>,
}))

vi.mock("@/components/chat/file-open-context", () => ({
  FileOpenContext: { Provider: ({ children }: { children: React.ReactNode }) => <>{children}</> },
}))

vi.mock("@/components/ui/shortcut-overlay", () => ({
  ShortcutOverlay: () => <div data-testid="shortcut-overlay">shortcuts</div>,
}))

vi.mock("@/components/chat/mobile-tab-bar", () => ({
  MobileTabBar: () => <div data-testid="mobile-tab-bar">mobile-tabs</div>,
}))

function renderShell(overrides: Partial<React.ComponentProps<typeof ChatPageShell>> = {}) {
  const noop = () => {}
  const shortcuts: ShortcutDef[] = []
  const props: React.ComponentProps<typeof ChatPageShell> = {
    openFile: noop,
    selectedId: null,
    selectedRoomId: null,
    selectedRoom: null,
    roomSessionsById: new Map(),
    employees: [],
    mobileView: "chat",
    onMobileList: false,
    headerTitle: "New chat",
    moreMenu: null,
    copiedField: null,
    activeTab: null,
    pendingEmployee: null,
    pendingUserMessage: null,
    portalName: "Cuttlefish",
    subscribe: () => noop,
    connectionSeq: 0,
    skillsVersion: 0,
    events: [],
    collaborationMode: false,
    collaborationLane: "team",
    projectRootSessionId: null,
    sessionFilterId: null,
    inspectorOpen: false,
    effectiveViewMode: "chat",
    focusTrigger: 0,
    shortcuts,
    showShortcutOverlay: false,
    onSelect: noop,
    onSelectRoom: noop,
    onNewChat: noop,
    onDeleteSession: noop,
    onDuplicateFromSidebar: noop,
    onSessionsLoaded: noop,
    onEmployeeSessionsAvailable: noop,
    onOrderComputed: noop,
    onContactEmployee: noop,
    onFileBack: noop,
    onSessionCreated: noop,
    onSessionMetaChange: noop,
    onRefresh: noop,
    onOpenShortcuts: noop,
    onCloseShortcuts: noop,
    onBackToList: noop,
    onSelectProject: noop,
    onSelectProjectSession: noop,
    onLaneChange: noop,
    onInspectSession: noop,
    onCloseInspector: noop,
    onInvalidProject: noop,
    onInvalidSessionFilter: noop,
    onOpenUnderlyingSession: noop,
    onProjectDeleted: noop,
    ...overrides,
  }

  return render(
    <MemoryRouter>
      <ChatPageShell {...props} />
    </MemoryRouter>,
  )
}

describe("ChatPageShell", () => {
  it("keeps the desktop nav ribbon in brand mode and the sidebar visible", () => {
    navRibbonSpy.mockClear()
    chatSidebarSpy.mockClear()
    const { container } = renderShell()

    expect(navRibbonSpy).toHaveBeenCalledWith(expect.objectContaining({}))
    expect(screen.getAllByTestId("chat-sidebar").length).toBeGreaterThan(0)
    expect(container.querySelector(".w-\\[280px\\]")).toBeTruthy()
  })

  it("passes selected room ids and room open handler to both sidebars", () => {
    chatSidebarSpy.mockClear()
    const onSelectRoom = vi.fn()

    renderShell({
      selectedId: "s-1",
      selectedRoomId: "platform",
      onSelectRoom,
      mobileView: "sidebar",
    })

    const calls = chatSidebarSpy.mock.calls.map(([props]) => props as Record<string, unknown>)
    expect(calls.length).toBe(2)
    expect(calls.every((props) => props.selectedId === "room:platform")).toBe(true)
    expect(calls.every((props) => props.onSelectRoom === onSelectRoom)).toBe(true)
  })
})
