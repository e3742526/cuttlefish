import { describe, it, expect, vi, beforeEach } from "vitest";
import { deliverConnectorReply } from "../api.js";
import type { Connector, Session } from "../../shared/types.js";

/** Build a minimal mocked connector exposing the two methods the helper uses. */
function makeConnector(name: string) {
  const target = { channel: "C123", thread: "T1" };
  const reconstructTarget = vi.fn(() => target);
  // A confirmed send returns a message id (Slack ts / WhatsApp id). `undefined`
  // now means "not delivered" (audit H3), so success must return a truthy id.
  const replyMessage = vi.fn(async () => "1700000000.0002" as string | undefined);
  const connector = { name, reconstructTarget, replyMessage } as unknown as Connector;
  return { connector, reconstructTarget, replyMessage, target };
}

/** Build the minimal slice of a Session the helper reads. */
function makeSession(
  overrides: Partial<Pick<Session, "source" | "connector" | "replyContext">> = {},
): Pick<Session, "source" | "connector" | "replyContext"> {
  return {
    source: "slack",
    connector: "slack",
    replyContext: { channel: "C123", ts: "1700000000.0001" },
    ...overrides,
  };
}

describe("deliverConnectorReply", () => {
  let map: Map<string, Connector>;
  let slack: ReturnType<typeof makeConnector>;

  beforeEach(() => {
    slack = makeConnector("slack");
    map = new Map<string, Connector>([["slack", slack.connector]]);
  });

  it("delivers a slack reply: reconstructTarget then replyMessage once", async () => {
    const session = makeSession();
    await deliverConnectorReply(session, "hello world", map);

    expect(slack.reconstructTarget).toHaveBeenCalledTimes(1);
    expect(slack.reconstructTarget).toHaveBeenCalledWith(session.replyContext);
    expect(slack.replyMessage).toHaveBeenCalledTimes(1);
    expect(slack.replyMessage).toHaveBeenCalledWith(slack.target, "hello world");
  });

  it("does not deliver for source 'web'", async () => {
    await deliverConnectorReply(makeSession({ source: "web" }), "hi", map);
    expect(slack.replyMessage).not.toHaveBeenCalled();
  });

  it("does not deliver for source 'cron'", async () => {
    await deliverConnectorReply(makeSession({ source: "cron" }), "hi", map);
    expect(slack.replyMessage).not.toHaveBeenCalled();
  });

  it("does not deliver for source 'talk'", async () => {
    await deliverConnectorReply(makeSession({ source: "talk" }), "hi", map);
    expect(slack.replyMessage).not.toHaveBeenCalled();
  });

  it("does not throw and does not call when connector missing from map", async () => {
    const session = makeSession({ connector: "whatsapp", source: "whatsapp" });
    await expect(deliverConnectorReply(session, "hi", map)).resolves.toBeUndefined();
    expect(slack.replyMessage).not.toHaveBeenCalled();
  });

  it("does not deliver when text is empty", async () => {
    await deliverConnectorReply(makeSession(), "", map);
    expect(slack.replyMessage).not.toHaveBeenCalled();
  });

  it("does not deliver when replyContext is missing", async () => {
    await deliverConnectorReply(makeSession({ replyContext: null }), "hi", map);
    expect(slack.replyMessage).not.toHaveBeenCalled();
  });

  it("emits failed delivery attempts and retries connector errors", async () => {
    slack.replyMessage.mockRejectedValueOnce(new Error("boom"));
    const emit = vi.fn();
    await expect(
      deliverConnectorReply(makeSession({ id: "s1" } as Partial<Session>), "hi", map, {
        emit,
        retryDelayMs: 0,
      }),
    ).resolves.toBeUndefined();

    expect(slack.replyMessage).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith("connector:reply_failed", expect.objectContaining({
      sessionId: "s1",
      connector: "slack",
      attempt: 1,
      maxAttempts: 2,
      error: "boom",
    }));
  });

  it("treats an undefined replyMessage return as a delivery failure: retries then emits reply_dropped (audit H3)", async () => {
    slack.replyMessage.mockResolvedValue(undefined);
    const events: Array<{ event: string; payload: unknown }> = [];
    await deliverConnectorReply(makeSession(), "hello", map, {
      emit: (event: string, payload: unknown) => events.push({ event, payload }),
    } as any);
    expect(slack.replyMessage).toHaveBeenCalledTimes(2); // DEFAULT_MAX_ATTEMPTS
    expect(events.some((e) => e.event === "connector:reply_dropped")).toBe(true);
  });

});
