import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { SidebarListSurface } from "../sidebar-list-surface"
import type { VirtualItem } from "../sidebar-view-model"
import type { SidebarSharedRowProps } from "../sidebar-row-components"
import type { Employee } from "@/lib/api"
import type { DepartmentRoom } from "@/lib/rooms/types"

vi.mock("../sidebar-row-components", () => ({
  SECTION_LABEL_CLASS: "section-label",
  SECTION_COUNT_CLASS: "section-count",
  SectionLabel: ({ label, count }: { label: string; count?: number }) => <div>{label}:{count ?? ""}</div>,
  FlatSessionRow: ({ displayName }: { displayName: string }) => <div>flat:{displayName}</div>,
  SessionRow: ({ session }: { session: { id: string } }) => <div>session:{session.id}</div>,
  EmployeeRow: ({ item }: { item: { employeeName?: string } }) => <div>employee:{item.employeeName}</div>,
  StatusDot: () => <span>status-dot</span>,
  ContactRow: ({ emp, onContact }: { emp: Employee; onContact: (name: string) => void }) => (
    <button onClick={() => onContact(emp.name)}>contact:{emp.displayName ?? emp.name}</button>
  ),
}))

function makeSharedRowProps(): SidebarSharedRowProps {
  return {
    selectedId: null,
    readSessions: new Set(),
    pinnedSessions: new Set(),
    renamingSessionId: null,
    renameCancelledRef: { current: false },
    fixTitle: (title, employee) => title ?? employee ?? "Untitled",
    onSelect: vi.fn(),
    onEmployeeSessionsAvailable: vi.fn(),
    togglePin: vi.fn(),
    handleDuplicate: vi.fn(),
    setArchiveTarget: vi.fn(),
    setDeleteTarget: vi.fn(),
    setRenamingSessionId: vi.fn(),
    updateSessionTitle: vi.fn(),
  }
}

function renderSurface(props?: Partial<React.ComponentProps<typeof SidebarListSurface>>) {
  return render(
    <SidebarListSurface
      loading={false}
      search=""
      viewMode="all"
      hiddenAutomated={0}
      selectViewMode={vi.fn()}
      virtualItems={[]}
      sharedRowProps={makeSharedRowProps()}
      selectedId={null}
      expandedRooms={new Set()}
      toggleRoomExpanded={vi.fn()}
      expandedProjects={new Set()}
      toggleProjectExpanded={vi.fn()}
      handleProjectClick={vi.fn()}
      handleProjectSessionClick={vi.fn()}
      expanded={{}}
      handleEmployeeClick={vi.fn()}
      handleMarkAllRead={vi.fn()}
      handleLoadMore={vi.fn()}
      loadingMore={new Set()}
      olderSummaryChats={0}
      olderLineLabel="Older · 0 chats"
      toggleOlderExpanded={vi.fn()}
      cronCollapsed={false}
      toggleCronCollapsed={vi.fn()}
      cronTotal={0}
      cronSessionsLength={0}
      managerEmployees={[]}
      teamEmployees={[]}
      scrollContainerRef={{ current: null }}
      handleListScroll={vi.fn()}
      shouldVirtualize={false}
      totalSize={0}
      virtualRows={[]}
      measureElement={vi.fn()}
      {...props}
    />,
  )
}

