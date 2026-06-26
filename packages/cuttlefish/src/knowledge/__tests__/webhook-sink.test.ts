import { afterEach, describe, expect, it, vi } from "vitest";
import { WebhookKnowledgeSink } from "../sinks/webhook.js";

describe("WebhookKnowledgeSink", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts envelopes with bearer auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [{ remoteId: "r1" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const sink = new WebhookKnowledgeSink({
      url: "http://127.0.0.1:9999/events",
      token: "secret",
      timeoutMs: 1000,
    });

    const result = await sink.emit([{
      envelopeId: "env-1",
      producer: "cuttlefish",
      schemaVersion: "1",
      topic: "cuttlefish.session.summary.v1",
      occurredAt: "2026-06-26T00:00:00.000Z",
      idempotencyKey: "idem-1",
      partitionKey: null,
      workspace: null,
      actor: null,
      sourceRef: "web:test",
      payload: { ok: true },
    }]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/events",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer secret",
          "content-type": "application/json",
        }),
      }),
    );
    expect(result.accepted).toBe(1);
    expect(result.results[0].remoteId).toBe("r1");
  });

  it("marks 5xx failures retryable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "unavailable",
    }));
    const sink = new WebhookKnowledgeSink({
      url: "http://127.0.0.1:9999/events",
      timeoutMs: 1000,
    });

    const result = await sink.emit([{
      envelopeId: "env-1",
      producer: "cuttlefish",
      schemaVersion: "1",
      topic: "cuttlefish.session.summary.v1",
      occurredAt: "2026-06-26T00:00:00.000Z",
      idempotencyKey: "idem-1",
      partitionKey: null,
      workspace: null,
      actor: null,
      sourceRef: "web:test",
      payload: { ok: true },
    }]);

    expect(result.retryable).toBe(true);
    expect(result.results[0]).toMatchObject({ accepted: false, retryable: true });
  });
});
