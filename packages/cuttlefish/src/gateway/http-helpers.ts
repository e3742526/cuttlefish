/**
 * Shared HTTP request-body helpers used by gateway/api.ts and talk/routes.ts
 * (previously duplicated in both). Error responses written here are tiny
 * (well under the compression threshold), so plain uncompressed JSON writes
 * are behaviour-identical to api.ts's compressing json() helper.
 */
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";

/** Signals that a request body exceeded the per-handler size cap. */
export class BodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds maximum allowed size");
    this.name = "BodyTooLargeError";
  }
}

export interface ReadBodyOpts {
  /** Hard cap on bytes accepted from the stream; rejects with BodyTooLargeError when exceeded. */
  maxBytes?: number;
}

export interface ReadJsonBodyOpts extends ReadBodyOpts {
  /** Treat an empty/whitespace-only body as `{ ok: true, body: null }` instead of a 400. */
  allowEmpty?: boolean;
}

export const DEFAULT_JSON_BODY_MAX_BYTES = 1024 * 1024;

export function readBody(req: HttpRequest, opts: ReadBodyOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const max = opts.maxBytes;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (max !== undefined && total > max) {
        // Bail out — destroy the socket so the sender stops shoveling bytes.
        req.destroy();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

export function readBodyRaw(req: HttpRequest, opts: ReadBodyOpts = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const max = opts.maxBytes;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (max !== undefined && total > max) {
        // Bound heap growth: reject and tear down the socket instead of buffering
        // an unbounded raw body before any downstream size check runs.
        req.destroy();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function errorJson(res: ServerResponse, data: unknown, status: number): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export async function readJsonBody(
  req: HttpRequest,
  res: ServerResponse,
  opts: ReadJsonBodyOpts = {},
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  let raw: string;
  try {
    raw = await readBody(req, { ...opts, maxBytes: opts.maxBytes ?? DEFAULT_JSON_BODY_MAX_BYTES });
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      errorJson(res, { error: "Payload too large" }, 413);
      return { ok: false };
    }
    throw err;
  }
  if (opts.allowEmpty && !raw.trim()) return { ok: true, body: null };
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    errorJson(res, { error: "Invalid JSON in request body" }, 400);
    return { ok: false };
  }
}
