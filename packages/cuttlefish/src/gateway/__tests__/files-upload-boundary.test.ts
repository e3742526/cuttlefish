import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-files-upload-");

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024;

type Files = typeof import("../files.js");
type Reg = typeof import("../../sessions/registry.js");

let files: Files;
let reg: Reg;

const originalFetch = globalThis.fetch;

beforeAll(async () => {
  reg = await import("../../sessions/registry.js");
  files = await import("../files.js");
  reg.initDb();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function fakeReq(chunks: Array<string | Buffer>, contentType: string): import("node:http").IncomingMessage {
  const body = chunks.map((chunk) => typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  const req = Readable.from(body) as unknown as import("node:http").IncomingMessage;
  (req as unknown as { headers: Record<string, string> }).headers = { "content-type": contentType };
  return req;
}

function fakeRes() {
  const out: { status?: number; body?: string } = {};
  const res = {
    writeHead(status: number) { out.status = status; return res; },
    end(body?: string) { out.body = body; return res; },
  } as unknown as import("node:http").ServerResponse;
  return { res, out };
}

const ctx = {
  emit: () => {},
  getConfig: () => ({}),
} as unknown as import("../api.js").ApiContext;

function repeatedBase64Chunks(totalLength: number, chunkSize = 1024 * 1024): string[] {
  const fullChunk = "A".repeat(chunkSize);
  const chunks: string[] = [];
  let remaining = totalLength;

  while (remaining > 0) {
    const size = Math.min(chunkSize, remaining);
    chunks.push(size === chunkSize ? fullChunk : "A".repeat(size));
    remaining -= size;
  }

  return chunks;
}

describe("POST /api/files JSON upload boundaries", () => {
  it("rejects base64 content whose decoded payload exceeds 50 MB", async () => {
    const encodedLength = Math.ceil((MAX_UPLOAD_SIZE + 1) / 3) * 4;
    const { res, out } = fakeRes();

    await files.handleFilesRequest(
      fakeReq(
        [
          '{"filename":"too-big.bin","content":"',
          ...repeatedBase64Chunks(encodedLength),
          '"}',
        ],
        "application/json",
      ),
      res,
      "/api/files",
      "POST",
      ctx,
    );

    expect(out.status).toBe(400);
    expect(JSON.parse(out.body!)).toEqual({ error: "File exceeds 50 MB limit" });
  });

  it("rejects fetched URL content whose advertised size exceeds 50 MB", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(new ReadableStream({
        start(controller) {
          controller.close();
        },
      }), {
        status: 200,
        headers: { "content-length": String(MAX_UPLOAD_SIZE + 1) },
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const { res, out } = fakeRes();
    await files.handleFilesRequest(
      fakeReq(
        [JSON.stringify({ filename: "remote.bin", url: "https://93.184.216.34/file.bin" })],
        "application/json",
      ),
      res,
      "/api/files",
      "POST",
      ctx,
    );

    // safeFetch (SEC-SSRF-001) now drives the fetch with redirect: "manual" so it
    // can re-validate each hop; the URL is still the one requested.
    expect(fetchSpy).toHaveBeenCalledWith("https://93.184.216.34/file.bin", { redirect: "manual" });
    expect(out.status).toBe(400);
    expect(JSON.parse(out.body!)).toEqual({ error: "File exceeds 50 MB limit" });
  });
});

describe("POST /api/files session confinement (AR-04)", () => {
  it("rejects a scoped session token whose JSON upload body names another session", async () => {
    const { res, out } = fakeRes();
    const req = fakeReq(
      [JSON.stringify({ filename: "note.txt", content: "aGVsbG8=", sessionId: "session-elsewhere" })],
      "application/json",
    );
    (req as unknown as { cuttlefishPrincipal?: unknown }).cuttlefishPrincipal = {
      kind: "session",
      sessionId: "session-mine",
    };

    await files.handleFilesRequest(req, res, "/api/files", "POST", ctx);

    expect(out.status).toBe(403);
    expect(JSON.parse(out.body!)).toEqual({
      error: "Forbidden: session-scoped token cannot target another session",
    });
  });

  it("allows a scoped session token to upload into its own session", async () => {
    const { res, out } = fakeRes();
    const req = fakeReq(
      [JSON.stringify({ filename: "note.txt", content: "aGVsbG8=", sessionId: "session-mine" })],
      "application/json",
    );
    (req as unknown as { cuttlefishPrincipal?: unknown }).cuttlefishPrincipal = {
      kind: "session",
      sessionId: "session-mine",
    };

    await files.handleFilesRequest(req, res, "/api/files", "POST", ctx);

    expect(out.status).toBe(201);
  });

  it("does not confine an admin/internal principal to a single session on upload", async () => {
    const { res, out } = fakeRes();
    const req = fakeReq(
      [JSON.stringify({ filename: "note.txt", content: "aGVsbG8=", sessionId: "session-elsewhere" })],
      "application/json",
    );
    (req as unknown as { cuttlefishPrincipal?: unknown }).cuttlefishPrincipal = { kind: "admin" };

    await files.handleFilesRequest(req, res, "/api/files", "POST", ctx);

    expect(out.status).toBe(201);
  });
});
