import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getFile } from "../../sessions/registry.js";
import type { ApiContext } from "../api/context.js";
import { logger } from "../../shared/logger.js";
import { badRequest, json, readBody } from "./responses.js";
import { assessFileRead, isAllowedReadPath } from "./read-security.js";
import { FILES_DIR, expandPath } from "./storage.js";

interface TransferSpec {
  file: string;
  remotePath?: string;
}

interface TransferResult {
  file: string;
  remotePath: string | null;
  status: "ok" | "error";
  remoteId?: string;
  error?: string;
}

const MAX_TRANSFER_SIZE = 50 * 1024 * 1024;
type RemoteConfig = { remotes?: Record<string, { url: string; label?: string; token?: string }> };

// CF2-202: transfer.ts reads an arbitrary local file and ships it to a
// configured remote — mirror the checks run-attachments.ts already applies
// before any local-path read reaches this handler.
export function resolveFileSpec(spec: TransferSpec, context: ApiContext): { buffer: Buffer; filename: string; relativePath: string | null } {
  const expanded = expandPath(spec.file);

  if (fs.existsSync(expanded)) {
    const assessment = assessFileRead(expanded, { authenticated: true });
    if (!assessment.allowed) {
      throw new Error(assessment.reason || `Refusing to transfer ${spec.file}`);
    }
    if (!isAllowedReadPath(expanded, context)) {
      throw new Error(`File ${spec.file} is outside the configured fileReadRoots`);
    }
    const stat = fs.statSync(expanded);
    if (stat.size > MAX_TRANSFER_SIZE) {
      throw new Error(`File ${spec.file} is ${(stat.size / 1024 / 1024).toFixed(1)} MB — exceeds 50 MB transfer limit`);
    }
    const buffer = fs.readFileSync(expanded);
    const filename = path.basename(expanded);
    const cuttlefishHome = path.join(os.homedir(), ".cuttlefish");
    const relativePath = expanded.startsWith(cuttlefishHome) ? path.relative(cuttlefishHome, expanded) : null;
    return { buffer, filename, relativePath };
  }

  const meta = getFile(spec.file);
  if (meta) {
    const filePath = path.join(FILES_DIR, meta.id, meta.filename);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Managed file ${spec.file} exists in DB but not on disk`);
    }
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_TRANSFER_SIZE) {
      throw new Error(`File ${spec.file} is ${(stat.size / 1024 / 1024).toFixed(1)} MB — exceeds 50 MB transfer limit`);
    }
    return {
      buffer: fs.readFileSync(filePath),
      filename: meta.filename,
      relativePath: meta.path || null,
    };
  }

  throw new Error(`File not found: ${spec.file}`);
}

function resolveDestination(destination: string, config: RemoteConfig): string {
  if (destination.startsWith("http://") || destination.startsWith("https://")) {
    return destination.replace(/\/+$/, "");
  }
  const remote = config.remotes?.[destination];
  if (!remote) {
    throw new Error(`Unknown remote "${destination}". Add it to config.yaml remotes or use a full URL.`);
  }
  return remote.url.replace(/\/+$/, "");
}

function isAllowedRemote(destUrl: string, config: RemoteConfig): boolean {
  if (!config.remotes) return false;
  const normalized = destUrl.replace(/\/+$/, "");
  return Object.values(config.remotes).some((remote) => remote.url.replace(/\/+$/, "") === normalized);
}

export function buildRemoteUploadBody(filename: string, buffer: Buffer, remotePath: string | null | undefined): Record<string, string> {
  return {
    filename,
    content: buffer.toString("base64"),
    ...(remotePath ? { path: remotePath } : {}),
  };
}

function remoteTokenFor(destUrl: string, config: RemoteConfig): string | undefined {
  const normalized = destUrl.replace(/\/+$/, "");
  return Object.values(config.remotes ?? {}).find((remote) => remote.url.replace(/\/+$/, "") === normalized)?.token;
}

export function remoteUploadHeaders(destUrl: string, config: RemoteConfig): Record<string, string> {
  const token = remoteTokenFor(destUrl, config);
  return {
    "Content-Type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

export async function handleTransfer(req: HttpRequest, res: ServerResponse, context: ApiContext): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return badRequest(res, "Invalid JSON body");
  }

  const destination = body.destination as string | undefined;
  if (!destination) return badRequest(res, "destination is required");

  let fileSpecs: TransferSpec[];
  if (body.files && Array.isArray(body.files)) {
    fileSpecs = body.files as TransferSpec[];
  } else if (body.file) {
    fileSpecs = [{
      file: body.file as string,
      remotePath: body.remotePath as string | undefined,
    }];
  } else {
    return badRequest(res, "file or files is required");
  }

  if (fileSpecs.length === 0) return badRequest(res, "files array is empty");

  const config = context.getConfig();
  let destUrl: string;
  try {
    destUrl = resolveDestination(destination, config);
  } catch (err) {
    return badRequest(res, err instanceof Error ? err.message : String(err));
  }

  if (!isAllowedRemote(destUrl, config)) {
    return json(res, { error: `Remote "${destUrl}" is not in config.yaml remotes whitelist` }, 403);
  }

  const results: TransferResult[] = [];
  for (const spec of fileSpecs) {
    try {
      const { buffer, filename } = resolveFileSpec(spec, context);
      const targetPath = spec.remotePath || null;
      const uploadBody = buildRemoteUploadBody(filename, buffer, targetPath);

      const response = await fetch(`${destUrl}/api/files`, {
        method: "POST",
        headers: remoteUploadHeaders(destUrl, config),
        body: JSON.stringify(uploadBody),
      });

      if (!response.ok) {
        const errText = await response.text();
        results.push({ file: spec.file, remotePath: targetPath, status: "error", error: `HTTP ${response.status}: ${errText}` });
      } else {
        const remoteMeta = await response.json() as { id: string };
        results.push({ file: spec.file, remotePath: targetPath, status: "ok", remoteId: remoteMeta.id });
      }
    } catch (err) {
      results.push({ file: spec.file, remotePath: spec.remotePath || null, status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  }

  const ok = results.filter((result) => result.status === "ok").length;
  const failed = results.filter((result) => result.status === "error").length;
  context.emit("file:transferred", { destination: destUrl, ok, failed });
  logger.info(`File transfer to ${destUrl}: ${ok} ok, ${failed} failed`);

  json(res, { destination: destUrl, results, summary: { ok, failed, total: results.length } });
}
