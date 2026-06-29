import type { JsonObject } from "./json.js";

export type RunAttachmentKind = "file" | "folder" | "url" | "artifact";
export type RunAttachmentAccess = "read_only" | "writable";
export type UntrustedContentSource =
  | "attachment"
  | "fetched_page"
  | "connector_message"
  | "email_body"
  | "ocr_text"
  | "pasted_external"
  | "skill_file";
export type ContentScreeningVerdict =
  | "benign"
  | "instructional_but_in_scope"
  | "suspicious_non_destructive"
  | "destructive_or_exfiltrative"
  | "unclear_requires_human";
export type ContentScreeningAction = "allow" | "sanitize" | "quarantine" | "checkpoint";
export type ContentScreeningState = "screened" | "not_text_screened" | "screening_unavailable";

export interface ContentScreeningResult {
  source: UntrustedContentSource;
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

export interface Session {
  id: string;
  engine: string;
  engineSessionId: string | null;
  source: string;
  sourceRef: string;
  connector: string | null;
  sessionKey: string;
  replyContext: JsonObject | null;
  messageId: string | null;
  transportMeta: JsonObject | null;
  employee: string | null;
  model: string | null;
  title: string | null;
  /** ≤140-char whitespace-flattened excerpt of the creation prompt — "what was asked". */
  promptExcerpt?: string | null;
  parentSessionId: string | null;
  /** Forwarded SSO identity captured from an auth proxy (opt-in via
   *  `gateway.userHeader`). Null/undefined for single-user installs. */
  userId?: string | null;
  status: "idle" | "running" | "error" | "waiting" | "interrupted";
  effortLevel: string | null;
  /** Working directory the engine runs in for this session. NULL/undefined =
   *  use the default (CUTTLEFISH_HOME). Set at new-chat time (web folder picker). */
  cwd?: string | null;
  totalCost: number;
  totalTurns: number;
  /** Most recent turn's input-context token count (for the UI context meter). */
  lastContextTokens: number | null;
  queueDepth?: number;
  transportState?: "idle" | "queued" | "running" | "error" | "interrupted";
  /** Serialize-time only (in-memory, never persisted): post-settle background
   *  work — the CLI still has upstream API requests in flight (background
   *  subagents/tasks) after the turn settled. Null when none. */
  backgroundActivity?: { activeStreams: number; lastActivityAt: string } | null;
  /** Serialize-time only: normalized run resources persisted in transportMeta. */
  attachments?: RunAttachment[];
  createdAt: string;
  lastActivity: string;
  lastError: string | null;
}
