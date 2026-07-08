import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CuttlefishConfig, Employee, Engine } from "../../shared/types.js";

vi.mock("../../shared/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
const { logger: mockLogger } = await import("../../shared/logger.js");

interface FakeSession {
  id: string;
  status: "idle" | "running" | "error" | "waiting" | "interrupted";
  transportMeta: Record<string, unknown> | null;
  employee?: string | null;
  parentSessionId?: string | null;
  source: string;
  connector?: string | null;
  title?: string | null;
  lastError?: string | null;
  [key: string]: unknown;
}

const hoisted = vi.hoisted(() => {
  const sessionsById = new Map<string, FakeSession>();
  const messagesById = new Map<string, Array<{ role: string; content: string; partial?: boolean }>>();
  let nextId = 1;

  /** Queue of scripted outcomes for each dispatchWebSessionRun call, consumed in call order. */
  type ScriptEntry = { status: "idle" | "error" | "interrupted"; assistantText?: string };
  const script: ScriptEntry[] = [];
  const dispatchCalls: FakeSession[] = [];

  const dispatchWebSessionRunMock = vi.fn(async (session: FakeSession) => {
    dispatchCalls.push(session);
    const entry = script.shift();
    if (!entry) throw new Error(`unscripted dispatchWebSessionRun call for session ${session.id}`);
    const current = sessionsById.get(session.id)!;
    sessionsById.set(session.id, { ...current, status: entry.status });
    if (entry.assistantText !== undefined) {
      const msgs = messagesById.get(session.id) ?? [];
      msgs.push({ role: "assistant", content: entry.assistantText });
      messagesById.set(session.id, msgs);
    }
  });

  const createSessionMock = vi.fn((opts: Record<string, unknown>) => {
    const id = `child-${nextId++}`;
    const session: FakeSession = {
      id,
      status: "idle",
      transportMeta: (opts.transportMeta as Record<string, unknown>) ?? null,
      employee: (opts.employee as string | undefined) ?? null,
      parentSessionId: (opts.parentSessionId as string | undefined) ?? null,
      source: opts.source as string,
      connector: opts.connector as string | undefined,
      title: opts.title as string | undefined,
      lastError: null,
      ...opts,
    };
    sessionsById.set(id, session);
    messagesById.set(id, []);
    return session;
  });

  const getSessionMock = vi.fn((id: string) => sessionsById.get(id));

  const updateSessionMock = vi.fn((id: string, updates: Record<string, unknown>) => {
    const current = sessionsById.get(id);
    if (!current) return undefined;
    const updated = { ...current, ...updates };
    sessionsById.set(id, updated);
    return updated;
  });

  const insertMessageMock = vi.fn((id: string, role: string, content: string) => {
    const msgs = messagesById.get(id) ?? [];
    msgs.push({ role, content });
    messagesById.set(id, msgs);
  });

  const getMessagesMock = vi.fn((id: string) => messagesById.get(id) ?? []);

  /** Defaults to a fixed summary_only context (hermetic — no git call); tests
   *  that care about mode transitions across passes override with
   *  mockImplementationOnce/mockReturnValueOnce. */
  interface FakeReviewContext {
    mode: "diff" | "summary_only";
    diffText?: string;
    changedFiles: number;
    reason?: string;
  }
  const buildReviewContextMock = vi.fn(
    (): FakeReviewContext => ({ mode: "summary_only", changedFiles: 0, reason: "test: no diff" }),
  );

  return {
    sessionsById, messagesById, script, dispatchCalls,
    dispatchWebSessionRunMock, createSessionMock, getSessionMock, updateSessionMock, insertMessageMock, getMessagesMock,
    buildReviewContextMock,
    reset: () => {
      sessionsById.clear();
      messagesById.clear();
      script.length = 0;
      dispatchCalls.length = 0;
      nextId = 1;
      buildReviewContextMock.mockReset();
      buildReviewContextMock.mockImplementation(() => ({ mode: "summary_only" as const, changedFiles: 0, reason: "test: no diff" }));
    },
    seedTopSession: (overrides: Partial<FakeSession> = {}): FakeSession => {
      const id = `top-${nextId++}`;
      const session: FakeSession = {
        id,
        status: "idle",
        transportMeta: null,
        employee: "backend-dev",
        parentSessionId: null,
        source: "web",
        connector: "web",
        title: "Top-level task",
        lastError: null,
        ...overrides,
      };
      sessionsById.set(id, session);
      messagesById.set(id, []);
      return session;
    },
  };
});

const orgHoisted = vi.hoisted(() => {
  const orgEmployees = new Map<string, Record<string, unknown>>();
  return { orgEmployees };
});
vi.mock("../org.js", () => ({ scanOrg: () => orgHoisted.orgEmployees }));

vi.mock("../api/session-dispatch.js", () => ({ dispatchWebSessionRun: hoisted.dispatchWebSessionRunMock }));
vi.mock("../../sessions/registry.js", () => ({
  createSession: hoisted.createSessionMock,
  getSession: hoisted.getSessionMock,
  updateSession: hoisted.updateSessionMock,
  insertMessage: hoisted.insertMessageMock,
  getMessages: hoisted.getMessagesMock,
}));
// Keep the loop hermetic: never shell out to git for diff context. Fake sessions
// also have no cwd, so buildReviewContext would short-circuit anyway.
vi.mock("../review-context.js", () => ({
  buildReviewContext: hoisted.buildReviewContextMock,
}));

const { dispatchEmployeeSessionRun } = await import("../mid-pair-orchestrator.js");

function baseConfig(overrides: Partial<CuttlefishConfig> = {}): CuttlefishConfig {
  return {
    gateway: { port: 8888, host: "127.0.0.1" },
    engines: { default: "claude", claude: { bin: "claude", model: "sonnet" }, codex: { bin: "codex", model: "gpt-5.5" } },
    connectors: {},
    logging: { file: true, stdout: true, level: "info" },
    features: { multiRoleEmployeeExecution: true },
    ...overrides,
  } as CuttlefishConfig;
}

function midPairEmployee(overrides: Partial<Employee> = {}): Employee {
  return {
    name: "backend-dev",
    displayName: "Backend Dev",
    department: "engineering",
    rank: "employee",
    engine: "claude",
    model: "sonnet",
    persona: "implement services",
    execution: { tier: "mid_pair" },
    ...overrides,
  };
}

function fakeEngine(): Engine {
  return { name: "claude" } as Engine;
}

function makeContext(emitted: Array<{ event: string; payload: unknown }>, engines: Record<string, Engine | undefined> = { claude: fakeEngine(), codex: fakeEngine() }) {
  return {
    getConfig: () => baseConfig(),
    emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
    sessionManager: {
      getEngine: (name: string) => engines[name],
    },
  } as unknown as import("../api/context.js").ApiContext;
}

const approvedVerdict = JSON.stringify({ verdict: "approved", summary: "ok", requiredChanges: [], riskAreas: [], confidence: "high" });
const changesRequestedVerdict = JSON.stringify({ verdict: "changes_requested", summary: "needs work", requiredChanges: ["fix x"], riskAreas: [], confidence: "medium" });
const blockedVerdict = JSON.stringify({ verdict: "blocked", summary: "do not ship", requiredChanges: [], riskAreas: ["security"], confidence: "high" });
const needsHumanVerdict = JSON.stringify({ verdict: "needs_human_review", summary: "unsure", requiredChanges: [], riskAreas: [], confidence: "low" });

beforeEach(() => {
  hoisted.reset();
  orgHoisted.orgEmployees.clear();
  hoisted.dispatchWebSessionRunMock.mockClear();
  hoisted.createSessionMock.mockClear();
  (mockLogger.warn as ReturnType<typeof vi.fn>).mockClear();
});

describe("dispatchEmployeeSessionRun — solo passthrough", () => {
  it("calls dispatchWebSessionRun directly and spawns nothing when the employee is solo", async () => {
    const top = hoisted.seedTopSession();
    hoisted.script.push({ status: "idle", assistantText: "done" });
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const context = makeContext(emitted);

    await dispatchEmployeeSessionRun(top as any, "do the task", fakeEngine(), baseConfig(), context, midPairEmployee({ execution: { tier: "solo" } }));

    expect(hoisted.dispatchWebSessionRunMock).toHaveBeenCalledTimes(1);
    expect(hoisted.createSessionMock).not.toHaveBeenCalled();
    expect(hoisted.sessionsById.get(top.id)?.transportMeta).toBeNull(); // never tagged
  });

  it("passes through when the feature flag is off even for a mid_pair employee", async () => {
    const top = hoisted.seedTopSession();
    hoisted.script.push({ status: "idle", assistantText: "done" });
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const context = { ...makeContext(emitted), getConfig: () => baseConfig({ features: { multiRoleEmployeeExecution: false } }) } as any;

    await dispatchEmployeeSessionRun(top as any, "do the task", fakeEngine(), baseConfig({ features: { multiRoleEmployeeExecution: false } }), context, midPairEmployee());

    expect(hoisted.dispatchWebSessionRunMock).toHaveBeenCalledTimes(1);
    expect(hoisted.createSessionMock).not.toHaveBeenCalled();
  });
});

describe("dispatchEmployeeSessionRun — implementer turn fails", () => {
  it("marks executionPhase failed and never spawns a reviewer", async () => {
    const top = hoisted.seedTopSession();
    hoisted.script.push({ status: "error" });
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const context = makeContext(emitted);

    await dispatchEmployeeSessionRun(top as any, "do the task", fakeEngine(), baseConfig(), context, midPairEmployee());

    expect(hoisted.createSessionMock).not.toHaveBeenCalled(); // no reviewer spawned
    const final = hoisted.sessionsById.get(top.id)!;
    expect((final.transportMeta as any).executionPhase).toBe("failed");
    expect(emitted.some((e) => e.event === "session:completed" && (e.payload as any).error)).toBe(true);
  });
});

describe("dispatchEmployeeSessionRun — never rejects, even on an internal exception", () => {
  it("marks the session errored and resolves instead of rejecting when something inside the review loop throws", async () => {
    const top = hoisted.seedTopSession();
    // Deliberately leave hoisted.script empty — the mocked dispatchWebSessionRun
    // throws "unscripted dispatchWebSessionRun call ..." on the first call,
    // simulating an exception occurring after the implementer-turn boundary
    // that dispatchWebSessionRun's own swallow-all catch cannot cover.
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const context = makeContext(emitted);

    await expect(
      dispatchEmployeeSessionRun(top as any, "do the task", fakeEngine(), baseConfig(), context, midPairEmployee()),
    ).resolves.toBeUndefined();

    const final = hoisted.sessionsById.get(top.id)!;
    expect(final.status).toBe("error");
    expect(final.lastError).toMatch(/unscripted dispatchWebSessionRun call/);
    expect(emitted.some((e) => e.event === "session:completed" && (e.payload as any).error)).toBe(true);
  });
});

describe("dispatchEmployeeSessionRun — redispatch onto a session carrying a prior run's stale state", () => {
  it("does not inherit a prior run's degraded/fallback/review-context flags into a clean new run", async () => {
    // Simulates board-ticket recovery redispatching onto the same session id
    // after a PRIOR mid_pair run left degraded/fallback state behind.
    const top = hoisted.seedTopSession({
      transportMeta: {
        employeeRunId: "prior-run",
        executionTier: "mid_pair",
        executionPhase: "degraded",
        executionDegraded: true,
        executionDegradedReason: "reviewer output could not be parsed after one repair retry — stale from a previous run",
        executionFallbackActive: true,
        executionReviewContext: "summary_only",
        executionReviewContextReason: "no changes detected in workspace",
      },
    });
    hoisted.script.push({ status: "idle", assistantText: "v1" }); // implementer
    hoisted.script.push({ status: "idle", assistantText: approvedVerdict }); // reviewer approves cleanly, no fallback
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const context = makeContext(emitted);

    await dispatchEmployeeSessionRun(top as any, "task", fakeEngine(), baseConfig(), context, midPairEmployee());

    const final = hoisted.sessionsById.get(top.id)!;
    expect((final.transportMeta as any).executionPhase).toBe("done");
    expect((final.transportMeta as any).executionDegraded).not.toBe(true);
    expect((final.transportMeta as any).executionDegradedReason).toBeFalsy(); // reset to null (JSON.stringify drops it on real persist)
    expect((final.transportMeta as any).executionFallbackActive).not.toBe(true);
    // This run's own (mocked) review-context reason, not the prior run's stale one.
    expect((final.transportMeta as any).executionReviewContextReason).not.toBe("no changes detected in workspace");
    expect((final.transportMeta as any).executionReviewContextReason).toBe("test: no diff");
  });
});

describe("dispatchEmployeeSessionRun — review loop", () => {
  it("approves on the first pass: one reviewer child session, phase done, board re-sync with no error", async () => {
    const top = hoisted.seedTopSession();
    hoisted.script.push({ status: "idle", assistantText: "implemented the feature" }); // implementer
    hoisted.script.push({ status: "idle", assistantText: approvedVerdict }); // reviewer
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const context = makeContext(emitted);

    await dispatchEmployeeSessionRun(top as any, "add healthz endpoint", fakeEngine(), baseConfig(), context, midPairEmployee());

    expect(hoisted.createSessionMock).toHaveBeenCalledTimes(1); // exactly one reviewer
    const reviewerOpts = hoisted.createSessionMock.mock.calls[0][0];
    expect(reviewerOpts.employee).toBeUndefined(); // role sessions are never org members
    expect(reviewerOpts.parentSessionId).toBe(top.id);
    expect((reviewerOpts.transportMeta as any).internalRole).toBe("reviewer");
    expect((reviewerOpts.transportMeta as any).executionDepth).toBe(1);

    const final = hoisted.sessionsById.get(top.id)!;
    expect((final.transportMeta as any).executionPhase).toBe("done");
    expect((final.transportMeta as any).executionChildCount).toBe(1);

    const completed = emitted.filter((e) => e.event === "session:completed");
    expect(completed.length).toBeGreaterThanOrEqual(1);
    expect(completed[completed.length - 1].payload).toMatchObject({ sessionId: top.id, error: null });
  });

  it("loops a revision pass on changes_requested, then approves — two children spawned beyond the implementer", async () => {
    const top = hoisted.seedTopSession();
    hoisted.script.push({ status: "idle", assistantText: "v1" }); // implementer
    hoisted.script.push({ status: "idle", assistantText: changesRequestedVerdict }); // reviewer pass 1
    hoisted.script.push({ status: "idle", assistantText: "v2 (revised)" }); // revision implementer
    hoisted.script.push({ status: "idle", assistantText: approvedVerdict }); // reviewer pass 2
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const context = makeContext(emitted);

    await dispatchEmployeeSessionRun(top as any, "add healthz endpoint", fakeEngine(), baseConfig(), context, midPairEmployee({ execution: { tier: "mid_pair", maxInternalPasses: 2 } }));

    expect(hoisted.createSessionMock).toHaveBeenCalledTimes(3); // reviewer, revision-implementer, reviewer
    const roles = hoisted.createSessionMock.mock.calls.map((c) => (c[0].transportMeta as any).internalRole);
    expect(roles).toEqual(["reviewer", "implementer", "reviewer"]);

    const final = hoisted.sessionsById.get(top.id)!;
    expect((final.transportMeta as any).executionPhase).toBe("done");
    expect((final.transportMeta as any).executionPass).toBe(2);
    expect((final.transportMeta as any).executionChildCount).toBe(3);
  });

  it("propagates the parent's cwd to every spawned role session (reviewer AND revision-implementer)", async () => {
    const top = hoisted.seedTopSession({ cwd: "/workspace/my-project" });
    hoisted.script.push({ status: "idle", assistantText: "v1" }); // implementer
    hoisted.script.push({ status: "idle", assistantText: changesRequestedVerdict }); // reviewer pass 1
    hoisted.script.push({ status: "idle", assistantText: "v2 (revised)" }); // revision implementer
    hoisted.script.push({ status: "idle", assistantText: approvedVerdict }); // reviewer pass 2
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const context = makeContext(emitted);

    await dispatchEmployeeSessionRun(top as any, "add healthz endpoint", fakeEngine(), baseConfig(), context, midPairEmployee({ execution: { tier: "mid_pair", maxInternalPasses: 2 } }));

    expect(hoisted.createSessionMock).toHaveBeenCalledTimes(3);
    for (const call of hoisted.createSessionMock.mock.calls) {
      expect(call[0].cwd).toBe("/workspace/my-project"); // every child (reviewer + revision-implementer) inherits it
    }
  });

  it("clears a stale reviewContextReason once mode moves from summary_only to diff on a later pass", async () => {
    // Pass 1 has no diff (e.g. a purely exploratory implementer turn); pass 2
    // (after revision) has real changes. The final reviewContextReason must not
    // be left over from pass 1's summary_only reason.
    hoisted.buildReviewContextMock.mockReturnValueOnce({ mode: "summary_only", changedFiles: 0, reason: "no changes detected in workspace" });
    hoisted.buildReviewContextMock.mockReturnValueOnce({ mode: "diff", diffText: "diff --git a/x b/x\n+y", changedFiles: 1 });

    const top = hoisted.seedTopSession();
    hoisted.script.push({ status: "idle", assistantText: "v1" }); // implementer
    hoisted.script.push({ status: "idle", assistantText: changesRequestedVerdict }); // reviewer pass 1 (summary_only)
    hoisted.script.push({ status: "idle", assistantText: "v2 (revised)" }); // revision implementer
    hoisted.script.push({ status: "idle", assistantText: approvedVerdict }); // reviewer pass 2 (diff)
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const context = makeContext(emitted);

    await dispatchEmployeeSessionRun(top as any, "task", fakeEngine(), baseConfig(), context, midPairEmployee({ execution: { tier: "mid_pair", maxInternalPasses: 2 } }));

    const final = hoisted.sessionsById.get(top.id)!;
    expect((final.transportMeta as any).executionPhase).toBe("done");
    expect((final.transportMeta as any).executionReviewContext).toBe("diff");
    expect((final.transportMeta as any).executionReviewContextReason).toBeUndefined(); // not the stale pass-1 reason
  });

  it("degrades when changes_requested but maxInternalPasses is exhausted (default 1) — no revision spawned", async () => {
    const top = hoisted.seedTopSession();
    hoisted.script.push({ status: "idle", assistantText: "v1" });
    hoisted.script.push({ status: "idle", assistantText: changesRequestedVerdict });
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const context = makeContext(emitted);

    await dispatchEmployeeSessionRun(top as any, "task", fakeEngine(), baseConfig(), context, midPairEmployee()); // default maxInternalPasses=1

    expect(hoisted.createSessionMock).toHaveBeenCalledTimes(1); // reviewer only, no revision
    const final = hoisted.sessionsById.get(top.id)!;
    expect((final.transportMeta as any).executionPhase).toBe("degraded");
    expect((final.transportMeta as any).executionDegraded).toBe(true);
    expect((final.transportMeta as any).executionDegradedReason).toMatch(/max internal passes exhausted/);
  });

  it("blocks on a 'blocked' verdict: phase failed, lastError set, board re-sync carries an error", async () => {
    const top = hoisted.seedTopSession();
    hoisted.script.push({ status: "idle", assistantText: "v1" });
    hoisted.script.push({ status: "idle", assistantText: blockedVerdict });
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const context = makeContext(emitted);

    await dispatchEmployeeSessionRun(top as any, "task", fakeEngine(), baseConfig(), context, midPairEmployee());

    const final = hoisted.sessionsById.get(top.id)!;
    expect((final.transportMeta as any).executionPhase).toBe("failed");
    expect(final.lastError).toMatch(/Review blocked/);
    const completed = emitted.filter((e) => e.event === "session:completed");
    expect(completed[completed.length - 1].payload).toMatchObject({ sessionId: top.id });
    expect((completed[completed.length - 1].payload as any).error).toBeTruthy();
  });

  it("treats 'needs_human_review' as a failed/degraded terminal phase, not a silent success", async () => {
    const top = hoisted.seedTopSession();
    hoisted.script.push({ status: "idle", assistantText: "v1" });
    hoisted.script.push({ status: "idle", assistantText: needsHumanVerdict });
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const context = makeContext(emitted);

    await dispatchEmployeeSessionRun(top as any, "task", fakeEngine(), baseConfig(), context, midPairEmployee());

    const final = hoisted.sessionsById.get(top.id)!;
    expect((final.transportMeta as any).executionPhase).toBe("failed");
    expect((final.transportMeta as any).executionDegraded).toBe(true);
  });

  it("caps revision loops at maxChildSessions, degrading before spawning past the budget", async () => {
    const top = hoisted.seedTopSession();
    hoisted.script.push({ status: "idle", assistantText: "v1" }); // implementer
    hoisted.script.push({ status: "idle", assistantText: changesRequestedVerdict }); // reviewer pass 1 (childCount -> 1)
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const context = makeContext(emitted);

    await dispatchEmployeeSessionRun(top as any, "task", fakeEngine(), baseConfig(), context, midPairEmployee({ execution: { tier: "mid_pair", maxInternalPasses: 5, maxChildSessions: 1 } }));

    expect(hoisted.createSessionMock).toHaveBeenCalledTimes(1); // only the reviewer; no revision spawned
    const final = hoisted.sessionsById.get(top.id)!;
    expect((final.transportMeta as any).executionPhase).toBe("degraded");
    expect((final.transportMeta as any).executionDegradedReason).toMatch(/child-session budget/);
  });

  it("respects the wall-clock budget across passes", async () => {
    const top = hoisted.seedTopSession();
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow);
    try {
      const applyOutcome = (session: FakeSession, text: string) => {
        const current = hoisted.sessionsById.get(session.id)!;
        hoisted.sessionsById.set(session.id, { ...current, status: "idle" });
        hoisted.messagesById.set(session.id, [{ role: "assistant", content: text }]);
      };
      // Call order: implementer -> reviewer pass 1 (changes_requested) -> revision pass 1.
      // Advance the clock as a side effect of the revision call, which lands AFTER
      // runReviewLoop's deadline is computed and BEFORE pass 2's loop-top check —
      // so pass 2 must never spawn a second reviewer.
      hoisted.dispatchWebSessionRunMock
        .mockImplementationOnce(async (session: FakeSession) => applyOutcome(session, "v1"))
        .mockImplementationOnce(async (session: FakeSession) => applyOutcome(session, changesRequestedVerdict))
        .mockImplementationOnce(async (session: FakeSession) => {
          applyOutcome(session, "v2 (revised)");
          nowSpy.mockImplementation(() => realNow + 10_000);
        });
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = makeContext(emitted);

      await dispatchEmployeeSessionRun(
        top as any, "task", fakeEngine(), baseConfig(), context,
        midPairEmployee({ execution: { tier: "mid_pair", maxInternalPasses: 5, maxWallClockMs: 1000 } }),
      );

      expect(hoisted.createSessionMock).toHaveBeenCalledTimes(2); // reviewer pass 1 + revision pass 1 — pass 2 never starts
      const final = hoisted.sessionsById.get(top.id)!;
      expect((final.transportMeta as any).executionPhase).toBe("degraded");
      expect((final.transportMeta as any).executionDegradedReason).toMatch(/wall-clock/);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("dispatchEmployeeSessionRun — reviewer verdict repair", () => {
  it("repairs an unparseable verdict with one in-place retry, then approves", async () => {
    const top = hoisted.seedTopSession();
    hoisted.script.push({ status: "idle", assistantText: "implemented the feature" }); // implementer
    hoisted.script.push({ status: "idle", assistantText: "sure, here's my review: looks good!" }); // reviewer: prose, not JSON
    hoisted.script.push({ status: "idle", assistantText: approvedVerdict }); // repair on the same session: valid JSON
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const context = makeContext(emitted);

    await dispatchEmployeeSessionRun(top as any, "task", fakeEngine(), baseConfig(), context, midPairEmployee());

    expect(hoisted.createSessionMock).toHaveBeenCalledTimes(1); // one reviewer session; the repair reuses it
    const reviewerId = hoisted.createSessionMock.mock.results[0].value.id;
    const reviewerDispatches = hoisted.dispatchCalls.filter((s) => s.id === reviewerId);
    expect(reviewerDispatches.length).toBe(2); // initial attempt + one repair, same session

    const final = hoisted.sessionsById.get(top.id)!;
    expect((final.transportMeta as any).executionPhase).toBe("done");
    expect((final.transportMeta as any).executionChildCount).toBe(1); // repair did not spawn a new child
    expect((final.transportMeta as any).executionReviewContext).toBe("summary_only"); // review-context wiring is recorded
  });

  it("degrades with an 'unparseable' reason when the repair retry also fails", async () => {
    const top = hoisted.seedTopSession();
    hoisted.script.push({ status: "idle", assistantText: "implemented" }); // implementer
    hoisted.script.push({ status: "idle", assistantText: "not json" }); // reviewer: bad
    hoisted.script.push({ status: "idle", assistantText: "still not json" }); // repair: still bad
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const context = makeContext(emitted);

    // default reviewerLossPolicy replace_then_degrade, no fallback chain -> degrade
    await dispatchEmployeeSessionRun(top as any, "task", fakeEngine(), baseConfig(), context, midPairEmployee());

    expect(hoisted.createSessionMock).toHaveBeenCalledTimes(1); // one reviewer, repaired in place, then given up
    const final = hoisted.sessionsById.get(top.id)!;
    expect((final.transportMeta as any).executionPhase).toBe("degraded");
    expect((final.transportMeta as any).executionDegraded).toBe(true);
    expect((final.transportMeta as any).executionDegradedReason).toMatch(/could not be parsed after one repair retry/i);
  });
});

describe("dispatchEmployeeSessionRun — loss-cause labeling reflects the LAST attempt, not just the primary", () => {
  it("labels the reason as a parse failure when the primary was unavailable but the fallback was unparseable", async () => {
    const top = hoisted.seedTopSession();
    hoisted.script.push({ status: "idle", assistantText: "v1" }); // implementer
    hoisted.script.push({ status: "idle", assistantText: "garbage" }); // fallback reviewer: not JSON
    hoisted.script.push({ status: "idle", assistantText: "still garbage" }); // fallback repair: still not JSON
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const context = makeContext(emitted, { claude: undefined, codex: fakeEngine() }); // primary (claude) missing

    await dispatchEmployeeSessionRun(
      top as any, "task", fakeEngine(), baseConfig(), context,
      midPairEmployee({
        execution: {
          tier: "mid_pair",
          reviewerLossPolicy: "replace_then_degrade",
          roles: { reviewer: { fallbackChain: [{ engine: "codex", model: "gpt-5.5" }] } },
        },
      }),
    );

    expect(hoisted.createSessionMock).toHaveBeenCalledTimes(1); // primary engine missing -> only the fallback spawned
    const final = hoisted.sessionsById.get(top.id)!;
    expect((final.transportMeta as any).executionPhase).toBe("degraded");
    // Cause reflects the FALLBACK's failure (unparseable), not the primary's (unavailable).
    expect((final.transportMeta as any).executionDegradedReason).toMatch(/could not be parsed after one repair retry/i);
    // F5: the specific validation error is preserved in the fallback failure log, not just a generic message.
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringMatching(/did not produce a verdict.*reviewer response was not valid JSON/));
  });

  it("does not mislabel the reason as a parse failure when the primary was unparseable but the fallback's session errors", async () => {
    const top = hoisted.seedTopSession();
    hoisted.script.push({ status: "idle", assistantText: "v1" }); // implementer
    hoisted.script.push({ status: "idle", assistantText: "garbage" }); // primary reviewer: not JSON
    hoisted.script.push({ status: "idle", assistantText: "still garbage" }); // primary repair: still not JSON
    hoisted.script.push({ status: "error" }); // fallback reviewer: engine registered, but its session errors
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const context = makeContext(emitted, { claude: fakeEngine(), codex: fakeEngine() }); // both engines available

    await dispatchEmployeeSessionRun(
      top as any, "task", fakeEngine(), baseConfig(), context,
      midPairEmployee({
        execution: {
          tier: "mid_pair",
          reviewerLossPolicy: "replace_then_degrade",
          roles: { reviewer: { fallbackChain: [{ engine: "codex", model: "gpt-5.5" }] } },
        },
      }),
    );

    expect(hoisted.createSessionMock).toHaveBeenCalledTimes(2); // primary + fallback both spawned
    const final = hoisted.sessionsById.get(top.id)!;
    expect((final.transportMeta as any).executionPhase).toBe("degraded");
    // The LAST attempt (the fallback's session error) determines the cause, not the
    // primary's earlier parse failure — must not falsely claim "could not be parsed".
    expect((final.transportMeta as any).executionDegradedReason).not.toMatch(/could not be parsed/i);
    expect((final.transportMeta as any).executionDegradedReason).toMatch(/degrading to solo/i);
  });
});

describe("dispatchEmployeeSessionRun — reviewer loss policy", () => {
  it("blocks when the reviewer engine is unavailable and the policy is 'block'", async () => {
    const top = hoisted.seedTopSession();
    hoisted.script.push({ status: "idle", assistantText: "v1" });
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const context = makeContext(emitted, { claude: undefined, codex: fakeEngine() }); // reviewer engine missing

    await dispatchEmployeeSessionRun(
      top as any, "task", fakeEngine(), baseConfig(), context,
      midPairEmployee({ execution: { tier: "mid_pair", reviewerLossPolicy: "block" } }),
    );

    expect(hoisted.createSessionMock).not.toHaveBeenCalled(); // engine check fails before spawning
    const final = hoisted.sessionsById.get(top.id)!;
    expect((final.transportMeta as any).executionPhase).toBe("failed");
    expect(final.lastError).toMatch(/Reviewer unavailable/);
  });

  it("degrades to the implementer's output when the reviewer is unavailable and the policy is 'degrade'", async () => {
    const top = hoisted.seedTopSession();
    hoisted.script.push({ status: "idle", assistantText: "v1" });
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const context = makeContext(emitted, { claude: undefined, codex: fakeEngine() });

    await dispatchEmployeeSessionRun(
      top as any, "task", fakeEngine(), baseConfig(), context,
      midPairEmployee({ execution: { tier: "mid_pair", reviewerLossPolicy: "degrade" } }),
    );

    const final = hoisted.sessionsById.get(top.id)!;
    expect((final.transportMeta as any).executionPhase).toBe("degraded");
    expect((final.transportMeta as any).executionDegraded).toBe(true);
  });

  it("replaces with the configured fallback engine when the primary reviewer is unavailable", async () => {
    const top = hoisted.seedTopSession();
    hoisted.script.push({ status: "idle", assistantText: "v1" }); // implementer
    hoisted.script.push({ status: "idle", assistantText: approvedVerdict }); // fallback reviewer succeeds
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const context = makeContext(emitted, { claude: undefined, codex: fakeEngine() }); // primary (claude) missing, fallback (codex) present

    await dispatchEmployeeSessionRun(
      top as any, "task", fakeEngine(), baseConfig(), context,
      midPairEmployee({
        execution: {
          tier: "mid_pair",
          reviewerLossPolicy: "replace_then_degrade",
          roles: { reviewer: { fallbackChain: [{ engine: "codex", model: "gpt-5.5" }] } },
        },
      }),
    );

    expect(hoisted.createSessionMock).toHaveBeenCalledTimes(1); // only the fallback reviewer spawned (primary engine never resolved)
    expect(hoisted.createSessionMock.mock.calls[0][0].engine).toBe("codex");
    const final = hoisted.sessionsById.get(top.id)!;
    expect((final.transportMeta as any).executionPhase).toBe("done");
    expect((final.transportMeta as any).executionFallbackActive).toBe(true); // fallback reviewer is observable
  });

  it("falls through to a final block/degrade resolution when the fallback also fails", async () => {
    const top = hoisted.seedTopSession();
    hoisted.script.push({ status: "idle", assistantText: "v1" }); // implementer
    hoisted.script.push({ status: "error" }); // fallback reviewer also errors
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const context = makeContext(emitted, { claude: undefined, codex: fakeEngine() });

    await dispatchEmployeeSessionRun(
      top as any, "task", fakeEngine(), baseConfig(), context,
      midPairEmployee({
        execution: {
          tier: "mid_pair",
          reviewerLossPolicy: "replace_then_degrade",
          roles: { reviewer: { fallbackChain: [{ engine: "codex", model: "gpt-5.5" }] } },
        },
      }),
    );

    const final = hoisted.sessionsById.get(top.id)!;
    expect((final.transportMeta as any).executionPhase).toBe("degraded"); // replace_then_degrade with no further fallback -> degrade
  });

  it("walks the full failover chain in order until a target produces a verdict", async () => {
    const top = hoisted.seedTopSession();
    hoisted.script.push({ status: "idle", assistantText: "v1" }); // implementer
    hoisted.script.push({ status: "error" }); // first fallback (codex) errors
    hoisted.script.push({ status: "idle", assistantText: approvedVerdict }); // second fallback (gemini) approves
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const context = makeContext(emitted, { claude: undefined, codex: fakeEngine(), gemini: fakeEngine() });

    await dispatchEmployeeSessionRun(
      top as any, "task", fakeEngine(), baseConfig(), context,
      midPairEmployee({
        execution: {
          tier: "mid_pair",
          reviewerLossPolicy: "replace_then_degrade",
          maxChildSessions: 5,
          roles: { reviewer: { fallbackChain: [
            { engine: "codex", model: "gpt-5.5" },
            { engine: "gemini", model: "gemini-pro" },
          ] } },
        },
      }),
    );

    const engines = hoisted.createSessionMock.mock.calls.map((c) => c[0].engine);
    expect(engines).toEqual(["codex", "gemini"]); // primary (claude) never spawned — engine missing
    const final = hoisted.sessionsById.get(top.id)!;
    expect((final.transportMeta as any).executionPhase).toBe("done");
    expect((final.transportMeta as any).executionChildCount).toBe(2);
  });

  it("resolves an external-agent (employee) failover target from the org", async () => {
    orgHoisted.orgEmployees.set("sec-reviewer", {
      name: "sec-reviewer", engine: "codex", model: "gpt-5.4", effortLevel: "medium",
    });
    const top = hoisted.seedTopSession();
    hoisted.script.push({ status: "idle", assistantText: "v1" }); // implementer
    hoisted.script.push({ status: "idle", assistantText: approvedVerdict }); // external reviewer approves
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const context = makeContext(emitted, { claude: undefined, codex: fakeEngine() });

    await dispatchEmployeeSessionRun(
      top as any, "task", fakeEngine(), baseConfig(), context,
      midPairEmployee({
        execution: {
          tier: "mid_pair",
          reviewerLossPolicy: "replace_then_degrade",
          roles: { reviewer: { fallbackChain: [{ employee: "sec-reviewer" }] } },
        },
      }),
    );

    expect(hoisted.createSessionMock).toHaveBeenCalledTimes(1);
    const opts = hoisted.createSessionMock.mock.calls[0][0];
    expect(opts.engine).toBe("codex");
    expect(opts.model).toBe("gpt-5.4");
    expect(opts.effortLevel).toBe("medium");
    expect(opts.employee).toBeUndefined(); // still a runtime-only role session, not an org member
    const final = hoisted.sessionsById.get(top.id)!;
    expect((final.transportMeta as any).executionPhase).toBe("done");
  });

  it("stops walking the chain when the child-session budget is exhausted, then degrades", async () => {
    const top = hoisted.seedTopSession();
    hoisted.script.push({ status: "idle", assistantText: "v1" }); // implementer
    hoisted.script.push({ status: "error" }); // primary reviewer errors (spawn 1)
    hoisted.script.push({ status: "error" }); // fallback 1 errors (spawn 2, budget now exhausted)
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const context = makeContext(emitted, { claude: fakeEngine(), codex: fakeEngine(), gemini: fakeEngine() });

    await dispatchEmployeeSessionRun(
      top as any, "task", fakeEngine(), baseConfig(), context,
      midPairEmployee({
        execution: {
          tier: "mid_pair",
          reviewerLossPolicy: "replace_then_degrade",
          maxChildSessions: 2,
          roles: { reviewer: { fallbackChain: [
            { engine: "codex", model: "gpt-5.5" },
            { engine: "gemini", model: "gemini-pro" }, // never reached: budget
          ] } },
        },
      }),
    );

    expect(hoisted.createSessionMock).toHaveBeenCalledTimes(2); // primary + one fallback, then hard stop
    const final = hoisted.sessionsById.get(top.id)!;
    expect((final.transportMeta as any).executionPhase).toBe("degraded");
  });

  it("terminates as degraded when a revision pass fails on every implementer target — no repeat review of unrevised output", async () => {
    const top = hoisted.seedTopSession();
    hoisted.script.push({ status: "idle", assistantText: "v1" }); // implementer
    hoisted.script.push({ status: "idle", assistantText: changesRequestedVerdict }); // reviewer pass 1
    hoisted.script.push({ status: "error" }); // revision attempt errors; no implementer fallback configured
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const context = makeContext(emitted);

    await dispatchEmployeeSessionRun(
      top as any, "task", fakeEngine(), baseConfig(), context,
      midPairEmployee({ execution: { tier: "mid_pair", maxInternalPasses: 3, maxChildSessions: 10 } }),
    );

    // reviewer + failed revision only — the loop must NOT spawn a second reviewer
    // to re-judge the identical unrevised output.
    const roles = hoisted.createSessionMock.mock.calls.map((c) => (c[0].transportMeta as any).internalRole);
    expect(roles).toEqual(["reviewer", "implementer"]);
    const final = hoisted.sessionsById.get(top.id)!;
    expect((final.transportMeta as any).executionPhase).toBe("degraded");
    expect((final.transportMeta as any).executionDegradedReason).toMatch(/revision pass 1 failed/);
  });

  it("uses the implementer failover chain for a revision pass when the override engine is missing", async () => {
    const top = hoisted.seedTopSession();
    hoisted.script.push({ status: "idle", assistantText: "v1" }); // implementer
    hoisted.script.push({ status: "idle", assistantText: changesRequestedVerdict }); // reviewer pass 1
    hoisted.script.push({ status: "idle", assistantText: "v2 (revised on fallback)" }); // revision on fallback engine
    hoisted.script.push({ status: "idle", assistantText: approvedVerdict }); // reviewer pass 2
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const context = makeContext(emitted, { claude: fakeEngine(), codex: fakeEngine(), grok: undefined });

    await dispatchEmployeeSessionRun(
      top as any, "task", fakeEngine(), baseConfig(), context,
      midPairEmployee({
        execution: {
          tier: "mid_pair",
          maxInternalPasses: 2,
          maxChildSessions: 5,
          roles: { implementer: {
            override: { engine: "grok", model: "grok-4" },
            fallbackChain: [{ engine: "codex", model: "gpt-5.5" }],
          } },
        },
      }),
    );

    const spawns = hoisted.createSessionMock.mock.calls.map((c) => ({
      engine: c[0].engine,
      role: (c[0].transportMeta as any).internalRole,
    }));
    expect(spawns).toEqual([
      { engine: "claude", role: "reviewer" },
      { engine: "codex", role: "implementer" }, // grok unavailable -> chain target, no wasted spawn
      { engine: "claude", role: "reviewer" },
    ]);
    const final = hoisted.sessionsById.get(top.id)!;
    expect((final.transportMeta as any).executionPhase).toBe("done");
  });
});
