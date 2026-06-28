import { describe, expect, it } from "vitest";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

withTempCuttlefishHome("cuttlefish-email-order-");

describe("listEmailMessages", () => {
  it("normalizes missing receivedAt to createdAt and returns newest-first", async () => {
    const reg = await import("../../sessions/registry.js");
    const store = await import("../store.js");
    reg.initDb();

    store.upsertEmailMessage({
      id: "email-a",
      inboxId: "ops",
      providerMessageId: "p1",
      messageIdHeader: null,
      threadKey: "t1",
      fromAddress: null,
      toAddresses: [],
      ccAddresses: [],
      subject: "older",
      receivedAt: "2026-06-27T12:00:00.000Z",
      textBody: "older",
      htmlBody: null,
      headers: {},
      authResults: null,
      attachments: [],
      status: "cached",
      sessionId: null,
      error: null,
    });

    const withoutReceived = store.upsertEmailMessage({
      id: "email-b",
      inboxId: "ops",
      providerMessageId: "p2",
      messageIdHeader: null,
      threadKey: "t2",
      fromAddress: null,
      toAddresses: [],
      ccAddresses: [],
      subject: "newer",
      receivedAt: null,
      textBody: "newer",
      htmlBody: null,
      headers: {},
      authResults: null,
      attachments: [],
      status: "cached",
      sessionId: null,
      error: null,
    });

    expect(withoutReceived.receivedAt).toBeTruthy();
    expect(store.listEmailMessages("ops", 10).map((msg) => msg.id)).toEqual(["email-b", "email-a"]);
  });
});
