import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ChatPageWrapper from "./page"

type ShellProps = {
  selectedId?: string | null
  selectedRoomId?: string | null
  onSessionsLoaded: (sessions: { id: string }[]) => void
  onSelect: (id: string) => void
  onSelectRoom: (roomId: string) => void
  onNewChat: () => void
}

const mocks = vi.hoisted(() => ({
  shellSpy: vi.fn(),
  deleteSession: vi.fn(),
  duplicateSession: vi.fn(),
}))

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock("./chat-page-shell", () => ({
  ChatPageShell: (props: ShellProps) => {
    mocks.shellSpy(props)
    return (
      <div
        data-testid="chat-page-shell"
        data-selected-id={props.selectedId ?? ""}
        data-selected-room-id={props.selectedRoomId ?? ""}
      >
        <button onClick={() => props.onSessionsLoaded([{ id: "s-1" }])}>sessions loaded</button>
        <button onClick={() => props.onSelect("s-1")}>select session</button>
        <button onClick={() => props.onSelectRoom("qa")}>select room</button>
        <button onClick={() => props.onNewChat()}>new chat</button>
      </div>
    )
  },
}))

vi.mock("@/hooks/use-gateway", () => ({
  useGateway: () => ({
    events: [],
    connectionSeq: 0,
    skillsVersion: 0,
    subscribe: () => () => {},
  }),
}))

vi.mock("@/hooks/use-employees", () => ({
  useOrg: () => ({
    data: {
      employees: [
        { name: "playtest-lead", displayName: "Playtest Lead", department: "qa", rank: "manager", engine: "claude", model: "opus", persona: "" },
        { name: "playtester-breaker", displayName: "Playtester Breaker", department: "qa", rank: "employee", engine: "codex", model: "gpt", persona: "" },
        { name: "dataflow-lead", displayName: "Dataflow Lead", department: "dataflow", rank: "manager", engine: "claude", model: "opus", persona: "" },
      ],
    },
  }),
}))

vi.mock("@/hooks/use-sessions", () => ({
  useSessions: () => ({
    data: [
      { id: "s-1", employee: "dataflow-lead", title: "Dataflow task", source: "web", createdAt: "2026-07-06T10:00:00.000Z", lastActivity: "2026-07-06T10:00:00.000Z", status: "idle" },
      { id: "qa-parent", employee: "playtest-lead", title: "Playtest task", source: "web", createdAt: "2026-07-06T09:00:00.000Z", lastActivity: "2026-07-06T09:00:00.000Z", status: "idle" },
      { id: "qa-child", employee: "playtester-breaker", parentSessionId: "qa-parent", title: "Delegated to breaker", source: "web", createdAt: "2026-07-06T09:05:00.000Z", lastActivity: "2026-07-06T09:05:00.000Z", status: "idle" },
    ],
  }),
  useDeleteSession: () => ({ mutateAsync: mocks.deleteSession }),
  useDuplicateSession: () => ({ mutateAsync: mocks.duplicateSession, isPending: false }),
}))

vi.mock("@/routes/settings-provider", () => ({
  useSettings: () => ({ settings: { portalName: "Cuttlefish" } }),
}))

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}))

vi.mock("@/hooks/use-keyboard-shortcuts", () => ({
  useKeyboardShortcuts: () => {},
}))

vi.mock("./chat-more-menu", () => ({
  ChatMoreMenu: () => null,
}))

vi.mock("@/components/ui/confirm-dialog", () => ({
  ConfirmDialog: () => null,
}))

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ChatPageWrapper />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function shell() {
  return screen.getByTestId("chat-page-shell")
}

describe("ChatPage room selection persistence", () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.shellSpy.mockClear()
    mocks.deleteSession.mockReset()
    mocks.duplicateSession.mockReset()
  })

  it("restores a stored room and does not auto-open the first session", async () => {
    localStorage.setItem("cuttlefish-chat-selected-room", "qa")
    localStorage.setItem(
      "cuttlefish-chat-tabs",
      JSON.stringify({
        tabs: [{ kind: "session", sessionId: "s-1", label: "Old tab", status: "idle", unread: false }],
        activeIndex: 0,
      }),
    )

    renderPage()

    await waitFor(() => expect(shell().dataset.selectedRoomId).toBe("qa"))
    fireEvent.click(screen.getByText("sessions loaded"))

    await waitFor(() => {
      expect(shell().dataset.selectedRoomId).toBe("qa")
      expect(shell().dataset.selectedId).toBe("")
    })
    expect(localStorage.getItem("cuttlefish-chat-selected-room")).toBe("qa")
  })

  it("persists room selection and clears it for new chat", async () => {
    renderPage()

    fireEvent.click(screen.getByText("select room"))

    await waitFor(() => {
      expect(shell().dataset.selectedRoomId).toBe("qa")
      expect(localStorage.getItem("cuttlefish-chat-selected-room")).toBe("qa")
    })

    fireEvent.click(screen.getByText("new chat"))

    await waitFor(() => {
      expect(shell().dataset.selectedRoomId).toBe("")
      expect(localStorage.getItem("cuttlefish-chat-selected-room")).toBeNull()
    })
  })

  it("clears stored room selection when a session is selected", async () => {
    localStorage.setItem("cuttlefish-chat-selected-room", "qa")

    renderPage()
    await waitFor(() => expect(shell().dataset.selectedRoomId).toBe("qa"))

    fireEvent.click(screen.getByText("select session"))

    await waitFor(() => {
      expect(shell().dataset.selectedRoomId).toBe("")
      expect(shell().dataset.selectedId).toBe("s-1")
      expect(localStorage.getItem("cuttlefish-chat-selected-room")).toBeNull()
    })
  })
})
