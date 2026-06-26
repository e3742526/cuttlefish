import fs from "node:fs/promises";
import path from "node:path";
import type { BatchEmitResult, ExternalKnowledgeEnvelope, HealthResult, KnowledgeSink } from "../../shared/types.js";

export class JsonlKnowledgeSink implements KnowledgeSink {
  readonly name = "jsonl";

  constructor(private readonly filePath: string) {}

  async emit(envelopes: ExternalKnowledgeEnvelope[]): Promise<BatchEmitResult> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const body = envelopes.map((envelope) => JSON.stringify(envelope)).join("\n");
    if (body) await fs.appendFile(this.filePath, body + "\n", "utf-8");
    return {
      accepted: envelopes.length,
      rejected: 0,
      retryable: false,
      results: envelopes.map(() => ({ accepted: true })),
    };
  }

  async health(): Promise<HealthResult> {
    return { ok: true, detail: this.filePath };
  }
}
