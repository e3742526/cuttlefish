import type {
  Approval,
  CuttlefishConfig,
  ExternalKnowledgeEnvelope,
  KnowledgeSink,
  Session,
} from "../shared/types.js";
import { logger } from "../shared/logger.js";
import {
  enqueueExternalOutboxItem,
  listPendingExternalOutboxItems,
  markExternalOutboxDelivered,
  markExternalOutboxFailed,
} from "../sessions/registry.js";
import type { SessionMessage } from "../sessions/registry/messages.js";
import { buildCheckpointDecisionEnvelope, buildSessionSummaryEnvelope } from "./envelopes.js";

function nextAttemptAt(attemptCount: number, baseDelayMs: number, maxDelayMs: number): string {
  const exponent = Math.max(0, attemptCount - 1);
  const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, exponent));
  return new Date(Date.now() + delay).toISOString();
}

export function knowledgeRelayOptions(config: CuttlefishConfig): {
  batchSize: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
} {
  return {
    batchSize: config.knowledge?.sink?.webhook?.batchSize ?? 25,
    retryBaseDelayMs: config.knowledge?.sink?.webhook?.retry?.baseDelayMs ?? 1_000,
    retryMaxDelayMs: config.knowledge?.sink?.webhook?.retry?.maxDelayMs ?? 60_000,
  };
}

export function enqueueKnowledgeEnvelope(envelope: ExternalKnowledgeEnvelope, sinkName: string) {
  const item = enqueueExternalOutboxItem({ envelope, sinkName });
  logger.info(`knowledge: queued ${envelope.topic} (${item.id})`);
  return item;
}

export async function flushKnowledgeOutboxBatch(input: {
  sink: KnowledgeSink;
  batchSize: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}): Promise<{ attempted: number; delivered: number; failed: number }> {
  const items = listPendingExternalOutboxItems(input.batchSize);
  if (items.length === 0) return { attempted: 0, delivered: 0, failed: 0 };

  const result = await input.sink.emit(items.map((item) => item.envelope));
  let delivered = 0;
  let failed = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const emitResult = result.results[index] ?? {
      accepted: false,
      retryable: result.retryable,
      error: "missing sink result",
    };
    if (emitResult.accepted) {
      markExternalOutboxDelivered(item.id, emitResult.remoteId ?? null);
      delivered += 1;
      logger.info(`knowledge: delivered ${item.topic} (${item.id})`);
      continue;
    }
    const retryAt = nextAttemptAt(item.attemptCount + 1, input.retryBaseDelayMs, input.retryMaxDelayMs);
    markExternalOutboxFailed(item.id, emitResult.error ?? "delivery failed", retryAt);
    failed += 1;
    logger.warn(`knowledge: retry ${item.topic} (${item.id}) at ${retryAt}: ${emitResult.error ?? "delivery failed"}`);
  }
  return { attempted: items.length, delivered, failed };
}

export async function relayPendingKnowledgeOutbox(input: {
  sink: KnowledgeSink;
  batchSize: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}): Promise<{ attempted: number; delivered: number; failed: number }> {
  try {
    return await flushKnowledgeOutboxBatch(input);
  } catch (err) {
    logger.warn(`knowledge: failed ${input.sink.name} relay: ${err instanceof Error ? err.message : String(err)}`);
    return { attempted: 0, delivered: 0, failed: 0 };
  }
}

export async function emitCheckpointDecisionBestEffort(input: {
  checkpoint: Approval;
  session?: Session;
  sink: KnowledgeSink;
  batchSize: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}): Promise<void> {
  const envelope = buildCheckpointDecisionEnvelope(input.checkpoint, input.session);
  enqueueKnowledgeEnvelope(envelope, input.sink.name);
  await relayPendingKnowledgeOutbox(input);
}

export async function emitSessionSummaryBestEffort(input: {
  session: Session;
  messages: SessionMessage[];
  sink: KnowledgeSink;
  batchSize: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}): Promise<void> {
  const envelope = buildSessionSummaryEnvelope(input.session, input.messages);
  enqueueKnowledgeEnvelope(envelope, input.sink.name);
  await relayPendingKnowledgeOutbox(input);
}
