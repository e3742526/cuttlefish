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
      clearCancelled: vi.fn(),
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

  it("refuses to append an explicit Grok profile request to a legacy HR singleton", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);
    ctx.getConfig = () => ({
      gateway: {},
      engines: {
        default: "claude",
        claude: { bin: "node", model: "sonnet" },
        grok: { bin: "node", model: "grok-4.5" },
      },
      portal: {},
    }) as any;
    ctx.sessionManager.getEngine = (name: string) => ({ name }) as any;

    const existing = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:legacy-hr",
      employee: "hr-manager",
      model: "sonnet",
      prompt: "existing HR work",
    });
    reg.insertMessage(existing.id, "user", "existing HR work");

    const cap = makeRes();
    await api.handleApiRequest(
      makeJsonReq("POST", "/api/sessions", {
        employee: "hr-manager",
        engine: "grok",
        model: "grok-4.5",
        effortLevel: "high",
        prompt: "new isolated HR request",
      }),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(409);
    expect(cap.body).toMatchObject({ code: "hr_singleton_profile_conflict", sessionId: existing.id, field: "engine" });
    expect(reg.getMessages(existing.id).map((message) => message.content)).toEqual(["existing HR work"]);
    expect(hoisted.dispatchEmployeeSessionRun).not.toHaveBeenCalled();
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

  it("archives board tickets for every deleted session", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);
    const first = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:bulk-board-a", prompt: "first" });
    const second = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:bulk-board-b", prompt: "second" });
    const boardDir = path.join(testHome.home(), "org", "qa");
    fs.mkdirSync(boardDir, { recursive: true });
    fs.writeFileSync(path.join(boardDir, "board.json"), JSON.stringify([
      { id: `session-${first.id}`, title: "First", description: "", status: "done", priority: "medium", assignee: "qa", source: "session", sessionId: first.id, createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:00:00.000Z" },
      { id: `session-${second.id}`, title: "Second", description: "", status: "done", priority: "medium", assignee: "qa", source: "session", sessionId: second.id, createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:00:00.000Z" },
      { id: "keep", title: "Keep", description: "", status: "todo", priority: "medium", assignee: "qa", createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:00:00.000Z" },
    ]));

    const cap = makeRes();
    await api.handleApiRequest(
      makeJsonReq("POST", "/api/sessions/bulk-delete", { ids: [first.id, second.id] }),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(200);
    const board = JSON.parse(fs.readFileSync(path.join(boardDir, "board.json"), "utf-8"));
    expect(board.tickets.map((ticket: { id: string }) => ticket.id)).toEqual(["keep"]);
    expect(board.deletedTickets.map((ticket: { id: string }) => ticket.id).sort()).toEqual([`session-${first.id}`, `session-${second.id}`].sort());
    expect(ctx.emit).toHaveBeenCalledWith("board:updated", { department: "qa" });
  });
});

describe("DELETE /api/sessions/:id board cleanup", () => {
  it("archives the deleted session's ticket without touching other board work", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:single-board", prompt: "single" });
    const boardDir = path.join(testHome.home(), "org", "qa");
    fs.mkdirSync(boardDir, { recursive: true });
    fs.writeFileSync(path.join(boardDir, "board.json"), JSON.stringify([
      { id: `session-${session.id}`, title: "Session work", description: "", status: "blocked", priority: "medium", assignee: "qa", source: "session", sessionId: session.id, createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:00:00.000Z" },
      { id: "keep", title: "Keep", description: "", status: "todo", priority: "medium", assignee: "qa", createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:00:00.000Z" },
    ]));

    const cap = makeRes();
    await api.handleApiRequest(makeReq("DELETE", `/api/sessions/${session.id}`), cap.res, ctx);

    expect(cap.status).toBe(200);
    const board = JSON.parse(fs.readFileSync(path.join(boardDir, "board.json"), "utf-8"));
    expect(board.tickets.map((ticket: { id: string }) => ticket.id)).toEqual(["keep"]);
    expect(board.deletedTickets.map((ticket: { id: string }) => ticket.id)).toEqual([`session-${session.id}`]);
    expect(ctx.emit).toHaveBeenCalledWith("session:deleted", { sessionId: session.id });
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
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:stop-live",
      prompt: "seed",
    });
    reg.updateSession(session.id, { status: "running", engineSessionId: "claude-resume-id" });
    hoisted.killSessionEngines.mockReturnValue({ interruptible: 1 });

    const cap = makeRes();
    await api.handleApiRequest(makeReq("POST", `/api/sessions/${session.id}/stop`), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect(cap.body).toEqual(expect.objectContaining({ status: "stopped", stopped: true, wasRunning: true }));
    expect(reg.getSession(session.id)?.engineSessionId).toBe("claude-resume-id");
  });

  it("clears a stopped Grok resume id so a follow-up starts a fresh turn", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);
    ctx.getConfig = () => ({ gateway: {}, engines: { default: "grok", grok: { bin: "grok", model: "grok-4.5" } }, portal: {} }) as any;
    ctx.sessionManager.getEngine = () => ({ name: "grok" }) as any;
    const session = reg.createSession({
      engine: "grok",
      source: "web",
      sourceRef: "web:stop-grok",
      prompt: "seed",
    });
    reg.updateSession(session.id, { status: "running", engineSessionId: "stale-grok-session" });
    hoisted.killSessionEngines.mockReturnValue({ interruptible: 1 });

    const stop = makeRes();
    await api.handleApiRequest(makeReq("POST", `/api/sessions/${session.id}/stop`), stop.res, ctx);

    expect(stop.status).toBe(200);
    expect(reg.getSession(session.id)).toMatchObject({ status: "idle", engineSessionId: null });

    const followUp = makeRes();
    await api.handleApiRequest(
      makeJsonReq("POST", `/api/sessions/${session.id}/message`, { message: "continue freshly" }),
      followUp.res,
      ctx,
    );

    expect(followUp.status).toBe(200);
    expect(hoisted.dispatchEmployeeSessionRun).toHaveBeenCalledTimes(1);
    const dispatched = hoisted.dispatchEmployeeSessionRun.mock.calls as unknown[][];
    expect(dispatched[0]?.[0]).toMatchObject({ engine: "grok", engineSessionId: null });
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

describe("session notification aggregation", () => {
  it("waits for all enforced manager children and dispatches exactly one synthesis", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);
    ctx.getConfig = () => ({ gateway: {}, engines: { default: "claude", claude: { bin: "node", model: "sonnet" } }, portal: {} }) as any;
    ctx.sessionManager.getEngine = () => ({ name: "claude" }) as any;

    const parent = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:parent", prompt: "parent" });
    const firstChild = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:child-a", parentSessionId: parent.id, prompt: "child a" });
    const secondChild = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:child-b", parentSessionId: parent.id, prompt: "child b" });
    reg.updateSession(parent.id, {
      transportMeta: {
        managerDelegationEnforcement: {
          childSessionIds: [firstChild.id, secondChild.id],
          completedChildSessionIds: [firstChild.id],
          synthesisDispatched: false,
        },
      } as any,
    });
    const firstNotification = makeRes();
    await api.handleApiRequest(
      makeJsonReq("POST", `/api/sessions/${parent.id}/message`, { message: "first child complete", role: "notification" }),
      firstNotification.res,
      ctx,
    );
    expect(firstNotification.status).toBe(200);
    expect(firstNotification.body).toMatchObject({ status: "notification_recorded", pendingChildSessionIds: [secondChild.id] });
    expect(hoisted.dispatchEmployeeSessionRun).not.toHaveBeenCalled();

    reg.updateSession(parent.id, {
      transportMeta: {
        managerDelegationEnforcement: {
          childSessionIds: [firstChild.id, secondChild.id],
          completedChildSessionIds: [firstChild.id, secondChild.id],
          synthesisDispatched: false,
        },
      } as any,
    });
    const finalNotification = makeRes();
    await api.handleApiRequest(
      makeJsonReq("POST", `/api/sessions/${parent.id}/message`, { message: "second child complete", role: "notification" }),
      finalNotification.res,
      ctx,
    );
    expect(finalNotification.status).toBe(200);
    expect(hoisted.dispatchEmployeeSessionRun).toHaveBeenCalledTimes(1);
    expect((reg.getSession(parent.id)?.transportMeta as any)?.managerDelegationEnforcement?.synthesisDispatched).toBe(true);

    const duplicateNotification = makeRes();
    await api.handleApiRequest(
      makeJsonReq("POST", `/api/sessions/${parent.id}/message`, { message: "duplicate child callback", role: "notification" }),
      duplicateNotification.res,
      ctx,
    );
    expect(duplicateNotification.status).toBe(200);
    expect(duplicateNotification.body).toMatchObject({ status: "notification_recorded" });
    expect(hoisted.dispatchEmployeeSessionRun).toHaveBeenCalledTimes(1);
  });

  it("claims a fully completed manager synthesis once when notification requests overlap", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);
    ctx.getConfig = () => ({ gateway: {}, engines: { default: "claude", claude: { bin: "node", model: "sonnet" } }, portal: {} }) as any;
    ctx.sessionManager.getEngine = () => ({ name: "claude" }) as any;

    const parent = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:parent-overlap", prompt: "parent" });
    const firstChild = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:child-overlap-a", parentSessionId: parent.id, prompt: "child a" });
    const secondChild = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:child-overlap-b", parentSessionId: parent.id, prompt: "child b" });
    reg.updateSession(parent.id, {
      transportMeta: {
        managerDelegationEnforcement: {
          childSessionIds: [firstChild.id, secondChild.id],
          completedChildSessionIds: [firstChild.id, secondChild.id],
          synthesisDispatched: false,
        },
      } as any,
    });

    const firstNotification = makeRes();
    const secondNotification = makeRes();
    await Promise.all([
      api.handleApiRequest(
        makeJsonReq("POST", `/api/sessions/${parent.id}/message`, { message: "child a callback", role: "notification" }),
        firstNotification.res,
        ctx,
      ),
      api.handleApiRequest(
        makeJsonReq("POST", `/api/sessions/${parent.id}/message`, { message: "child b callback", role: "notification" }),
        secondNotification.res,
        ctx,
      ),
    ]);

    expect(firstNotification.status).toBe(200);
    expect(secondNotification.status).toBe(200);
    expect(hoisted.dispatchEmployeeSessionRun).toHaveBeenCalledTimes(1);
    expect((reg.getSession(parent.id)?.transportMeta as any)?.managerDelegationEnforcement?.synthesisDispatched).toBe(true);
    expect([firstNotification.body?.status, secondNotification.body?.status]).toContain("notification_recorded");
  });

  it("waits for a child still running even if a stale callback ledger says every child completed", async () => {
    const { api, reg } = await setup();
    const ctx = makeCtx(api);
    ctx.getConfig = () => ({ gateway: {}, engines: { default: "claude", claude: { bin: "node", model: "sonnet" } }, portal: {} }) as any;
    ctx.sessionManager.getEngine = () => ({ name: "claude" }) as any;

    const parent = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:parent-live-barrier", prompt: "parent" });
    const firstChild = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:child-live-a", parentSessionId: parent.id, prompt: "child a" });
    const secondChild = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:child-live-b", parentSessionId: parent.id, prompt: "child b" });
    reg.updateSession(firstChild.id, {
      status: "idle",
      transportMeta: { activeRunId: "child-a-run", latestRunId: "child-a-run" } as any,
    });
    reg.updateSession(secondChild.id, {
      status: "running",
      transportMeta: { activeRunId: "child-b-run", latestRunId: "child-b-run" } as any,
    });
    reg.updateSession(parent.id, {
      transportMeta: {
        managerDelegationEnforcement: {
          childSessionIds: [firstChild.id, secondChild.id],
          completedChildSessionIds: [firstChild.id, secondChild.id],
          synthesisDispatched: false,
        },
      } as any,
    });

    const notification = makeRes();
    await api.handleApiRequest(
      makeJsonReq("POST", `/api/sessions/${parent.id}/message`, { message: "first child callback", role: "notification" }),
      notification.res,
      ctx,
    );

    expect(notification.status).toBe(200);
    expect(notification.body).toMatchObject({ status: "notification_recorded", pendingChildSessionIds: [secondChild.id] });
    expect(hoisted.dispatchEmployeeSessionRun).not.toHaveBeenCalled();
  });
});
