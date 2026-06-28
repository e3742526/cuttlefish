import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";

/**
 * Route-level tests for two hardened GET handlers in ../api.ts:
 *   - GET /api/cron/:id/runs   → skips corrupt JSONL lines, returns the good rows
 *   - GET /api/org/departments/:name/board → 500s on a corrupt board.json
 *
 * Both handlers resolve their on-disk paths from CRON_RUNS / ORG_DIR in
 * ../../shared/paths.js, so we mock that module to point at a temp dir. The
 * handlers return early (before touching session/connector state), so a minimal
 * ApiContext stub is sufficient. We drive handleApiRequest directly with fake
 * req/res objects — no HTTP server boot required.
 */

// Initialized at module load (before the mocked paths.js getters can be hit by
// import-time consumers like usageAwareness.ts). Re-pointed per test in beforeEach.
const bootHome = fs.mkdtempSync(path.join(os.tmpdir(), "route-harden-boot-"));
let tmpHome = bootHome;
let cronRunsDir = path.join(tmpHome, "cron", "runs");
let orgDir = path.join(tmpHome, "org");

vi.mock("../../shared/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/paths.js")>();
  return {
    ...actual,
    // Only override the two dirs the target routes read. CUTTLEFISH_HOME is left as
    // the real value so import-time consumers don't break.
    get CRON_RUNS() {
      return cronRunsDir;
    },
    get ORG_DIR() {
      return orgDir;
    },
  };
});

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { handleApiRequest } from "../api.js";
import type { ApiContext } from "../api.js";
import { invalidateModelRegistry } from "../../shared/models.js";

interface CapturedRes {
  res: ServerResponse;
  get status(): number;
  get body(): unknown;
}

function makeRes(): CapturedRes {
  let status = 200;
  let chunks: Buffer[] = [];
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

function makeReq(method: string, urlPath: string, body?: unknown) {
  const req = body === undefined
    ? Readable.from([])
    : Readable.from([Buffer.from(JSON.stringify(body))]);
  return Object.assign(req, {
    method,
    url: urlPath,
    headers: { host: "localhost" },
  }) as unknown as Parameters<typeof handleApiRequest>[0];
}

// Minimal context — the target routes return before reading these fields.
const ctx = {
  getConfig: () => ({ gateway: {}, engines: {} }),
  connectors: new Map(),
  startTime: Date.now(),
} as unknown as ApiContext;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "route-harden-"));
  cronRunsDir = path.join(tmpHome, "cron", "runs");
  orgDir = path.join(tmpHome, "org");
  fs.mkdirSync(cronRunsDir, { recursive: true });
  fs.mkdirSync(orgDir, { recursive: true });
});

afterEach(() => {
  if (tmpHome && fs.existsSync(tmpHome)) fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.clearAllMocks();
});

afterAll(() => {
  if (fs.existsSync(bootHome)) fs.rmSync(bootHome, { recursive: true, force: true });
});

