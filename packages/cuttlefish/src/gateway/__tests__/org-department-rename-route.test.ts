import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import yaml from "js-yaml";

const testHome = withTempCuttlefishHome("cuttlefish-org-dept-rename-");
let tmpHome: string;

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

function makeJsonReq(method: string, urlPath: string, body: unknown) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as any;
  Object.assign(req, {
    method,
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json" },
  });
  return req;
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

function writeEmployee(dept: string, name: string): void {
  const dir = path.join(tmpHome, "org", dept);
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
    ].join("\n"),
  );
}

function readEmployee(dept: string, name: string): Record<string, unknown> {
  return yaml.load(fs.readFileSync(path.join(tmpHome, "org", dept, `${name}.yaml`), "utf-8")) as Record<string, unknown>;
}

beforeEach(() => {
  tmpHome = testHome.home();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PATCH /api/org/departments/:name", () => {
  it("renames matching employee departments and moves the board directory", async () => {
    writeEmployee("platform", "dev");
    fs.writeFileSync(path.join(tmpHome, "org", "platform", "board.json"), JSON.stringify([{ id: "t1", status: "todo" }]));
    const api = await import("../api.js");
    const ctx = makeCtx();
    const cap = makeRes();

    await api.handleApiRequest(
      makeJsonReq("PATCH", "/api/org/departments/platform", { name: "product" }),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(200);
    expect(cap.body).toMatchObject({
      status: "ok",
      previousDepartment: "platform",
      department: "product",
      employees: ["dev"],
      movedDirectory: true,
    });
    expect(fs.existsSync(path.join(tmpHome, "org", "platform"))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, "org", "product", "board.json"))).toBe(true);
    expect(readEmployee("product", "dev").department).toBe("product");
    expect(ctx.reloadOrg).toHaveBeenCalled();
    expect(ctx.emit).toHaveBeenCalledWith("org:updated", expect.objectContaining({ action: "department-renamed" }));
  });

  it("rejects rename into an existing department", async () => {
    writeEmployee("platform", "dev");
    writeEmployee("product", "pm");
    const api = await import("../api.js");
    const cap = makeRes();

    await api.handleApiRequest(
      makeJsonReq("PATCH", "/api/org/departments/platform", { name: "product" }),
      cap.res,
      makeCtx(),
    );

    expect(cap.status).toBe(409);
  });

  it("rolls back employee updates when the department directory move fails", async () => {
    writeEmployee("platform", "dev");
    fs.writeFileSync(path.join(tmpHome, "org", "platform", "board.json"), JSON.stringify([{ id: "t1", status: "todo" }]));
    const oldDir = path.join(tmpHome, "org", "platform");
    const newDir = path.join(tmpHome, "org", "product");
    const originalRenameSync = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (from === oldDir && to === newDir) throw new Error("rename blocked");
      return originalRenameSync(from, to);
    });
    const api = await import("../api.js");
    const ctx = makeCtx();
    const cap = makeRes();

    await api.handleApiRequest(
      makeJsonReq("PATCH", "/api/org/departments/platform", { name: "product" }),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(409);
    expect(cap.body.error).toContain("failed to move department directory");
    expect(fs.existsSync(path.join(tmpHome, "org", "platform", "board.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, "org", "product"))).toBe(false);
    expect(readEmployee("platform", "dev").department).toBe("platform");
    expect(ctx.reloadOrg).not.toHaveBeenCalled();
    expect(ctx.emit).not.toHaveBeenCalledWith("org:updated", expect.anything());
  });

  it("rolls back earlier employee updates when a later employee update fails", async () => {
    writeEmployee("platform", "alpha");
    writeEmployee("platform", "beta");
    const org = await import("../org.js");
    const originalUpdateEmployeeYaml = org.updateEmployeeYaml;
    vi.spyOn(org, "updateEmployeeYaml").mockImplementation((name, updates) => {
      if (name === "beta") return false;
      return originalUpdateEmployeeYaml(name, updates);
    });
    const { renameDepartment } = await import("../department-rename.js");

    const result = renameDepartment("platform", "product");

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result.ok ? "" : result.error).toContain('failed to update employee "beta"');
    expect(fs.existsSync(path.join(tmpHome, "org", "product"))).toBe(false);
    expect(readEmployee("platform", "alpha").department).toBe("platform");
    expect(readEmployee("platform", "beta").department).toBe("platform");
  });
});
