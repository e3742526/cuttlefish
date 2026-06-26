import { describe, expect, it } from "vitest";
import { buildCheckpointDecisionEnvelope, buildSessionSummaryEnvelope } from "../envelopes.js";

describe("knowledge envelopes", () => {
  it("builds deterministic checkpoint decision idempotency keys", () => {
    const envelope = buildCheckpointDecisionEnvelope({
      id: "cp-1",
      sessionId: "s-1",
      type: "checkpoint",
      payload: { decisionNeeded: "Delete file", why: "cleanup" },
      state: "approved",
      createdAt: "2026-06-26T00:00:00.000Z",
      resolvedAt: "2026-06-26T00:01:00.000Z",
      actor: "web-user",
      decisionNotes: "looks good",
      resultingAction: "resume_session",
    }, {
      id: "s-1",
      engine: "claude",
      engineSessionId: null,
      source: "web",
      sourceRef: "web:1",
      connector: "web",
      sessionKey: "web:1",
      replyContext: null,
      messageId: null,
      transportMeta: null,
      employee: null,
      model: null,
      title: null,
      promptExcerpt: null,
      parentSessionId: null,
      userId: null,
      status: "idle",
      effortLevel: null,
      cwd: "/tmp/project",
      totalCost: 0,
      totalTurns: 0,
      lastContextTokens: null,
      createdAt: "2026-06-26T00:00:00.000Z",
      lastActivity: "2026-06-26T00:01:00.000Z",
      lastError: null,
    });

    expect(envelope.idempotencyKey).toBe("checkpoint-decision:cp-1:approved:2026-06-26T00:01:00.000Z");
    expect(envelope.payload).toMatchObject({
      checkpointId: "cp-1",
      decision: "approved",
      resultingAction: "resume_session",
    });
  });

  it("builds session summary envelopes from the latest assistant message", () => {
    const envelope = buildSessionSummaryEnvelope({
      id: "s-2",
      engine: "codex",
      engineSessionId: null,
      source: "web",
      sourceRef: "web:2",
      connector: "web",
      sessionKey: "web:2",
      replyContext: null,
      messageId: null,
      transportMeta: null,
      employee: "worker",
      model: "gpt-5",
      title: "Hello",
      promptExcerpt: "find bug",
      parentSessionId: null,
      userId: "web-user",
      status: "idle",
      effortLevel: null,
      cwd: "/tmp/repo",
      totalCost: 0.2,
      totalTurns: 3,
      lastContextTokens: 123,
      createdAt: "2026-06-26T00:00:00.000Z",
      lastActivity: "2026-06-26T00:03:00.000Z",
      lastError: null,
    }, [
      { id: "m1", role: "user", content: "hi", timestamp: 1 },
      { id: "m2", role: "assistant", content: "fixed the issue and updated the parser", timestamp: 2 },
    ]);

    expect(envelope.topic).toBe("cuttlefish.session.summary.v1");
    expect(envelope.payload).toMatchObject({
      sessionId: "s-2",
      finalAssistantExcerpt: "fixed the issue and updated the parser",
      promptExcerpt: "find bug",
    });
  });
});
