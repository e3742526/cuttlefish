import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { runAxe, formatViolations } from "@/test/axe"
import OrchestrationPage from "./page"
import {
  loadOrchestrationDashboard,
  pauseOrchestrationQueue,
  retryContinuation,
  resumeOrchestrationQueue,
  selectDualLaneWinner,
  stopOrchestrationLease,
  type OrchestrationDashboardData,
} from "@/lib/orchestration-api"

vi.mock("@/components/page-layout", () => ({
  PageLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ToolbarActions: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock("@/lib/orchestration-api", () => ({
  loadOrchestrationDashboard: vi.fn(),
  pauseOrchestrationQueue: vi.fn(async () => ({ ok: true })),
  retryContinuation: vi.fn(async () => ({ ok: true })),
  resumeOrchestrationQueue: vi.fn(async () => ({ ok: true })),
  selectDualLaneWinner: vi.fn(async () => ({ ok: true })),
  stopOrchestrationLease: vi.fn(async () => ({ ok: true })),
}))

const loadMock = vi.mocked(loadOrchestrationDashboard)
const pauseQueueMock = vi.mocked(pauseOrchestrationQueue)
const retryMock = vi.mocked(retryContinuation)
const resumeQueueMock = vi.mocked(resumeOrchestrationQueue)
const selectMock = vi.mocked(selectDualLaneWinner)
const stopLeaseMock = vi.mocked(stopOrchestrationLease)

beforeEach(() => {
  vi.clearAllMocks()
})

describe("OrchestrationPage", () => {
  it("renders disabled runtime state and empty operational sections", async () => {
    loadMock.mockResolvedValueOnce(sampleData({
      status: {
        enabled: false,
        runtimeBound: false,
        degraded: false,
        queuePaused: false,
        pausedAt: null,
        pauseReason: null,
        disabledReason: "orchestration is disabled",
        degradedReason: null,
        counts: { workers: 0, runningLeases: 0, queueItems: 0, allocations: 0, continuations: 0, activeWork: false },
      },
      workers: [],
    }))

    render(<OrchestrationPage />)

    expect(await screen.findByText("Disabled by gateway configuration")).toBeTruthy()
    expect(screen.getByText("orchestration is disabled")).toBeTruthy()
    expect((screen.getAllByRole("button", { name: "Pause queue" })[0] as HTMLButtonElement).disabled).toBe(true)
    activateTab("Workers")
    expect(await screen.findByText("No workers match this search.")).toBeTruthy()
  })

  it("renders paused state and resumes the global queue", async () => {
    loadMock.mockResolvedValue(sampleData({
      status: {
        enabled: true,
        runtimeBound: true,
        degraded: false,
        queuePaused: true,
        pausedAt: "2026-06-24T10:00:00.000Z",
        pauseReason: "operator hold",
        disabledReason: null,
        degradedReason: null,
        counts: { workers: 1, runningLeases: 0, queueItems: 1, allocations: 0, continuations: 1, activeWork: true },
      },
      queue: [{ taskId: "queued-task", coordinatorId: "coord", state: "blocked_resource" }],
    }))

    render(<OrchestrationPage />)

    expect(await screen.findByText("Queue paused, 0 running lease(s)")).toBeTruthy()
    expect(screen.getByText("Queue paused: operator hold")).toBeTruthy()
    fireEvent.click(screen.getAllByRole("button", { name: "Resume queue" })[0])

    await waitFor(() => expect(resumeQueueMock).toHaveBeenCalled())
  })

  it("shows stop only for running leases and surfaces stop failures", async () => {
    stopLeaseMock.mockRejectedValueOnce(new Error("mapped session engine is not interruptible"))
    loadMock.mockResolvedValue(sampleData({
      status: {
        enabled: true,
        runtimeBound: true,
        degraded: false,
        queuePaused: false,
        pausedAt: null,
        pauseReason: null,
        disabledReason: null,
        degradedReason: null,
        counts: { workers: 1, runningLeases: 1, queueItems: 0, allocations: 1, continuations: 0, activeWork: true },
      },
      leases: [
        { leaseId: "lease-run", taskId: "task-run", coordinatorId: "coord", workerId: "worker-1", role: "seniorImplementer", state: "running", leaseExpiresAt: "2026-06-24T10:05:00.000Z" },
        { leaseId: "lease-old", taskId: "task-old", coordinatorId: "coord", workerId: "worker-1", role: "seniorImplementer", state: "released" },
      ],
    }))

    render(<OrchestrationPage />)

    const stopButtons = await screen.findAllByRole("button", { name: "Stop lease" })
    expect(stopButtons).toHaveLength(1)
    fireEvent.click(stopButtons[0])

    await waitFor(() => expect(stopLeaseMock).toHaveBeenCalledWith("lease-run", "Stopped from dashboard"))
    expect(await screen.findByText("mapped session engine is not interruptible")).toBeTruthy()
  })

  it("shows retry only for failed continuations and runs the retry action", async () => {
    loadMock.mockResolvedValue(sampleData({
      continuations: [
        { taskId: "failed-task", coordinatorId: "coord", mode: "single_worker", state: "failed", retryCount: 1, updatedAt: "2026-06-24T10:00:00.000Z", lastError: "engine failed" },
        { taskId: "queued-task", coordinatorId: "coord", mode: "single_worker", state: "queued", retryCount: 0, updatedAt: "2026-06-24T10:00:00.000Z" },
      ],
    }))

    render(<OrchestrationPage />)
    await screen.findByRole("tab", { name: "Continuations" })
    activateTab("Continuations")

    const retryButtons = await screen.findAllByRole("button", { name: "Retry" })
    expect(retryButtons).toHaveLength(2)
    expect((retryButtons[0] as HTMLButtonElement).disabled).toBe(false)
    expect((retryButtons[1] as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(retryButtons[0])

    await waitFor(() => expect(retryMock).toHaveBeenCalledWith("failed-task", "coord"))
  })

  it("enables selection only for selection_required dual-lane manifests", async () => {
    loadMock.mockResolvedValue(sampleData({
      dualLane: [
        dualLaneRun("select-task", "selection_required"),
        dualLaneRun("done-task", "selected"),
      ],
    }))

    render(<OrchestrationPage />)
    await screen.findByRole("tab", { name: "Dual-lane" })
    activateTab("Dual-lane")

    const openaiButtons = await screen.findAllByRole("button", { name: "Select openai" })
    expect(openaiButtons).toHaveLength(2)
    expect((openaiButtons[0] as HTMLButtonElement).disabled).toBe(false)
    expect((openaiButtons[1] as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(openaiButtons[0])

    await waitFor(() => expect(selectMock).toHaveBeenCalledWith("select-task", "dual-coord", "openai"))
  })

  it("has no axe-core structural/semantic violations (color-contrast excluded — jsdom has no real paint)", async () => {
    loadMock.mockResolvedValue(sampleData())

    const { container } = render(<OrchestrationPage />)
    await screen.findByRole("tab", { name: "Dual-lane" })

    const violations = await runAxe(container)
    expect(violations, formatViolations(violations)).toEqual([])
  })
})

function sampleData(overrides: Partial<OrchestrationDashboardData> = {}): OrchestrationDashboardData {
  return {
    status: {
      enabled: true,
      runtimeBound: true,
      degraded: false,
      queuePaused: false,
      pausedAt: null,
      pauseReason: null,
      disabledReason: null,
      degradedReason: null,
      counts: { workers: 1, runningLeases: 0, queueItems: 0, allocations: 0, continuations: 0, activeWork: false },
    },
    workers: [{
      id: "worker-1",
      provider: "mock",
      family: "local",
      tier: "frontier",
      capabilities: ["repo_edit"],
      tools: ["filesystem"],
      maxConcurrentTasks: 1,
      costClass: "low",
      workspacePolicy: "shared",
    }],
    leases: [],
    queue: [],
    taskPauses: [],
    holds: [],
    allocations: [],
    continuations: [],
    telemetry: {
      maxBytes: 1000,
      maxRecords: 100,
      summary: {
        totals: bucket(0),
        byProvider: {},
        byFamily: {},
        byRole: {},
        byWorker: {},
        skippedLines: 0,
      },
    },
    worktrees: [],
    dualLane: [],
    ...overrides,
  }
}

function bucket(count: number) {
  return {
    count,
    dispositions: {},
    totalCost: 0,
    avgCost: null,
    totalLatencyMs: 0,
    avgLatencyMs: null,
    totalTokens: 0,
    avgTokens: null,
    filesChanged: 0,
    testsAdded: 0,
    testsPassed: 0,
    reviewBlockers: 0,
    humanEdits: 0,
    regressions: 0,
    score: 0,
  }
}

function dualLaneRun(taskId: string, state: string) {
  return {
    taskId,
    coordinatorId: "dual-coord",
    state,
    createdAt: "2026-06-24T10:00:00.000Z",
    updatedAt: "2026-06-24T10:01:00.000Z",
    baseCwd: "/tmp/repo",
    selectedLane: state === "selected" ? "openai" : null,
    archivedLane: null,
    lanes: [
      lane("openai"),
      lane("anthropic"),
    ],
    comparisonReport: {
      taskId,
      generatedAt: "2026-06-24T10:02:00.000Z",
      laneSummaries: [
        { laneId: "openai", changedFiles: ["src/a.ts"], addedLines: 2, removedLines: 0, status: "completed", error: null },
        { laneId: "anthropic", changedFiles: ["src/b.ts"], addedLines: 1, removedLines: 1, status: "completed", error: null },
      ],
      commonFiles: [],
      uniqueFiles: { openai: ["src/a.ts"], anthropic: ["src/b.ts"] },
      majorDifferences: ["Different files changed"],
    },
  } as OrchestrationDashboardData["dualLane"][number]
}

function lane(id: "openai" | "anthropic") {
  return {
    id,
    role: `${id}Implementer`,
    family: id,
    workerId: `${id}-worker`,
    leaseId: `${id}-lease`,
    sessionId: `${id}-session`,
    sessionStatus: "completed",
    sessionError: null,
    worktreePath: `/tmp/${id}`,
    archive: null,
  }
}

function activateTab(name: string) {
  const tab = screen.getByRole("tab", { name })
  fireEvent.pointerDown(tab, { button: 0, ctrlKey: false, pointerType: "mouse" })
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false })
  fireEvent.pointerUp(tab, { button: 0, ctrlKey: false, pointerType: "mouse" })
  fireEvent.mouseUp(tab, { button: 0, ctrlKey: false })
  fireEvent.click(tab)
}
