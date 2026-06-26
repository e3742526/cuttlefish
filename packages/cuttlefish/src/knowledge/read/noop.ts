import type {
  HealthResult,
  KnowledgeContextRequest,
  KnowledgeContextResponse,
  KnowledgeReadProvider,
  KnowledgeSearchRequest,
  KnowledgeSearchResponse,
} from "../../shared/types.js";

export class NoopKnowledgeReadProvider implements KnowledgeReadProvider {
  readonly name = "none";

  async search(_request: KnowledgeSearchRequest): Promise<KnowledgeSearchResponse> {
    return { results: [] };
  }

  async context(_request: KnowledgeContextRequest): Promise<KnowledgeContextResponse> {
    return { items: [] };
  }

  async health(): Promise<HealthResult> {
    return { ok: true, detail: "read provider disabled" };
  }
}
