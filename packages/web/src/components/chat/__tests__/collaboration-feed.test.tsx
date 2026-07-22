import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { CollaborationFeed } from "../collaboration-feed"

describe("CollaborationFeed", () => {
  it("surfaces identity, inferred attribution, delivery receipts, project context, and inspection", () => {
    const inspect = vi.fn()
    render(<CollaborationFeed
      items={[{
        id: "event-1", lane: "team", projectRootSessionId: "root", sessionId: "child",
        kind: "callback", author: { kind: "agent", id: "builder", displayName: "Builder" },
        recipients: ["operator"], content: "Work complete", timestamp: 1,
        attribution: "inferred", projectTitle: "Alpha",
        deliveryReceipts: [{ recipientId: "operator", state: "queued", sessionId: "child" }],
      }]}
      loading={false} hasOlder={false} loadingOlder={false}
      onLoadOlder={vi.fn()} onRetry={vi.fn()} onInspectSession={inspect}
    />)
    expect(screen.getByLabelText("Builder callback")).toBeTruthy()
    expect(screen.getByText("inferred")).toBeTruthy()
    expect(screen.getByText("Alpha")).toBeTruthy()
    expect(screen.getByText("operator: queued")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Inspect session" }))
    expect(inspect).toHaveBeenCalledWith("child")
  })
})
