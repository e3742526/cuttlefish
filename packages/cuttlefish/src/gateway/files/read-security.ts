import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactText } from "../../shared/redact.js";
import type { ApiContext } from "../api/context.js";
import { GATEWAY_INFO_FILE } from "../../shared/paths.js";
import { CUTTLEFISH_HOME, expandPath, mimeFromFilename } from "./storage.js";

export const MAX_READ_SIZE = 5 * 1024 * 1024;

function isBinaryMime(mime: string): boolean {
  return (
    mime.startsWith("image/") ||
    mime.startsWith("audio/") ||
    mime.startsWith("video/") ||
    mime.startsWith("font/") ||
    mime === "application/pdf" ||
    mime === "application/zip" ||
    mime === "application/gzip" ||
    mime === "application/x-tar" ||
    mime === "application/octet-stream" ||
    mime === "application/msword" ||
    mime.startsWith("application/vnd.")
  );
}

export function readPathCandidates(requestedPath: string): string[] {
  const p = String(requestedPath ?? "").trim();
  if (!p) return [];
  if (p.startsWith("/") || p.startsWith("~")) {
    return [path.resolve(expandPath(p))];
  }
  return [
    path.resolve(CUTTLEFISH_HOME, p),
    path.resolve(os.homedir(), "Projects", p),
    path.resolve(process.cwd(), p),
    path.resolve(p),
  ];
}

export function resolveReadPath(requestedPath: string): { resolvedPath: string | null; candidates: string[] } {
  const candidates = readPathCandidates(requestedPath);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return { resolvedPath: candidate, candidates };
      }
    } catch {
    }
  }
  return { resolvedPath: null, candidates };
}

export interface FileReadAssessment { allowed: boolean; reason?: string }

function pathSegments(absPath: string): string[] {
  return path.resolve(absPath).split(path.sep).filter(Boolean).map((s) => s.toLowerCase());
}

function realpathOrResolved(absPath: string): string {
  const resolved = path.resolve(absPath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isInsidePath(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}

function assessSingleResolvedPath(resolved: string): FileReadAssessment {
  const base = path.basename(resolved).toLowerCase();
  const segments = pathSegments(resolved);
  const home = realpathOrResolved(os.homedir());
  const cuttlefishHome = realpathOrResolved(CUTTLEFISH_HOME);
  if (base.startsWith(".env")) return { allowed: false, reason: "Refusing to read environment secret files" };
  if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|.*\.pem|.*\.key|auth\.json|credentials(?:\.json)?|\.credentials(?:\.json)?|token(?:\.json|\.txt)?|application_default_credentials\.json|\.npmrc|\.netrc|\.git-credentials)$/i.test(base)) {
    return { allowed: false, reason: "Refusing to read private keys, credentials, or token files" };
  }
  if (isInsidePath(resolved, path.join(home, ".ssh"))) return { allowed: false, reason: "Refusing to read SSH secrets" };
  if (isInsidePath(resolved, path.join(cuttlefishHome, "secrets"))) return { allowed: false, reason: "Refusing to read Cuttlefish secrets" };
  if (isInsidePath(resolved, GATEWAY_INFO_FILE)) return { allowed: false, reason: "Refusing to read the Cuttlefish gateway admin token" };
  if (segments.includes(".claude") && (base.startsWith("auth") || base.startsWith(".credentials"))) return { allowed: false, reason: "Refusing to read Claude auth files" };
  if (segments.includes(".codex") && base === "auth.json") return { allowed: false, reason: "Refusing to read Codex auth files" };
  if (segments.includes(".aws") && base === "credentials") return { allowed: false, reason: "Refusing to read AWS credentials" };
  if (segments.includes(".kube") && base === "config") return { allowed: false, reason: "Refusing to read kubeconfig" };
  if (segments.includes(".docker") && base === "config.json") return { allowed: false, reason: "Refusing to read Docker registry credentials" };
  if (segments.includes("gcloud") && base === "application_default_credentials.json") return { allowed: false, reason: "Refusing to read gcloud application default credentials" };
  return { allowed: true };
}

export function assessFileRead(absPath: string, _opts: { authenticated?: boolean } = {}): FileReadAssessment {
  const requested = path.resolve(expandPath(absPath));
  const candidates = [requested];
  const real = realpathOrResolved(requested);
  if (real !== requested) candidates.push(real);
  for (const candidate of candidates) {
    const assessment = assessSingleResolvedPath(candidate);
    if (!assessment.allowed) return assessment;
  }
  return { allowed: true };
}

export function isAllowedReadPath(
  absPath: string,
  context: Pick<ApiContext, "getConfig">,
): boolean {
  const gateway = (context.getConfig().gateway ?? {}) as Record<string, unknown> & {
    allowArbitraryFileRead?: boolean;
    fileReadRoots?: string[];
  };
  if (gateway.allowArbitraryFileRead === true) return true;
  const roots = gateway.fileReadRoots;
  if (!Array.isArray(roots) || roots.length === 0) return true;
  const resolved = realpathOrResolved(absPath);
  return roots.some((root) => isInsidePath(resolved, realpathOrResolved(root)));
}

export interface FileClassification {
  mime: string;
  size: number;
  tooLarge: boolean;
  binary: boolean;
  content?: string;
}

export function classifyFile(absPath: string): FileClassification {
  const stat = fs.statSync(absPath);
  const size = stat.size;
  const mime = mimeFromFilename(absPath);

  if (size > MAX_READ_SIZE) {
    return { mime, size, tooLarge: true, binary: false };
  }
  if (isBinaryMime(mime)) {
    return { mime, size, tooLarge: false, binary: true };
  }

  const buffer = fs.readFileSync(absPath);
  const scanLen = Math.min(buffer.length, 8192);
  for (let i = 0; i < scanLen; i++) {
    if (buffer[i] === 0) {
      return { mime, size, tooLarge: false, binary: true };
    }
  }

  return { mime, size, tooLarge: false, binary: false, content: redactText(buffer.toString("utf-8")) };
}
