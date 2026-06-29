import type { TalkGraphNodeWire } from '@/routes/talk/protocol'
import { archiveApi } from "./api-archives"
import { approvalApi } from "./api-approvals"
import { authFetch, del, extractErrorMessage, get, post, put } from "./api-core"
import { orgApi } from "./api-org"

export type {
  Approval,
  ApprovalDecision,
  ApprovalState,
  Checkpoint,
  CheckpointDecisionInput,
  CheckpointPayload,
} from "./api-approvals"
export type {
  ArchiveKind,
  ArchivedMessage,
  ArchivedMessageMedia,
  ArchivedSessionSnapshot,
  CreateArchivePayload,
  ProjectArchive,
  ProjectArchiveDetail,
} from "./api-archives"
export type {
  Employee,
  EmployeeCreate,
  EmployeeUpdate,
  OrgData,
  OrgHierarchy,
  OrgWarning,
} from "./api-org"

export interface TranscriptContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking'
  text?: string
  name?: string
  input?: Record<string, unknown>
}

export interface TranscriptEntry {
  role: 'user' | 'assistant' | 'system'
  content: TranscriptContentBlock[]
}

export interface QueueItem {
  id: string;
  sessionId: string;
  prompt: string;
  status: 'pending' | 'running' | 'cancelled' | 'completed';
  position: number;
  createdAt: string;
}

interface UploadedFile {
  id: string
  filename: string
  size: number
  mimetype: string | null
}

/**
 * Background work still running after a session's turn officially ended
 * (subagents / background tasks making API calls). Present on session rows
 * (list + detail) and pushed live via the `session:background` WS event.
 * null/absent = no background work.
 */
export interface BackgroundActivity {
  activeStreams: number
  lastActivityAt: string
}

export interface SessionsResponse {
  /** Top-N most-recent sessions per group (employee / direct / cron). */
  sessions: Record<string, unknown>[]
  /** Total session count per group key, so the UI can show accurate "+N more". */
  counts: Record<string, number>
  /** How many per group the server returned (the load-more threshold). */
  perGroup: number
}

// --- Model + capability registry (GET /api/engines) ---
export interface ModelInfo {
  id: string;
  label: string;
  supportsEffort: boolean;
  effortLevels: string[];
  contextWindow?: number;
}
export interface EngineRegistryEntry {
  name: string;
  available: boolean;
  defaultModel: string;
  effortMechanism: "claude-flag" | "codex-config" | "grok-flag" | "pi-flag" | "none";
  models: ModelInfo[];
}
export interface EnginesResponse {
  default: string;
  engines: Record<string, EngineRegistryEntry>;
}

// --- Engine quota/limit snapshots (GET /api/engine-limits) ---
export interface EngineLimitWindow {
  name: string;
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
  resetsAtIso?: string;
}

export interface EngineLimitContext {
  usedPercent?: number;
  remainingPercent?: number;
  contextWindowSize?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
}

export interface EngineLimitCredits {
  hasCredits?: boolean;
  unlimited?: boolean;
  balance?: string;
  limit?: number;
  used?: number;
  remainingPercent?: number;
  resetsAt?: number;
  resetsAtIso?: string;
}

export interface EngineLimitBucket {
  id: string;
  name?: string;
  planType?: string;
  primary?: EngineLimitWindow;
  secondary?: EngineLimitWindow;
  credits?: EngineLimitCredits;
}

export interface EngineLimitEngineSnapshot {
  name: string;
  available: boolean;
  status: "live" | "snapshot" | "static" | "unsupported" | "error";
  source: string;
  refreshedAt: string;
  defaultModel?: string;
  models: ModelInfo[];
  accountPlan?: string;
  windows?: EngineLimitWindow[];
  buckets?: EngineLimitBucket[];
  credits?: EngineLimitCredits;
  context?: EngineLimitContext;
  costUsd?: number;
  unsupportedReason?: string;
  error?: string;
  stale?: boolean;
}

