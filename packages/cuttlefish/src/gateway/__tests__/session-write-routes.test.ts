import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";

const hoisted = vi.hoisted(() => ({
  scheduleOnLoadTailSync: vi.fn(),
  scheduleTranscriptBackfill: vi.fn(),
  loadRawTranscript: vi.fn(),
  dispatchWebSessionRun: vi.fn(async () => {}),
  dispatchEmployeeSessionRun: vi.fn(async () => {}),
  dispatchPendingWebQueueHeadForSessionKey: vi.fn(() => 0),
  killSessionEngines: vi.fn(() => ({ interruptible: 0 })),
}));

vi.mock("../external-turns.js", () => ({
  scheduleOnLoadTailSync: hoisted.scheduleOnLoadTailSync,
}));

vi.mock("../transcript-backfill.js", () => ({
  loadRawTranscript: hoisted.loadRawTranscript,
  scheduleTranscriptBackfill: hoisted.scheduleTranscriptBackfill,
}));

vi.mock("../api/session-dispatch.js", () => ({
  dispatchWebSessionRun: hoisted.dispatchWebSessionRun,
  dispatchPendingWebQueueHeadForSessionKey: hoisted.dispatchPendingWebQueueHeadForSessionKey,
  killSessionEngines: hoisted.killSessionEngines,
  maybeRevertEngineOverride: <T>(session: T) => session,
  redispatchPendingWebQueueItemsForSessionKey: vi.fn(() => 0),
}));

vi.mock("../mid-pair-orchestrator.js", () => ({
  dispatchEmployeeSessionRun: hoisted.dispatchEmployeeSessionRun,
}));

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
  return {
    method,
    url: urlPath,
    headers: { host: "localhost" },
  } as any;
}

function makeJsonReq(method: string, urlPath: string, body: unknown) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as any;
  Object.assign(req, {
    method,
    url: urlPath,
    headers: {
      host: "localhost",
      "content-type": "application/json",
    },
  });
  return req;
}

async function setup() {
  vi.resetModules();
  const api = await import("../api.js");
  const reg = await import("../../sessions/registry.js");
  reg.initDb();
  return { api, reg };
}

function makeCtx(api: Awaited<ReturnType<typeof setup>>["api"]) {
  return {
    getConfig: () => ({ gateway: {}, engines: {}, portal: {} }),
    connectors: new Map(),
    startTime: Date.now(),
    emit: vi.fn(),
    sessionManager: {
      getEngine: () => undefined,
      getQueue: () => ({
        getPendingCount: () => 0,
        getTransportState: (_key: string, status: string) => status,
        resumeQueue: vi.fn(),
        clearQueue: vi.fn(),
      }),
    },
  } as unknown as import("../api.js").ApiContext;
}

const testHome = withTempCuttlefishHome("cuttlefish-session-write-");

