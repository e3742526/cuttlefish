import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import type { ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

const hoisted = vi.hoisted(() => ({
  scheduleOnLoadTailSync: vi.fn(),
  scheduleTranscriptBackfill: vi.fn(),
  loadRawTranscript: vi.fn(),
  dispatchWebSessionRun: vi.fn(async () => {}),
  dispatchPendingWebQueueHeadForSessionKey: vi.fn(() => 0),
}));
const scheduleOnLoadTailSync = hoisted.scheduleOnLoadTailSync;
const scheduleTranscriptBackfill = hoisted.scheduleTranscriptBackfill;
const loadRawTranscript = hoisted.loadRawTranscript;
const dispatchWebSessionRun = hoisted.dispatchWebSessionRun;
const dispatchPendingWebQueueHeadForSessionKey = hoisted.dispatchPendingWebQueueHeadForSessionKey;

vi.mock("../external-turns.js", () => ({
  scheduleOnLoadTailSync,
}));

vi.mock("../transcript-backfill.js", () => ({
  loadRawTranscript,
  scheduleTranscriptBackfill,
}));

vi.mock("../api/session-dispatch.js", () => ({
  dispatchWebSessionRun,
  dispatchPendingWebQueueHeadForSessionKey,
  killSessionEngines: vi.fn(),
  maybeRevertEngineOverride: <T>(session: T) => session,
  redispatchPendingWebQueueItemsForSessionKey: vi.fn(() => 0),
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

/** New-session dispatch fires fire-and-forget through dispatchEmployeeSessionRun,
 *  which now resolves dispatchWebSessionRun via a dynamic import (to avoid a
 *  static import cycle with session-dispatch.ts) — an extra microtask hop
 *  beyond handleApiRequest's own resolution. Poll instead of asserting
 *  immediately. */
async function waitForCall(fn: { mock: { calls: unknown[] } }, times = 1, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn.mock.calls.length >= times) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (fn.mock.calls.length < times) throw new Error(`waitForCall: expected ${times} call(s), got ${fn.mock.calls.length}`);
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
      }),
    },
  } as unknown as import("../api.js").ApiContext;
}

let tmpHome: string;
const testHome = withTempCuttlefishHome("cuttlefish-session-query-");