describe("SidebarListSurface", () => {
  it("renders the search empty state", () => {
    renderSurface({ search: "ops" })
    expect(screen.getByText("No matching chats")).toBeTruthy()
  })

  it("renders the focused empty state CTA", () => {
    const selectViewMode = vi.fn()
    renderSurface({
      viewMode: "focused",
      hiddenAutomated: 3,
      selectViewMode,
    })

    fireEvent.click(screen.getByText("View all (3 automated)"))
    expect(selectViewMode).toHaveBeenCalledWith("all")
  })

  it("renders a department room header and wires expand + open", () => {
    const toggleRoomExpanded = vi.fn()
    const onSelectRoom = vi.fn()
    const room: DepartmentRoom = {
      id: "platform",
      name: "Platform",
      departmentId: "platform",
      isUnassigned: false,
      sessions: [],
      participants: [],
      sessionCount: 2,
      participantCount: 1,
      lastActivity: "2026-06-22T10:00:00.000Z",
      runningCount: 1,
      needsAttentionCount: 0,
      status: "active",
    }

    renderSurface({
      virtualItems: [{ kind: "room-header", room }],
      selectedId: "room:platform",
      expandedRooms: new Set(["platform"]),
      toggleRoomExpanded,
      onSelectRoom,
    })

    const openButton = screen.getByText("Platform").closest("button")
    expect(openButton).toBeTruthy()
    if (!openButton) throw new Error("room open button not found")
    expect(openButton.getAttribute("aria-current")).toBe("page")
    expect(screen.getByText("2 chats")).toBeTruthy()
    expect(screen.getByText("1 person")).toBeTruthy()
    expect(screen.getByText("1 running")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Collapse Platform" }))
    expect(toggleRoomExpanded).toHaveBeenCalledWith("platform")
    expect(onSelectRoom).not.toHaveBeenCalled()

    fireEvent.click(openButton)
    expect(onSelectRoom).toHaveBeenCalledWith("platform")
  })

  it("renders a project root and wires tree expansion + root selection", () => {
    const toggleProjectExpanded = vi.fn()
    const handleProjectClick = vi.fn()
    const root = {
      id: "root",
      source: "web",
      sourceRef: "web:root",
      title: "Launch campaign",
      createdAt: "2026-07-21T10:00:00.000Z",
      lastActivity: "2026-07-21T10:00:00.000Z",
    }
    const project = {
      rootSessionId: "root",
      rootSession: root,
      title: "Launch campaign",
      lastActivity: root.lastActivity,
      sessions: [root],
      nodes: [{ session: root, depth: 0 }],
      participantIds: ["program-manager"],
      runningCount: 0,
      needsAttentionCount: 0,
      integrity: "valid" as const,
    }

    renderSurface({
      viewMode: "projects",
      virtualItems: [{ kind: "project-header", project }],
      expandedProjects: new Set(["root"]),
      toggleProjectExpanded,
      handleProjectClick,
    })

    fireEvent.click(screen.getByRole("button", { name: "Collapse Launch campaign" }))
    expect(toggleProjectExpanded).toHaveBeenCalledWith("root")
    fireEvent.click(screen.getByText("Launch campaign"))
    expect(handleProjectClick).toHaveBeenCalledWith(project)
    expect(screen.getByText("1 session")).toBeTruthy()
  })

  it("renders a distinct 'need you' badge alongside the running badge", () => {
    const room: DepartmentRoom = {
      id: "platform",
      name: "Platform",
      departmentId: "platform",
      isUnassigned: false,
      sessions: [],
      participants: [],
      sessionCount: 3,
      participantCount: 2,
      lastActivity: "2026-06-22T10:00:00.000Z",
      runningCount: 1,
      needsAttentionCount: 2,
      status: "active",
    }

    renderSurface({
      virtualItems: [{ kind: "room-header", room }],
      expandedRooms: new Set(),
      toggleRoomExpanded: vi.fn(),
      onSelectRoom: vi.fn(),
    })

    expect(screen.getByText("2 need you")).toBeTruthy()
    expect(screen.getByText("1 running")).toBeTruthy()
  })

  it("renders the scheduled section and load-more button wiring", () => {
    const handleLoadMore = vi.fn()
    const toggleCronCollapsed = vi.fn()
    const items: VirtualItem[] = [
      { kind: "cron-header" },
      { kind: "cron-more" },
    ]

    renderSurface({
      virtualItems: items,
      cronTotal: 5,
      cronSessionsLength: 2,
      handleLoadMore,
      toggleCronCollapsed,
    })

    fireEvent.click(screen.getByText("Scheduled"))
    expect(toggleCronCollapsed).toHaveBeenCalled()
    fireEvent.click(screen.getByText("+3 more"))
    expect(handleLoadMore).toHaveBeenCalledWith("__cron__", 2)
  })

  it("renders non-virtualized list items through the shared item renderer", () => {
    const items: VirtualItem[] = [
      { kind: "section", id: "today", label: "Today", count: 1 },
      {
        kind: "flat",
        row: {
          session: { id: "s-1" } as any,
          avatarName: "cuttlefish",
          displayName: "Cuttlefish",
        },
      },
      { kind: "cron-session", session: { id: "cron-1" } as any },
    ]

    renderSurface({ virtualItems: items })

    expect(screen.getByText("Today")).toBeTruthy()
    expect(screen.getByText("flat:Cuttlefish")).toBeTruthy()
    expect(screen.getByText("session:cron-1")).toBeTruthy()
  })

  it("renders manager contacts only in Management", () => {
    const onContactEmployee = vi.fn()
    renderSurface({
      viewMode: "management",
      onContactEmployee,
      managerEmployees: [
        {
          name: "boss",
          displayName: "Boss",
          department: "leadership",
          rank: "manager",
          engine: "claude",
          model: "opus",
          persona: "",
        },
      ],
      teamEmployees: [
        {
          name: "alice",
          displayName: "Alice",
          department: "platform",
          rank: "employee",
          engine: "claude",
          model: "opus",
          persona: "",
        },
      ],
    })

    expect(screen.getByText(/Managers:1/)).toBeTruthy()
    fireEvent.click(screen.getByText("contact:Boss"))
    expect(onContactEmployee).toHaveBeenCalledWith("boss")
    expect(screen.queryByText("contact:Alice")).toBeNull()
  })

  it("renders team contacts only in Team", () => {
    const onContactEmployee = vi.fn()
    renderSurface({
      viewMode: "projects",
      onContactEmployee,
      managerEmployees: [],
      teamEmployees: [{
        name: "alice",
        displayName: "Alice",
        department: "platform",
        rank: "employee",
        engine: "claude",
        model: "opus",
        persona: "",
      }],
    })

    expect(screen.getByText(/Team:1/)).toBeTruthy()
    fireEvent.click(screen.getByText("contact:Alice"))
    expect(onContactEmployee).toHaveBeenCalledWith("alice")
  })
})
