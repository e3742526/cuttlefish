import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  findArtifactsByPaths,
  getFile,
  type FileMeta,
} from "../sessions/registry.js";
import type { JsonObject, RunAttachment, RunAttachmentAccess, RunAttachmentKind, Session } from "../shared/types.js";
import type { ApiContext } from "./api/context.js";
import { assessFileRead, isAllowedReadPath } from "./files/read-security.js";
import { expandPath } from "./files/storage.js";
import {
  renderAttachmentContentForPrompt,
  screenAttachmentContent,
  shouldInlineAttachmentText,
} from "./content-screening.js";
import { openUntrustedContentCheckpoint } from "./security-review.js";

const RUN_ATTACHMENTS_META_KEY = "runAttachments";

interface RawRunAttachmentInput {
  artifactId?: unknown;
  path?: unknown;
  url?: unknown;
  access?: unknown;
  intendedUse?: unknown;
  producingRunId?: unknown;
}

export interface ResolvedRunAttachments {
  attachments: RunAttachment[];
  promptBlock: string | null;
  engineAttachments: string[];
  blocked: boolean;
  blockedAttachmentIds: string[];
}

function safeTrim(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeAccess(value: unknown): RunAttachmentAccess {
  return value === "writable" ? "writable" : "read_only";
}

function isRunAttachment(value: unknown): value is RunAttachment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.kind === "string" &&
    (candidate.path === null || typeof candidate.path === "string") &&
    (candidate.url === null || typeof candidate.url === "string") &&
    (candidate.artifactId === null || typeof candidate.artifactId === "string") &&
    (candidate.sha256 === null || typeof candidate.sha256 === "string") &&
    (candidate.access === "read_only" || candidate.access === "writable") &&
    (candidate.intendedUse === null || typeof candidate.intendedUse === "string") &&
    (candidate.producingRunId === null || typeof candidate.producingRunId === "string") &&
    typeof candidate.createdAt === "string" &&
    (candidate.screeningState === undefined ||
      candidate.screeningState === "screened" ||
      candidate.screeningState === "not_text_screened" ||
      candidate.screeningState === "screening_unavailable")
  );
}

function normalizeStoredRunAttachment(value: RunAttachment): RunAttachment {
  return {
    id: value.id,
    kind: value.kind,
    path: value.path ?? null,
    url: value.url ?? null,
    artifactId: value.artifactId ?? null,
    sha256: value.sha256 ?? null,
    access: value.access === "writable" ? "writable" : "read_only",
    intendedUse: value.intendedUse ?? null,
    producingRunId: value.producingRunId ?? null,
    createdAt: value.createdAt,
    resolvedPath: value.resolvedPath ?? null,
    existsOnDisk: value.existsOnDisk ?? undefined,
    screeningState: value.screeningState,
    contentScreening: value.contentScreening ?? null,
  };
}

function inferKindFromArtifact(meta: FileMeta, diskPath: string | null): RunAttachmentKind {
  if (meta.sourceUrl && !diskPath) return "url";
  if (diskPath && fs.existsSync(diskPath)) {
    try {
      return fs.statSync(diskPath).isDirectory() ? "folder" : "artifact";
    } catch {
    }
  }
  return "artifact";
}

function fileMetaDiskPath(meta: FileMeta): string | null {
  if (meta.path && fs.existsSync(meta.path)) return meta.path;
  return null;
}

function sha256ForPath(absPath: string): string | null {
  try {
    if (!fs.statSync(absPath).isFile()) return null;
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(absPath));
    return hash.digest("hex");
  } catch {
    return null;
  }
}

function pathKey(value: string | null): string {
  return value ? path.resolve(value) : "";
}

function attachmentKey(att: Pick<RunAttachment, "artifactId" | "url" | "resolvedPath" | "path" | "kind">): string {
  if (att.artifactId) return `artifact:${att.artifactId}`;
  if (att.url) return `url:${att.url}`;
  const resolved = att.resolvedPath ?? att.path;
  if (resolved) return `path:${path.resolve(resolved)}`;
  return `${att.kind}:${crypto.randomUUID()}`;
}

function localPathError(absPath: string, context: ApiContext): string | null {
  if (!fs.existsSync(absPath)) return "attachment path does not exist";
  const assessment = assessFileRead(absPath, { authenticated: true });
  if (!assessment.allowed) return assessment.reason || "attachment path blocked by file policy";
  if (!isAllowedReadPath(absPath, context)) return "attachment path is outside configured fileReadRoots";
  return null;
}

function attachmentFromArtifact(meta: FileMeta): RunAttachment {
  const diskPath = fileMetaDiskPath(meta);
  return {
    id: crypto.randomUUID(),
    kind: inferKindFromArtifact(meta, diskPath),
    path: diskPath,
    url: meta.sourceUrl ?? null,
    artifactId: meta.id,
    sha256: meta.sha256,
    access: "read_only",
    intendedUse: null,
    producingRunId: meta.producingRunId,
    createdAt: new Date().toISOString(),
    resolvedPath: diskPath,
    existsOnDisk: !!diskPath && fs.existsSync(diskPath),
  };
}

