import type { JsonObject } from "./json.js";

export type RunAttachmentKind = "file" | "folder" | "url" | "artifact";
export type RunAttachmentAccess = "read_only" | "writable";
export type ContentScreeningVerdict =
  | "benign"
  | "instructional_but_in_scope"
  | "suspicious_non_destructive"
  | "destructive_or_exfiltrative"
  | "unclear_requires_human";
export type ContentScreeningAction = "allow" | "sanitize" | "quarantine" | "checkpoint";
export type ContentScreeningState = "screened" | "not_text_screened" | "screening_unavailable";

export interface ContentScreeningResult {
  source: string;
  verdict: ContentScreeningVerdict;
  action: ContentScreeningAction;
  screener: string;
  summary: string;
  suspiciousSpans: string[];
  sanitizedText: string | null;
  occurredAt: string;
}

export interface RunAttachment {
  id: string;
  kind: RunAttachmentKind;
  path: string | null;
  url: string | null;
  artifactId: string | null;
  sha256: string | null;
  access: RunAttachmentAccess;
  intendedUse: string | null;
  producingRunId: string | null;
  createdAt: string;
  resolvedPath?: string | null;
  existsOnDisk?: boolean;
  screeningState?: ContentScreeningState;
  contentScreening?: ContentScreeningResult | null;
}

export type SessionStatus = "idle" | "running" | "error" | "waiting" | "interrupted";
export type SessionTransportState = "idle" | "queued" | "running" | "error" | "interrupted";
export type SessionJobState = "idle" | "working" | "needs_attention" | "finished" | "failed";

export interface BackgroundActivity {
  activeStreams: number;
  lastActivityAt: string;
}

export interface PublicSession {
  id: string;
  engine?: string;
  engineSessionId?: string | null;
  source?: string;
  sourceRef?: string;
  connector?: string | null;
  sessionKey?: string;
  replyContext?: JsonObject | null;
  messageId?: string | null;
  transportMeta?: JsonObject | null;
  employee?: string | null;
  model?: string | null;
  title?: string | null;
  promptExcerpt?: string | null;
  parentSessionId?: string | null;
  userId?: string | null;
  status?: SessionStatus;
  effortLevel?: string | null;
  cwd?: string | null;
  totalCost?: number;
  totalTurns?: number;
  lastContextTokens?: number | null;
  queueDepth?: number;
  transportState?: SessionTransportState;
  /** Operator-facing aggregate state for this session and its delegated descendants. */
  jobState?: SessionJobState;
  backgroundActivity?: BackgroundActivity | null;
  attachments?: RunAttachment[];
  createdAt?: string;
  lastActivity?: string;
  lastError?: string | null;
  [key: string]: unknown;
}
