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

function makeCtx() {
  return {
    getConfig: () => ({ gateway: {}, engines: { default: "claude", claude: { bin: "claude", model: "opus" } } }),
    connectors: new Map(),
    startTime: Date.now(),
    emit: vi.fn(),
    reloadOrg: vi.fn(),
  } as any;
}

function writeEmployee(home: string, dept: string, name: string, extra: string[] = []) {
  const dir = path.join(home, "org", dept);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.yaml`),
    [
      `name: ${name}`,
      `displayName: ${name}`,
      `department: ${dept}`,
      "rank: employee",
      "engine: claude",
      "model: opus",
      `persona: ${name}`,
      ...extra,
    ].join("\n"),
  );
}

const testHome = withTempCuttlefishHome("cuttlefish-org-delete-route-");
let tmpHome: string;

beforeEach(() => {
  tmpHome = testHome.home();
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("DELETE /api/org/employees/:name", () => {
  it("deletes an employee with no reports", async () => {
    writeEmployee(tmpHome, "platform", "lonely");

    const api = await import("../api.js");
    const cap = makeRes();
    await api.handleApiRequest(makeReq("DELETE", "/api/org/employees/lonely"), cap.res, makeCtx());

    expect(cap.status).toBe(200);
    expect(cap.body).toMatchObject({ status: "ok" });
    expect(fs.existsSync(path.join(tmpHome, "org", "platform", "lonely.yaml"))).toBe(false);
  });

  it("archives tickets assigned to the removed employee", async () => {
    writeEmployee(tmpHome, "platform", "lonely");
    const boardPath = path.join(tmpHome, "org", "platform", "board.json");
    fs.writeFileSync(boardPath, JSON.stringify([
      { id: "assigned", title: "Assigned", description: "", status: "todo", priority: "medium", assignee: "lonely", createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:00:00.000Z" },
      { id: "keep", title: "Keep", description: "", status: "todo", priority: "medium", assignee: "", createdAt: "2026-07-13T00:00:00.000Z", updatedAt: "2026-07-13T00:00:00.000Z" },
    ]));

    const api = await import("../api.js");
    const ctx = makeCtx();
    const cap = makeRes();
    await api.handleApiRequest(makeReq("DELETE", "/api/org/employees/lonely"), cap.res, ctx);

    expect(cap.status).toBe(200);
    const board = JSON.parse(fs.readFileSync(boardPath, "utf-8"));
    expect(board.tickets.map((ticket: { id: string }) => ticket.id)).toEqual(["keep"]);
    expect(board.deletedTickets.map((ticket: { id: string }) => ticket.id)).toEqual(["assigned"]);
    expect(ctx.emit).toHaveBeenCalledWith("board:updated", { department: "platform" });
  });

  it("returns 409 and keeps the file when an employee still has reports", async () => {
    writeEmployee(tmpHome, "platform", "boss");
    writeEmployee(tmpHome, "platform", "minion", ["reportsTo: boss"]);

    const api = await import("../api.js");
    const cap = makeRes();
    await api.handleApiRequest(makeReq("DELETE", "/api/org/employees/boss"), cap.res, makeCtx());

    expect(cap.status).toBe(409);
    expect(cap.body.reports).toEqual(["minion"]);
    expect(fs.existsSync(path.join(tmpHome, "org", "platform", "boss.yaml"))).toBe(true);
  });

  it("blocks deletion for secondary (matrix) reportsTo links too", async () => {
    writeEmployee(tmpHome, "platform", "primary-mgr");
    writeEmployee(tmpHome, "platform", "matrix-mgr");
    writeEmployee(tmpHome, "platform", "worker", ["reportsTo:", "  - primary-mgr", "  - matrix-mgr"]);

    const api = await import("../api.js");
    const cap = makeRes();
    await api.handleApiRequest(makeReq("DELETE", "/api/org/employees/matrix-mgr"), cap.res, makeCtx());

    expect(cap.status).toBe(409);
    expect(cap.body.reports).toEqual(["worker"]);
  });

  it("returns 404 for an unknown employee", async () => {
    writeEmployee(tmpHome, "platform", "exists");

    const api = await import("../api.js");
    const cap = makeRes();
    await api.handleApiRequest(makeReq("DELETE", "/api/org/employees/ghost"), cap.res, makeCtx());

    expect(cap.status).toBe(404);
  });
});