describe("GET /api/cron/:id/runs — corrupt-line tolerance", () => {
  it("skips a dangling/corrupt JSONL line and returns the good rows, newest first", async () => {
    const good1 = JSON.stringify({ ts: "2026-01-01T00:00:00Z", ok: true });
    const good2 = JSON.stringify({ ts: "2026-01-02T00:00:00Z", ok: false });
    // A crash mid-write can leave a half-written final line.
    const corrupt = '{"ts":"2026-01-03T00:00:00Z","ok"';
    fs.writeFileSync(path.join(cronRunsDir, "my-job.jsonl"), [good1, corrupt, good2].join("\n"));

    const cap = makeRes();
    await handleApiRequest(makeReq("GET", "/api/cron/my-job/runs"), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect(Array.isArray(cap.body)).toBe(true);
    expect(cap.body).toEqual([
      { ts: "2026-01-02T00:00:00Z", ok: false },
      { ts: "2026-01-01T00:00:00Z", ok: true },
    ]);
  });

  it("honors ?limit=N, returning only the newest N runs", async () => {
    const lines = [1, 2, 3, 4].map((n) => JSON.stringify({ n }));
    fs.writeFileSync(path.join(cronRunsDir, "my-job.jsonl"), lines.join("\n") + "\n");

    const cap = makeRes();
    await handleApiRequest(makeReq("GET", "/api/cron/my-job/runs?limit=2"), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect(cap.body).toEqual([{ n: 4 }, { n: 3 }]);
  });

  it("returns [] when the run file does not exist", async () => {
    const cap = makeRes();
    await handleApiRequest(makeReq("GET", "/api/cron/no-such-job/runs"), cap.res, ctx);
    expect(cap.status).toBe(200);
    expect(cap.body).toEqual([]);
  });
});

describe("GET /api/org — department list", () => {
  it("excludes reserved org artifact directories from departments", async () => {
    fs.mkdirSync(path.join(orgDir, "_changes"), { recursive: true });
    fs.mkdirSync(path.join(orgDir, "general"), { recursive: true });
    fs.writeFileSync(path.join(orgDir, "general", "parliamentarian.yaml"), `
name: parliamentarian
displayName: Parliamentarian
department: general
rank: manager
engine: claude
model: sonnet
persona: Keeps order.
`);

    const cap = makeRes();
    await handleApiRequest(makeReq("GET", "/api/org"), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect((cap.body as { departments: string[] }).departments).toEqual(["general"]);
  });
});

describe("GET /api/org/departments/:name/board — corrupt board.json", () => {
  it("returns 500 when board.json is not valid JSON", async () => {
    const deptDir = path.join(orgDir, "platform");
    fs.mkdirSync(deptDir, { recursive: true });
    fs.writeFileSync(path.join(deptDir, "board.json"), "{ this is not json ]");

    const cap = makeRes();
    await handleApiRequest(makeReq("GET", "/api/org/departments/platform/board"), cap.res, ctx);

    expect(cap.status).toBe(500);
    expect(cap.body).toMatchObject({ error: expect.stringContaining("corrupt") });
  });

  it("returns 200 with the normalized board state when board.json is valid", async () => {
    const deptDir = path.join(orgDir, "platform");
    fs.mkdirSync(deptDir, { recursive: true });
    const board = [{
      id: "ticket-1",
      title: "One",
      description: "",
      status: "todo",
      priority: "medium",
      assignee: "a",
      createdAt: "2026-06-22T00:00:00.000Z",
      updatedAt: "2026-06-22T00:00:00.000Z",
    }];
    fs.writeFileSync(path.join(deptDir, "board.json"), JSON.stringify(board));

    const cap = makeRes();
    await handleApiRequest(makeReq("GET", "/api/org/departments/platform/board"), cap.res, ctx);

    expect(cap.status).toBe(200);
    expect(cap.body).toEqual({
      tickets: board,
      deletedTickets: [],
      retentionDays: 3,
    });
  });
});

describe("PUT /api/org/departments/:name/board — assignee department boundary", () => {
  it("rejects a ticket assigned to an employee from another department", async () => {
    const softwareDir = path.join(orgDir, "software-delivery");
    const researchDir = path.join(orgDir, "research");
    fs.mkdirSync(softwareDir, { recursive: true });
    fs.mkdirSync(researchDir, { recursive: true });
    fs.writeFileSync(path.join(softwareDir, "board.json"), JSON.stringify([]));
    fs.writeFileSync(path.join(researchDir, "researcher.yaml"), [
      "name: researcher",
      "displayName: Researcher",
      "department: research",
      "rank: employee",
      "engine: claude",
      "model: opus",
      "persona: researcher",
    ].join("\n"));

    const cap = makeRes();
    await handleApiRequest(
      makeReq("PUT", "/api/org/departments/software-delivery/board", {
        tickets: [{
          id: "ticket-foreign",
          title: "Wrong board",
          description: "",
          status: "todo",
          priority: "medium",
          complexity: "medium",
          assignee: "researcher",
          createdAt: "2026-06-22T00:00:00.000Z",
          updatedAt: "2026-06-22T00:00:00.000Z",
        }],
      }),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(400);
    expect(cap.body).toMatchObject({
      error: expect.stringContaining("belongs to department"),
    });
    expect(JSON.parse(fs.readFileSync(path.join(softwareDir, "board.json"), "utf-8"))).toEqual([]);
  });
});

describe("PUT /api/org/departments/:name/board — optimistic concurrency", () => {
  it("returns 409 when a stale board save would overwrite active session state", async () => {
    const softwareDir = path.join(orgDir, "software-delivery");
    fs.mkdirSync(softwareDir, { recursive: true });
    fs.writeFileSync(path.join(softwareDir, "board.json"), JSON.stringify([{
      id: "ticket-running",
      title: "Running",
      description: "",
      status: "in_progress",
      priority: "medium",
      complexity: "medium",
      assignee: "worker",
      source: "session",
      sessionId: "session-123",
      createdAt: "2026-06-22T00:00:00.000Z",
      updatedAt: "2026-06-22T01:00:00.000Z",
    }]));

    const cap = makeRes();
    await handleApiRequest(
      makeReq("PUT", "/api/org/departments/software-delivery/board", {
        tickets: [{
          id: "ticket-running",
          title: "Running",
          description: "",
          status: "todo",
          priority: "medium",
          complexity: "medium",
          assignee: "worker",
          createdAt: "2026-06-22T00:00:00.000Z",
          updatedAt: "2026-06-22T00:00:00.000Z",
          baseUpdatedAt: "2026-06-22T00:00:00.000Z",
        }],
      }),
      cap.res,
      ctx,
    );

    expect(cap.status).toBe(409);
    expect(cap.body).toMatchObject({
      reason: "board-conflict",
      ticketIds: ["ticket-running"],
    });
    const stored = JSON.parse(fs.readFileSync(path.join(softwareDir, "board.json"), "utf-8"));
    expect(stored[0]).toMatchObject({
      status: "in_progress",
      sessionId: "session-123",
    });
  });
});

describe("GET /api/status", () => {
  it("reports error when no configured engine is available", async () => {
    invalidateModelRegistry();
    const statusCtx = {
      getConfig: () => ({
        gateway: { port: 8888, host: "127.0.0.1" },
        engines: {
          default: "claude",
          claude: { bin: "__cuttlefish_missing_engine_for_status_test__", model: "opus" },
          codex: { bin: "__cuttlefish_missing_codex_for_status_test__", model: "gpt-5" },
          antigravity: { bin: "__cuttlefish_missing_agy_for_status_test__", model: "gemini" },
          grok: { bin: "__cuttlefish_missing_grok_for_status_test__", model: "grok-build" },
          pi: { bin: "__cuttlefish_missing_pi_for_status_test__", model: "ollama/gemma4:12b" },
          kiro: { bin: "__cuttlefish_missing_kiro_for_status_test__", model: "auto" },
          hermes: { bin: "__cuttlefish_missing_hermes_for_status_test__", model: "openai-codex:gpt-5.5" },
          ollama: { bin: "__cuttlefish_missing_ollama_for_status_test__", model: "gemma4" },
          kilo: { bin: "__cuttlefish_missing_kilo_for_status_test__", model: "kilo-auto/free" },
          aider: { bin: "__cuttlefish_missing_aider_for_status_test__", model: "default" },
        },
      }),
      connectors: new Map(),
      startTime: Date.now(),
    } as unknown as ApiContext;

    const cap = makeRes();
    await handleApiRequest(makeReq("GET", "/api/status"), cap.res, statusCtx);

    expect(cap.status).toBe(200);
    expect(cap.body).toMatchObject({
      status: "error",
      checks: expect.arrayContaining([
        expect.objectContaining({ name: "engines", status: "error" }),
      ]),
    });
  });
});
