import type { BatchEmitResult, ExternalKnowledgeEnvelope, HealthResult, KnowledgeSink } from "../../shared/types.js";
import { validateUrlForServerFetch } from "../../shared/ssrf-guard.js";

export class WebhookKnowledgeSink implements KnowledgeSink {
  readonly name = "webhook";

  constructor(
    private readonly opts: {
      url: string;
      token?: string;
      timeoutMs: number;
    },
  ) {}

  async emit(envelopes: ExternalKnowledgeEnvelope[]): Promise<BatchEmitResult> {
    const check = await validateUrlForServerFetch(this.opts.url, { allowPrivateHosts: true });
    if (!check.ok) {
      return {
        accepted: 0,
        rejected: envelopes.length,
        retryable: false,
        results: envelopes.map(() => ({ accepted: false, retryable: false, error: check.reason ?? "invalid webhook URL" })),
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const response = await fetch(this.opts.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
        },
        body: JSON.stringify({ events: envelopes }),
        signal: controller.signal,
      });
      const retryable = response.status === 429 || response.status >= 500;
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const error = body ? `HTTP ${response.status}: ${body}` : `HTTP ${response.status}`;
        return {
          accepted: 0,
          rejected: envelopes.length,
          retryable,
          results: envelopes.map(() => ({ accepted: false, retryable, error })),
        };
      }
      const payload = await response.json().catch(() => null) as
        | { results?: Array<{ remoteId?: string | null }> }
        | null;
      const results = envelopes.map((_, index) => ({
        accepted: true,
        remoteId: payload?.results?.[index]?.remoteId ?? null,
      }));
      return {
        accepted: results.length,
        rejected: 0,
        retryable: false,
        results,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        accepted: 0,
        rejected: envelopes.length,
        retryable: true,
        results: envelopes.map(() => ({ accepted: false, retryable: true, error })),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async health(): Promise<HealthResult> {
    const check = await validateUrlForServerFetch(this.opts.url, { allowPrivateHosts: true });
    return check.ok ? { ok: true, detail: this.opts.url } : { ok: false, detail: check.reason ?? "invalid webhook URL" };
  }
}
