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
})
