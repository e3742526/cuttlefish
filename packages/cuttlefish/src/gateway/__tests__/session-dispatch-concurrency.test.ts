import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

let releaseGate: (() => void) | undefined;
let gate: Promise<void>;

vi.mock("../run-web-session.js", () => ({
  runWebSession: vi.fn(async () => {
    await gate;
  }),
}));

let tmpHome: string;
const testHome = withTempCuttlefishHome("cuttlefish-session-dispatch-concurrency-");

beforeEach(() => {
  tmpHome = testHome.home();
  vi.resetModules();
  gate = new Promise((resolve) => { releaseGate = resolve; });
});

afterEach(() => {
  vi.clearAllMocks();
});

async function setup() {
  const dispatch = await import("../api/session-dispatch.js");
  const reg = await import("../../sessions/registry.js");
  const { SessionQueue } = await import("../../sessions/queue.js");
  const { Semaphore } = await import("../../shared/async-lock.js");
  reg.initDb();
  return { dispatch, reg, SessionQueue, Semaphore };
}

function makeSession(reg: Awaited<ReturnType<typeof setup>>["reg"], ref: string) {
  return reg.createSession({
    engine: "claude",
    source: "web",
    sourceRef: ref,
    sessionKey: ref,
    prompt: "do work",
  });
}

describe("dispatchWebSessionRun concurrency cap (Ledger-0007 Finding 2)", () => {
  it("never lets more than the configured limit run at once", async () => {
    const { dispatch, reg, SessionQueue, Semaphore } = await setup();
    const runSemaphore = new Semaphore(2);
    const queue = new SessionQueue();
    const ctx = {
      getConfig: () => ({ gateway: {}, engines: { default: "claude" }, sessions: { maxConcurrentRuns: 2 } }),
      connectors: new Map(),
      startTime: Date.now(),
      emit: vi.fn(),
      sessionManager: { getEngine: () => ({} as any), getQueue: () => queue },
      runSemaphore,
    } as any;

    const sessions = [1, 2, 3, 4].map((n) => makeSession(reg, `web:conc-${n}`));
    const runs = sessions.map((s) => dispatch.dispatchWebSessionRun(s, "go", {} as any, ctx.getConfig(), ctx));

    // Give every dispatch a chance to reach (and block on) the mocked runWebSession.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runSemaphore.inFlightCount).toBe(2);

    releaseGate!();
    await Promise.all(runs);
    expect(runSemaphore.inFlightCount).toBe(0);
  });

  it("is a no-op (unbounded) when no runSemaphore is configured on the context", async () => {
    const { dispatch, reg, SessionQueue } = await setup();
    const queue = new SessionQueue();
    const ctx = {
      getConfig: () => ({ gateway: {}, engines: { default: "claude" }, sessions: {} }),
      connectors: new Map(),
      startTime: Date.now(),
      emit: vi.fn(),
      sessionManager: { getEngine: () => ({} as any), getQueue: () => queue },
    } as any;

    const session = makeSession(reg, "web:no-semaphore");
    releaseGate!();
    await expect(dispatch.dispatchWebSessionRun(session, "go", {} as any, ctx.getConfig(), ctx)).resolves.toBeUndefined();
  });
});
