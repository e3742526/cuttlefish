import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import { BodyTooLargeError } from "../http-helpers.js";

// Re-export so the file handlers can catch an oversize body from one place.
export { BodyTooLargeError };

export class FileRequestError extends Error {}

/**
 * Buffer a request body to a UTF-8 string, capped at `opts.maxBytes` when given.
 * A body that exceeds the cap rejects with `BodyTooLargeError` and destroys the
 * socket, so a hostile chunked/streamed body cannot exhaust the heap before a
 * downstream size check runs (AR-07). An absent cap preserves the legacy
 * unbounded behavior for callers that do not opt in.
 */
export function readBody(req: HttpRequest, opts: { maxBytes?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const max = opts.maxBytes;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (max !== undefined && total > max) {
        req.destroy();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function badRequest(res: ServerResponse, message: string): void {
  json(res, { error: message }, 400);
}

export function notFound(res: ServerResponse): void {
  json(res, { error: "Not found" }, 404);
}

export function serverError(res: ServerResponse, message: string): void {
  json(res, { error: message }, 500);
}