export interface EngineLimitsResponse {
  generatedAt: string;
  default: string;
  engines: Record<string, EngineLimitEngineSnapshot>;
}

// --- Talk: session search + delegate (Mission Control) ---
export interface TalkSearchHit {
  snippet: string
  role: string
  ts: number
}
export interface TalkSearchResult {
  sessionId: string
  title: string | null
  employee: string | null
  source: string
  lastActivity: string
  status: string
  isTalkChild: boolean
  hits: TalkSearchHit[]
}
export interface TalkSearchResponse {
  ok: true
  results: TalkSearchResult[]
}
/** POST /api/talk/delegate body — see talkDelegate() / the server delegate.ts. */
export interface TalkDelegateBody {
  /** The caller's own talk session id (orchestratorId). Required. */
  sessionId: string
  /** "new" to spawn, or a session id to continue / attach / detach. */
  thread: string
  attach?: boolean
  detach?: boolean
  mode?: "observe" | "engage"
  brief?: string
  label?: string
  utterance?: string
}
export type TalkDelegateResult =
  | { ok: true; threadId: string; created: boolean }
  | { ok: true; threadId: string; attached: true; mode: "observe" | "engage" }
  | { ok: true; threadId: string; detached: true }

export type WorkState =
  | 'queued' | 'running' | 'waiting_on_human' | 'blocked' | 'completed' | 'failed'

export interface WorkItem {
  sessionId: string
  employee: string | null
  dept: string | null
  workState: WorkState
  title: string | null
}

export interface WorkOverview {
  counts: Record<WorkState, number>
  items: WorkItem[]
}

export interface FsEntry { name: string; isDir: boolean }
export interface FsListResult { path: string; parent: string | null; entries: FsEntry[] }
export interface FsRecent { default: string; recent: string[] }

// --- Kanban / Department Board types ---
export interface DepartmentBoardTicket {
  id: string
  title: string
  description?: string
  status: 'backlog' | 'todo' | 'in_progress' | 'review' | 'done' | 'blocked'
  priority?: 'low' | 'medium' | 'high'
  complexity?: 'low' | 'medium' | 'high'
  assignee?: string
  resourcePath?: string
  resourceUrl?: string
  manualOnly?: boolean
  source?: string
  sessionId?: string
  createdAt?: string
  updatedAt?: string
  baseUpdatedAt?: string
  deletedAt?: string
}

export interface DepartmentBoardResponse {
  tickets: DepartmentBoardTicket[]
  deletedTickets: DepartmentBoardTicket[]
  retentionDays?: number
}

export interface UpdateDepartmentBoardPayload {
  tickets: DepartmentBoardTicket[]
  deletedIds?: string[]
  deletedVersions?: Record<string, string>
  retentionDays?: number
}

export interface RejectedBoardTicket {
  index: number
  id: string | null
  title: string | null
  error: string
}

export interface UpdateDepartmentBoardResponse {
  status: 'ok' | 'partial'
  rejectedTickets?: RejectedBoardTicket[]
}

export interface DispatchTicketResponse {
  status: string
  sessionId?: string
}

export interface TicketSessionMessage {
  role: 'user' | 'assistant'
  text: string
  ts: number
  toolCall?: unknown
  kind?: string
}

export interface TicketSessionResponse {
  found: boolean
  sessionId?: string
  messages?: TicketSessionMessage[]
  status?: string
  stalled?: boolean
  stalledForMs?: number
  lastActivityAgoMs?: number
  lastActivityIso?: string
  fallback?: { active: boolean; toEngine?: string; fromEngine?: string; toModel?: string }
  engine?: string
  model?: string
  totalCost?: number
  lastError?: string
  failureReason?: string
}

