import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { ReactFlowProvider } from "@xyflow/react"
import { EmployeeNode } from "./employee-node"
import type { Employee } from "@/lib/api"

function renderNode(employee: Employee, onWrapperClick?: () => void) {
  const nodeProps = {
    data: employee as Employee & Record<string, unknown>,
    id: employee.name,
    type: "employeeNode",
    selected: false,
    dragging: false,
    zIndex: 0,
    isConnectable: true,
  } as any

  return render(
    <ReactFlowProvider>
      <MemoryRouter>
        <div onClick={onWrapperClick}>
          <EmployeeNode {...nodeProps} />
        </div>
      </MemoryRouter>
    </ReactFlowProvider>,
  )
}

describe("EmployeeNode quick chat affordance", () => {
  it("renders an employee chat link with the existing deep-link contract", () => {
    renderNode({
      name: "engineer",
      displayName: "Engineer",
      department: "Engineering",
      rank: "employee",
      engine: "claude",
      model: "opus",
      persona: "Builds things",
    })

    const link = screen.getByRole("link", { name: "Chat with Engineer" })
    expect(link.getAttribute("href")).toBe("/?employee=engineer")
  })

  it("routes the executive card to the direct chat workspace", () => {
    renderNode({
      name: "cuttlefish",
      displayName: "Cuttlefish",
      department: "",
      rank: "executive",
      engine: "claude",
      model: "opus",
      persona: "COO",
    })

    const link = screen.getByRole("link", { name: "Chat with Cuttlefish" })
    expect(link.getAttribute("href")).toBe("/")
  })

  it("does not bubble quick-chat activation to the parent click surface", () => {
    const onWrapperClick = vi.fn()
    renderNode(
      {
        name: "engineer",
        displayName: "Engineer",
        department: "Engineering",
        rank: "employee",
        engine: "claude",
        model: "opus",
        persona: "Builds things",
      },
      onWrapperClick,
    )

    fireEvent.pointerDown(screen.getByRole("link", { name: "Chat with Engineer" }))
    fireEvent.click(screen.getByRole("link", { name: "Chat with Engineer" }))

    expect(onWrapperClick).not.toHaveBeenCalled()
  })

  it("preserves the node body as a separate click target", () => {
    const onWrapperClick = vi.fn()
    renderNode(
      {
        name: "engineer",
        displayName: "Engineer",
        department: "Engineering",
        rank: "employee",
        engine: "claude",
        model: "opus",
        persona: "Builds things",
      },
      onWrapperClick,
    )

    fireEvent.click(screen.getByText("Engineer"))

    expect(onWrapperClick).toHaveBeenCalledTimes(1)
  })

  it("exposes full display name and role text via hover titles", () => {
    renderNode({
      name: "parliamentarian",
      displayName: "Parliamentarian and Strategic Governance Lead",
      department: "General",
      rank: "manager",
      engine: "claude",
      model: "opus",
      persona: "Keeps the org aligned",
    })

    expect(screen.getByTitle("Parliamentarian and Strategic Governance Lead")).toBeTruthy()
    expect(screen.getByTitle("Manager")).toBeTruthy()
  })

  it("shows the selected model without requiring hover", () => {
    renderNode({
      name: "assistant",
      displayName: "Assistant",
      department: "General",
      rank: "senior",
      engine: "claude",
      model: "claude-sonnet-4-6",
      persona: "Keeps things moving",
    })

    expect(screen.getByText("claude-sonnet-4-6")).toBeTruthy()
  })

  it("labels non-solo execution as a configured profile, not active review runtime", () => {
    renderNode({
      name: "reviewed",
      displayName: "Reviewed",
      department: "Engineering",
      rank: "employee",
      engine: "claude",
      model: "opus",
      persona: "Builds things",
      executionProfileSummary: {
        tier: "mid_pair",
        label: "Built-in review",
        hasCustomRoleOverrides: false,
      },
    })

    expect(screen.getByText("profile")).toBeTruthy()
    expect(screen.getByTitle("Review profile configured")).toBeTruthy()
    expect(screen.queryByTitle("Built-in review")).toBeNull()
  })
})
