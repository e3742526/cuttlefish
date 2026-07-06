import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import {
  findArtifactsByPaths,
  getFile,
  getFilesByIds,
  insertFile,
  listArtifacts,
  updateArtifactMetadata,
  type ArtifactKind,
  type FileMeta,
} from "../../../sessions/registry.js";
import { assessFileRead, isAllowedReadPath } from "../../files/read-security.js";
import { expandPath, mimeFromFilename, sanitizeUploadFilename } from "../../files/storage.js";
import { readJsonBody } from "../../http-helpers.js";
import type { ApiContext } from "../context.js";
import { matchRoute } from "../match-route.js";
import { badRequest, json, notFound } from "../responses.js";

const VALID_ARTIFACT_KINDS = new Set<ArtifactKind>(["generated", "input", "downloaded", "manual"]);

function parseKind(value: string | null | undefined): ArtifactKind | undefined {
  return value && VALID_ARTIFACT_KINDS.has(value as ArtifactKind) ? value as ArtifactKind : undefined;
}

function parseTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((tag): tag is string => typeof tag === "string");
}

function diskPathForArtifact(artifact: FileMeta): string | null {
  if (artifact.path) return artifact.path;
  return null;
}

function artifactPayload(artifact: FileMeta): FileMeta & { existsOnDisk: boolean; downloadUrl: string } {
  const diskPath = diskPathForArtifact(artifact);
  return {
    ...artifact,
    existsOnDisk: !!diskPath && fs.existsSync(diskPath),
    downloadUrl: `/api/files/${artifact.id}`,
  };
}

function resolveRegisterPath(requestedPath: string): string {
  return path.resolve(expandPath(requestedPath));
}

function assessRegisterPath(absPath: string, context: ApiContext): string | null {
  if (!fs.existsSync(absPath)) return "artifact path does not exist";
  if (!fs.statSync(absPath).isFile()) return "artifact path must be a file";
  const readAssessment = assessFileRead(absPath, { authenticated: true });
  if (!readAssessment.allowed) return readAssessment.reason || "artifact path blocked by file policy";
  if (!isAllowedReadPath(absPath, context)) return "artifact path is outside configured fileReadRoots";
  return null;
}

function hashFile(absPath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(absPath));
  return hash.digest("hex");
}

function validationResultForArtifact(artifact: FileMeta | undefined): {
  id?: string;
  path?: string | null;
  found: boolean;
  existsOnDisk: boolean;
  sha256?: string | null;
} {
  if (!artifact) return { found: false, existsOnDisk: false };
  const diskPath = diskPathForArtifact(artifact);
  return {
    id: artifact.id,
    path: diskPath,
    found: true,
    existsOnDisk: !!diskPath && fs.existsSync(diskPath),
    sha256: artifact.sha256,
  };
}

