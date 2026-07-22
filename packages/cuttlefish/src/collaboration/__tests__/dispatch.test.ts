import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../shared/types.js";
import { dispatchCollaborationMessage } from "../dispatch.js";

const fakeSession = (id: string, employee: string): Session => ({
  id,
  engine: "codex",
  engineSessionId: null,
  source: "web",
  sourceRef: id,
  connector: "web",
  sessionKey: id,
  replyContext: null,
  messageId: null,
  transportMeta: null,
  employee,
  model: "gpt-5.6-sol",
  title: id,
  promptExcerpt: id,
  parentSessionId: null,
  userId: null,
  effortLevel: null,
  cwd: null,
  status: "idle",
  totalCost: 0,
  totalTurns: 0,
  lastContextTokens: null,
  createdAt: "2026-01-01T00:00:00Z",
  lastActivity: "2026-01-01T00:00:00Z",
  lastError: null,
});

function context() {
  return {
    getConfig: () => ({ gateway: {}, engines: { default: "codex", codex: { model: "gpt-5.6-sol" } }, portal: {} }),
    sessionManager: { getEngine: () => ({ name: "codex" }) },
  } as never;
}

describe("dispatchCollaborationMessage", () => {
  it("reports genuine partial delivery without rolling back queued turns", async () => {
    const dispatchTurn = vi.fn(async ({ sessionId }: { sessionId: string }) => sessionId === "ok"
      ? { statusCode: 200, body: { status: "queued" }, insertedMessageId: "m-ok" }
      : { statusCode: 500, body: { error: "failed" } });
    const result = await dispatchCollaborationMessage({
      lane: "team",
      message: "ship it",
      targets: [{ recipientId: "a", session: fakeSession("ok", "a") }, { recipientId: "b", session: fakeSession("bad", "b") }],
      projectRootSessionId: "root",
      context: context(),
      dispatchTurn: dispatchTurn as never,
      recordEvent: vi.fn(),
    });
    expect(result).toMatchObject({ ok: true, statusCode: 207, response: { status: "partial" } });
    if (result.ok) expect(result.response.receipts.map((receipt) => receipt.state)).toEqual(["queued", "failed"]);
    expect(dispatchTurn).toHaveBeenCalledTimes(2);
  });

  it("keeps dispatch successful and surfaces a warning when projection recording fails", async () => {
    const result = await dispatchCollaborationMessage({
      lane: "team",
      message: "ship it",
      targets: [{ recipientId: "a", session: fakeSession("ok", "a") }],
      projectRootSessionId: "root",
      context: context(),
      dispatchTurn: vi.fn(async () => ({ statusCode: 200, body: { status: "queued" }, insertedMessageId: "m-ok" })) as never,
      recordEvent: () => { throw new Error("disk full"); },
    });
    expect(result).toMatchObject({
      ok: true,
      statusCode: 202,
      response: { status: "queued", projectionWarning: expect.stringContaining("projection") },
    });
  });
});

