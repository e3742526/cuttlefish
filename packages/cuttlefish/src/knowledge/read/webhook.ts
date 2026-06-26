import type {
  HealthResult,
  KnowledgeContextRequest,
  KnowledgeContextResponse,
  KnowledgeReadProvider,
  KnowledgeSearchRequest,
  KnowledgeSearchResponse,
} from "../../shared/types.js";
import { validateUrlForServerFetch } from "../../shared/ssrf-guard.js";

export class WebhookKnowledgeReadProvider implements KnowledgeReadProvider {
  readonly name = "webhook";

  constructor(
    private readonly opts: {
      url: string;
      token?: string;
      timeoutMs: number;
    },
  ) {}

  async search(request: KnowledgeSearchRequest): Promise<KnowledgeSearchResponse> {
    const response = await this.postJson<KnowledgeSearchResponse>(request);
    return {
      results: Array.isArray(response?.results) ? response.results : [],
    };
  }

  async context(request: KnowledgeContextRequest): Promise<KnowledgeContextResponse> {
    const response = await this.postJson<KnowledgeContextResponse>(request);
    return {
      items: Array.isArray(response?.items) ? response.items : [],
    };
  }

  async health(): Promise<HealthResult> {
    const check = await validateUrlForServerFetch(this.opts.url, { allowPrivateHosts: true });
    return check.ok ? { ok: true, detail: this.opts.url } : { ok: false, detail: check.reason ?? "invalid provider URL" };
  }

  private async postJson<TResponse>(body: unknown): Promise<TResponse> {
    const check = await validateUrlForServerFetch(this.opts.url, { allowPrivateHosts: true });
    if (!check.ok) throw new Error(check.reason ?? "invalid provider URL");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const response = await fetch(this.opts.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`);
      }
      return await response.json() as TResponse;
    } finally {
      clearTimeout(timeout);
    }
  }
}
