import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ContactRow, SectionLabel, SessionRow, StatusDot } from "../sidebar-row-components"
import type { Session } from "../sidebar-types"

vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuItem: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => <div {...props}>{children}</div>,
  ContextMenuSeparator: () => <hr />,
}))

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => <div {...props}>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}))

vi.mock("@/components/ui/employee-avatar", () => ({
  EmployeeAvatar: ({ name }: { name: string }) => <div>{name}</div>,
}))

describe("sidebar row components", () => {
  it("renders a section label with its count", () => {
    render(<SectionLabel label="Managers" count={3} />)

    expect(screen.getByText("Managers")).toBeTruthy()
    expect(screen.getByText("3")).toBeTruthy()
  })

  it("exposes the status dot label for assistive text when present", () => {
    render(<StatusDot color="red" pulse title="running" />)

    expect(screen.getByLabelText("running")).toBeTruthy()
  })

  it("starts a contact chat with the selected employee", () => {
    const onContact = vi.fn()

    render(
      <ContactRow
        emp={{
          name: "cuttlefish",
          displayName: "Cuttlefish Dev",
          department: "platform",
          rank: "employee",
          engine: "claude",
          model: "opus",
          persona: "",
        }}
        onContact={onContact}
      />,
    )

    fireEvent.click(screen.getByTitle("Start a chat with Cuttlefish Dev"))
    expect(onContact).toHaveBeenCalledWith("cuttlefish")
  })

  it("uses the live session action contract with archive actions", () => {
    const setArchiveTarget = vi.fn()
    const session: Session = {
      id: "s-1",
      employee: "cuttlefish",
      title: "Cuttlefish - Status",
      source: "web",
      sourceRef: "web:s-1",
      status: "idle",
      createdAt: "2026-06-25T10:00:00.000Z",
      lastActivity: "2026-06-25T10:00:00.000Z",
    }

    render(
      <SessionRow
        session={session}
        selectedId={null}
        readSessions={new Set([session.id])}
        pinnedSessions={new Set()}
        renamingSessionId={null}
        renameCancelledRef={{ current: false }}
        fixTitle={(title) => title ?? "Untitled"}
        onSelect={vi.fn()}
        onEmployeeSessionsAvailable={vi.fn()}
        togglePin={vi.fn()}
        handleDuplicate={vi.fn()}
        setArchiveTarget={setArchiveTarget}
        setDeleteTarget={vi.fn()}
        setRenamingSessionId={vi.fn()}
        updateSessionTitle={vi.fn()}
      />,
    )

    expect(screen.getAllByText("Rename").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Duplicate...").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Archive...").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Delete session").length).toBeGreaterThan(0)
    fireEvent.click(screen.getAllByText("Archive...")[0])
    expect(setArchiveTarget).toHaveBeenCalledWith(expect.objectContaining({
      kind: "chat",
      title: "Cuttlefish - Status",
      sessionIds: ["s-1"],
    }))
    const actionsButton = screen.getByLabelText("Session actions")
    const buttons = screen.getAllByRole("button")
    const rowButton = buttons.find((button) => button !== actionsButton && button.textContent?.includes("Cuttlefish - Status"))
    expect(rowButton).toBeTruthy()
    expect(rowButton?.contains(actionsButton)).toBe(false)
  })

  it("renders an accessible new-agent-message indicator for an unread completed session", () => {
    const session: Session = {
      id: "s-agent-message",
      title: "Delegated work",
      source: "web",
      sourceRef: "web:s-agent-message",
      status: "idle",
      jobState: "finished",
      lastAgentMessageAt: "2026-07-20T20:00:00.000Z",
      createdAt: "2026-07-20T19:00:00.000Z",
      lastActivity: "2026-07-20T20:00:00.000Z",
    }

    render(
      <SessionRow
        session={session}
        selectedId={null}
        readSessions={new Set()}
        pinnedSessions={new Set()}
        renamingSessionId={null}
        renameCancelledRef={{ current: false }}
        fixTitle={(title) => title ?? "Untitled"}
        onSelect={vi.fn()}
        onEmployeeSessionsAvailable={vi.fn()}
        togglePin={vi.fn()}
        handleDuplicate={vi.fn()}
        setArchiveTarget={vi.fn()}
        setDeleteTarget={vi.fn()}
        setRenamingSessionId={vi.fn()}
        updateSessionTitle={vi.fn()}
      />,
    )

    expect(screen.getByLabelText("new agent message")).toBeTruthy()
    expect(screen.getByText(/New agent message · Delegated work/)).toBeTruthy()
  })
})
