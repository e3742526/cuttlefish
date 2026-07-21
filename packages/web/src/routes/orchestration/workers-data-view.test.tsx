import { describe, expect, it } from "vitest"
import type { HoldSummary, LeaseSummary, WorkerSummary } from "@/lib/orchestration-api"
import { deriveWorkerPresence } from "./workers-data-view"

const worker: WorkerSummary = {
  id: "worker-1",
  provider: "openai",
  family: "openai",
  tier: "frontier",
  capabilities: ["repo_edit"],
  tools: ["filesystem"],
  maxConcurrentTasks: 2,
  costClass: "medium",
  workspacePolicy: "isolated_worktree",
}

const runningLease: LeaseSummary = {
  leaseId: "lease-1",
  taskId: "task-1",
  coordinatorId: "coord-1",
  workerId: "worker-1",
  role: "implementer",
  state: "running",
}

const activeHold: HoldSummary = {
  holdId: "hold-1",
  managerName: "Manager",
  state: "active",
  roles: [],
  workerIds: ["worker-1"],
  taskId: null,
  coordinatorId: null,
  reason: "Reserved for review",
  createdAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z",
  expiresAt: "2026-07-21T00:00:00.000Z",
}

describe("deriveWorkerPresence", () => {
  it("derives available, held, working, and capacity states from observed scheduler data", () => {
    expect(deriveWorkerPresence(worker, [], []).label).toBe("Available")
    expect(deriveWorkerPresence(worker, [], [activeHold]).label).toBe("Held")
    expect(deriveWorkerPresence(worker, [runningLease], [activeHold])).toMatchObject({
      label: "Working",
      activeLeases: [runningLease],
      activeHolds: [activeHold],
    })
    expect(deriveWorkerPresence({ ...worker, maxConcurrentTasks: 1 }, [runningLease], []).label).toBe("At capacity")
  })
})
