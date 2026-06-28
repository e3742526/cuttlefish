import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { SidebarListSurface } from "../sidebar-list-surface"
import type { VirtualItem } from "../sidebar-view-model"
import type { SidebarSharedRowProps } from "../sidebar-row-components"
import type { Employee } from "@/lib/api"

vi.mock("../sidebar-row-components", () => ({
  SECTION_LABEL_CLASS: "section-label",
  SECTION_COUNT_CLASS: "section-count",
  SectionLabel: ({ label, count }: { label: string; count?: number }) => <div>{label}:{count ?? ""}</div>,
  FlatSessionRow: ({ displayName }: { displayName: string }) => <div>flat:{displayName}</div>,
  SessionRow: ({ session }: { session: { id: string } }) => <div>session:{session.id}</div>,
  EmployeeRow: ({ item }: { item: { employeeName?: string } }) => <div>employee:{item.employeeName}</div>,
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
      focusMode="all"
      hiddenAutomated={0}
      selectFocusMode={vi.fn()}
      virtualItems={[]}
      sharedRowProps={makeSharedRowProps()}
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
    const selectFocusMode = vi.fn()
    renderSurface({
      focusMode: "focused",
      hiddenAutomated: 3,
      selectFocusMode,
    })

    fireEvent.click(screen.getByText("View all (3 automated)"))
    expect(selectFocusMode).toHaveBeenCalledWith("all")
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

  it("renders manager and team contact rows when provided", () => {
    const onContactEmployee = vi.fn()
    renderSurface({
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
    expect(screen.getByText(/Team:1/)).toBeTruthy()
    fireEvent.click(screen.getByText("contact:Boss"))
    fireEvent.click(screen.getByText("contact:Alice"))
    expect(onContactEmployee).toHaveBeenCalledWith("boss")
    expect(onContactEmployee).toHaveBeenCalledWith("alice")
  })
})
