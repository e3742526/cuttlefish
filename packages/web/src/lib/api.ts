import type {
  BackgroundActivity,
  PublicSession,
  WorkspaceProfile,
  WorkspaceProfilesResponse,
} from '@cuttlefish/contracts'
import { archiveApi } from "./api-archives"
import { approvalApi } from "./api-approvals"
import { authFetch, del, extractErrorMessage, get, post, put } from "./api-core"
import { orgApi } from "./api-org"
import { collaborationApi } from "./api-collaboration"

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

export type { BackgroundActivity, PublicSession }

export interface SessionsResponse {
  /** Top-N most-recent sessions per group (employee / direct / cron). */
  sessions: PublicSession[]
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

export type { WorkspaceProfile, WorkspaceProfilesResponse }

export type CommandCenterUsageRange = 'day' | 'week' | 'month'

export interface CommandCenterUsageBucket {
  range: CommandCenterUsageRange
  sessionCount: number
  totalCostUsd: number
  totalTurns: number
  totalTokens: number
}

export interface CommandCenterAgentUsage {
  employee: string
  displayName: string
  rank: string
  department: string | null
  engine: string
  model: string
  running: boolean
  usage: Record<CommandCenterUsageRange, CommandCenterUsageBucket>
}

export interface CommandCenterManagerSummary {
  employee: string
  displayName: string
  department: string | null
  rank: string
  running: boolean
}

export interface CommandCenterResponse {
  generatedAt: string
  summary: {
    agents: number
    agentsRunning: number
    cronJobs: number
    ticketsOpen: number
    ticketsTotal: number
  }
  ticketCounts: Record<string, number>
  managers: CommandCenterManagerSummary[]
  availableAgents: CommandCenterAgentUsage[]
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
  ...collaborationApi,
  ...approvalApi,
  ...archiveApi,
  ...orgApi,
  getStatus: () => get<Record<string, unknown>>("/api/status"),
  /** Working-folder picker: list subdirectories of a path (dirs only). */
  fsList: (p?: string) => get<FsListResult>(`/api/fs/list${p ? `?path=${encodeURIComponent(p)}` : ""}`),
  /** Working-folder picker: default dir + most-recently-used working dirs. */
  fsRecent: () => get<FsRecent>("/api/fs/recent"),
  /** Feature 2: normalized work-state across all sessions. */
  getWork: () => get<WorkOverview>("/api/work"),
  getWorkspaceProfiles: () => get<WorkspaceProfilesResponse>("/api/workspace-profiles"),
  getCommandCenter: () => get<CommandCenterResponse>("/api/command-center"),
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
    get<PublicSession[]>(
      `/api/sessions?group=${encodeURIComponent(group)}&offset=${offset}&limit=${limit}`,
    ),
  /** Search across ALL sessions (title / employee / id), newest first. */
  searchSessions: (query: string) =>
    get<PublicSession[]>(`/api/sessions?q=${encodeURIComponent(query)}`),
  getSession: (id: string) => get<PublicSession & { messages?: import('@cuttlefish/contracts').SessionMessage[] }>(`/api/sessions/${id}`),
  getSessionChildren: (id: string) => get<PublicSession[]>(`/api/sessions/${id}/children`),
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
