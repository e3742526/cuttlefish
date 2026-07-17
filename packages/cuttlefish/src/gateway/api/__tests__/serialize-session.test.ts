import { describe, it, expect } from "vitest";
import { serializeSession, isSessionLiveRunning } from "../serialize-session.js";
import type { Session } from "../../../shared/types.js";
import type { ApiContext } from "../context.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    engine: "claude",
    engineSessionId: null,
    source: "web",
    sourceRef: "web:1",
    connector: null,
    sessionKey: "web:1",
    replyContext: null,
    messageId: null,
    transportMeta: null,
    employee: null,
    model: null,
    title: null,
    promptExcerpt: null,
    parentSessionId: null,
    userId: null,
    status: "idle",
    effortLevel: null,
    cwd: null,
    totalCost: 0,
    totalTurns: 0,
    lastContextTokens: null,
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    lastError: null,
    ...overrides,
  };
}

function makeContext(overrides: { getEngine?: (name: string) => unknown } = {}): ApiContext {
  return {
    sessionManager: {
      getQueue: () => ({
        getPendingCount: () => 0,
        getTransportState: (_key: string, status: string) => status,
      }),
      getEngine: overrides.getEngine ?? (() => undefined),
    },
  } as unknown as ApiContext;
}

describe("serializeSession", () => {
  it("ARCN-CTF-003: does not leak an internal-only Session field that isn't part of PublicSession", () => {
    // Simulates a field added to the internal Session type without anyone
    // remembering to thread it through the public DTO mapper.
    const session = makeSession({ title: "hello" }) as Session & { internalOnlyDebugNotes: string };
    session.internalOnlyDebugNotes = "should never leave the process";

    const result = serializeSession(session, makeContext()) as Record<string, unknown>;

    expect(result.internalOnlyDebugNotes).toBeUndefined();
    expect(result.title).toBe("hello");
  });

  it("still exposes every documented PublicSession field for a normal session", () => {
    const session = makeSession({ status: "running", title: "in progress", totalCost: 1.5, totalTurns: 3 });
    const result = serializeSession(session, makeContext());

    expect(result.id).toBe(session.id);
    expect(result.engine).toBe("claude");
    expect(result.status).toBe("running");
    expect(result.title).toBe("in progress");
    expect(result.totalCost).toBe(1.5);
    expect(result.totalTurns).toBe(3);
    expect(result.attachments).toEqual([]);
    expect(result.queueDepth).toBe(0);
    expect(result.transportState).toBe("running");
  });
});

describe("isSessionLiveRunning", () => {
  it("STT-CF-003: is the single live-engine predicate serializeSession and status.ts both rely on", () => {
    // status: "running" in the DB, but the actual engine process is gone (a
    // crash before the DB row was updated to reflect it).
    const session = makeSession({ status: "running" });
    const context = makeContext({
      getEngine: () => ({
        name: "claude",
        kill: () => {},
        isAlive: () => false,
        killAll: () => {},
        killIdle: () => {},
        isTurnRunning: () => false,
      }),
    });

    expect(isSessionLiveRunning(session, context)).toBe(false);
  });

  it("trusts the DB status when the engine can't be positively checked", () => {
    const session = makeSession({ status: "running" });
    const context = makeContext({ getEngine: () => undefined });

    expect(isSessionLiveRunning(session, context)).toBe(true);
  });

  it("returns false outright when the DB status isn't 'running'", () => {
    const session = makeSession({ status: "idle" });
    const context = makeContext();

    expect(isSessionLiveRunning(session, context)).toBe(false);
  });
});
