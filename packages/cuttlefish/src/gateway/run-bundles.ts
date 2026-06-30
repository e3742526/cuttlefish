import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  getMessages,
  getSession,
  listApprovalRecords,
  listArtifacts,
  type FileMeta,
  type SessionMessage,
} from "../sessions/registry.js";
import { LOGS_DIR, RUN_BUNDLES_DIR } from "../shared/paths.js";
import type { Approval, RunAttachment, Session } from "../shared/types.js";
import type { ApiContext } from "./api/context.js";
import { enrichRunAttachmentsForSession } from "./run-attachments.js";
import { serializeSession } from "./api/serialize-session.js";
import { gateExternalEmit } from "../policy/export-gate.js";

interface BundleManifestFile {
  path: string;
  sha256: string;
  size: number;
}

export interface ExportedRunBundle {
  id: string;
  sessionId: string;
  createdAt: string;
  bundlePath: string;
  runPath: string;
  summaryPath: string;
  manifestPath: string;
  errorsPath: string;
  artifactsPath: string;
  logsPath: string;
  manifest: {
    kind: "cuttlefish.runBundle";
    bundleId: string;
    sessionId: string;
    createdAt: string;
    status: Session["status"];
    files: BundleManifestFile[];
    artifactCount: number;
    logCount: number;
    approvalCount: number;
    checkpointCount: number;
  };
}

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "bundle";
}

function hashBuffer(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function hashFile(absPath: string): string {
  return hashBuffer(fs.readFileSync(absPath));
}

function writeBundleFile(root: string, relativePath: string, content: string | Buffer, manifestFiles: BundleManifestFile[]): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf-8");
  fs.writeFileSync(target, buffer);
  manifestFiles.push({
    path: relativePath,
    sha256: hashBuffer(buffer),
    size: buffer.length,
  });
}

function artifactDiskPath(artifact: FileMeta): string | null {
  if (!artifact.path) return null;
  if (!fs.existsSync(artifact.path)) return null;
  try {
    return fs.statSync(artifact.path).isFile() ? artifact.path : null;
  } catch {
    return null;
  }
}

function attachmentFileCandidates(attachments: RunAttachment[]): Array<{ source: string; label: string; sha256: string | null }> {
  return attachments.flatMap((attachment) => {
    if (attachment.kind === "folder") return [];
    const resolved = attachment.resolvedPath ?? attachment.path;
    if (!resolved || !fs.existsSync(resolved)) return [];
    try {
      if (!fs.statSync(resolved).isFile()) return [];
    } catch {
      return [];
    }
    return [{
      source: resolved,
      label: attachment.artifactId ? `attachment-${attachment.artifactId}-${path.basename(resolved)}` : `attachment-${path.basename(resolved)}`,
      sha256: attachment.sha256 ?? null,
    }];
  });
}