beforeEach(() => {
  tmpHome = testHome.home();
  scheduleOnLoadTailSync.mockReset();
  scheduleTranscriptBackfill.mockReset();
  loadRawTranscript.mockReset();
  dispatchWebSessionRun.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("session query routes", () => {
  it("returns the default grouped session payload shape for GET /api/sessions", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);

    const direct = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:default", prompt: "default" });
    reg.updateSession(direct.id, { title: "Default Session" });
    reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:worker-default",
      employee: "worker",
      prompt: "worker default",
    });

    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/sessions"), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect(cap.body).toEqual(
      expect.objectContaining({
        sessions: expect.arrayContaining([
          expect.objectContaining({ id: direct.id, title: "Default Session" }),
        ]),
        counts: expect.any(Object),
        perGroup: 50,
      }),
    );
  }, 15_000);

  it("persists a selected cwd for POST /api/sessions", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);
    const config = {
      gateway: {},
      engines: {
        default: "claude",
        claude: { bin: "claude", model: "opus" },
      },
      portal: {},
    };
    ctx.getConfig = () => config as any;
    const cwd = fs.mkdtempSync(path.join(tmpHome, "chat-cwd-"));
    const expectedCwd = fs.realpathSync(cwd);

    const cap = makeRes();
    await api.handleApiRequest(
      makeJsonReq("POST", "/api/sessions", { prompt: "use this folder", cwd }),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(201);
    expect(cap.body).toEqual(expect.objectContaining({ cwd: expectedCwd }));
    expect(reg.getSession(cap.body.id)?.cwd).toBe(expectedCwd);
  });

  it("reuses the singleton hr-manager session for new HR chat requests", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);
    const config = {
      gateway: {},
      engines: {
        default: "claude",
        claude: { bin: "claude", model: "sonnet" },
      },
      portal: {},
      models: {
        claude: {
          default: "sonnet",
          models: [{ id: "sonnet", supportsEffort: true, effortLevels: ["low", "medium", "high"] }],
        },
      },
    };
    ctx.getConfig = () => config as any;
    ctx.sessionManager = {
      ...ctx.sessionManager,
      getEngine: () => ({ isAlive: () => false }),
    } as any;

    const first = makeRes();
    await api.handleApiRequest(
      makeJsonReq("POST", "/api/sessions", { prompt: "first", employee: "hr-manager" }),
      first.res,
      ctx,
    );

    const second = makeRes();
    await api.handleApiRequest(
      makeJsonReq("POST", "/api/sessions", { prompt: "second", employee: "hr-manager" }),
      second.res,
      ctx,
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(reg.listSessions().filter((session) => session.employee === "hr-manager")).toHaveLength(1);
    expect(reg.getSessionBySessionKey("employee:hr-manager")?.id).toBe(first.body.id);
    expect(reg.getMessages(first.body.id).filter((message) => message.role === "user").map((message) => message.content)).toEqual([
      "first",
      "second",
    ]);
    await waitForCall(dispatchWebSessionRun);
    expect(dispatchWebSessionRun).toHaveBeenCalledTimes(1);
    await waitForCall(dispatchPendingWebQueueHeadForSessionKey);
    expect(dispatchPendingWebQueueHeadForSessionKey).toHaveBeenCalledWith(expect.anything(), "employee:hr-manager");
  });

  it("does not dispatch a new HR message ahead of an older durable pending queue item", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);
    const config = {
      gateway: {},
      engines: {
        default: "claude",
        claude: { bin: "claude", model: "sonnet" },
      },
      portal: {},
      models: {
        claude: {
          default: "sonnet",
          models: [{ id: "sonnet", supportsEffort: true, effortLevels: ["low", "medium", "high"] }],
        },
      },
    };
    ctx.getConfig = () => config as any;
    ctx.sessionManager = {
      ...ctx.sessionManager,
      getEngine: () => ({ isAlive: () => false }),
    } as any;

    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "employee:hr-manager",
      sessionKey: "employee:hr-manager",
      employee: "hr-manager",
      prompt: "older",
    });
    reg.enqueueQueueItem(session.id, session.sessionKey, "older pending work");
    dispatchWebSessionRun.mockClear();
    dispatchPendingWebQueueHeadForSessionKey.mockClear();

    const cap = makeRes();
    await api.handleApiRequest(
      makeJsonReq("POST", "/api/sessions", { prompt: "newer", employee: "hr-manager" }),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(201);
    expect(dispatchWebSessionRun).not.toHaveBeenCalled();
    expect(dispatchPendingWebQueueHeadForSessionKey).toHaveBeenCalledWith(ctx, "employee:hr-manager");
    expect(reg.getQueueItems(session.sessionKey).filter((item) => item.status === "pending").map((item) => item.prompt)).toEqual([
      "older pending work",
      "newer",
    ]);
  });

  it("reuses a legacy hr-manager web session when the singleton session key is absent", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);
    const config = {
      gateway: {},
      engines: {
        default: "claude",
        claude: { bin: "claude", model: "sonnet" },
      },
      portal: {},
      models: {
        claude: {
          default: "sonnet",
          models: [{ id: "sonnet", supportsEffort: true, effortLevels: ["low", "medium", "high"] }],
        },
      },
    };
    ctx.getConfig = () => config as any;
    ctx.sessionManager = {
      ...ctx.sessionManager,
      getEngine: () => ({ isAlive: () => false }),
    } as any;

    const legacy = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:legacy-hr",
      sessionKey: "web:legacy-hr",
      employee: "hr-manager",
      prompt: "legacy session",
    });

    const cap = makeRes();
    await api.handleApiRequest(
      makeJsonReq("POST", "/api/sessions", { prompt: "reuse me", employee: "hr-manager" }),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(201);
    expect(cap.body.id).toBe(legacy.id);
    expect(reg.listSessions().filter((session) => session.employee === "hr-manager")).toHaveLength(1);
    expect(reg.getMessages(legacy.id).filter((message) => message.role === "user").map((message) => message.content)).toContain("reuse me");
    await waitForCall(dispatchWebSessionRun);
    expect(dispatchWebSessionRun).toHaveBeenCalledTimes(1);
  });

  it("preserves q/group/offset/limit list behavior for GET /api/sessions", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);

    const direct = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:direct", prompt: "alpha prompt" });
    reg.updateSession(direct.id, { title: "Alpha Unique Session" });
    const workerOld = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:worker-old",
      employee: "worker",
      prompt: "worker older",
    });
    const workerNew = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:worker-new",
      employee: "worker",
      prompt: "worker newer",
    });
    reg.updateSession(workerOld.id, { lastActivity: "2026-06-22T10:00:00.000Z" });
    reg.updateSession(workerNew.id, { lastActivity: "2026-06-22T10:00:01.000Z" });

    const search = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/sessions?q=Alpha%20Unique%20Session"), search.res, ctx);
    expect(search.status).toBe(200);
    expect(search.body).toEqual([
      expect.objectContaining({ id: direct.id, title: "Alpha Unique Session" }),
    ]);

    const group = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/sessions?group=worker&limit=1&offset=1"), group.res, ctx);
    expect(group.status).toBe(200);
    expect(group.body).toEqual([
      expect.objectContaining({ id: workerOld.id }),
    ]);
    expect((group.body as Array<{ id: string }>).map((session) => session.id)).not.toContain(workerNew.id);

    const all = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/sessions?limit=0"), all.res, ctx);
    expect(all.status).toBe(200);
    expect(Array.isArray(all.body)).toBe(true);
    expect((all.body as Array<{ id: string }>).map((session) => session.id)).toEqual(
      expect.arrayContaining([direct.id, workerOld.id, workerNew.id]),
    );
  }, 15_000);

  it("keeps /api/sessions/interrupted ahead of generic session detail matching", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:interrupted", prompt: "resume me" });
    reg.updateSession(session.id, { status: "interrupted", engineSessionId: "claude-resume-id" });

    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/sessions/interrupted"), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect(Array.isArray(cap.body)).toBe(true);
    expect(cap.body).toEqual([
      expect.objectContaining({ id: session.id, status: "interrupted" }),
    ]);
  });

  it("preserves ?last=N and Claude on-load tail sync for session detail", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:last-n", prompt: "last n" });
    reg.updateSession(session.id, { engineSessionId: "claude-tail-id" });
    reg.insertMessage(session.id, "user", "one");
    reg.insertMessage(session.id, "assistant", "two");
    reg.insertMessage(session.id, "assistant", "three");

    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/sessions/${session.id}?last=2`), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect((cap.body as { messages: Array<{ content: string }> }).messages.map((message) => message.content)).toEqual([
      "two",
      "three",
    ]);
    expect(scheduleOnLoadTailSync).toHaveBeenCalledWith(session.id, ctx.emit);
    expect(scheduleTranscriptBackfill).not.toHaveBeenCalled();
  });

  it("schedules transcript backfill when a session has no stored messages yet", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:backfill", prompt: "backfill" });
    reg.updateSession(session.id, { engineSessionId: "claude-backfill-id" });

    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/sessions/${session.id}`), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect(scheduleTranscriptBackfill).toHaveBeenCalledWith(session.id, "claude-backfill-id", ctx);
    expect(scheduleOnLoadTailSync).not.toHaveBeenCalled();
  });

  it("returns 404 for missing session detail and transcript routes", async () => {
    const { api } = await setup();
    const ctx = makeCtx(api);

    const detail = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/sessions/missing-session"), detail.res, ctx);
    expect(detail.status).toBe(404);

    const transcript = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/sessions/missing-session/transcript"), transcript.res, ctx);
    expect(transcript.status).toBe(404);

    const queue = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/sessions/missing-session/queue"), queue.res, ctx);
    expect(queue.status).toBe(404);
  });

  it("returns an empty transcript when the session has no engine session id", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:no-engine", prompt: "no engine" });

    const transcript = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/sessions/${session.id}/transcript`), transcript.res, ctx);

    expect(transcript.status).toBe(200);
    expect(transcript.body).toEqual([]);
    expect(loadRawTranscript).not.toHaveBeenCalled();
  });

  it("preserves children and transcript route ownership", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);
    const parent = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:parent", prompt: "parent" });
    const child = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:child",
      parentSessionId: parent.id,
      prompt: "child",
    });
    const transcriptSession = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:tx", prompt: "transcript" });
    reg.updateSession(transcriptSession.id, { engineSessionId: "claude-transcript-id" });
    loadRawTranscript.mockReturnValue([{ type: "assistant", text: "raw entry" }]);

    const children = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/sessions/${parent.id}/children`), children.res, ctx);
    expect(children.status).toBe(200);
    expect(children.body).toEqual([
      expect.objectContaining({ id: child.id }),
    ]);

    const transcript = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/sessions/${transcriptSession.id}/transcript`), transcript.res, ctx);
    expect(transcript.status).toBe(200);
    expect(transcript.body).toEqual([{ type: "assistant", text: "raw entry" }]);
    expect(loadRawTranscript).toHaveBeenCalledWith("claude-transcript-id");
  });

  it("preserves queue route ownership for read-only session queue lookup", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:queue", prompt: "queue" });

    const queue = makeRes();
    await api.handleApiRequest(makeReq("GET", `/api/sessions/${session.id}/queue`), queue.res, ctx);

    expect(queue.status).toBe(200);
    expect(queue.body).toEqual([]);
  });

  it("returns found:false for a ticket session lookup when nothing maps", async () => {
    const { api } = await setup();
    const ctx = makeCtx(api);
    const deptDir = path.join(tmpHome, "org", "software-delivery");
    fs.mkdirSync(deptDir, { recursive: true });
    fs.writeFileSync(path.join(deptDir, "board.json"), JSON.stringify([
      {
        id: "ticket-404",
        title: "Missing session",
        description: "",
        status: "in_progress",
        priority: "medium",
        complexity: "medium",
        assignee: "worker",
        createdAt: "2026-06-22T00:00:00.000Z",
        updatedAt: "2026-06-22T00:00:00.000Z",
      },
    ]));

    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/org/departments/software-delivery/tickets/ticket-404/session"), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect(cap.body).toEqual({ found: false });
  });

  it("resolves ticket session lookup via channel match, picks the newest match, and caps messages", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);
    const deptDir = path.join(tmpHome, "org", "software-delivery");
    fs.mkdirSync(deptDir, { recursive: true });
    fs.writeFileSync(path.join(deptDir, "board.json"), JSON.stringify([
      {
        id: "ticket-live",
        title: "Live worker",
        description: "",
        status: "in_progress",
        priority: "medium",
        complexity: "medium",
        assignee: "worker",
        createdAt: "2026-06-22T00:00:00.000Z",
        updatedAt: "2026-06-22T00:00:00.000Z",
      },
    ]));

    const older = reg.createSession({
      engine: "claude",
      source: "manual",
      sourceRef: "manual:software-delivery:ticket-live:older",
      employee: "worker",
      prompt: "older",
      replyContext: { channel: "kanban:ticket-live" } as any,
    });
    reg.updateSession(older.id, { lastActivity: "2026-06-22T10:00:00.000Z" });

    const newer = reg.createSession({
      engine: "claude",
      source: "manual",
      sourceRef: "manual:software-delivery:ticket-live:newer",
      employee: "worker",
      prompt: "newer",
      replyContext: { channel: "kanban:ticket-live" } as any,
    });
    reg.updateSession(newer.id, {
      status: "running",
      model: "opus",
      lastActivity: "2026-06-22T10:00:09.000Z",
    });

    reg.insertMessage(newer.id, "user", "u1");
    for (let i = 0; i < 9; i++) {
      reg.insertMessage(newer.id, "assistant", `a${i}`);
    }

    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/org/departments/software-delivery/tickets/ticket-live/session"), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect(cap.body).toMatchObject({
      found: true,
      sessionId: newer.id,
      status: "running",
      engine: "claude",
      model: "opus",
      employee: "worker",
      totalCost: 0,
      stalled: false,
      stalledForMs: null,
      failureReason: null,
      fallback: null,
    });
    expect((cap.body as { messages: Array<{ text: string }> }).messages).toHaveLength(8);
    expect((cap.body as { messages: Array<{ text: string }> }).messages.map((message) => message.text)).toEqual([
      "a1",
      "a2",
      "a3",
      "a4",
      "a5",
      "a6",
      "a7",
      "a8",
    ]);
    expect(scheduleOnLoadTailSync).toHaveBeenCalledWith(newer.id, ctx.emit);
  });

  it("surfaces truthful stalled and fallback metadata from persisted session state", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);
    const deptDir = path.join(tmpHome, "org", "software-delivery");
    fs.mkdirSync(deptDir, { recursive: true });
    fs.writeFileSync(path.join(deptDir, "board.json"), JSON.stringify([
      {
        id: "ticket-stalled",
        title: "Stalled worker",
        description: "",
        status: "in_progress",
        priority: "medium",
        complexity: "medium",
        assignee: "worker",
        createdAt: "2026-06-22T00:00:00.000Z",
        updatedAt: "2026-06-22T00:00:00.000Z",
      },
      {
        id: "ticket-fallback",
        title: "Fallback worker",
        description: "",
        status: "in_progress",
        priority: "medium",
        complexity: "medium",
        assignee: "worker",
        createdAt: "2026-06-22T00:00:00.000Z",
        updatedAt: "2026-06-22T00:00:00.000Z",
      },
    ]));

    const stalled = reg.createSession({
      engine: "claude",
      source: "manual",
      sourceRef: "manual:software-delivery:ticket-stalled",
      employee: "worker",
      prompt: "stalled",
      transportMeta: { boardTicketId: "ticket-stalled" } as any,
    });
    reg.updateSession(stalled.id, {
      status: "idle",
      lastActivity: "2026-06-22T10:00:00.000Z",
      lastError: "Stalled: session was stuck at status=running with no live turn (heartbeat stale 45s) — auto-reset by the reconciler.",
    });

    const fallback = reg.createSession({
      engine: "codex",
      source: "manual",
      sourceRef: "manual:software-delivery:ticket-fallback",
      employee: "worker",
      prompt: "fallback",
      transportMeta: {
        boardTicketId: "ticket-fallback",
        modelFallback: {
          status: "running_on_fallback",
          reason: "timeout",
          from: { engine: "claude", model: "opus" },
          to: { engine: "codex", model: "gpt-5.5" },
        },
      } as any,
    });
    reg.updateSession(fallback.id, {
      status: "running",
      model: "gpt-5.5",
      lastActivity: "2026-06-22T10:00:09.000Z",
      lastError: "Fallback (stall): claude/opus → codex/gpt-5.5",
    });

    const stalledCap = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/org/departments/software-delivery/tickets/ticket-stalled/session"), stalledCap.res, ctx);
    expect(stalledCap.status).toBe(200);
    expect(stalledCap.body).toMatchObject({
      found: true,
      sessionId: stalled.id,
      stalled: true,
      failureReason: "timeout",
      fallback: null,
    });
    expect((stalledCap.body as { stalledForMs: number }).stalledForMs).toBeGreaterThanOrEqual(0);

    const fallbackCap = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/org/departments/software-delivery/tickets/ticket-fallback/session"), fallbackCap.res, ctx);
    expect(fallbackCap.status).toBe(200);
    expect(fallbackCap.body).toMatchObject({
      found: true,
      sessionId: fallback.id,
      stalled: false,
      failureReason: "timeout",
      fallback: {
        active: true,
        fromEngine: "claude",
        toEngine: "codex",
        toModel: "gpt-5.5",
      },
    });
  });
});