export const api = {
  ...approvalApi,
  ...archiveApi,
  ...orgApi,
  authStatus: () => get<{ required: boolean; authenticated: boolean }>("/api/auth/status"),
  login: (token: string) => post<{ status: string }>("/api/auth/login", { token }),
  logout: () => post<{ status: string }>("/api/auth/logout", {}),
  getStatus: () => get<Record<string, unknown>>("/api/status"),
  /** Working-folder picker: list subdirectories of a path (dirs only). */
  fsList: (p?: string) => get<FsListResult>(`/api/fs/list${p ? `?path=${encodeURIComponent(p)}` : ""}`),
  /** Working-folder picker: default dir + most-recently-used working dirs. */
  fsRecent: () => get<FsRecent>("/api/fs/recent"),
  /** Feature 2: normalized work-state across all sessions. */
  getWork: () => get<WorkOverview>("/api/work"),
  /** Resolved model + capability registry (engines, their models, effort levels). */
  getEngines: () => get<EnginesResponse>("/api/engines"),
  /** Force re-discovery of dynamic (pi) models, returning the rebuilt registry. */
  refreshEngines: () => post<EnginesResponse>("/api/engines/refresh"),
  getEngineLimits: (engine?: string) =>
    get<EngineLimitsResponse>(`/api/engine-limits${engine ? `?engine=${encodeURIComponent(engine)}` : ""}`),
  refreshEngineLimits: (engine?: string) =>
    post<EngineLimitsResponse>(`/api/engine-limits/refresh${engine ? `?engine=${encodeURIComponent(engine)}` : ""}`, {}),
  getSessions: () => get<SessionsResponse>("/api/sessions"),
  /** One group's sessions, newest first — used by the sidebar "load more" button. */
  getSessionsForGroup: (group: string, offset: number, limit = 50) =>
    get<Record<string, unknown>[]>(
      `/api/sessions?group=${encodeURIComponent(group)}&offset=${offset}&limit=${limit}`,
    ),
  /** Search across ALL sessions (title / employee / id), newest first. */
  searchSessions: (query: string) =>
    get<Record<string, unknown>[]>(`/api/sessions?q=${encodeURIComponent(query)}`),
  getSession: (id: string) => get<Record<string, unknown>>(`/api/sessions/${id}`),
  getSessionChildren: (id: string) => get<Record<string, unknown>[]>(`/api/sessions/${id}/children`),
  updateSession: (id: string, data: { title?: string; model?: string; effortLevel?: string }) =>
    put<Record<string, unknown>>(`/api/sessions/${id}`, data),
  deleteSession: (id: string) => del<Record<string, unknown>>(`/api/sessions/${id}`),
  duplicateSession: (id: string) =>
    post<Record<string, unknown>>(`/api/sessions/${id}/duplicate`, {}),
  bulkDeleteSessions: (ids: string[]) =>
    post<{ status: string; count: number }>("/api/sessions/bulk-delete", { ids }),
  createSession: (data: Record<string, unknown>) =>
    post<Record<string, unknown>>("/api/sessions", data),
  sendMessage: (id: string, data: Record<string, unknown>) =>
    post<Record<string, unknown>>(`/api/sessions/${id}/message`, data),
  stopSession: (id: string) =>
    post<{ status: string; sessionId: string; stopped: boolean; interruptible: boolean }>(`/api/sessions/${id}/stop`, {}),
  createPtyToken: (id: string) =>
    post<{ token: string; expiresInMs: number }>(`/api/sessions/${id}/pty-token`, {}),
  resetSession: (id: string) =>
    post<{ status: string; sessionId: string }>(`/api/sessions/${id}/reset`, {}),
  getCronJobs: () => get<Record<string, unknown>[]>("/api/cron"),
  getCronRuns: (id: string, runId?: string) =>
    get<Record<string, unknown>[]>(
      `/api/cron/${id}/runs${runId ? `?runId=${encodeURIComponent(runId)}` : ""}`,
    ),
  updateCronJob: (id: string, data: Record<string, unknown>) =>
    put<Record<string, unknown>>(`/api/cron/${id}`, data),
  triggerCronJob: (id: string) =>
    post<Record<string, unknown>>(`/api/cron/${id}/trigger`, {}),
  getDepartmentBoard: (name: string) =>
    get<DepartmentBoardResponse>(`/api/org/departments/${name}/board`),
  getSkills: () => get<Record<string, unknown>[]>("/api/skills"),
  getSkill: (name: string) => get<Record<string, unknown>>(`/api/skills/${name}`),
  getConfig: () => get<Record<string, unknown>>("/api/config"),
  reloadConnectors: () =>
    post<{ started: string[]; stopped: string[]; errors: string[] }>("/api/connectors/reload", {}),
  updateConfig: (data: Record<string, unknown>) =>
    put<Record<string, unknown>>("/api/config", data),
  getLogs: (n?: number) =>
    get<{ lines: string[] }>(`/api/logs${n ? `?n=${n}` : ""}`),
  getOnboarding: () =>
    get<{ needed: boolean; onboarded: boolean; sessionsCount: number; hasEmployees: boolean; portalName: string | null; operatorName: string | null }>("/api/onboarding"),
  completeOnboarding: (data: { portalName?: string; operatorName?: string; language?: string; engine?: string; model?: string; effortLevel?: string }) =>
    post<{ status: string; portal: { portalName?: string; operatorName?: string; language?: string } }>("/api/onboarding", data),
  getActivity: () =>
    get<Array<{ event: string; payload: unknown; ts: number }>>("/api/activity"),
  updateDepartmentBoard: (name: string, data: UpdateDepartmentBoardPayload) =>
    put<UpdateDepartmentBoardResponse>(`/api/org/departments/${name}/board`, data),
  dispatchTicket: (department: string, ticketId: string) =>
    post<DispatchTicketResponse>(`/api/org/departments/${department}/tickets/${ticketId}/dispatch`, {}),
  escalateToLead: (department: string, ticketId: string) =>
    post<DispatchTicketResponse>(`/api/org/departments/${department}/tickets/${ticketId}/dispatch`, { routeToManager: true }),
  getTicketSession: (department: string, ticketId: string) =>
    get<TicketSessionResponse>(`/api/org/departments/${department}/tickets/${ticketId}/session`),
  sttStatus: () =>
    get<{ available: boolean; model: string | null; downloading: boolean; progress: number; languages: string[] }>("/api/stt/status"),
  sttDownload: () =>
    post<{ status: string; model: string }>("/api/stt/download", {}),
  sttTranscribe: async (audioBlob: Blob, language?: string): Promise<{ text: string }> => {
    const params = language ? `?language=${encodeURIComponent(language)}` : "";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5 * 60_000); // 5 min timeout
    try {
      const res = await authFetch(`/api/stt/transcribe${params}`, {
        method: "POST",
        headers: { "Content-Type": audioBlob.type || "audio/webm" },
        credentials: "include",
        body: audioBlob,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error("Transcription timed out (5 min)");
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  },
  sttUpdateConfig: (languages: string[]) =>
    put<{ status: string; languages: string[] }>("/api/stt/config", { languages }),
  /**
   * Talk (Path 1): bootstrap (or reuse) the voice orchestrator —
   * a real gateway session with source:"talk". Voice turns then go through the
   * normal sendMessage(); the spoken reply streams back as talk:audio over WS.
   */
  talkCreateSession: (fresh = false) =>
    post<{ sessionId: string; reused: boolean }>("/api/talk/session", { fresh }),
  /** Talk: full delegation-tree snapshot under the orchestrator (Mission Control).
   *  Nodes are the wire type (incl. briefExcerpt/attached/mode), not a stripped copy. */
  getTalkGraph: (rootId: string) =>
    get<{ rootId: string; nodes: TalkGraphNodeWire[] }>(
      `/api/talk/graph?root=${encodeURIComponent(rootId)}`,
    ),
  /** Talk: TTS/loop readiness + the active orchestrator engine/model. */
  talkStatus: () =>
    get<{
      ttsAvailable: boolean
      ttsDownloading: boolean
      progress: number
      voice?: string | null
      ready?: boolean
      /** Active orchestrator engine (null when none is installed). */
      engine: string | null
      model: string | null
      /** True when the configured/default engine was unavailable and we fell back. */
      engineFallback: boolean
      /** Installed engines the orchestrator could use, in priority order. */
      enginesAvailable: string[]
    }>("/api/talk/status"),
  /** Talk: kick off the local TTS model download (progress streams via talk:tts:download:* WS events). */
  talkTtsDownload: () =>
    post<{ status: string; model: string }>("/api/talk/tts/download", {}),
  /** Talk: the currently-active orchestrator engine/model + the available set. */
  talkEngineGet: () =>
    get<{
      engine: string | null
      model: string | null
      fallback: boolean
      reason: string | null
      available: string[]
      configured: string | null
      liveSessionEngine: string | null
    }>("/api/talk/engine"),
  /**
   * Talk: switch the orchestrator engine and/or model.
   * - model: applies to the live session on its next turn (no re-bootstrap).
   * - engine: new-chat-only — the caller MUST re-bootstrap the talk session
   *   (talkCreateSession) so the new engine is adopted.
   */
  talkEngineSet: (body: { engine?: string; model?: string }) =>
    post<{
      ok: boolean
      engine: string | null
      model: string | null
      fallback: boolean
      reason: string | null
      available: string[]
    }>("/api/talk/engine", body),
  /**
   * Talk: tell the gateway this talk session is muted (silent/read mode) so the
   * run loop skips server-side Kokoro synthesis it would otherwise discard.
   * Best-effort — the UI mutes regardless; this just saves the wasted synthesis.
   */
  talkSetMuted: (body: { sessionId: string; muted: boolean }) =>
    post<{ ok: boolean; muted: boolean }>("/api/talk/mute", body),
  /**
   * Talk: search sessions by title/metadata + message content (FTS). Returns
   * merged, de-duped results (≤20, ≤3 hits each); snippets carry «» highlight
   * markers. Throws on 4xx with the backend `error` message.
   */
  talkSearch: (q: string, limit?: number) =>
    get<TalkSearchResponse>(
      `/api/talk/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ""}`,
    ),
  /**
   * Talk: server-owned delegate surface — spawn (thread:"new"), continue an
   * owned COO thread (thread:"<id>"), or attach/detach a soft link
   * (attach:true / detach:true, optional mode:"observe"|"engage" + brief).
   * NOTE: a follow-up to an ALREADY-attached engage session does NOT go here
   * (both delegate paths 400 — see the thread drawer's composer, which uses
   * sendMessage instead). Throws on 4xx with the backend `error` message.
   */
  talkDelegate: (body: TalkDelegateBody) =>
    post<TalkDelegateResult>("/api/talk/delegate", body),
  getSessionQueue: (id: string) =>
    get<QueueItem[]>(`/api/sessions/${id}/queue`),
  cancelQueueItem: (sessionId: string, itemId: string) =>
    del<{ status: string }>(`/api/sessions/${sessionId}/queue/${itemId}`),
  clearSessionQueue: (sessionId: string) =>
    del<{ status: string; cancelled: number; requested?: number }>(`/api/sessions/${sessionId}/queue`),
  pauseSessionQueue: (sessionId: string) =>
    post<{ status: string }>(`/api/sessions/${sessionId}/queue/pause`, {}),
  resumeSessionQueue: (sessionId: string) =>
    post<{ status: string }>(`/api/sessions/${sessionId}/queue/resume`, {}),
  getSessionTranscript: (id: string) =>
    get<TranscriptEntry[]>(`/api/sessions/${id}/transcript`),
  uploadFile: async (file: File, sessionId?: string): Promise<UploadedFile> => {
    const form = new FormData()
    form.append('file', file)
    // When known, scope the upload to the session so it lands in the date-bucketed uploads dir.
    if (sessionId) form.append('sessionId', sessionId)
    const res = await authFetch("/api/files", { method: 'POST', body: form })
    if (!res.ok) throw new Error(await extractErrorMessage(res))
    return res.json()
  },
};