function uniqueFileName(dir: string, preferred: string): string {
  const parsed = path.parse(preferred);
  let candidate = preferred;
  let index = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${parsed.name}-${index}${parsed.ext}`;
    index++;
  }
  return candidate;
}

function copyArtifacts(
  root: string,
  producedArtifacts: FileMeta[],
  attachments: RunAttachment[],
  manifestFiles: BundleManifestFile[],
): { copied: Array<{ id: string | null; path: string; sha256: string | null }>; skipped: string[] } {
  const artifactsDir = path.join(root, "artifacts");
  fs.mkdirSync(artifactsDir, { recursive: true });
  const copied: Array<{ id: string | null; path: string; sha256: string | null }> = [];
  const skipped: string[] = [];
  const seenSources = new Set<string>();

  for (const artifact of producedArtifacts) {
    const source = artifactDiskPath(artifact);
    if (!source) {
      skipped.push(artifact.id);
      continue;
    }
    if (seenSources.has(source)) continue;
    seenSources.add(source);
    const filename = uniqueFileName(artifactsDir, `${artifact.id}-${artifact.filename}`);
    const rel = path.join("artifacts", filename);
    fs.copyFileSync(source, path.join(root, rel));
    manifestFiles.push({
      path: rel,
      sha256: artifact.sha256 ?? hashFile(source),
      size: fs.statSync(source).size,
    });
    copied.push({ id: artifact.id, path: rel, sha256: artifact.sha256 ?? null });
  }

  for (const attachment of attachmentFileCandidates(attachments)) {
    if (seenSources.has(attachment.source)) continue;
    seenSources.add(attachment.source);
    const filename = uniqueFileName(artifactsDir, attachment.label);
    const rel = path.join("artifacts", filename);
    fs.copyFileSync(attachment.source, path.join(root, rel));
    manifestFiles.push({
      path: rel,
      sha256: attachment.sha256 ?? hashFile(attachment.source),
      size: fs.statSync(attachment.source).size,
    });
    copied.push({ id: null, path: rel, sha256: attachment.sha256 });
  }

  return { copied, skipped };
}

function filterGatewayLog(session: Session): string[] {
  const logPath = path.join(LOGS_DIR, "gateway.log");
  if (!fs.existsSync(logPath)) return [];
  const text = fs.readFileSync(logPath, "utf-8");
  const needles = [session.id, session.engineSessionId, session.sourceRef, session.title]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return text
    .split("\n")
    .filter((line) => needles.some((needle) => line.includes(needle)))
    .slice(-500);
}

function summarizeMessages(messages: SessionMessage[]): { count: number; firstAt: number | null; lastAt: number | null } {
  if (messages.length === 0) return { count: 0, firstAt: null, lastAt: null };
  return {
    count: messages.length,
    firstAt: messages[0].timestamp,
    lastAt: messages[messages.length - 1].timestamp,
  };
}

function buildSummaryMarkdown(input: {
  session: Session;
  attachments: RunAttachment[];
  approvals: Approval[];
  producedArtifacts: FileMeta[];
  messages: SessionMessage[];
  copiedArtifacts: Array<{ id: string | null; path: string; sha256: string | null }>;
  skippedArtifacts: string[];
}): string {
  const messageSummary = summarizeMessages(input.messages);
  const checkpoints = input.approvals.filter((approval) => approval.type === "checkpoint");
  const lines = [
    `# Run Summary`,
    ``,
    `- Session: \`${input.session.id}\``,
    `- Title: ${input.session.title ?? "(untitled)"}`,
    `- Status: ${input.session.status}`,
    `- Engine: ${input.session.engine}${input.session.model ? ` (${input.session.model})` : ""}`,
    `- Source: ${input.session.source}`,
    `- Created: ${input.session.createdAt}`,
    `- Last activity: ${input.session.lastActivity}`,
    `- Messages: ${messageSummary.count}`,
    `- Produced artifacts: ${input.producedArtifacts.length}`,
    `- Bundled artifact files: ${input.copiedArtifacts.length}`,
    `- Approvals and checkpoints: ${input.approvals.length}`,
    ``,
    `## Prompt`,
    ``,
    input.session.promptExcerpt ?? "(no prompt excerpt recorded)",
    ``,
    `## Attachments`,
    ``,
    ...(input.attachments.length > 0
      ? input.attachments.map((attachment) => `- ${attachment.kind}: ${attachment.url ?? attachment.path ?? attachment.artifactId ?? attachment.id}${attachment.intendedUse ? ` — ${attachment.intendedUse}` : ""}`)
      : ["- none"]),
    ``,
    `## Checkpoints`,
    ``,
    ...(checkpoints.length > 0
      ? checkpoints.map((checkpoint) => `- ${checkpoint.state}: ${(checkpoint.payload.decisionNeeded as string | undefined) ?? checkpoint.id}`)
      : ["- none"]),
  ];
  if (input.skippedArtifacts.length > 0) {
    lines.push("", "## Skipped Artifacts", "", ...input.skippedArtifacts.map((id) => `- ${id}`));
  }
  return lines.join("\n");
}

