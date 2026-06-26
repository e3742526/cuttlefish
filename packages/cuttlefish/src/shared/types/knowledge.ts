import type { JsonObject } from "./json.js";

export type ExternalKnowledgeTopic =
  | "cuttlefish.session.summary.v1"
  | "cuttlefish.checkpoint.decision.v1"
  | "cuttlefish.finding.recorded.v1";

export interface ExternalKnowledgeEnvelope<TPayload extends object = object> {
  envelopeId: string;
  producer: string;
  schemaVersion: string;
  topic: ExternalKnowledgeTopic;
  occurredAt: string;
  idempotencyKey: string;
  partitionKey: string | null;
  workspace: string | null;
  actor: string | null;
  sourceRef: string | null;
  payload: TPayload;
}

export interface CuttlefishSessionSummaryV1 {
  sessionId: string;
  source: string;
  sourceRef: string;
  engine: string;
  model: string | null;
  employee: string | null;
  status: string;
  promptExcerpt: string | null;
  finalAssistantExcerpt: string | null;
  lastError: string | null;
  completedAt: string;
}

export interface CuttlefishCheckpointDecisionV1 {
  checkpointId: string;
  sessionId: string;
  decision: string;
  resultingAction: string;
  decisionNeeded: string | null;
  why: string | null;
  actor: string | null;
  notes: string | null;
  resolvedAt: string;
}

export interface EmitResult {
  accepted: boolean;
  remoteId?: string | null;
  retryable?: boolean;
  error?: string | null;
}

export interface BatchEmitResult {
  accepted: number;
  rejected: number;
  retryable: boolean;
  results: EmitResult[];
}

export interface HealthResult {
  ok: boolean;
  detail?: string | null;
}

export interface KnowledgeSink {
  readonly name: string;
  emit(envelopes: ExternalKnowledgeEnvelope[]): Promise<BatchEmitResult>;
  health(): Promise<HealthResult>;
}

export interface KnowledgeSearchRequest {
  query: string;
  limit?: number;
  workspace?: string | null;
}

export interface KnowledgeSearchResult {
  id: string;
  title?: string | null;
  excerpt?: string | null;
  score?: number | null;
  sourceRef?: string | null;
  metadata?: JsonObject | null;
}

export interface KnowledgeSearchResponse {
  results: KnowledgeSearchResult[];
}

export interface KnowledgeContextRequest {
  sessionId?: string;
  query?: string;
  limit?: number;
  workspace?: string | null;
}

export interface KnowledgeContextItem {
  id: string;
  content: string;
  title?: string | null;
  sourceRef?: string | null;
  metadata?: JsonObject | null;
}

export interface KnowledgeContextResponse {
  items: KnowledgeContextItem[];
}

export interface KnowledgeReadProvider {
  readonly name: string;
  search(request: KnowledgeSearchRequest): Promise<KnowledgeSearchResponse>;
  context(request: KnowledgeContextRequest): Promise<KnowledgeContextResponse>;
  health(): Promise<HealthResult>;
}
