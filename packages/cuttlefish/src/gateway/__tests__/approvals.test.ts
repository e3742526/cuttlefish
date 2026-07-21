import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import type { ServerResponse } from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { buildOperatorDelegationGrant, operatorDelegationPromptHash } from "../../sessions/operator-delegation.js";

// Isolate the DB + approvals store before importing modules that resolve paths
// from CUTTLEFISH_HOME at load time.
const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-appr-");

type Api = typeof import("../api.js");
type Approvals = typeof import("../approvals.js");
type Reg = typeof import("../../sessions/registry.js");
let api: Api;
let store: Approvals;
let reg: Reg;

const approvalsFile = path.join(tmp, "approvals.test.json");

beforeAll(async () => {
  api = await import("../api.js");
  store = await import("../approvals.js");
  reg = await import("../../sessions/registry.js");
  reg.initDb();
  // approvals.session_id now carries an enforced FOREIGN KEY to sessions(id), so
  // the referenced sessions must exist before an approval can be created.
  for (const id of ["s1", "s-hr", "s-other"]) {
    const db = reg.initDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT OR IGNORE INTO sessions (id, engine, source, source_ref, status, created_at, last_activity)
       VALUES (?, 'claude', 'web', ?, 'idle', ?, ?)`,
    ).run(id, `web:${id}`, now, now);
  }
});

beforeEach(() => {
  // Fresh store file per test.
  try { fs.rmSync(approvalsFile, { force: true }); } catch { /* ignore */ }
  store.__setApprovalsStoreForTest(approvalsFile);
});

// ── Response/request harness (mirrors route-hardening.test.ts) ──────────────
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
function makeCtx(over: Record<string, unknown> = {}) {
  return {
    getConfig: () => ({ gateway: {}, engines: {} }),
    emit: vi.fn(),
    sessionManager: { getEngine: () => undefined },
    ...over,
  } as unknown as import("../api.js").ApiContext;
}

// ── Store unit tests ────────────────────────────────────────────────────────
describe("approvals store", () => {
  it("creates a pending approval and lists pending by default", () => {
    const a = store.createApproval({ sessionId: "s1", type: "fallback", payload: { reason: "quota_exhausted" } });
    expect(a.state).toBe("pending");
    expect(store.listApprovals().map((x) => x.id)).toContain(a.id);
  });

  it("dedupes a fallback approval per session", () => {
    const a = store.createApproval({ sessionId: "s1", type: "fallback", payload: { v: 1 } });
    const b = store.createApproval({ sessionId: "s1", type: "fallback", payload: { v: 2 } });
    expect(b.id).toBe(a.id);
    expect(store.listApprovals({ sessionId: "s1" })).toHaveLength(1);
    expect(store.getApproval(a.id)?.payload.v).toBe(2); // payload refreshed
  });

  it("resolve flips state; only pending is listed by default", () => {
    const a = store.createApproval({ sessionId: "s1", type: "fallback", payload: {} });
    store.resolveApproval(a.id, "approved", "tester");
    expect(store.listApprovals()).toHaveLength(0);
    expect(store.listApprovals({ state: "approved" })[0].actor).toBe("tester");
  });

  it("resolving a non-pending approval throws ApprovalStateError", () => {
    const a = store.createApproval({ sessionId: "s1", type: "fallback", payload: {} });
    store.resolveApproval(a.id, "approved");
    expect(() => store.resolveApproval(a.id, "rejected")).toThrow(store.ApprovalStateError);
  });
});

// ── Endpoint tests ──────────────────────────────────────────────────────────
describe("approvals endpoints", () => {
  it("GET /api/approvals returns the pending queue", async () => {
    store.createApproval({ sessionId: "s1", type: "fallback", payload: {} });
    store.createApproval({ sessionId: "s1", type: "checkpoint", payload: { decisionNeeded: "Ship it", why: "Need a human" } });
    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/approvals"), cap.res, makeCtx());
    expect(cap.status).toBe(200);
    expect(Array.isArray(cap.body)).toBe(true);
    expect((cap.body as unknown[]).length).toBe(1);
    expect((cap.body as Array<{ type: string }>)[0]?.type).toBe("fallback");
  });

  it("GET /api/approvals can filter by sessionId", async () => {
    const a = store.createApproval({ sessionId: "s-hr", type: "org-change", payload: { changeRequestId: "cr-1" } });
    store.createApproval({ sessionId: "s-other", type: "fallback", payload: {} });
    const cap = makeRes();
    await api.handleApiRequest(makeReq("GET", "/api/approvals?sessionId=s-hr"), cap.res, makeCtx());
    expect(cap.status).toBe(200);
    expect(cap.body).toEqual([expect.objectContaining({ id: a.id, sessionId: "s-hr" })]);
  });

  it("approve on a missing approval → 404", async () => {
    const cap = makeRes();
    await api.handleApiRequest(makeReq("POST", "/api/approvals/nope/approve"), cap.res, makeCtx());
    expect(cap.status).toBe(404);
  });

  it("records an eligible delegated COO decision with an auditable actor", async () => {
    const prompt = "/delegate-authority decide\nReject the fallback.";
    const session = reg.createSession({
      engine: "claude",
      model: "opus",
      source: "web",
      sourceRef: "web:delegated-coo",
      employee: null,
      prompt,
      transportMeta: { operatorDelegation: buildOperatorDelegationGrant({ prompt, scopes: ["decide"] }) },
    });
    const approval = store.createApproval({ sessionId: session.id, type: "fallback", payload: {} });
    const req = makeReq("POST", `/api/approvals/${approval.id}/reject`) as any;
    req.cuttlefishPrincipal = {
      kind: "session",
      sessionId: session.id,
      delegatedScopes: ["decide"],
      operatorDelegationId: operatorDelegationPromptHash(prompt),
    };
    const cap = makeRes();
    await api.handleApiRequest(req, cap.res, makeCtx());

    expect(cap.status).toBe(200);
    expect(store.getApproval(approval.id)).toMatchObject({
      state: "rejected",
      actor: `operator-delegate:cuttlefish-coo:${session.id}`,
    });
  });

  it("approve on a non-pending approval → 409", async () => {
    // Payload carries a target engine so the route reaches the real state check
    // (a resolved, non-resumable fallback approval) rather than the earlier
    // "missing target engine" 400. The session s1 exists (FK-required), so the
    // route no longer short-circuits via the session-not-found branch.
    const a = store.createApproval({ sessionId: "s1", type: "fallback", payload: { to: { engine: "codex" } } });
    store.resolveApproval(a.id, "rejected");
    const cap = makeRes();
    // Provide the target engine so the route passes the availability (422) check
    // and reaches the real "already rejected" state check (409).
    await api.handleApiRequest(makeReq("POST", `/api/approvals/${a.id}/approve`), cap.res, makeCtx({
      sessionManager: { getEngine: () => ({}) },
    }));
    expect(cap.status).toBe(409);
  });

  it("rejects checkpoint ids on the generic approvals endpoints", async () => {
    const checkpoint = store.createApproval({
      sessionId: "s1",
      type: "checkpoint",
      payload: { decisionNeeded: "Delete report", why: "Destructive" },
    });

    const approveCap = makeRes();
    await api.handleApiRequest(makeReq("POST", `/api/approvals/${checkpoint.id}/approve`), approveCap.res, makeCtx());
    expect(approveCap.status).toBe(409);
    expect(approveCap.body).toEqual(expect.objectContaining({
      error: expect.stringContaining("/api/checkpoints"),
    }));

    const rejectCap = makeRes();
    await api.handleApiRequest(makeReq("POST", `/api/approvals/${checkpoint.id}/reject`), rejectCap.res, makeCtx());
    expect(rejectCap.status).toBe(409);
    expect(rejectCap.body).toEqual(expect.objectContaining({
      error: expect.stringContaining("/api/checkpoints"),
    }));
  });

  it("approve applies an org-change approval from the generic approvals dashboard route", async () => {
    const { createChangeRequest, getChangeRequest, updateChangeRequest } = await import("../org-changes.js");
    const employeeName = `approval-route-agent-${Date.now()}`;
    const request = createChangeRequest({
      changeType: "create_agent",
      employeeName,
      status: "pending_approval",
      riskLevel: "high",
      requiresHumanApproval: true,
      proposed: {
        displayName: "Approval Route Agent",
        department: "engineering",
        rank: "employee",
        engine: "claude",
        model: "sonnet",
        persona: "Created through the generic approvals route.",
      },
    });
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "employee:hr-manager",
      sessionKey: "employee:hr-manager",
      employee: "hr-manager",
      prompt: "approve org change",
    });
    const approval = store.createApproval({
      sessionId: session.id,
      type: "org-change",
      payload: { changeRequestId: request.id, changeType: request.changeType, employeeName, riskLevel: "high" },
    });
    updateChangeRequest(request.id, { approvalId: approval.id });

    const cap = makeRes();
    await api.handleApiRequest(makeReq("POST", `/api/approvals/${approval.id}/approve`), cap.res, makeCtx({
      getConfig: () => ({
        gateway: {},
        engines: { default: "claude" },
        models: {
          claude: {
            default: "sonnet",
            models: [{ id: "sonnet", supportsEffort: true, effortLevels: ["low", "medium", "high"] }],
          },
        },
      }),
      reloadOrg: vi.fn(),
    }));

    expect(cap.status).toBe(200);
    expect(store.getApproval(approval.id)?.state).toBe("approved");
    expect(getChangeRequest(request.id)?.status).toBe("applied");
    expect(fs.existsSync(path.join(tmp, "org", "engineering", `${employeeName}.yaml`))).toBe(true);
  });

  it("approve a fallback whose target engine is unavailable → 422", async () => {
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:e1", prompt: "x" });
    const a = store.createApproval({
      sessionId: s.id, type: "fallback",
      payload: { to: { engine: "codex", model: "gpt-5.5" }, handoffPath: "nope.md" },
    });
    const cap = makeRes();
    await api.handleApiRequest(makeReq("POST", `/api/approvals/${a.id}/approve`), cap.res, makeCtx({
      sessionManager: { getEngine: () => undefined }, // target engine gone
    }));
    expect(cap.status).toBe(422);
    expect(store.getApproval(a.id)?.state).toBe("pending"); // not resolved on 422
  });

  it("approve rolls the session to the fallback engine and dispatches", async () => {
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:e2", prompt: "x" });
    reg.updateSession(s.id, { engineSessionId: "eng-x" });
    const a = store.createApproval({
      sessionId: s.id, type: "fallback",
      payload: { to: { engine: "codex", model: "gpt-5.5" }, handoffPath: "nope.md" },
    });
    const enqueue = vi.fn(async () => { /* do not run the callback (no live engine) */ });
    const cap = makeRes();
    await api.handleApiRequest(makeReq("POST", `/api/approvals/${a.id}/approve`), cap.res, makeCtx({
      sessionManager: {
        getEngine: () => ({ run: vi.fn() }),
        getQueue: () => ({ enqueue, getPendingCount: () => 0, getTransportState: () => "running" }),
      },
    }));
    expect(cap.status).toBe(200);
    expect(store.getApproval(a.id)?.state).toBe("approved");
    const rolled = reg.getSession(s.id);
    expect(rolled?.engine).toBe("codex");
    expect(rolled?.model).toBe("gpt-5.5");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("retries a fallback approval cleanly if the first attempt fails before resolution", async () => {
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:e4", prompt: "x" });
    const a = store.createApproval({
      sessionId: s.id,
      type: "fallback",
      payload: { to: { engine: "codex", model: "gpt-5.5" }, handoffPath: "nope.md" },
    });
    const enqueue = vi.fn(async () => { /* do not run the callback (no live engine) */ });
    const resolveSpy = vi.spyOn(store, "resolveApproval");
    resolveSpy.mockImplementationOnce(() => {
      throw new Error("injected before resolve");
    });

    try {
      const failCap = makeRes();
      await api.handleApiRequest(makeReq("POST", `/api/approvals/${a.id}/approve`), failCap.res, makeCtx({
        sessionManager: {
          getEngine: () => ({ run: vi.fn() }),
          getQueue: () => ({ enqueue, getPendingCount: () => 0, getTransportState: () => "running" }),
        },
      }));

      expect(failCap.status).toBe(500);
      expect(store.getApproval(a.id)?.state).toBe("pending");
      const afterFail = reg.getSession(s.id);
      expect(afterFail?.engine).toBe("claude");
      expect(((afterFail?.transportMeta ?? {}) as Record<string, any>).modelFallback?.status).toBe("approval_resume_pending");
      expect(enqueue).toHaveBeenCalledTimes(0);

      const retryCap = makeRes();
      await api.handleApiRequest(makeReq("POST", `/api/approvals/${a.id}/approve`), retryCap.res, makeCtx({
        sessionManager: {
          getEngine: () => ({ run: vi.fn() }),
          getQueue: () => ({ enqueue, getPendingCount: () => 0, getTransportState: () => "running" }),
        },
      }));

      expect(retryCap.status).toBe(200);
      expect(store.getApproval(a.id)?.state).toBe("approved");
      const rolled = reg.getSession(s.id);
      expect(rolled?.engine).toBe("codex");
      expect(rolled?.model).toBe("gpt-5.5");
      expect(((rolled?.transportMeta ?? {}) as Record<string, any>).modelFallback?.status).toBe("running_on_fallback");
      expect(enqueue).toHaveBeenCalledTimes(1);

      const idempotentCap = makeRes();
      await api.handleApiRequest(makeReq("POST", `/api/approvals/${a.id}/approve`), idempotentCap.res, makeCtx({
        sessionManager: {
          getEngine: () => ({ run: vi.fn() }),
          getQueue: () => ({ enqueue, getPendingCount: () => 0, getTransportState: () => "running" }),
        },
      }));

      expect(idempotentCap.status).toBe(200);
      expect(enqueue).toHaveBeenCalledTimes(1);
    } finally {
      resolveSpy.mockRestore();
    }
  });

  it("reject marks the approval rejected and errors the session (surfaced, not stalled)", async () => {
    const s = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:e3", prompt: "x" });
    const a = store.createApproval({ sessionId: s.id, type: "fallback", payload: { to: { engine: "codex" } } });
    const cap = makeRes();
    await api.handleApiRequest(makeReq("POST", `/api/approvals/${a.id}/reject`), cap.res, makeCtx());
    expect(cap.status).toBe(200);
    expect(store.getApproval(a.id)?.state).toBe("rejected");
    expect(reg.getSession(s.id)?.status).toBe("error");
  });
});
