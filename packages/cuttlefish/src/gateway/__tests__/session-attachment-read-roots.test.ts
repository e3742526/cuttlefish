import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { handleSessionAttachment } from "../files/attachments.js";

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

function makeJsonReq(body: unknown) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as any;
  Object.assign(req, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  return req;
}

describe("handleSessionAttachment path allowlist (CF2-103 remaining gap)", () => {
  it("refuses a local path outside a configured gateway.fileReadRoots allowlist", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-attach-roots-"));
    const outside = path.join(tmpDir, "outside.txt");
    fs.writeFileSync(outside, "hello");
    const allowedDir = path.join(tmpDir, "allowed-only");
    fs.mkdirSync(allowedDir, { recursive: true });

    const context = {
      getConfig: () => ({ gateway: { fileReadRoots: [allowedDir] } }),
    } as any;

    const cap = makeRes();
    await handleSessionAttachment(makeJsonReq({ path: outside }), cap.res, "session-1", context);

    expect(cap.status).toBe(400);
    expect(cap.body.error).toMatch(/fileReadRoots/);
  });

  it("still blocks a secret-named file even when fileReadRoots allows the directory (secret blocklist runs first)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-attach-roots-secret-"));
    const secretFile = path.join(tmpDir, ".env");
    fs.writeFileSync(secretFile, "TOKEN=leak");

    const context = {
      getConfig: () => ({ gateway: { fileReadRoots: [tmpDir] } }),
    } as any;

    const cap = makeRes();
    await handleSessionAttachment(makeJsonReq({ path: secretFile }), cap.res, "session-1", context);

    expect(cap.status).toBe(400);
    expect(cap.body.error).not.toMatch(/fileReadRoots/);
  });
});