function buildErrorsJson(input: { session: Session; approvals: Approval[]; messages: SessionMessage[] }): string {
  const checkpointIssues = input.approvals.filter((approval) => approval.state === "rejected" || approval.state === "deferred");
  const notifications = input.messages
    .filter((message) => message.role === "notification")
    .map((message) => ({ timestamp: message.timestamp, content: message.content }))
    .slice(-50);
  return JSON.stringify({
    sessionId: input.session.id,
    status: input.session.status,
    lastError: input.session.lastError,
    checkpoints: checkpointIssues.map((approval) => ({
      id: approval.id,
      state: approval.state,
      notes: approval.decisionNotes ?? null,
      resultingAction: approval.resultingAction ?? null,
    })),
    notifications,
  }, null, 2);
}

export function exportRunBundle(sessionId: string, context: ApiContext): ExportedRunBundle {
  const baseSession = getSession(sessionId);
  if (!baseSession) throw new Error(`session ${sessionId} not found`);
  if (baseSession.status === "running" || baseSession.status === "waiting") {
    throw new Error(`session ${sessionId} is not complete enough to export`);
  }

  const session = serializeSession(baseSession, context);
  const messages = getMessages(sessionId);
  const approvals = listApprovalRecords({ state: "all", sessionId });
  const attachments = enrichRunAttachmentsForSession(baseSession);
  const producedArtifacts = listArtifacts({ producingRunId: sessionId, limit: 1000 });
  const now = new Date().toISOString();
  const bundleId = `${safeSegment(sessionId)}-${Date.now().toString(36)}`;
  const bundlePath = path.join(RUN_BUNDLES_DIR, safeSegment(sessionId), bundleId);

  const exportVerdict = gateExternalEmit({
    kind: "cuttlefish.run_bundle",
    locator: bundlePath,
    sizeBytes: null,
    mimeType: null,
    producingRunId: sessionId,
  });
  if (!exportVerdict.allowed) {
    throw new Error(`run bundle export denied by policy: ${exportVerdict.reason}`);
  }

  fs.mkdirSync(bundlePath, { recursive: true });


  const manifestFiles: BundleManifestFile[] = [];
  const { copied, skipped } = copyArtifacts(bundlePath, producedArtifacts, attachments, manifestFiles);
  const gatewayLogLines = filterGatewayLog(baseSession);

  writeBundleFile(bundlePath, "run.json", JSON.stringify({
    exportedAt: now,
    session,
    messages,
    approvals,
    attachments,
  }, null, 2), manifestFiles);

  writeBundleFile(bundlePath, "summary.md", buildSummaryMarkdown({
    session,
    attachments,
    approvals,
    producedArtifacts,
    messages,
    copiedArtifacts: copied,
    skippedArtifacts: skipped,
  }), manifestFiles);

  writeBundleFile(bundlePath, "errors.json", buildErrorsJson({
    session,
    approvals,
    messages,
  }), manifestFiles);

  writeBundleFile(bundlePath, path.join("logs", "gateway.log"), gatewayLogLines.join("\n"), manifestFiles);

  const manifest = {
    kind: "cuttlefish.runBundle" as const,
    bundleId,
    sessionId,
    createdAt: now,
    status: session.status,
    files: manifestFiles,
    artifactCount: producedArtifacts.length,
    logCount: gatewayLogLines.length,
    approvalCount: approvals.length,
    checkpointCount: approvals.filter((approval) => approval.type === "checkpoint").length,
  };
  const manifestPath = path.join(bundlePath, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  let manifestEntry = {
    path: "manifest.json",
    sha256: hashFile(manifestPath),
    size: fs.statSync(manifestPath).size,
  };
  manifest.files = [...manifest.files, manifestEntry];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  manifestEntry = {
    path: "manifest.json",
    sha256: hashFile(manifestPath),
    size: fs.statSync(manifestPath).size,
  };
  manifest.files = [...manifest.files.filter((file) => file.path !== "manifest.json"), manifestEntry];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    id: bundleId,
    sessionId,
    createdAt: now,
    bundlePath,
    runPath: path.join(bundlePath, "run.json"),
    summaryPath: path.join(bundlePath, "summary.md"),
    manifestPath,
    errorsPath: path.join(bundlePath, "errors.json"),
    artifactsPath: path.join(bundlePath, "artifacts"),
    logsPath: path.join(bundlePath, "logs"),
    manifest,
  };
}
