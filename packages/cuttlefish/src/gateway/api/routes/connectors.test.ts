import { describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { handleConnectorRoutes } from "./connectors.js";
import type { ApiContext } from "../context.js";
import type { Connector, ConnectorCapabilities, ConnectorHealth } from "../../../shared/types.js";

// ARC-CF-003: the /api/connectors/:id/proxy route used to call
// editMessage/addReaction/removeReaction unconditionally and always report
// {status:"ok"} — even on connectors (like Twilio SMS) that implement those
// methods as silent no-ops because the transport has no such concept. These
// tests assert the route now consults connector.getCapabilities() and
// returns an honest "unsupported" outcome instead of a fake "ok".

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },
  };
}

function makeReq(body: unknown) {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]);
  return Object.assign(stream, {
    method: "POST",
    url: "/api/connectors/twilio/proxy",
    headers: { host: "localhost", "content-type": "application/json" },
  }) as any;
}

function makeConnector(capabilities: ConnectorCapabilities): Connector {
  return {
    name: "fake",
    async start() {},
    async stop() {},
    getCapabilities: () => capabilities,
    getHealth: (): ConnectorHealth => ({ status: "running", capabilities }),
    reconstructTarget: (ctx) => ({ channel: "", replyContext: ctx }),
    sendMessage: vi.fn(async () => "msg-1"),
    replyMessage: vi.fn(async () => "msg-1"),
    addReaction: vi.fn(async () => {}),
    removeReaction: vi.fn(async () => {}),
    editMessage: vi.fn(async () => {}),
    onMessage: () => {},
  };
}

function makeContext(connector: Connector): ApiContext {
  const connectors = new Map<string, Connector>([["twilio", connector]]);
  return { connectors } as unknown as ApiContext;
}

const target = { channel: "+15551234567" };

describe("POST /api/connectors/:id/proxy capability gating (ARC-CF-003)", () => {
  it("returns an honest 'unsupported' outcome for editMessage on a connector without messageEdits, instead of calling through", async () => {
    const connector = makeConnector({ threading: false, messageEdits: false, reactions: false, attachments: false });
    const context = makeContext(connector);
    const cap = makeRes();

    const handled = await handleConnectorRoutes(
      "POST",
      "/api/connectors/twilio/proxy",
      makeReq({ action: "editMessage", target, text: "edited" }),
      cap.res,
      context,
    );

    expect(handled).toBe(true);
    expect(connector.editMessage).not.toHaveBeenCalled();
    expect(cap.body).toMatchObject({ status: "unsupported" });
    expect(cap.body.status).not.toBe("ok");
  });

  it("returns an honest 'unsupported' outcome for addReaction/removeReaction on a connector without reactions", async () => {
    const connector = makeConnector({ threading: false, messageEdits: false, reactions: false, attachments: false });
    const context = makeContext(connector);

    const add = makeRes();
    await handleConnectorRoutes(
      "POST",
      "/api/connectors/twilio/proxy",
      makeReq({ action: "addReaction", target, emoji: "thumbsup" }),
      add.res,
      context,
    );
    expect(connector.addReaction).not.toHaveBeenCalled();
    expect(add.body).toMatchObject({ status: "unsupported" });

    const remove = makeRes();
    await handleConnectorRoutes(
      "POST",
      "/api/connectors/twilio/proxy",
      makeReq({ action: "removeReaction", target, emoji: "thumbsup" }),
      remove.res,
      context,
    );
    expect(connector.removeReaction).not.toHaveBeenCalled();
    expect(remove.body).toMatchObject({ status: "unsupported" });
  });

  it("still calls through and reports 'ok' for a connector that actually supports edits/reactions", async () => {
    const connector = makeConnector({ threading: true, messageEdits: true, reactions: true, attachments: true });
    const context = makeContext(connector);

    const edit = makeRes();
    await handleConnectorRoutes(
      "POST",
      "/api/connectors/twilio/proxy",
      makeReq({ action: "editMessage", target, text: "edited" }),
      edit.res,
      context,
    );
    expect(connector.editMessage).toHaveBeenCalledWith(target, "edited");
    expect(edit.body).toMatchObject({ status: "ok" });

    const react = makeRes();
    await handleConnectorRoutes(
      "POST",
      "/api/connectors/twilio/proxy",
      makeReq({ action: "addReaction", target, emoji: "thumbsup" }),
      react.res,
      context,
    );
    expect(connector.addReaction).toHaveBeenCalledWith(target, "thumbsup");
    expect(react.body).toMatchObject({ status: "ok" });
  });

  it("still validates required fields before consulting capabilities", async () => {
    const connector = makeConnector({ threading: false, messageEdits: false, reactions: false, attachments: false });
    const context = makeContext(connector);
    const cap = makeRes();

    await handleConnectorRoutes(
      "POST",
      "/api/connectors/twilio/proxy",
      makeReq({ action: "editMessage", target }), // missing text
      cap.res,
      context,
    );

    expect(cap.status).toBe(400);
    expect(cap.body).toMatchObject({ error: expect.any(String) });
  });
});