beforeEach(() => {
  testHome.home();
  hoisted.scheduleOnLoadTailSync.mockReset();
  hoisted.scheduleTranscriptBackfill.mockReset();
  hoisted.loadRawTranscript.mockReset();
  hoisted.dispatchWebSessionRun.mockReset();
  hoisted.dispatchEmployeeSessionRun.mockReset();
  hoisted.killSessionEngines.mockReset();
  hoisted.killSessionEngines.mockReturnValue({ interruptible: 0 });
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/sessions prompt validation (I-1)", () => {
  it("rejects a whitespace-only prompt instead of dispatching a real engine turn", async () => {
    const { api } = await setup();
    const ctx = makeCtx(api);

    const cap = makeRes();
    await api.handleApiRequest(makeJsonReq("POST", "/api/sessions", { prompt: "   " }), cap.res, ctx);

    expect(cap.status).toBe(400);
    expect(cap.body).toEqual(expect.objectContaining({ error: expect.stringContaining("prompt or message is required") }));
    expect(hoisted.dispatchWebSessionRun).not.toHaveBeenCalled();
  });

  it("fails fast with 429 (no session created) when the concurrent-run cap is already exhausted (Ledger-0007 Finding 2)", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);
    ctx.getConfig = () => ({ gateway: {}, engines: { default: "claude", claude: { bin: "claude", model: "sonnet" } }, portal: {}, sessions: { maxConcurrentRuns: 1 } }) as any;
    const { Semaphore } = await import("../../shared/async-lock.js");
    const runSemaphore = new Semaphore(1);
    const held = runSemaphore.tryAcquire(1);
    expect(held).not.toBeNull();
    (ctx as any).runSemaphore = runSemaphore;

    const before = reg.listSessions().length;
    const cap = makeRes();
    await api.handleApiRequest(makeJsonReq("POST", "/api/sessions", { prompt: "hello" }), cap.res, ctx);

    expect(cap.status).toBe(429);
    expect(reg.listSessions()).toHaveLength(before);
    expect(hoisted.dispatchWebSessionRun).not.toHaveBeenCalled();
    expect(hoisted.dispatchEmployeeSessionRun).not.toHaveBeenCalled();
  });

  it("still accepts a real prompt with surrounding whitespace", async () => {
    const { api } = await setup();
    const ctx = makeCtx(api);
    ctx.getConfig = () => ({ gateway: {}, engines: { default: "claude", claude: { bin: "claude", model: "sonnet" } }, portal: {} }) as any;

    const cap = makeRes();
    await api.handleApiRequest(makeJsonReq("POST", "/api/sessions", { prompt: "  hello  " }), cap.res, ctx);

    expect(cap.status).toBe(201);
  });

  it("rejects a whitespace-only message on POST /api/sessions/:id/message", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:msg", prompt: "seed" });

    const cap = makeRes();
    await api.handleApiRequest(makeJsonReq("POST", `/api/sessions/${session.id}/message`, { message: "   " }), cap.res, ctx);

    expect(cap.status).toBe(400);
    expect(cap.body).toEqual(expect.objectContaining({ error: expect.stringContaining("message is required") }));
  });

  it("applies a workspace profile cwd and instructions to a new session", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);
    const repoDir = path.join(testHome.home(), "repo");
    fs.mkdirSync(repoDir, { recursive: true });
    const expectedRepoDir = fs.realpathSync(repoDir);
    ctx.getConfig = () => ({
      gateway: {},
      engines: { default: "claude", claude: { bin: "claude", model: "sonnet" } },
      portal: {},
      workspaces: {
        roots: [testHome.home()],
        profiles: {
          billing: {
            label: "Billing",
            cwd: repoDir,
            instructions: ["Use the billing repo conventions.", "Read AGENTS.md first."],
          },
        },
      },
    }) as any;
    ctx.sessionManager.getEngine = () => ({ name: "claude" }) as any;

    const cap = makeRes();
    await api.handleApiRequest(
      makeJsonReq("POST", "/api/sessions", { prompt: "Implement invoices.", workspaceProfile: "billing" }),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(201);
    const session = reg.getSession(String(cap.body.id));
    expect(session?.cwd).toBe(expectedRepoDir);
    expect(session?.promptExcerpt).toBe("Implement invoices.");
    expect(session?.transportMeta?.workspaceProfile).toMatchObject({ id: "billing", label: "Billing", cwd: expectedRepoDir });
    expect(reg.getMessages(session!.id)[0]?.content).toBe("Implement invoices.");
    expect(hoisted.dispatchEmployeeSessionRun).toHaveBeenCalledTimes(1);
    const dispatchedPrompt = (hoisted.dispatchEmployeeSessionRun.mock.calls as unknown[][])[0][1] as string;
    expect(dispatchedPrompt).toContain("Use the billing repo conventions.");
    expect(dispatchedPrompt).toContain("### Operator request\nImplement invoices.");
  });
});

describe("POST /api/sessions/bulk-delete duplicate ids (I-2)", () => {
  it("reports a full success, not a partial failure, when the same id is submitted twice", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:bulk", prompt: "seed" });

    const cap = makeRes();
    await api.handleApiRequest(
      makeJsonReq("POST", "/api/sessions/bulk-delete", { ids: [session.id, session.id] }),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(200);
    expect(cap.body).toEqual(
      expect.objectContaining({ status: "deleted", count: 1, requested: 1, deletedIds: [session.id] }),
    );
    expect(reg.getSession(session.id)).toBeUndefined();
  });
});

describe("POST /api/sessions/:id/stop on an idle session (I-4)", () => {
  it("reports wasRunning: false when there was no live turn to interrupt", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:stop", prompt: "seed" });
    expect(reg.getSession(session.id)?.status).not.toBe("running");

    const cap = makeRes();
    await api.handleApiRequest(makeReq("POST", `/api/sessions/${session.id}/stop`), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect(cap.body).toEqual(expect.objectContaining({ status: "stopped", stopped: true, wasRunning: false }));
  });

  it("reports wasRunning: true when a live turn was actually interrupted", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:stop-live", prompt: "seed" });
    reg.updateSession(session.id, { status: "running" });
    hoisted.killSessionEngines.mockReturnValue({ interruptible: 1 });

    const cap = makeRes();
    await api.handleApiRequest(makeReq("POST", `/api/sessions/${session.id}/stop`), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect(cap.body).toEqual(expect.objectContaining({ status: "stopped", stopped: true, wasRunning: true }));
  });

  it("reports wasRunning: false even if the engine reports interruptible > 0 for an already-idle session", async () => {
    // killResult.interruptible only reflects "an interruptible engine type is
    // attached", not "a live process existed for this session" (e.g. a
    // Codex-backed session where kill() no-ops because no live process is
    // tracked). wasRunning must not be derived from it.
    const { api, reg } = await setup();
    const ctx = makeCtx(api);
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:stop-stale", prompt: "seed" });
    expect(reg.getSession(session.id)?.status).not.toBe("running");
    hoisted.killSessionEngines.mockReturnValue({ interruptible: 1 });

    const cap = makeRes();
    await api.handleApiRequest(makeReq("POST", `/api/sessions/${session.id}/stop`), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect(cap.body).toEqual(expect.objectContaining({ status: "stopped", stopped: true, wasRunning: false }));
  });
});
