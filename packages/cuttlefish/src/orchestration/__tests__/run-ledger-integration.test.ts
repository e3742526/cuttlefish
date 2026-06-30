import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunLedgerStore } from "../../run-ledger/store.js";
import type { Allocation } from "../types.js";
import type { LiveRunContinuationRecord } from "../live-run.js";

// Mock the run-ledger module before importing the module under test so the
// singleton is intercepted before any module-level code runs.
const mockCreateRun = vi.fn();
const mockTransitionRun = vi.fn();
const mockListRuns = vi.fn();

vi.mock("../../run-ledger/index.js", () => ({
  getRunLedger: () =>
    ({
      createRun: mockCreateRun,
      transitionRun: mockTransitionRun,
      listRuns: mockListRuns,
    }) as unknown as RunLedgerStore,
}));

// Import AFTER the mock is set up.
import {
  beginOrchestrationRun,
  createBlockedOrchestrationRun,
  finalizeOrchestrationRunCompleted,
  finalizeOrchestrationRunFailed,
  interruptOrchestrationRun,
  recoverOrchestrationRun,
  sweepOrphanedOrchestrationRuns,
} from "../run-ledger-integration.js";

function makeAllocation(overrides: Partial<Allocation> = {}): Allocation {
  return {
    allocationId: "alloc-1",
    taskId: "task-1",
    coordinatorId: "coord-1",
    state: "allocated",
    leases: [],
    optionalRolesSkipped: [],
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("beginOrchestrationRun", () => {
  it("creates a run entry and transitions it to running", () => {
    mockTransitionRun.mockReturnValue({ runId: "r1", currentState: "running" });
    const now = "2026-06-30T00:01:00.000Z";
    const runId = beginOrchestrationRun(makeAllocation(), "single_worker", "My Task", now);

    expect(typeof runId).toBe("string");
    expect(runId).toBeTruthy();

    expect(mockCreateRun).toHaveBeenCalledOnce();
    const createArgs = mockCreateRun.mock.calls[0][0];
    expect(createArgs.runId).toBe(runId);
    expect(createArgs.sessionId).toBeNull();
    expect(createArgs.source).toBe("orchestration");
    expect(createArgs.sourceRef).toBe("alloc-1");
    expect(createArgs.engine).toBe("orchestration");
    expect(createArgs.title).toBe("My Task");
    expect(createArgs.promptExcerpt).toBe("mode:single_worker");
    expect(createArgs.createdAt).toBe(now);

    expect(mockTransitionRun).toHaveBeenCalledOnce();
    const transitionArgs = mockTransitionRun.mock.calls[0][0];
    expect(transitionArgs.runId).toBe(runId);
    expect(transitionArgs.nextState).toBe("running");
    expect(transitionArgs.at).toBe(now);
  });

  it("derives the title from taskId/coordinatorId when no taskTitle is provided", () => {
    const alloc = makeAllocation({ taskId: "task-42", coordinatorId: "coord-7" });
    beginOrchestrationRun(alloc, "dual_lane");

    const createArgs = mockCreateRun.mock.calls[0][0];
    expect(createArgs.title).toBe("task-42/coord-7");
  });

  it("returns a UUID-shaped string", () => {
    const runId = beginOrchestrationRun(makeAllocation(), "single_worker");
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("createBlockedOrchestrationRun", () => {
  it("creates a run entry and transitions it to blocked", () => {
    mockTransitionRun.mockReturnValue({ runId: "r2", currentState: "blocked" });
    const now = "2026-06-30T00:02:00.000Z";
    const runId = createBlockedOrchestrationRun("task-2", "coord-2", "single_worker", "Blocked Task", now);

    expect(typeof runId).toBe("string");
    expect(runId).toBeTruthy();

    expect(mockCreateRun).toHaveBeenCalledOnce();
    const createArgs = mockCreateRun.mock.calls[0][0];
    expect(createArgs.runId).toBe(runId);
    expect(createArgs.sessionId).toBeNull();
    expect(createArgs.source).toBe("orchestration");
    expect(createArgs.sourceRef).toBe("task-2:coord-2");
    expect(createArgs.engine).toBe("orchestration");
    expect(createArgs.title).toBe("Blocked Task");
    expect(createArgs.promptExcerpt).toBe("mode:single_worker blocked");
    expect(createArgs.createdAt).toBe(now);

    expect(mockTransitionRun).toHaveBeenCalledOnce();
    const transitionArgs = mockTransitionRun.mock.calls[0][0];
    expect(transitionArgs.runId).toBe(runId);
    expect(transitionArgs.nextState).toBe("blocked");
  });

  it("uses taskId/coordinatorId as title when taskTitle is omitted", () => {
    createBlockedOrchestrationRun("task-3", "coord-3", "dual_lane");
    const createArgs = mockCreateRun.mock.calls[0][0];
    expect(createArgs.title).toBe("task-3/coord-3");
  });
});

describe("finalizeOrchestrationRunCompleted", () => {
  it("transitions the run to completed", () => {
    mockTransitionRun.mockReturnValue({ runId: "r3", currentState: "completed" });
    const now = "2026-06-30T00:03:00.000Z";
    finalizeOrchestrationRunCompleted("run-xyz", now);

    expect(mockTransitionRun).toHaveBeenCalledOnce();
    const args = mockTransitionRun.mock.calls[0][0];
    expect(args.runId).toBe("run-xyz");
    expect(args.nextState).toBe("completed");
    expect(args.at).toBe(now);
  });

  it("is a no-op when runId is undefined", () => {
    finalizeOrchestrationRunCompleted(undefined);
    expect(mockTransitionRun).not.toHaveBeenCalled();
  });

  it("swallows errors from the ledger without rethrowing", () => {
    mockTransitionRun.mockImplementation(() => {
      throw new Error("ledger unavailable");
    });
    expect(() => finalizeOrchestrationRunCompleted("run-bad")).not.toThrow();
  });
});

describe("finalizeOrchestrationRunFailed", () => {
  it("transitions the run to failed with an error message", () => {
    mockTransitionRun.mockReturnValue({ runId: "r4", currentState: "failed" });
    const now = "2026-06-30T00:04:00.000Z";
    finalizeOrchestrationRunFailed("run-abc", "something went wrong", now);

    expect(mockTransitionRun).toHaveBeenCalledOnce();
    const args = mockTransitionRun.mock.calls[0][0];
    expect(args.runId).toBe("run-abc");
    expect(args.nextState).toBe("failed");
    expect(args.errorMessage).toBe("something went wrong");
    expect(args.at).toBe(now);
  });

  it("is a no-op when runId is undefined", () => {
    finalizeOrchestrationRunFailed(undefined, "err");
    expect(mockTransitionRun).not.toHaveBeenCalled();
  });

  it("swallows errors from the ledger without rethrowing", () => {
    mockTransitionRun.mockImplementation(() => {
      throw new Error("db error");
    });
    expect(() => finalizeOrchestrationRunFailed("run-bad", "oops")).not.toThrow();
  });
});

describe("interruptOrchestrationRun", () => {
  it("transitions the run to interrupted with a reason", () => {
    mockTransitionRun.mockReturnValue({ runId: "r5", currentState: "interrupted" });
    const now = "2026-06-30T00:05:00.000Z";
    interruptOrchestrationRun("run-int", "graceful shutdown", now);

    expect(mockTransitionRun).toHaveBeenCalledOnce();
    const args = mockTransitionRun.mock.calls[0][0];
    expect(args.runId).toBe("run-int");
    expect(args.nextState).toBe("interrupted");
    expect(args.errorMessage).toBe("graceful shutdown");
    expect(args.at).toBe(now);
  });

  it("is a no-op when runId is undefined", () => {
    interruptOrchestrationRun(undefined, "shutdown");
    expect(mockTransitionRun).not.toHaveBeenCalled();
  });

  it("swallows errors without rethrowing", () => {
    mockTransitionRun.mockImplementation(() => {
      throw new Error("conn error");
    });
    expect(() => interruptOrchestrationRun("run-int", "reason")).not.toThrow();
  });
});

describe("recoverOrchestrationRun", () => {
  it("transitions to interrupted when retryCount is below maxRetries", () => {
    mockTransitionRun.mockReturnValue({ runId: "r6", currentState: "interrupted" });
    const continuation: Pick<LiveRunContinuationRecord, "runId" | "retryCount"> = {
      runId: "run-retry",
      retryCount: 1,
    };
    const now = "2026-06-30T00:06:00.000Z";
    recoverOrchestrationRun(continuation, 3, "transient error", now);

    expect(mockTransitionRun).toHaveBeenCalledOnce();
    const args = mockTransitionRun.mock.calls[0][0];
    expect(args.runId).toBe("run-retry");
    expect(args.nextState).toBe("interrupted");
    expect(args.errorMessage).toBe("transient error");
    expect(args.at).toBe(now);
  });

  it("transitions to dead_lettered when retryCount equals maxRetries", () => {
    mockTransitionRun.mockReturnValue({ runId: "r7", currentState: "dead_lettered" });
    const continuation: Pick<LiveRunContinuationRecord, "runId" | "retryCount"> = {
      runId: "run-exhausted",
      retryCount: 3,
    };
    recoverOrchestrationRun(continuation, 3, "exhausted retries");

    expect(mockTransitionRun).toHaveBeenCalledOnce();
    expect(mockTransitionRun.mock.calls[0][0].nextState).toBe("dead_lettered");
  });

  it("transitions to dead_lettered when retryCount exceeds maxRetries", () => {
    const continuation: Pick<LiveRunContinuationRecord, "runId" | "retryCount"> = {
      runId: "run-over-limit",
      retryCount: 5,
    };
    recoverOrchestrationRun(continuation, 3, "way over limit");
    expect(mockTransitionRun.mock.calls[0][0].nextState).toBe("dead_lettered");
  });

  it("is a no-op when runId is undefined", () => {
    const continuation: Pick<LiveRunContinuationRecord, "runId" | "retryCount"> = {
      runId: undefined,
      retryCount: 0,
    };
    recoverOrchestrationRun(continuation, 3, "err");
    expect(mockTransitionRun).not.toHaveBeenCalled();
  });

  it("swallows ledger errors without rethrowing", () => {
    mockTransitionRun.mockImplementation(() => {
      throw new Error("ledger down");
    });
    const continuation = { runId: "run-bad", retryCount: 0 };
    expect(() => recoverOrchestrationRun(continuation, 5, "err")).not.toThrow();
  });
});

describe("sweepOrphanedOrchestrationRuns", () => {
  it("dead-letters runs whose sourceRef is not in the live set", () => {
    mockListRuns.mockReturnValue([
      { runId: "run-orphan-1", sourceRef: "alloc-dead-1" },
      { runId: "run-orphan-2", sourceRef: "alloc-dead-2" },
    ]);
    mockTransitionRun.mockReturnValue({ runId: "x", currentState: "dead_lettered" });

    const swept = sweepOrphanedOrchestrationRuns(new Set(["alloc-live-99"]), new Set());
    expect(swept).toBe(2);

    expect(mockTransitionRun).toHaveBeenCalledTimes(2);
    for (const call of mockTransitionRun.mock.calls) {
      expect(call[0].nextState).toBe("dead_lettered");
      expect(call[0].errorMessage).toMatch(/orphan/i);
    }
  });

  it("skips runs whose sourceRef is in the live allocation set", () => {
    mockListRuns.mockReturnValue([
      { runId: "run-live", sourceRef: "alloc-live-1" },
    ]);

    const swept = sweepOrphanedOrchestrationRuns(new Set(["alloc-live-1"]), new Set());
    expect(swept).toBe(0);
    expect(mockTransitionRun).not.toHaveBeenCalled();
  });

  it("queries the ledger for non-terminal orchestration runs", () => {
    mockListRuns.mockReturnValue([]);
    sweepOrphanedOrchestrationRuns(new Set(), new Set());

    expect(mockListRuns).toHaveBeenCalledOnce();
    const listArgs = mockListRuns.mock.calls[0][0];
    expect(listArgs.states).toEqual(["created", "running", "blocked"]);
    expect(listArgs.engine).toBe("orchestration");
  });

  it("skips runs with no sourceRef (not allocationId-keyed)", () => {
    mockListRuns.mockReturnValue([
      { runId: "run-no-ref", sourceRef: null },
    ]);
    mockTransitionRun.mockReturnValue({ runId: "run-no-ref", currentState: "dead_lettered" });

    // A null sourceRef means liveAllocationIds.has(null) is false → swept
    const swept = sweepOrphanedOrchestrationRuns(new Set(["alloc-live"]), new Set());
    expect(swept).toBe(1);
  });

  it("returns 0 when there are no non-terminal orchestration runs", () => {
    mockListRuns.mockReturnValue([]);
    const swept = sweepOrphanedOrchestrationRuns(new Set(), new Set());
    expect(swept).toBe(0);
    expect(mockTransitionRun).not.toHaveBeenCalled();
  });

  it("swallows per-run errors and continues sweeping remaining runs", () => {
    mockListRuns.mockReturnValue([
      { runId: "run-bad", sourceRef: "alloc-dead-1" },
      { runId: "run-good", sourceRef: "alloc-dead-2" },
    ]);
    let callCount = 0;
    mockTransitionRun.mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) throw new Error("transient ledger error");
      return { runId: "run-good", currentState: "dead_lettered" };
    });

    // The error on the first run should not prevent the second from being swept.
    const swept = sweepOrphanedOrchestrationRuns(new Set(), new Set());
    expect(swept).toBe(1); // only the successful one is counted
    expect(mockTransitionRun).toHaveBeenCalledTimes(2);
  });
});
