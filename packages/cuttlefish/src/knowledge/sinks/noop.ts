import type { BatchEmitResult, ExternalKnowledgeEnvelope, HealthResult, KnowledgeSink } from "../../shared/types.js";

export class NoopKnowledgeSink implements KnowledgeSink {
  readonly name = "noop";

  async emit(envelopes: ExternalKnowledgeEnvelope[]): Promise<BatchEmitResult> {
    return {
      accepted: envelopes.length,
      rejected: 0,
      retryable: false,
      results: envelopes.map(() => ({ accepted: true, remoteId: "noop" })),
    };
  }

  async health(): Promise<HealthResult> {
    return { ok: true, detail: "noop sink active" };
  }
}
