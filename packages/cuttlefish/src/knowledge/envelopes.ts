import { createHash, randomUUID } from "node:crypto";
import type {
  Approval,
  CuttlefishCheckpointDecisionV1,
  CuttlefishSessionSummaryV1,
  ExternalKnowledgeEnvelope,
  Session,
} from "../shared/types.js";
import type { SessionMessage } from "../sessions/registry/messages.js";

function hashSeed(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 24);
}

function excerpt(value: string | null | undefined, limit: number): string | null {
  if (!value) return null;
  const flat = value.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > limit ? flat.slice(0, limit - 1).trimEnd() + "…" : flat;
}

function latestAssistantExcerpt(messages: SessionMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant" && messages[index].content.trim()) {
      return excerpt(messages[index].content, 280);
    }
  }
  return null;
}

function workspaceOf(session: Session): string | null {
  return session.cwd ?? null;
}

export function buildSessionSummaryEnvelope(
  session: Session,
  messages: SessionMessage[],
): ExternalKnowledgeEnvelope<CuttlefishSessionSummaryV1> {
  const occurredAt = session.lastActivity;
  const idempotencyKey = `session-summary:${session.id}:${session.totalTurns}:${session.lastActivity}`;
  return {
    envelopeId: randomUUID(),
    producer: "cuttlefish",
    schemaVersion: "1",
    topic: "cuttlefish.session.summary.v1",
    occurredAt,
    idempotencyKey,
    partitionKey: session.sessionKey || session.id,
    workspace: workspaceOf(session),
    actor: session.userId ?? null,
    sourceRef: session.sourceRef,
    payload: {
      sessionId: session.id,
      source: session.source,
      sourceRef: session.sourceRef,
      engine: session.engine,
      model: session.model ?? null,
      employee: session.employee ?? null,
      status: session.status,
      promptExcerpt: session.promptExcerpt ?? null,
      finalAssistantExcerpt: latestAssistantExcerpt(messages),
      lastError: session.lastError ?? null,
      completedAt: occurredAt,
    },
  };
}

export function buildCheckpointDecisionEnvelope(
  checkpoint: Approval,
  session: Session | undefined,
): ExternalKnowledgeEnvelope<CuttlefishCheckpointDecisionV1> {
  const resolvedAt = checkpoint.resolvedAt ?? checkpoint.createdAt;
  const decisionNeeded = typeof checkpoint.payload.decisionNeeded === "string" ? checkpoint.payload.decisionNeeded : null;
  const why = typeof checkpoint.payload.why === "string" ? checkpoint.payload.why : null;
  return {
    envelopeId: hashSeed(`${checkpoint.id}:${checkpoint.state}:${resolvedAt}`),
    producer: "cuttlefish",
    schemaVersion: "1",
    topic: "cuttlefish.checkpoint.decision.v1",
    occurredAt: resolvedAt,
    idempotencyKey: `checkpoint-decision:${checkpoint.id}:${checkpoint.state}:${resolvedAt}`,
    partitionKey: session?.sessionKey ?? checkpoint.sessionId,
    workspace: session?.cwd ?? null,
    actor: checkpoint.actor ?? null,
    sourceRef: session?.sourceRef ?? null,
    payload: {
      checkpointId: checkpoint.id,
      sessionId: checkpoint.sessionId,
      decision: checkpoint.state,
      resultingAction: checkpoint.resultingAction ?? "record_only",
      decisionNeeded,
      why,
      actor: checkpoint.actor ?? null,
      notes: checkpoint.decisionNotes ?? null,
      resolvedAt,
    },
  };
}
