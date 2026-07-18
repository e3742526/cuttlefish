import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Busboy from "busboy";
import { readJsonBody } from "../http-helpers.js";
import type { ApiContext } from "../api/context.js";
import { safeFetch, SsrfError } from "../../shared/ssrf-guard.js";
import { logger } from "../../shared/logger.js";
import { insertFile, type ArtifactKind, type FileMeta } from "../../sessions/registry.js";
import { principalBodySessionForbidden, type GatewayPrincipal } from "../auth.js";
import { badRequest, FileRequestError, json, serverError } from "./responses.js";
import {
  FILES_DIR,
  mimeFromFilename,
  resolveCustomUploadPath,
  sanitizeUploadFilename,
  uploadDir,
} from "./storage.js";

export function allowUploadedFileOpen(context: Pick<ApiContext, "getConfig">): boolean {
  return context.getConfig().gateway?.allowFileOpen === true;
}

function allowCustomUploadPaths(context: ApiContext): boolean {
  return context.getConfig().gateway?.allowFileCustomPaths === true;
}

const MAX_UPLOAD_SIZE_MB = 50;
const MAX_UPLOAD_SIZE = MAX_UPLOAD_SIZE_MB * 1024 * 1024;
const MAX_JSON_UPLOAD_BODY_SIZE = MAX_UPLOAD_SIZE * 2;

function uploadTooLargeMessage(): string {
  return `File exceeds ${MAX_UPLOAD_SIZE_MB} MB limit`;
}

/**
 * AR-04: an upload's target session lives in the request body (`sessionId`),
 * which the transport-layer scoped-token gate (URL-only) cannot see. Without
 * this a session-scoped agent token could stash an upload under another
 * session by naming its id in the body. Mirrors the guard used by
 * `handleTalkApi`'s `rejectCrossSessionBody` (talk/routes.ts).
 */
function rejectCrossSessionUpload(req: HttpRequest, res: ServerResponse, bodySessionId: unknown): boolean {
  const principal = (req as HttpRequest & { cuttlefishPrincipal?: GatewayPrincipal }).cuttlefishPrincipal;
  if (!principalBodySessionForbidden(principal, bodySessionId)) return false;
  json(res, { error: "Forbidden: session-scoped token cannot target another session" }, 403);
  return true;
}

function estimateBase64DecodedBytes(content: string): number {
  let normalizedLength = 0;
  let trailing = "";
  let trailingPrev = "";

  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) continue;
    normalizedLength++;
    trailingPrev = trailing;
    trailing = content[i];
  }

  if (normalizedLength === 0) return 0;

  let padding = 0;
  if (trailing === "=") padding++;
  if (trailing === "=" && trailingPrev === "=") padding++;
  return Math.floor((normalizedLength * 3) / 4) - padding;
}

export async function bufferResponseWithLimit(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsed = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new FileRequestError(uploadTooLargeMessage());
    }
  }

  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new FileRequestError(uploadTooLargeMessage());
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks);
}

interface UploadResult {
  id: string;
  filename: string;
  buffer: Buffer;
  customPath: string | null;
  open: boolean;
  sessionId?: string | null;
  artifactKind?: ArtifactKind;
  producingRunId?: string | null;
  sourceUrl?: string | null;
  sourcePath?: string | null;
  tags?: string[];
  notes?: string | null;
}

