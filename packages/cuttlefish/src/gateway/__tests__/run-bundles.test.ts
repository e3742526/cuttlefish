import { beforeAll, describe, expect, it } from "vitest";
import type { ServerResponse } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-run-bundles-");

type Api = typeof import("../api.js");
type Reg = typeof import("../../sessions/registry.js");
type Paths = typeof import("../../shared/paths.js");
let api: Api;
let reg: Reg;
let paths: Paths;

beforeAll(async () => {
  api = await import("../api.js");
  reg = await import("../../sessions/registry.js");
  paths = await import("../../shared/paths.js");
  reg.initDb();
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

function makeCtx() {
  return {
    getConfig: () => ({ gateway: {}, engines: {}, portal: {} }),
    connectors: new Map(),
    startTime: Date.now(),
    emit: () => {},
    sessionManager: {
      getQueue: () => ({
        getPendingCount: () => 0,
        getTransportState: (_key: string, status: string) => status,
      }),
      getEngine: () => undefined,
    },
  } as unknown as import("../api.js").ApiContext;
}

describe("run bundle export", () => {
  it("exports a completed run into the required bundle structure", async () => {
    const ctx = makeCtx();
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:bundle-1",
      prompt: "Prepare the report bundle",
    });
    reg.updateSession(session.id, {
      title: "Bundle Session",
      engineSessionId: "engine-bundle-1",
      lastError: "Minor warning kept for export",
    });
    reg.insertMessage(session.id, "user", "Generate report");
    reg.insertMessage(session.id, "assistant", "Done");

    const artifactSource = path.join(tmp, "report.csv");
    fs.writeFileSync(artifactSource, "col\n1\n");
    reg.insertFile({
      id: "artifact-report",
      filename: "report.csv",
      size: fs.statSync(artifactSource).size,
      mimetype: "text/csv",
      path: artifactSource,
      artifactKind: "generated",
      producingRunId: session.id,
      sha256: "abc123",
    });

    fs.mkdirSync(paths.LOGS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(paths.LOGS_DIR, "gateway.log"),
      [
        `2026-06-26T00:00:00.000Z [INFO] session ${session.id} API_KEY=super-secret exported`,
        "2026-06-26T00:00:00.500Z [INFO] another session titled Bundle Session",
        "2026-06-26T00:00:01.000Z [INFO] unrelated other session",
      ].join("\n"),
    );

    const cap = makeRes();
    await api.handleApiRequest(makeReq("POST", `/api/sessions/${session.id}/bundle`), cap.res, ctx);

    expect(cap.status).toBe(201);
    expect(cap.body).toEqual(expect.objectContaining({
      sessionId: session.id,
      bundlePath: expect.any(String),
      manifest: expect.objectContaining({
        kind: "cuttlefish.runBundle",
        sessionId: session.id,
      }),
    }));

    const bundlePath = cap.body.bundlePath as string;
    expect(fs.existsSync(path.join(bundlePath, "run.json"))).toBe(true);
    expect(fs.existsSync(path.join(bundlePath, "summary.md"))).toBe(true);
    expect(fs.existsSync(path.join(bundlePath, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(bundlePath, "errors.json"))).toBe(true);
    expect(fs.existsSync(path.join(bundlePath, "artifacts"))).toBe(true);
    expect(fs.existsSync(path.join(bundlePath, "logs", "gateway.log"))).toBe(true);

    const summary = fs.readFileSync(path.join(bundlePath, "summary.md"), "utf-8");
    expect(summary).toContain("Bundle Session");
    expect(summary).toContain(session.id);

    const runJson = JSON.parse(fs.readFileSync(path.join(bundlePath, "run.json"), "utf-8"));
    expect(runJson.session.id).toBe(session.id);
    expect(runJson.messages).toHaveLength(2);

    const manifest = JSON.parse(fs.readFileSync(path.join(bundlePath, "manifest.json"), "utf-8"));
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(
      expect.arrayContaining([
        "run.json",
        "summary.md",
        "errors.json",
        path.join("artifacts", "artifact-report-report.csv"),
        path.join("logs", "gateway.log"),
      ]),
    );
    expect(manifest.files.map((file: { path: string }) => file.path)).not.toContain("manifest.json");
    for (const file of manifest.files as Array<{ path: string; sha256: string; size: number }>) {
      const bytes = fs.readFileSync(path.join(bundlePath, file.path));
      expect(file.size, file.path).toBe(bytes.length);
      expect(file.sha256, file.path).toBe(crypto.createHash("sha256").update(bytes).digest("hex"));
    }

    const logText = fs.readFileSync(path.join(bundlePath, "logs", "gateway.log"), "utf-8");
    expect(logText).toContain(session.id);
    expect(logText).toContain("API_KEY=[REDACTED]");
    expect(logText).not.toContain("super-secret");
    expect(logText).not.toContain("another session titled Bundle Session");
    expect(logText).not.toContain("unrelated other session");
  });

  it("redacts secrets from run.json, summary.md, and errors.json (not just the log excerpt)", async () => {
    const ctx = makeCtx();
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:bundle-secret-1",
      prompt: "API_KEY=super-secret-prompt do the thing",
    });
    reg.updateSession(session.id, {
      title: "API_KEY=super-secret-title",
      engineSessionId: "engine-bundle-secret-1",
      lastError: "auth failed: API_KEY=super-secret-error",
    });
    reg.insertMessage(session.id, "user", "here you go API_KEY=super-secret-message use it");
    reg.insertMessage(session.id, "notification", "warning API_KEY=super-secret-notification detected");

    const cap = makeRes();
    await api.handleApiRequest(makeReq("POST", `/api/sessions/${session.id}/bundle`), cap.res, ctx);
    expect(cap.status).toBe(201);

    const bundlePath = cap.body.bundlePath as string;

    const runJsonText = fs.readFileSync(path.join(bundlePath, "run.json"), "utf-8");
    expect(runJsonText).not.toContain("super-secret-prompt");
    expect(runJsonText).not.toContain("super-secret-title");
    expect(runJsonText).not.toContain("super-secret-message");
    expect(runJsonText).not.toContain("super-secret-notification");
    // Must still be valid, well-formed JSON after redaction.
    expect(() => JSON.parse(runJsonText)).not.toThrow();

    const summaryText = fs.readFileSync(path.join(bundlePath, "summary.md"), "utf-8");
    expect(summaryText).not.toContain("super-secret-title");
    expect(summaryText).not.toContain("super-secret-prompt");

    const errorsText = fs.readFileSync(path.join(bundlePath, "errors.json"), "utf-8");
    expect(errorsText).not.toContain("super-secret-error");
    expect(errorsText).not.toContain("super-secret-notification");
    expect(() => JSON.parse(errorsText)).not.toThrow();
  });

  it("refuses to export a still-running session", async () => {
    const session = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: "web:bundle-running",
      prompt: "still working",
    });
    reg.updateSession(session.id, { status: "running" });

    const cap = makeRes();
    await api.handleApiRequest(makeReq("POST", `/api/sessions/${session.id}/bundle`), cap.res, makeCtx());
    expect(cap.status).toBe(409);
  });
});
