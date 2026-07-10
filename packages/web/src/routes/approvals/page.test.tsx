import { describe, expect, it, vi, beforeEach } from "vitest"
import { MemoryRouter } from "react-router-dom"
import { render, screen, fireEvent } from "@testing-library/react"
import type { Approval, Checkpoint } from "@/lib/api"
import { runAxe, formatViolations } from "@/test/axe"

const approvalsState = vi.hoisted(() => ({
  approvals: [] as Approval[],
  approvalsLoading: false,
  approvalsError: null as Error | null,
  checkpoints: [] as Checkpoint[],
  checkpointsLoading: false,
  checkpointsError: null as Error | null,
}))

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock("@/context/breadcrumb-context", () => ({
  useBreadcrumbs: () => undefined,
}))

vi.mock("@/hooks/use-approvals", () => ({
  useApprovals: () => ({
    data: approvalsState.approvals,
    isLoading: approvalsState.approvalsLoading,
    error: approvalsState.approvalsError,
  }),
  useApproveApproval: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useRejectApproval: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}))

vi.mock("@/hooks/use-checkpoints", () => ({
  useCheckpoints: () => ({
    data: approvalsState.checkpoints,
    isLoading: approvalsState.checkpointsLoading,
    error: approvalsState.checkpointsError,
  }),
  useDecideCheckpoint: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
}))

import ApprovalsPage from "./page"

describe("ApprovalsPage", () => {
  beforeEach(() => {
    approvalsState.approvals = []
    approvalsState.approvalsLoading = false
    approvalsState.approvalsError = null
    approvalsState.checkpoints = []
    approvalsState.checkpointsLoading = false
    approvalsState.checkpointsError = null
  })

  it("renders fallback approvals and human checkpoints in the pending list, and shows detail on click", () => {
    approvalsState.approvals = [{
      id: "approval-1",
      sessionId: "session-12345678",
      type: "fallback",
      payload: {
        from: { engine: "claude", model: "sonnet" },
        to: { engine: "codex", model: "gpt-5.5" },
        reason: "rate_limit",
      },
      state: "pending",
      createdAt: "2026-06-26T10:00:00.000Z",
    }]
    approvalsState.checkpoints = [{
      id: "checkpoint-1",
      sessionId: "session-87654321",
      type: "checkpoint",
      payload: {
        decisionNeeded: "Approve deleting generated report",
        why: "This will remove the current draft artifact before rewriting it.",
        affectedFiles: ["reports/draft.md"],
        affectedArtifacts: ["artifact-1"],
        affectedActions: ["delete artifact-1"],
        options: ["approved", "deferred", "revised", "rejected"],
      },
      state: "pending",
      createdAt: "2026-06-26T11:00:00.000Z",
    }]

    render(
      <MemoryRouter>
        <ApprovalsPage />
      </MemoryRouter>,
    )

    // Both items appear in the pending list by their labels
    expect(screen.getAllByText("fallback approval").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Approve deleting generated report").length).toBeGreaterThan(0)

    // Click the checkpoint list item to load its detail
    const checkpointListItems = screen.getAllByText("Approve deleting generated report")
    fireEvent.click(checkpointListItems[0])

    // Detail panel shows checkpoint-specific content
    expect(screen.getByText("reports/draft.md")).toBeTruthy()
    expect(screen.getByRole("button", { name: /Revise & resume/i })).toBeTruthy()
  })

  it("renders approvals inside an internal scroll region", () => {
    render(
      <MemoryRouter>
        <ApprovalsPage />
      </MemoryRouter>,
    )

    const scrollRegion = screen.getByTestId("approvals-scroll-region")
    expect(scrollRegion.className).toContain("overflow-y-auto")
  })

  it("renders a visible error state when either queue fails to load", () => {
    approvalsState.approvalsError = new Error("approval fetch failed")

    render(
      <MemoryRouter>
        <ApprovalsPage />
      </MemoryRouter>,
    )

    expect(screen.getByText("approval fetch failed")).toBeTruthy()
  })

  it("has no axe-core structural/semantic violations (color-contrast excluded — jsdom has no real paint)", async () => {
    approvalsState.approvals = [{
      id: "approval-2",
      sessionId: "session-11111111",
      type: "fallback",
      payload: {
        from: { engine: "claude", model: "sonnet" },
        to: { engine: "codex", model: "gpt-5.5" },
        reason: "rate_limit",
      },
      state: "pending",
      createdAt: "2026-06-26T10:00:00.000Z",
    }]

    const { container } = render(
      <MemoryRouter>
        <ApprovalsPage />
      </MemoryRouter>,
    )
    const violations = await runAxe(container)
    expect(violations, formatViolations(violations)).toEqual([])
  })
})