function attachmentFromPath(absPath: string, input: RawRunAttachmentInput): RunAttachment {
  const stat = fs.statSync(absPath);
  const matches = findArtifactsByPaths([absPath]);
  const matchedArtifact = matches[0];
  return {
    id: crypto.randomUUID(),
    kind: stat.isDirectory() ? "folder" : "file",
    path: absPath,
    url: null,
    artifactId: matchedArtifact?.id ?? null,
    sha256: stat.isFile() ? (matchedArtifact?.sha256 ?? sha256ForPath(absPath)) : null,
    access: normalizeAccess(input.access),
    intendedUse: safeTrim(input.intendedUse),
    producingRunId: safeTrim(input.producingRunId) ?? matchedArtifact?.producingRunId ?? null,
    createdAt: new Date().toISOString(),
    resolvedPath: absPath,
    existsOnDisk: true,
  };
}

function attachmentFromUrl(input: RawRunAttachmentInput): RunAttachment {
  return {
    id: crypto.randomUUID(),
    kind: "url",
    path: null,
    url: safeTrim(input.url),
    artifactId: safeTrim(input.artifactId),
    sha256: null,
    access: normalizeAccess(input.access),
    intendedUse: safeTrim(input.intendedUse),
    producingRunId: safeTrim(input.producingRunId),
    createdAt: new Date().toISOString(),
    resolvedPath: null,
    existsOnDisk: false,
  };
}

export function listRunAttachments(session: Pick<Session, "transportMeta">): RunAttachment[] {
  const raw = session.transportMeta?.[RUN_ATTACHMENTS_META_KEY];
  if (!Array.isArray(raw)) return [];
  const attachments: RunAttachment[] = [];
  for (const item of raw) {
    if (isRunAttachment(item)) attachments.push(normalizeStoredRunAttachment(item));
  }
  return attachments;
}

export function setRunAttachmentsOnTransportMeta(meta: JsonObject | null | undefined, attachments: RunAttachment[]): JsonObject {
  return {
    ...(meta ?? {}),
    [RUN_ATTACHMENTS_META_KEY]: attachments.map((attachment) => ({
      id: attachment.id,
      kind: attachment.kind,
      path: attachment.path,
      url: attachment.url,
      artifactId: attachment.artifactId,
      sha256: attachment.sha256,
      access: attachment.access,
      intendedUse: attachment.intendedUse,
      producingRunId: attachment.producingRunId,
      createdAt: attachment.createdAt,
      ...(attachment.screeningState ? { screeningState: attachment.screeningState } : {}),
      ...(attachment.contentScreening
        ? {
            contentScreening: {
              source: attachment.contentScreening.source,
              verdict: attachment.contentScreening.verdict,
              action: attachment.contentScreening.action,
              screener: attachment.contentScreening.screener,
              summary: attachment.contentScreening.summary,
              suspiciousSpans: attachment.contentScreening.suspiciousSpans,
              sanitizedText: attachment.contentScreening.sanitizedText,
              occurredAt: attachment.contentScreening.occurredAt,
            },
          }
        : {}),
    })),
  };
}

export function mergeRunAttachments(existing: RunAttachment[], incoming: RunAttachment[]): RunAttachment[] {
  const byKey = new Map<string, RunAttachment>();
  for (const attachment of existing) byKey.set(attachmentKey(attachment), normalizeStoredRunAttachment(attachment));
  for (const attachment of incoming) byKey.set(attachmentKey(attachment), normalizeStoredRunAttachment(attachment));
  return Array.from(byKey.values());
}

export async function screenRunAttachmentsForSession(
  session: Pick<Session, "id" | "promptExcerpt" | "title">,
  attachments: RunAttachment[],
  context: ApiContext,
  operatorIntent?: string | null,
): Promise<RunAttachment[]> {
  const screened: RunAttachment[] = [];
  for (const attachment of attachments) {
    const outcome = await screenAttachmentContent(
      attachment,
      context,
      operatorIntent ?? session.promptExcerpt ?? session.title ?? null,
    );
    screened.push(outcome.attachment);
    if (
      outcome.attachment.contentScreening &&
      (outcome.attachment.contentScreening.action === "quarantine" ||
        outcome.attachment.contentScreening.action === "checkpoint")
    ) {
      const location =
        outcome.attachment.url ??
        outcome.attachment.resolvedPath ??
        outcome.attachment.path ??
        outcome.attachment.artifactId ??
        outcome.attachment.id;
      openUntrustedContentCheckpoint(
        {
          sessionId: session.id,
          location,
          screening: outcome.attachment.contentScreening,
        },
        context,
      );
    }
  }
  return screened;
}

