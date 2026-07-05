import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
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

function makeReq(method: string, urlPath: string, headers: Record<string, string> = {}) {
  return {
    method,
    url: urlPath,
    headers: { host: "localhost", ...headers },
  } as any;
}

const testHome = withTempCuttlefishHome("cuttlefish-org-approval-route-");
let tmpHome: string;

beforeEach(() => {
  tmpHome = testHome.home();
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("org approval routes", () => {
  it("resolves the approval and records continuation messages in the existing HR chat", async () => {
    const api = await import("../api.js");
    const reg = await import("../../sessions/registry.js");
    const approvals = await import("../approvals.js");
    const changes = await import("../org-changes.js");

    reg.initDb();

    const ctx = {
      getConfig: () => ({
        gateway: { userHeader: "x-user" },
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
      }),
      connectors: new Map(),
      startTime: Date.now(),
      emit: vi.fn(),
      reloadOrg: vi.fn(),
      sessionManager: { getEngine: () => undefined },
    } as any;

    const hrSession = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:hr-current",
      sessionKey: "employee:hr-manager",
      employee: "hr-manager",
      prompt: "Review this onboarding request",
    });

    const request = changes.createChangeRequest({
      changeType: "create_agent",
      employeeName: "new-hire",
      proposed: {
        displayName: "New Hire",
        department: "engineering",
        rank: "employee",
        engine: "claude",
        model: "sonnet",
        persona: "A new teammate.",
      },
      status: "pending_approval",
      proposedBy: "operator",
      riskLevel: "high",
      requiresHumanApproval: true,
    });
    const approval = approvals.createApproval({
      sessionId: hrSession.id,
      type: "org-change",
      payload: { changeRequestId: request.id },
    });
    changes.updateChangeRequest(request.id, { approvalId: approval.id });

    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/org/change-requests/${request.id}/approve`, { "x-user": "Alice" }),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(200);
    expect(approvals.getApproval(approval.id)?.state).toBe("approved");
    expect(changes.getChangeRequest(request.id)?.status).toBe("applied");
    expect(reg.getMessages(hrSession.id).filter((message) => message.role === "assistant").map((message) => message.content)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Human approval received from Alice"),
        expect.stringContaining('The approved create_agent for "new-hire" has been applied successfully.'),
      ]),
    );
    expect(ctx.emit).toHaveBeenCalledWith(
      "approval:resolved",
      expect.objectContaining({ approvalId: approval.id, sessionId: hrSession.id, state: "approved" }),
    );
    expect(ctx.emit).toHaveBeenCalledWith("session:updated", { sessionId: hrSession.id });
  });

  it("rejects applying a request that is not pending approval", async () => {
    const api = await import("../api.js");
    const reg = await import("../../sessions/registry.js");
    const changes = await import("../org-changes.js");

    reg.initDb();

    const ctx = {
      getConfig: () => ({
        gateway: { userHeader: "x-user" },
        engines: { default: "claude", claude: { bin: "claude", model: "sonnet" } },
        portal: {},
        models: { claude: { default: "sonnet", models: [{ id: "sonnet", supportsEffort: true, effortLevels: ["low", "medium", "high"] }] } },
      }),
      connectors: new Map(),
      startTime: Date.now(),
      emit: vi.fn(),
      reloadOrg: vi.fn(),
      sessionManager: { getEngine: () => undefined },
    } as any;

    const request = changes.createChangeRequest({
      changeType: "create_agent",
      employeeName: "draft-hire",
      proposed: {
        displayName: "Draft Hire",
        department: "engineering",
        rank: "employee",
        engine: "claude",
        model: "sonnet",
        persona: "Draft persona.",
      },
      status: "rejected",
      proposedBy: "operator",
      riskLevel: "high",
      requiresHumanApproval: true,
    });

    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/org/change-requests/${request.id}/apply`, { "x-user": "Alice" }),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(409);
    expect(cap.body).toEqual({ error: "Change request is 'rejected' and cannot be applied" });
  });

  it("direct apply resolves the linked approval and records the human actor", async () => {
    const api = await import("../api.js");
    const reg = await import("../../sessions/registry.js");
    const approvals = await import("../approvals.js");
    const changes = await import("../org-changes.js");

    reg.initDb();

    const ctx = {
      getConfig: () => ({
        gateway: { userHeader: "x-user" },
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
      }),
      connectors: new Map(),
      startTime: Date.now(),
      emit: vi.fn(),
      reloadOrg: vi.fn(),
      sessionManager: { getEngine: () => undefined },
    } as any;

    const hrSession = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:hr-current",
      sessionKey: "employee:hr-manager",
      employee: "hr-manager",
      prompt: "Review this onboarding request",
    });

    const request = changes.createChangeRequest({
      changeType: "create_agent",
      employeeName: "new-hire",
      proposed: {
        displayName: "New Hire",
        department: "engineering",
        rank: "employee",
        engine: "claude",
        model: "sonnet",
        persona: "A new teammate.",
      },
      status: "pending_approval",
      proposedBy: "operator",
      riskLevel: "high",
      requiresHumanApproval: true,
    });
    const approval = approvals.createApproval({
      sessionId: hrSession.id,
      type: "org-change",
      payload: { changeRequestId: request.id },
    });
    changes.updateChangeRequest(request.id, { approvalId: approval.id });

    const cap = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/org/change-requests/${request.id}/apply`, { "x-user": "Alice" }),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(200);
    expect(approvals.getApproval(approval.id)).toEqual(expect.objectContaining({ state: "approved", actor: "Alice" }));
    expect(changes.getChangeRequest(request.id)?.status).toBe("applied");
    expect(reg.getMessages(hrSession.id).filter((message) => message.role === "assistant").map((message) => message.content)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Human approval received from Alice"),
        expect.stringContaining('The approved create_agent for "new-hire" has been applied successfully.'),
      ]),
    );
    expect(ctx.emit).toHaveBeenCalledWith(
      "approval:resolved",
      expect.objectContaining({ approvalId: approval.id, sessionId: hrSession.id, state: "approved" }),
    );
  });

  it("reject refuses to overwrite an already-applied change request", async () => {
    const api = await import("../api.js");
    const reg = await import("../../sessions/registry.js");
    const approvals = await import("../approvals.js");
    const changes = await import("../org-changes.js");

    reg.initDb();

    const ctx = {
      getConfig: () => ({
        gateway: { userHeader: "x-user" },
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
      }),
      connectors: new Map(),
      startTime: Date.now(),
      emit: vi.fn(),
      reloadOrg: vi.fn(),
      sessionManager: { getEngine: () => undefined },
    } as any;

    const hrSession = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:hr-current",
      sessionKey: "employee:hr-manager",
      employee: "hr-manager",
      prompt: "Review this onboarding request",
    });

    const request = changes.createChangeRequest({
      changeType: "create_agent",
      employeeName: "new-hire",
      proposed: {
        displayName: "New Hire",
        department: "engineering",
        rank: "employee",
        engine: "claude",
        model: "sonnet",
        persona: "A new teammate.",
      },
      status: "pending_approval",
      proposedBy: "operator",
      riskLevel: "high",
      requiresHumanApproval: true,
    });
    const approval = approvals.createApproval({
      sessionId: hrSession.id,
      type: "org-change",
      payload: { changeRequestId: request.id },
    });
    changes.updateChangeRequest(request.id, { approvalId: approval.id });

    const applyCap = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/org/change-requests/${request.id}/apply`, { "x-user": "Alice" }),
      applyCap.res,
      ctx,
    );
    expect(applyCap.status).toBe(200);

    const rejectCap = makeRes();
    await api.handleApiRequest(
      makeReq("POST", `/api/org/change-requests/${request.id}/reject`, { "x-user": "Bob" }),
      rejectCap.res,
      ctx,
    );

    expect(rejectCap.status).toBe(409);
    expect(rejectCap.body).toEqual({ error: "change is applied, not awaiting approval" });
    expect(changes.getChangeRequest(request.id)?.status).toBe("applied");
    expect(approvals.getApproval(approval.id)?.state).toBe("approved");
  });
});
