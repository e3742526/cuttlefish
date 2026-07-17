import { describe, it, expect, beforeAll } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import type { ServerResponse } from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-work-");

type Api = typeof import("../api.js");
type Approvals = typeof import("../approvals.js");
type Reg = typeof import("../../sessions/registry.js");
let api: Api;
let store: Approvals;
let reg: Reg;

beforeAll(async () => {
  api = await import("../api.js");
  store = await import("../approvals.js");
  reg = await import("../../sessions/registry.js");
  reg.initDb();
  store.__setApprovalsStoreForTest(path.join(tmp, "approvals.json"));
});

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) { status = s; return this; },
    end(buf?: Buffer | string) { if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); },
  } as unknown as ServerResponse;
  return {
    res,
    get status() { return status; },
    get body() { try { return JSON.parse(Buffer.concat(chunks).toString("utf-8")); } catch { return null; } },
  };
}
function makeReq(method: string, urlPath: string) {
  return { method, url: urlPath, headers: { host: "localhost" } } as unknown as Parameters<Api["handleApiRequest"]>[0];
}

describe("GET /api/work", () => {
  it("normalizes sessions into work-state counts (approval beats running)", async () => {
    // status-driven states; queue stub returns idle transport (so status rules).
    const running = reg.createSession({ engine: "claude", source: "web", sourceRef: "w:run", prompt: "x" });
    reg.updateSession(running.id, { status: "running" });
    const errored = reg.createSession({ engine: "claude", source: "web", sourceRef: "w:err", prompt: "x" });
    reg.updateSession(errored.id, { status: "error" });
    const waiting = reg.createSession({ engine: "claude", source: "web", sourceRef: "w:wait", prompt: "x" });
    reg.updateSession(waiting.id, { status: "waiting" });
    const idle = reg.createSession({ engine: "claude", source: "web", sourceRef: "w:idle", prompt: "x" });
    reg.updateSession(idle.id, { status: "idle" });
    reg.patchSessionTransportMeta(idle.id, { latestRunId: "idle-completed-run" });
    const neverRun = reg.createSession({ engine: "claude", source: "web", sourceRef: "w:new", prompt: "x" });
    // A session with a pending approval must classify as waiting_on_human even
    // though its status is "running".
    const gated = reg.createSession({ engine: "claude", source: "web", sourceRef: "w:gate", prompt: "x" });
    reg.updateSession(gated.id, { status: "running" });
    store.createApproval({ sessionId: gated.id, type: "fallback", payload: {} });

    const ctx = {
      getConfig: () => ({ gateway: {}, engines: {} }),
      emit: () => {},
      sessionManager: {
        // No engine registered for any of these sessions: isSessionLiveRunning
        // treats a "running" status as live when the engine can't be found (it
        // only downgrades a session when it can positively confirm the engine
        // died), so this preserves the status-driven expectations below.
        getEngine: () => undefined,
        getQueue: () => ({ getTransportState: (_k: string, s: string) => s, getPendingCount: () => 0 }),
      },
    } as unknown as import("../api.js").ApiContext;

    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/work"), cap.res, ctx);
    expect(cap.status).toBe(200);
    const body = cap.body as { counts: Record<string, number>; items: unknown[] };
    expect(body.counts.running).toBe(1);          // `running` (gated re-classified)
    expect(body.counts.failed).toBe(1);           // errored
    expect(body.counts.blocked).toBe(1);          // waiting (non-approval)
    expect(body.counts.completed).toBe(1);        // idle
    expect(body.counts.queued).toBe(1);           // created, never dispatched
    expect(body.counts.waiting_on_human).toBe(1); // gated (approval beats running)
    expect(body.items.length).toBe(6);
    expect((body.items as Array<{ sessionId: string; workState: string }>).find((item) => item.sessionId === neverRun.id)?.workState).toBe("queued");
  });

  it("STT-CF-003: reclassifies a session as failed, not running, when the live engine has crashed but session.status hasn't caught up yet", async () => {
    // Simulates the crash window: the DB row still says "running" (no crash
    // handler has written status:"error" yet), but the live engine reports the
    // process is gone. /api/work must agree with the live-engine check used by
    // isSessionLiveRunning (and thus with serializeSession/command-center/health)
    // instead of trusting session.status/queue bookkeeping alone.
    const crashed = reg.createSession({ engine: "claude", source: "web", sourceRef: "w:crashed", prompt: "x" });
    reg.updateSession(crashed.id, { status: "running" });
    reg.patchSessionTransportMeta(crashed.id, { latestRunId: "crashed-run" });

    const ctx = {
      getConfig: () => ({ gateway: {}, engines: {} }),
      emit: () => {},
      sessionManager: {
        getEngine: () => ({
          name: "claude",
          kill: () => {},
          isAlive: () => false,
          killAll: () => {},
          killIdle: () => {},
          isTurnRunning: () => false,
        }),
        getQueue: () => ({ getTransportState: (_k: string, s: string) => s, getPendingCount: () => 0 }),
      },
    } as unknown as import("../api.js").ApiContext;

    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/work"), cap.res, ctx);
    expect(cap.status).toBe(200);
    // Session store is shared across tests in this file, so assert on this
    // session's own item rather than the global counts (which also include
    // sessions created by earlier tests).
    const body = cap.body as { items: Array<{ sessionId: string; workState: string }> };
    expect(body.items.find((item) => item.sessionId === crashed.id)?.workState).toBe("failed");
  });

  it("serves command-center summary counts, manager chat roster, and usage buckets", async () => {
    fs.mkdirSync(path.join(tmp, "org", "engineering"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "org", "engineering", "boss.yaml"),
      [
        "name: boss",
        "displayName: Boss",
        "department: engineering",
        "rank: manager",
        "engine: claude",
        "model: sonnet",
        "persona: Team manager",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmp, "org", "engineering", "worker.yaml"),
      [
        "name: worker",
        "displayName: Worker",
        "department: engineering",
        "rank: employee",
        "engine: codex",
        "model: gpt-5",
        "persona: Builder",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(tmp, "org", "engineering", "board.json"),
      JSON.stringify([
        { id: "t-1", title: "Todo", description: "", status: "todo", priority: "medium", assignee: "worker", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        { id: "t-2", title: "Blocked", description: "", status: "blocked", priority: "high", assignee: "boss", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        { id: "t-3", title: "Done", description: "", status: "done", priority: "low", assignee: "worker", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      ]),
    );

    const running = reg.createSession({ engine: "claude", source: "web", sourceRef: "cmd:boss", employee: "boss", prompt: "lead" });
    reg.updateSession(running.id, { status: "running", lastContextTokens: 120, title: "Lead" });
    reg.accumulateSessionCost(running.id, 1.25, 2);
    const idle = reg.createSession({ engine: "codex", source: "web", sourceRef: "cmd:worker", employee: "worker", prompt: "build" });
    reg.updateSession(idle.id, { status: "idle", lastContextTokens: 80, title: "Build" });
    reg.accumulateSessionCost(idle.id, 0.5, 1);

    const ctx = {
      getConfig: () => ({ gateway: {}, engines: {}, portal: { portalName: "Cuttlefish" } }),
      emit: () => {},
      connectors: new Map(),
      sessionManager: {
        getEngine: () => ({ isTurnRunning: () => true }),
        getQueue: () => ({ getTransportState: (_k: string, s: string) => s, getPendingCount: () => 0 }),
      },
    } as unknown as import("../api.js").ApiContext;

    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/command-center"), cap.res, ctx);
    expect(cap.status).toBe(200);
    expect(cap.body.summary).toMatchObject({
      agents: 3,
      agentsRunning: 1,
      cronJobs: 0,
      // ticketsOpen excludes the terminal "done" ticket; ticketsTotal keeps it.
      ticketsOpen: 2,
      ticketsTotal: 3,
    });
    expect(cap.body.ticketCounts).toMatchObject({ todo: 1, blocked: 1, done: 1 });
    expect(cap.body.managers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ employee: "boss", running: true }),
      ]),
    );
    expect(cap.body.availableAgents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ employee: "boss", usage: expect.objectContaining({ day: expect.objectContaining({ totalTokens: 120 }) }) }),
        expect.objectContaining({ employee: "worker", usage: expect.objectContaining({ day: expect.objectContaining({ totalTokens: 80 }) }) }),
      ]),
    );
  });
});
