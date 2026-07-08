import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import fs from "node:fs";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";

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
    getConfig: () => ({
      gateway: {},
      engines: {
        default: "claude",
        claude: { bin: "claude", model: "opus" },
        codex: { bin: "codex", model: "gpt-5.5" },
      },
      models: {
        claude: {
          default: "opus",
          effortMechanism: "claude-flag",
          models: [
            { id: "opus", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
            { id: "sonnet", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
          ],
        },
        codex: {
          default: "gpt-5.5",
          effortMechanism: "codex-config",
          models: [
            { id: "gpt-5.5", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh"] },
          ],
        },
      },
    }),
    connectors: new Map(),
    startTime: Date.now(),
    emit: vi.fn(),
    reloadOrg: vi.fn(),
  } as any;
}

function writeEmployee(home: string, dept: string, name: string, rank = "employee", extra: string[] = []) {
  const dir = path.join(home, "org", dept);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.yaml`),
    [
      `name: ${name}`,
      `displayName: ${name}`,
      `department: ${dept}`,
      `rank: ${rank}`,
      "engine: claude",
      "model: opus",
      "effortLevel: medium",
      `persona: ${name}`,
      ...extra,
    ].join("\n"),
  );
}

function readEmployee(home: string, dept: string, name: string): string {
  return fs.readFileSync(path.join(home, "org", dept, `${name}.yaml`), "utf-8");
}

const testHome = withTempCuttlefishHome("cuttlefish-org-manager-route-");
let tmpHome: string;

beforeEach(() => {
  tmpHome = testHome.home();
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("PATCH /api/org/employees/:name manager scope", () => {
  it("allows a manager to switch model fields for a direct report", async () => {
    writeEmployee(tmpHome, "platform", "boss", "manager");
    writeEmployee(tmpHome, "platform", "worker", "employee", ["reportsTo: boss"]);

    const api = await import("../api.js");
    const cap = makeRes();
    await api.handleApiRequest(
      makeJsonReq("PATCH", "/api/org/employees/worker", {
        managerName: "boss",
        engine: "codex",
        model: "gpt-5.5",
        effortLevel: "high",
      }),
      cap.res,
      makeCtx(),
    );

    expect(cap.status).toBe(200);
    expect(cap.body).toMatchObject({
      status: "ok",
      employee: { engine: "codex", model: "gpt-5.5", effortLevel: "high" },
    });
    expect(readEmployee(tmpHome, "platform", "worker")).toContain("engine: codex");
    expect(readEmployee(tmpHome, "platform", "worker")).toContain("model: gpt-5.5");
  });

  it("rejects manager-scoped edits outside model-routing fields", async () => {
    writeEmployee(tmpHome, "platform", "boss", "manager");
    writeEmployee(tmpHome, "platform", "worker", "employee", ["reportsTo: boss"]);

    const api = await import("../api.js");
    const cap = makeRes();
    await api.handleApiRequest(
      makeJsonReq("PATCH", "/api/org/employees/worker", {
        managerName: "boss",
        persona: "new persona",
      }),
      cap.res,
      makeCtx(),
    );

    expect(cap.status).toBe(403);
    expect(cap.body.error).toContain("manager-scoped employee updates may only modify");
    expect(readEmployee(tmpHome, "platform", "worker")).toContain("persona: worker");
  });

  it("rejects manager-scoped edits for employees outside the manager's hierarchy", async () => {
    writeEmployee(tmpHome, "platform", "boss", "manager");
    writeEmployee(tmpHome, "platform", "other-boss", "manager");
    writeEmployee(tmpHome, "platform", "other-worker", "employee", ["reportsTo: other-boss"]);

    const api = await import("../api.js");
    const cap = makeRes();
    await api.handleApiRequest(
      makeJsonReq("PATCH", "/api/org/employees/other-worker", {
        managerName: "boss",
        model: "sonnet",
      }),
      cap.res,
      makeCtx(),
    );

    expect(cap.status).toBe(403);
    expect(cap.body.error).toContain("outside boss's hierarchy");
  });

  it("rejects a session-scoped principal claiming a manager identity that isn't its own (Ledger-0007 Finding 4)", async () => {
    writeEmployee(tmpHome, "platform", "boss", "manager");
    writeEmployee(tmpHome, "platform", "worker", "employee", ["reportsTo: boss"]);

    const api = await import("../api.js");
    const reg = await import("../../sessions/registry.js");
    reg.initDb();
    const impostorSession = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:impostor", employee: "worker", prompt: "hi" });

    const req = makeJsonReq("PATCH", "/api/org/employees/worker", {
      managerName: "boss",
      model: "sonnet",
    });
    (req as any).cuttlefishPrincipal = { kind: "session", sessionId: impostorSession.id };

    const cap = makeRes();
    await api.handleApiRequest(req, cap.res, makeCtx());

    expect(cap.status).toBe(403);
    expect(cap.body.error).toContain("own bound manager identity");
    expect(readEmployee(tmpHome, "platform", "worker")).not.toContain("model: sonnet");
  });

  it("allows a session-scoped principal to claim its own bound manager identity", async () => {
    writeEmployee(tmpHome, "platform", "boss", "manager");
    writeEmployee(tmpHome, "platform", "worker", "employee", ["reportsTo: boss"]);

    const api = await import("../api.js");
    const reg = await import("../../sessions/registry.js");
    reg.initDb();
    const bossSession = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:boss", employee: "boss", prompt: "hi" });

    const req = makeJsonReq("PATCH", "/api/org/employees/worker", {
      managerName: "boss",
      model: "sonnet",
    });
    (req as any).cuttlefishPrincipal = { kind: "session", sessionId: bossSession.id };

    const cap = makeRes();
    await api.handleApiRequest(req, cap.res, makeCtx());

    expect(cap.status).toBe(200);
    expect(readEmployee(tmpHome, "platform", "worker")).toContain("model: sonnet");
  });
});
