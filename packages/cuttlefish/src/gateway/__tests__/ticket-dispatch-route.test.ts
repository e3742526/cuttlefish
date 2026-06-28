import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import fs from "node:fs";
import path from "node:path";
import type { ServerResponse } from "node:http";

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

let tmpHome: string;
const testHome = withTempCuttlefishHome("cuttlefish-ticket-dispatch-route-");

beforeEach(() => {
  tmpHome = testHome.home();
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("../ticket-dispatch.js");
  vi.clearAllMocks();
});

describe("POST /api/org/departments/:name/tickets/:id/dispatch", () => {
  it("returns 400 when the ticket has no assignee", async () => {
    const deptDir = path.join(tmpHome, "org", "software-delivery");
    fs.mkdirSync(deptDir, { recursive: true });
    fs.writeFileSync(path.join(deptDir, "board.json"), JSON.stringify([
      {
        id: "ticket-1",
        title: "Run me",
        description: "But nobody owns me",
        status: "todo",
        priority: "medium",
        complexity: "medium",
        assignee: "",
        createdAt: "2026-06-22T00:00:00.000Z",
        updatedAt: "2026-06-22T00:00:00.000Z",
      },
    ]));

    const api = await import("../api.js");
    const cap = makeRes();
    const ctx = {
      getConfig: () => ({ gateway: {}, engines: { default: "claude", claude: { bin: "claude", model: "opus" } } }),
      connectors: new Map(),
      startTime: Date.now(),
      emit: vi.fn(),
      sessionManager: {
        getEngine: () => undefined,
        getQueue: () => ({ enqueue: vi.fn(), getPendingCount: () => 0, getTransportState: (_key: string, status: string) => status }),
      },
    } as any;

    await api.handleApiRequest(
      makeReq("POST", "/api/org/departments/software-delivery/tickets/ticket-1/dispatch"),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(400);
    expect(cap.body).toMatchObject({ reason: "no-assignee" });
  }, 15_000);

  it("rejects a ticket assigned to an employee from another department without creating a session", async () => {
    const softwareDir = path.join(tmpHome, "org", "software-delivery");
    const researchDir = path.join(tmpHome, "org", "research");
    fs.mkdirSync(softwareDir, { recursive: true });
    fs.mkdirSync(researchDir, { recursive: true });
    fs.writeFileSync(path.join(researchDir, "researcher.yaml"), [
      "name: researcher",
      "displayName: Researcher",
      "department: research",
      "rank: employee",
      "engine: claude",
      "model: opus",
      "persona: researcher",
    ].join("\n"));
    fs.writeFileSync(path.join(softwareDir, "board.json"), JSON.stringify([
      {
        id: "ticket-foreign",
        title: "Run me elsewhere",
        description: "Wrong department",
        status: "todo",
        priority: "medium",
        complexity: "medium",
        assignee: "researcher",
        createdAt: "2026-06-22T00:00:00.000Z",
        updatedAt: "2026-06-22T00:00:00.000Z",
      },
    ]));

    const api = await import("../api.js");
    const registry = await import("../../sessions/registry.js");
    const cap = makeRes();
    const ctx = {
      getConfig: () => ({ gateway: {}, engines: { default: "claude", claude: { bin: "claude", model: "opus" } } }),
      connectors: new Map(),
      startTime: Date.now(),
      emit: vi.fn(),
      sessionManager: {
        getEngine: () => {
          throw new Error("engine should not be resolved for rejected dispatch");
        },
        getQueue: () => ({ enqueue: vi.fn(), getPendingCount: () => 0, getTransportState: (_key: string, status: string) => status }),
      },
    } as any;

    await api.handleApiRequest(
      makeReq("POST", "/api/org/departments/software-delivery/tickets/ticket-foreign/dispatch"),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(400);
    expect(cap.body).toMatchObject({ reason: "foreign-department-assignee" });
    expect(registry.listSessions()).toHaveLength(0);
  }, 15_000);

  it("maps orchestration allocation failures to 409", async () => {
    vi.doMock("../ticket-dispatch.js", () => ({
      dispatchTicket: vi.fn(() => ({ ok: false, reason: "orchestration-busy" })),
    }));
    const api = await import("../api.js");
    const cap = makeRes();
    const ctx = {
      getConfig: () => ({ gateway: {}, engines: { default: "claude", claude: { bin: "claude", model: "opus" } } }),
      connectors: new Map(),
      startTime: Date.now(),
      emit: vi.fn(),
      sessionManager: {
        getEngine: () => undefined,
        getQueue: () => ({ enqueue: vi.fn(), getPendingCount: () => 0, getTransportState: (_key: string, status: string) => status }),
      },
    } as any;

    await api.handleApiRequest(
      makeReq("POST", "/api/org/departments/software-delivery/tickets/ticket-1/dispatch"),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(409);
    expect(cap.body).toMatchObject({ reason: "orchestration-busy" });
  }, 15_000);

  it("maps manual-only and invalid-resource failures cleanly", async () => {
    vi.doMock("../ticket-dispatch.js", () => ({
      dispatchTicket: vi
        .fn()
        .mockReturnValueOnce({ ok: false, reason: "manual-only" })
        .mockReturnValueOnce({ ok: false, reason: "invalid-resource" }),
    }));
    const api = await import("../api.js");
    const ctx = {
      getConfig: () => ({ gateway: {}, engines: { default: "claude", claude: { bin: "claude", model: "opus" } } }),
      connectors: new Map(),
      startTime: Date.now(),
      emit: vi.fn(),
      sessionManager: {
        getEngine: () => undefined,
        getQueue: () => ({ enqueue: vi.fn(), getPendingCount: () => 0, getTransportState: (_key: string, status: string) => status }),
      },
    } as any;

    const manualCap = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/org/departments/software-delivery/tickets/ticket-1/dispatch"),
      manualCap.res,
      ctx,
    );
    expect(manualCap.status).toBe(409);
    expect(manualCap.body).toMatchObject({ reason: "manual-only" });

    const resourceCap = makeRes();
    await api.handleApiRequest(
      makeReq("POST", "/api/org/departments/software-delivery/tickets/ticket-1/dispatch"),
      resourceCap.res,
      ctx,
    );
    expect(resourceCap.status).toBe(400);
    expect(resourceCap.body).toMatchObject({ reason: "invalid-resource" });
  }, 15_000);
});
