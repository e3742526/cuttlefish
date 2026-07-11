import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, BodyTooLargeError } from "../files/responses.js";
import { readBodyRaw } from "../http-helpers.js";
import { handleTransfer } from "../files/transfer.js";

function fakeReq(chunks: Array<string | Buffer>): IncomingMessage {
  const body = chunks.map((chunk) => (typeof chunk === "string" ? Buffer.from(chunk) : chunk));
  return Readable.from(body) as unknown as IncomingMessage;
}

function fakeRes() {
  const out: { status?: number; body?: string } = {};
  const res = {
    writeHead(status: number) { out.status = status; return res; },
    end(body?: string) { out.body = body; return res; },
  } as unknown as ServerResponse;
  return { res, out };
}

describe("request body byte caps (AR-07)", () => {
  it("readBody rejects a body over maxBytes with BodyTooLargeError", async () => {
    await expect(
      readBody(fakeReq(["A".repeat(1024), "B".repeat(1024)]), { maxBytes: 1500 }),
    ).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("readBody resolves a body within maxBytes", async () => {
    await expect(readBody(fakeReq(["hello"]), { maxBytes: 1500 })).resolves.toBe("hello");
  });

  it("readBodyRaw rejects an oversize raw body while streaming", async () => {
    await expect(
      readBodyRaw(fakeReq([Buffer.alloc(2048)]), { maxBytes: 1024 }),
    ).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("readBodyRaw resolves a raw body within maxBytes", async () => {
    const buf = await readBodyRaw(fakeReq([Buffer.from("abc")]), { maxBytes: 1024 });
    expect(buf.toString()).toBe("abc");
  });

  it("POST /api/files/transfer returns 413 for an oversized body", async () => {
    const { res, out } = fakeRes();
    const ctx = { getConfig: () => ({}), emit: () => {} } as unknown as import("../api.js").ApiContext;
    // 2 MiB body exceeds the 1 MiB transfer-spec cap and is rejected before parse.
    await handleTransfer(fakeReq(["X".repeat(2 * 1024 * 1024)]), res, ctx);
    expect(out.status).toBe(413);
    expect(JSON.parse(out.body!)).toEqual({ error: "Payload too large" });
  });
});