export async function saveFile(result: UploadResult, context: ApiContext): Promise<FileMeta> {
  const safeName = sanitizeUploadFilename(result.filename);
  const customPath = resolveCustomUploadPath(result.customPath);
  if (result.customPath && (!allowCustomUploadPaths(context) || !customPath)) {
    throw new FileRequestError("custom upload paths are disabled or outside managed storage");
  }

  const sessionScoped = !!result.sessionId;
  const storageDir = sessionScoped
    ? uploadDir(result.sessionId!)
    : `${FILES_DIR}/${result.id}`;
  await fs.promises.mkdir(storageDir, { recursive: true });
  const storagePath = `${storageDir}/${safeName}`;
  await fs.promises.writeFile(storagePath, result.buffer);

  const mimetype = mimeFromFilename(safeName);
  const sha256 = crypto.createHash("sha256").update(result.buffer).digest("hex");
  const meta = insertFile({
    id: result.id,
    filename: safeName,
    size: result.buffer.length,
    mimetype,
    path: sessionScoped ? storagePath : customPath,
    sha256,
    artifactKind: result.artifactKind,
    producingRunId: result.producingRunId ?? null,
    sourceUrl: result.sourceUrl ?? null,
    sourcePath: result.sourcePath ?? null,
    tags: result.tags,
    notes: result.notes ?? null,
  });

  if (customPath) {
    try {
      await fs.promises.access(customPath);
      throw new FileRequestError("file already exists at custom path; use a different path or delete the existing file");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await fs.promises.mkdir(path.dirname(customPath), { recursive: true });
    await fs.promises.writeFile(customPath, result.buffer);
  }

  if (result.open && allowUploadedFileOpen(context)) {
    const targetPath = customPath || storagePath;
    const { spawn } = await import("node:child_process");
    spawn("open", [targetPath], { stdio: "ignore", detached: true }).unref();
  }

  context.emit("file:uploaded", { id: result.id, filename: result.filename, size: result.buffer.length });
  logger.info(`File uploaded: ${result.filename} (${result.id}, ${result.buffer.length} bytes)`);

  return meta;
}

export async function handleMultipartUpload(req: HttpRequest, res: ServerResponse, context: ApiContext): Promise<void> {
  return new Promise((resolve) => {
    const busboy = Busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_SIZE } });
    let filename = "";
    let fileBuffer: Buffer | null = null;
    let customPath: string | null = null;
    let open = false;
    let sessionId: string | null = null;
    let artifactKind: ArtifactKind | undefined;
    let tags: string[] | undefined;
    let notes: string | null = null;
    let fileTruncated = false;

    busboy.on("file", (_fieldname: string, file: NodeJS.ReadableStream, info: { filename: string }) => {
      filename = info.filename;
      const chunks: Buffer[] = [];
      file.on("data", (chunk: Buffer) => chunks.push(chunk));
      (file as NodeJS.EventEmitter).on("limit", () => { fileTruncated = true; });
      file.on("end", () => { fileBuffer = Buffer.concat(chunks); });
    });

    busboy.on("field", (name: string, val: string) => {
      if (name === "path") customPath = val;
      if (name === "open") open = val === "true" || val === "1";
      if (name === "sessionId") sessionId = val;
      if (name === "artifactKind") artifactKind = val as ArtifactKind;
      if (name === "tag" || name === "tags") {
        const parsed = name === "tags" ? val.split(",") : [val];
        tags = [...(tags ?? []), ...parsed.map((tag) => tag.trim()).filter(Boolean)];
      }
      if (name === "notes") notes = val;
    });

    busboy.on("finish", async () => {
      if (fileTruncated) {
        badRequest(res, uploadTooLargeMessage());
        resolve();
        return;
      }
      if (!fileBuffer || !filename) {
        badRequest(res, "No file provided");
        resolve();
        return;
      }
      if (rejectCrossSessionUpload(req, res, sessionId)) {
        resolve();
        return;
      }
      try {
        const meta = await saveFile({
          id: crypto.randomUUID(),
          filename,
          buffer: fileBuffer,
          customPath,
          open,
          sessionId,
          artifactKind: artifactKind ?? "input",
          sourcePath: customPath,
          tags,
          notes,
        }, context);
        json(res, meta, 201);
      } catch (err) {
        if (err instanceof FileRequestError) {
          badRequest(res, err.message);
          resolve();
          return;
        }
        serverError(res, err instanceof Error ? err.message : "Upload failed");
      }
      resolve();
    });

    busboy.on("error", (err: Error) => {
      serverError(res, err.message);
      resolve();
    });

    req.pipe(busboy);
  });
}

export async function handleJsonUpload(req: HttpRequest, res: ServerResponse, context: ApiContext): Promise<void> {
  const parsed = await readJsonBody(req, res, { maxBytes: MAX_JSON_UPLOAD_BODY_SIZE });
  if (!parsed.ok) return;
  if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
    badRequest(res, "Invalid JSON body");
    return;
  }
  const body = parsed.body as Record<string, unknown>;

  const filename = body.filename as string | undefined;
  const content = body.content as string | undefined;
  const url = body.url as string | undefined;
  const customPath = (body.path as string) || null;
  const open = !!body.open;
  const sessionId = (body.sessionId as string) || null;
  const artifactKind = body.artifactKind as ArtifactKind | undefined;
  const tags = Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === "string") : undefined;
  const notes = typeof body.notes === "string" ? body.notes : null;

  if (!filename) return badRequest(res, "filename is required");
  if (content && url) return badRequest(res, "content and url are mutually exclusive");
  if (!content && !url) return badRequest(res, "content or url is required");
  if (rejectCrossSessionUpload(req, res, body.sessionId)) return;

  let buffer: Buffer;

  if (content) {
    if (estimateBase64DecodedBytes(content) > MAX_UPLOAD_SIZE) {
      return badRequest(res, uploadTooLargeMessage());
    }
    try {
      buffer = Buffer.from(content, "base64");
    } catch {
      return badRequest(res, "Invalid base64 content");
    }
    if (buffer.length > MAX_UPLOAD_SIZE) {
      return badRequest(res, uploadTooLargeMessage());
    }
  } else {
    try {
      // safeFetch re-validates every redirect hop against the SSRF guard, so a
      // 3xx to a private/metadata address cannot slip past the initial check.
      const response = await safeFetch(url!);
      if (!response.ok) {
        return serverError(res, `Failed to fetch URL: ${response.status} ${response.statusText}`);
      }
      buffer = await bufferResponseWithLimit(response, MAX_UPLOAD_SIZE);
    } catch (err) {
      if (err instanceof SsrfError) return badRequest(res, err.message);
      if (err instanceof FileRequestError) {
        return badRequest(res, err.message);
      }
      return serverError(res, `Failed to fetch URL: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (buffer.length > MAX_UPLOAD_SIZE) {
      return badRequest(res, uploadTooLargeMessage());
    }
  }

  try {
    const meta = await saveFile({
      id: crypto.randomUUID(),
      filename,
      buffer,
      customPath,
      open,
      sessionId,
      artifactKind: artifactKind ?? (url ? "downloaded" : "input"),
      sourceUrl: url ?? null,
      sourcePath: customPath,
      tags,
      notes,
    }, context);
    json(res, meta, 201);
  } catch (err) {
    if (err instanceof FileRequestError) {
      return badRequest(res, err.message);
    }
    serverError(res, err instanceof Error ? err.message : "Upload failed");
  }
}