export async function resolveIncomingRunAttachments(
  input: unknown,
  context: ApiContext,
): Promise<RunAttachment[]> {
  if (!Array.isArray(input)) return [];
  const resolved: RunAttachment[] = [];
  for (const item of input) {
    if (typeof item === "string" && item.trim()) {
      const artifact = getFile(item.trim());
      if (!artifact) throw new Error(`Attachment artifact not found: ${item}`);
      resolved.push(attachmentFromArtifact(artifact));
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("attachments must contain artifact IDs or resource objects");
    }
    const raw = item as RawRunAttachmentInput;
    const artifactId = safeTrim(raw.artifactId);
    const requestedPath = safeTrim(raw.path);
    const requestedUrl = safeTrim(raw.url);
    const provided = [artifactId, requestedPath, requestedUrl].filter(Boolean).length;
    if (provided !== 1) {
      throw new Error("each attachment must specify exactly one of artifactId, path, or url");
    }
    if (artifactId) {
      const artifact = getFile(artifactId);
      if (!artifact) throw new Error(`Attachment artifact not found: ${artifactId}`);
      const att = attachmentFromArtifact(artifact);
      att.access = normalizeAccess(raw.access);
      att.intendedUse = safeTrim(raw.intendedUse);
      att.producingRunId = safeTrim(raw.producingRunId) ?? att.producingRunId;
      resolved.push(att);
      continue;
    }
    if (requestedPath) {
      const absPath = path.resolve(expandPath(requestedPath));
      const pathErr = localPathError(absPath, context);
      if (pathErr) throw new Error(pathErr);
      resolved.push(attachmentFromPath(absPath, raw));
      continue;
    }
    if (requestedUrl) {
      let parsed: URL;
      try {
        parsed = new URL(requestedUrl);
      } catch {
        throw new Error(`Invalid attachment URL: ${requestedUrl}`);
      }
      if (!/^https?:$/.test(parsed.protocol)) {
        throw new Error(`Unsupported attachment URL protocol: ${parsed.protocol}`);
      }
      resolved.push(attachmentFromUrl({ ...raw, url: parsed.toString() }));
    }
  }
  return resolved;
}

export function buildResolvedRunAttachments(attachments: RunAttachment[]): ResolvedRunAttachments {
  const promptLines: string[] = [];
  const contentBlocks: string[] = [];
  const engineAttachments: string[] = [];
  const seenEngineAttachments = new Set<string>();
  let blocked = false;
  const blockedAttachmentIds: string[] = [];
  for (const attachment of attachments) {
    const location = attachment.url ?? attachment.resolvedPath ?? attachment.path ?? attachment.artifactId ?? attachment.id;
    const details = [
      attachment.kind,
      attachment.access === "writable" ? "writable" : "read-only",
      attachment.artifactId ? `artifact ${attachment.artifactId}` : null,
      attachment.producingRunId ? `produced by ${attachment.producingRunId}` : null,
      attachment.sha256 ? `sha256 ${attachment.sha256}` : null,
      attachment.intendedUse ? `use: ${attachment.intendedUse}` : null,
      attachment.screeningState ? `screening: ${attachment.screeningState}` : null,
      attachment.contentScreening ? `verdict: ${attachment.contentScreening.verdict}` : null,
    ].filter(Boolean).join("; ");
    promptLines.push(`- ${location}${details ? ` [${details}]` : ""}`);
    if (
      attachment.contentScreening &&
      (attachment.contentScreening.action === "quarantine" || attachment.contentScreening.action === "checkpoint")
    ) {
      blocked = true;
      blockedAttachmentIds.push(attachment.id);
      promptLines.push(`  quarantined: ${attachment.contentScreening.summary}`);
      continue;
    }
    const rendered = renderAttachmentContentForPrompt(attachment);
    if (rendered) contentBlocks.push(rendered);
    if ((attachment.kind === "file" || attachment.kind === "artifact") && attachment.resolvedPath) {
      if (shouldInlineAttachmentText(attachment)) continue;
      const key = path.resolve(attachment.resolvedPath);
      if (!seenEngineAttachments.has(key)) {
        seenEngineAttachments.add(key);
        engineAttachments.push(attachment.resolvedPath);
      }
    }
  }
  return {
    attachments,
    promptBlock:
      promptLines.length > 0
        ? [
            `Attached resources:\n${promptLines.join("\n")}`,
            ...(contentBlocks.length > 0 ? ["", contentBlocks.join("\n\n")] : []),
          ].join("\n")
        : null,
    engineAttachments,
    blocked,
    blockedAttachmentIds,
  };
}

export function enrichRunAttachmentsForSession(session: Pick<Session, "transportMeta">): RunAttachment[] {
  return listRunAttachments(session).map((attachment) => {
    const resolvedPath = attachment.path ? path.resolve(attachment.path) : null;
    const existsOnDisk = !!resolvedPath && fs.existsSync(resolvedPath);
    let artifact = attachment.artifactId ? getFile(attachment.artifactId) : undefined;
    if (!artifact && resolvedPath) artifact = findArtifactsByPaths([resolvedPath])[0];
    return {
      ...attachment,
      artifactId: attachment.artifactId ?? artifact?.id ?? null,
      sha256: attachment.sha256 ?? artifact?.sha256 ?? null,
      producingRunId: attachment.producingRunId ?? artifact?.producingRunId ?? null,
      resolvedPath,
      existsOnDisk,
      url: attachment.url ?? artifact?.sourceUrl ?? null,
      screeningState: attachment.screeningState,
      contentScreening: attachment.contentScreening ?? null,
    };
  });
}
