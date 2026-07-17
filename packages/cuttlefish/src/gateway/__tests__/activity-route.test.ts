import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
  };
}

function makeReq(method: string, urlPath: string) {
  return Object.assign(Readable.from([]), {
    method,
    url: urlPath,
    headers: { host: "localhost" },
  }) as unknown as Parameters<typeof import("../api.js").handleApiRequest>[0];
}

const testHome = withTempCuttlefishHome("cuttlefish-activity-route-");

beforeEach(() => {
  testHome.home();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/activity", () => {
  it("includes a delegation event for child sessions", async () => {
    vi.resetModules();
    const api = await import("../api.js");
    const reg = await import("../../sessions/registry.js");
    reg.initDb();

    const parent = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:parent",
      prompt: "parent",
    });
    const child = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:child",
      employee: "content-lead",
      parentSessionId: parent.id,
      prompt: "child",
    });
    reg.updateSession(child.id, { status: "running" });

    const ctx = {
      getConfig: () => ({ gateway: {}, engines: {}, portal: {} }),
      connectors: new Map(),
      startTime: Date.now(),
      emit: vi.fn(),
      sessionManager: {
        // No engine registered: isSessionLiveRunning treats a "running" status
        // as live when the engine can't be found, preserving this test's
        // status-driven expectations.
        getEngine: () => undefined,
        getQueue: () => ({
          getTransportState: (_key: string, status: string) => status,
        }),
      },
    } as unknown as import("../api.js").ApiContext;

    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/activity"), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect(cap.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "session:delegated",
          payload: expect.objectContaining({
            sessionId: child.id,
            parentSessionId: parent.id,
            employee: "content-lead",
            engine: "claude",
          }),
        }),
        expect.objectContaining({
          event: "session:started",
          payload: expect.objectContaining({
            sessionId: child.id,
            employee: "content-lead",
          }),
        }),
      ]),
    );
  });

  it("STT-CF-003: reports session:error, not session:started, when the live engine has crashed but session.status hasn't caught up yet", async () => {
    vi.resetModules();
    const api = await import("../api.js");
    const reg = await import("../../sessions/registry.js");
    reg.initDb();

    const crashed = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:crashed",
      prompt: "crashed",
    });
    reg.updateSession(crashed.id, { status: "running" });

    const ctx = {
      getConfig: () => ({ gateway: {}, engines: {}, portal: {} }),
      connectors: new Map(),
      startTime: Date.now(),
      emit: vi.fn(),
      sessionManager: {
        getEngine: () => ({
          name: "claude",
          kill: () => {},
          isAlive: () => false,
          killAll: () => {},
          killIdle: () => {},
          isTurnRunning: () => false,
        }),
        getQueue: () => ({
          getTransportState: (_key: string, status: string) => status,
        }),
      },
    } as unknown as import("../api.js").ApiContext;

    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/activity"), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect(cap.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "session:error",
          payload: expect.objectContaining({ sessionId: crashed.id }),
        }),
      ]),
    );
    expect(cap.body).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "session:started",
          payload: expect.objectContaining({ sessionId: crashed.id }),
        }),
      ]),
    );
  });
});
