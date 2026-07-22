import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { CollaborationComposer } from "../collaboration-composer"

describe("CollaborationComposer", () => {
  it("uses keyboard mention selection and submits structured Team recipient IDs", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(<CollaborationComposer lane="team" recipients={[{ id: "builder", displayName: "Builder" }]} onSend={onSend} />)
    const input = screen.getByLabelText("Team message")
    fireEvent.change(input, { target: { value: "@b" } })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.change(input, { target: { value: "Please investigate" } })
    fireEvent.click(screen.getByLabelText("Send collaboration message"))
    await waitFor(() => expect(onSend).toHaveBeenCalledWith({ message: "Please investigate", recipientIds: ["builder"] }))
  })

  it("requires and submits an exact @all roster confirmation", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(<CollaborationComposer lane="team" recipients={[{ id: "one", displayName: "One" }, { id: "two", displayName: "Two" }]} onSend={onSend} />)
    const input = screen.getByLabelText("Team message")
    fireEvent.change(input, { target: { value: "@all" } })
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.click(screen.getByRole("button", { name: "Confirm 2 recipients" }))
    fireEvent.change(input, { target: { value: "Status update" } })
    fireEvent.click(screen.getByLabelText("Send collaboration message"))
    await waitFor(() => expect(onSend).toHaveBeenCalledWith({
      message: "Status update", recipientMode: "all", confirmAllRecipients: ["one", "two"],
    }))
  })

  it("only attaches one-turn authority to an explicit eligible management recipient", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined)
    render(<CollaborationComposer lane="management" recipients={[{ id: "cuttlefish", displayName: "COO", rank: "executive", active: true }]} onSend={onSend} />)
    const input = screen.getByLabelText("Management message")
    fireEvent.change(input, { target: { value: "@c" } })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.click(screen.getByRole("checkbox", { name: "approve" }))
    fireEvent.change(input, { target: { value: "Approve this turn" } })
    fireEvent.click(screen.getByLabelText("Send collaboration message"))
    await waitFor(() => expect(onSend).toHaveBeenCalledWith({
      message: "Approve this turn", recipientIds: ["cuttlefish"], operatorDelegationScopes: ["approve"],
    }))
  })
})
