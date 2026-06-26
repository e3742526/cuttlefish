import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-checkpoints-");

type Api = typeof import("../api.js");
type Approvals = typeof import("../approvals.js");
type Reg = typeof import("../../sessions/registry.js");
let api: Api;
let store: Approvals;
let reg: Reg;

const approvalsFile = path.join(tmp, "checkpoints.approvals.json");

beforeAll(async () => {
  api = await import("../api.js");
  store = await import("../approvals.js");
  reg = await import("../../sessions/registry.js");
  reg.initDb();
});

beforeEach(() => {
  try { fs.rmSync(approvalsFile, { force: true }); } catch { /* ignore */ }
  store.__setApprovalsStoreForTest(approvalsFile);
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
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try { return JSON.parse(raw); } catch { return raw; }
    },
  };
}

function makeReq(method: string, urlPath: string) {
  return { method, url: urlPath, headers: { host: "localhost" } } as unknown as Parameters<Api["handleApiRequest"]>[0];
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

function makeCtx(over: Record<string, unknown> = {}) {
  return {
    getConfig: () => ({ gateway: {}, engines: { default: "claude" }, portal: {} }),
    emit: vi.fn(),
    connectors: new Map(),
    startTime: Date.now(),
    sessionManager: {
      getEngine: () => undefined,
      getQueue: () => ({
        enqueue: vi.fn(async () => {}),
        getPendingCount: () => 0,
        getTransportState: (_key: string, status: string) => status,
      }),
    },
    ...over,
  } as unknown as import("../api.js").ApiContext;
}

describe("checkpoint routes", () => {
  it("creates a checkpoint, pauses the session, and lists it", async () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:cp1", prompt: "x" });
    const cap = makeRes();
    await api.handleApiRequest(
      makeJsonReq("POST", "/api/checkpoints", {
        sessionId: session.id,
        decisionNeeded: "Approve deleting generated report",
        why: "This will remove the current draft artifact before rewriting it.",
        affectedArtifacts: ["artifact-1"],
        affectedActions: ["delete artifact-1", "rerun report generation"],
      }),
      cap.res,
      makeCtx(),
    );

    expect(cap.status).toBe(201);
    expect(cap.body.checkpoint).toEqual(expect.objectContaining({
      type: "checkpoint",
      state: "pending",
      payload: expect.objectContaining({
        decisionNeeded: "Approve deleting generated report",
        why: "This will remove the current draft artifact before rewriting it.",
      }),
    }));
    expect(reg.getSession(session.id)?.status).toBe("waiting");

    const listCap = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/checkpoints"), listCap.res, makeCtx());
    expect(listCap.status).toBe(200);
    expect(listCap.body).toEqual([
      expect.objectContaining({ id: cap.body.checkpoint.id, type: "checkpoint" }),
    ]);
  });

  it("defers a checkpoint and records notes plus resulting action", async () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:cp2", prompt: "x" });
    const checkpoint = store.createApproval({
      sessionId: session.id,
      type: "checkpoint",
      payload: {
        decisionNeeded: "Ship migration",
        why: "Need human timing confirmation",
        options: ["approved", "deferred"],
      },
    });

    const cap = makeRes();
    await api.handleApiRequest(
      makeJsonReq("POST", `/api/checkpoints/${checkpoint.id}/decision`, {
        decision: "deferred",
        notes: "Wait until the maintenance window opens.",
      }),
      cap.res,
      makeCtx(),
    );

    expect(cap.status).toBe(200);
    expect(cap.body.checkpoint).toEqual(expect.objectContaining({
      state: "deferred",
      decisionNotes: "Wait until the maintenance window opens.",
      resultingAction: "stay_paused",
    }));
    expect(reg.getSession(session.id)?.status).toBe("waiting");
  });

  it("approves a checkpoint with a resume prompt and resumes the session", async () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:cp3", prompt: "x" });
    const checkpoint = store.createApproval({
      sessionId: session.id,
      type: "checkpoint",
      payload: {
        decisionNeeded: "Approve revision pass",
        why: "Human edits should be incorporated before continuing.",
        resumePrompt: "Continue by incorporating the operator's comments.",
      },
    });
    const enqueue = vi.fn(async (_key: string, job: () => Promise<void>) => {
      // do not execute the job; we only need to observe dispatch intent
      return Promise.resolve(job()).catch(() => {});
    });
    const cap = makeRes();
    await api.handleApiRequest(
      makeJsonReq("POST", `/api/checkpoints/${checkpoint.id}/decision`, {
        decision: "approved",
      }),
      cap.res,
      makeCtx({
        sessionManager: {
          getEngine: () => ({ run: vi.fn(async () => ({ sessionId: "eng-1", result: "ok" })) }),
          getQueue: () => ({
            enqueue,
            getPendingCount: () => 0,
            getTransportState: (_key: string, status: string) => status,
          }),
        },
      }),
    );

    expect(cap.status).toBe(200);
    expect(cap.body.checkpoint).toEqual(expect.objectContaining({
      state: "approved",
      resultingAction: "resume_session",
    }));
    expect(reg.getSession(session.id)?.status).toBe("running");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("exports checkpoint decisions to the external outbox", async () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:cp4", prompt: "x" });
    const checkpoint = store.createApproval({
      sessionId: session.id,
      type: "checkpoint",
      payload: {
        decisionNeeded: "Approve cleanup",
        why: "Need operator sign-off",
      },
    });

    const cap = makeRes();
    await api.handleApiRequest(
      makeJsonReq("POST", `/api/checkpoints/${checkpoint.id}/decision`, {
        decision: "deferred",
        notes: "wait",
      }),
      cap.res,
      makeCtx({
        knowledgeSink: {
          name: "noop",
          emit: vi.fn(async () => ({
            accepted: 1,
            rejected: 0,
            retryable: false,
            results: [{ accepted: true, remoteId: "noop" }],
          })),
          health: vi.fn(async () => ({ ok: true })),
        },
      }),
    );

    expect(cap.status).toBe(200);
    expect(reg.listExternalOutboxItems({ limit: 10 })).toEqual([
      expect.objectContaining({
        topic: "cuttlefish.checkpoint.decision.v1",
        status: "delivered",
      }),
    ]);
  });
});