export async function handleArtifactRoutes(
  method: string,
  pathname: string,
  req: HttpRequest,
  url: URL,
  res: ServerResponse,
  context: ApiContext,
): Promise<boolean> {
  if (method === "GET" && pathname === "/api/artifacts") {
    const artifacts = listArtifacts({
      kind: parseKind(url.searchParams.get("kind")),
      producingRunId: url.searchParams.get("runId") ?? undefined,
      sourceUrl: url.searchParams.get("sourceUrl") ?? undefined,
      sourcePath: url.searchParams.get("sourcePath") ?? undefined,
      tag: url.searchParams.get("tag") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
      limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
    }).map(artifactPayload);
    json(res, { artifacts });
    return true;
  }

  if (method === "GET" && pathname === "/api/artifacts/bundle") {
    const runId = url.searchParams.get("runId");
    if (!runId) {
      badRequest(res, "runId query parameter is required");
      return true;
    }
    const artifacts = listArtifacts({ producingRunId: runId, limit: 1000 }).map(artifactPayload);
    json(res, {
      kind: "cuttlefish.runBundleManifest",
      runId,
      createdAt: new Date().toISOString(),
      artifacts,
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/artifacts/register") {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    if (!parsed.body || typeof parsed.body !== "object" || Array.isArray(parsed.body)) {
      badRequest(res, "Invalid JSON body");
      return true;
    }
    const body = parsed.body as Record<string, unknown>;
    const requestedPath = typeof body.path === "string" ? body.path.trim() : "";
    if (!requestedPath) {
      badRequest(res, "path is required");
      return true;
    }
    const absPath = resolveRegisterPath(requestedPath);
    const blocked = assessRegisterPath(absPath, context);
    if (blocked) {
      badRequest(res, blocked);
      return true;
    }
    const stat = fs.statSync(absPath);
    // The id is used as a storage path segment (FILES_DIR/<id>) by the files
    // routes, so a separator or `..` would let a delete/move escape FILES_DIR.
    const providedId = typeof body.id === "string" && body.id.trim() ? body.id.trim() : null;
    if (providedId !== null && (providedId.includes("/") || providedId.includes("\\") || providedId === "." || providedId === "..")) {
      badRequest(res, "invalid artifact id");
      return true;
    }
    const artifact = insertFile({
      id: providedId ?? crypto.randomUUID(),
      // Persist a flat basename: meta.filename is later joined under FILES_DIR by
      // the attachment re-home path, so a raw `../`-laden label must not survive.
      filename: sanitizeUploadFilename(typeof body.filename === "string" && body.filename.trim() ? body.filename : path.basename(absPath)),
      size: stat.size,
      mimetype: typeof body.mimetype === "string" ? body.mimetype : mimeFromFilename(absPath),
      path: absPath,
      sha256: hashFile(absPath),
      artifactKind: parseKind(body.artifactKind as string | undefined) ?? "generated",
      producingRunId: typeof body.producingRunId === "string" ? body.producingRunId : null,
      sourceUrl: typeof body.sourceUrl === "string" ? body.sourceUrl : null,
      sourcePath: typeof body.sourcePath === "string" ? path.resolve(expandPath(body.sourcePath)) : null,
      tags: parseTags(body.tags),
      notes: typeof body.notes === "string" ? body.notes : null,
    });
    context.emit("artifact:registered", { id: artifact.id, path: artifact.path, producingRunId: artifact.producingRunId });
    json(res, artifactPayload(artifact), 201);
    return true;
  }

  if (method === "POST" && pathname === "/api/artifacts/validate") {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as Record<string, unknown>;
    const ids = Array.isArray(body?.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
    const requestedPaths = Array.isArray(body?.paths) ? body.paths.filter((p): p is string => typeof p === "string") : [];
    const resolvedPaths = requestedPaths.map(resolveRegisterPath);
    const byPath = new Map(findArtifactsByPaths(resolvedPaths).flatMap((artifact) => {
      const pairs: Array<[string, FileMeta]> = [];
      if (artifact.path) pairs.push([path.resolve(artifact.path), artifact]);
      if (artifact.sourcePath) pairs.push([path.resolve(artifact.sourcePath), artifact]);
      return pairs;
    }));

    const byId = new Map(getFilesByIds(ids).map((artifact) => [artifact.id, artifact]));
    const idResults = ids.map((id) => ({ requested: id, ...validationResultForArtifact(byId.get(id)) }));

    json(res, {
      ids: idResults,
      paths: resolvedPaths.map((p) => {
        const artifact = byPath.get(p);
        const result = validationResultForArtifact(artifact);
        return { requested: p, ...result };
      }),
      ok:
        idResults.every((r) => r.existsOnDisk) &&
        resolvedPaths.every((p) => validationResultForArtifact(byPath.get(p)).existsOnDisk),
    });
    return true;
  }

  const params = matchRoute("/api/artifacts/:id", pathname);
  if (method === "GET" && params) {
    const artifact = getFile(params.id);
    if (!artifact) {
      notFound(res);
      return true;
    }
    json(res, artifactPayload(artifact));
    return true;
  }

  if (method === "PATCH" && params) {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as Record<string, unknown>;
    const artifact = updateArtifactMetadata(params.id, {
      artifactKind: parseKind(body.artifactKind as string | undefined),
      producingRunId: typeof body.producingRunId === "string" ? body.producingRunId : undefined,
      sourceUrl: typeof body.sourceUrl === "string" ? body.sourceUrl : undefined,
      sourcePath: typeof body.sourcePath === "string" ? path.resolve(expandPath(body.sourcePath)) : undefined,
      tags: parseTags(body.tags),
      notes: typeof body.notes === "string" ? body.notes : undefined,
    });
    if (!artifact) {
      notFound(res);
      return true;
    }
    context.emit("artifact:updated", { id: artifact.id });
    json(res, artifactPayload(artifact));
    return true;
  }

  return false;
}
