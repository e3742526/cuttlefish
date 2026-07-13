import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Session } from "../../shared/types.js";

vi.mock("../../sessions/registry.js", () => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  getSessionBySessionKey: vi.fn(),
  listChildSessions: vi.fn(),
  searchMessages: vi.fn(),
  searchSessions: vi.fn(),
  updateSession: vi.fn(),
}));

import { handleTalkApi } from "../routes.js";
import { getSession, listChildSessions } from "../../sessions/registry.js";

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "talk-1",
    engine: "claude",
    engineSessionId: null,
    source: "talk",
    sourceRef: "talk:main",
    connector: "web",
    sessionKey: "talk:main",
    replyContext: null,
    messageId: null,
    transportMeta: null,
    employee: null,
    model: null,
    title: "Talk",
    parentSessionId: null,
    userId: null,
    status: "idle",
    effortLevel: null,
    totalCost: 0,
    totalTurns: 0,
    lastContextTokens: null,
    createdAt: "2026-06-23T00:00:00.000Z",
    lastActivity: "2026-06-23T00:00:00.000Z",
    lastError: null,
    ...overrides,
  } as Session;
}

function makeReq(body: unknown, url = "/api/talk/delegate"): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  req.method = "POST";
  req.url = url;
  req.headers = { host: "localhost" };
  return req;
}

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(chunk?: Buffer | string) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get body() {
      return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    },
  };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.mocked(getSession).mockImplementation((id: string) =>
    id === "talk-1" ? session() : undefined,
  );
  vi.mocked(listChildSessions).mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

describe("handleTalkApi delegate auth", () => {
  it("adds the gateway API token to internal /api/sessions requests", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn(async () => ({ id: "child-1" })),
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const cap = makeRes();
    const context = {
      apiToken: "route-api-token",
      emit: vi.fn(),
      getConfig: () => ({
        gateway: { port: 8888 },
        engines: { default: "claude", claude: { bin: "claude", model: "opus" } },
      }),
    } as any;

    const handled = await handleTalkApi(
      makeReq({ sessionId: "talk-1", thread: "new", brief: "start child" }),
      cap.res,
      context,
    );

    expect(handled).toBe(true);
    expect(cap.status).toBe(200);
    expect(cap.body).toMatchObject({ ok: true, threadId: "child-1", created: true });
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:8888/api/sessions",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Cuttlefish-Token": "route-api-token",
        }),
      }),
    );
  });

  it("rejects a scoped session token that names another Talk session in the delegate body", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const cap = makeRes();
    const request = makeReq({ sessionId: "talk-1", thread: "new", brief: "start child" });
    (request as IncomingMessage & { cuttlefishPrincipal?: unknown }).cuttlefishPrincipal = {
      kind: "session",
      sessionId: "session-elsewhere",
    };
    const context = {
      apiToken: "route-api-token",
      emit: vi.fn(),
      getConfig: () => ({ gateway: { port: 8888 }, engines: { default: "claude", claude: { bin: "claude" } } }),
    } as any;

    await handleTalkApi(request, cap.res, context);

    expect(cap.status).toBe(403);
    expect(cap.body).toEqual({ error: "Forbidden: session-scoped token cannot target another session" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an unsafe URL scheme before broadcasting a Talk card patch", async () => {
    const cap = makeRes();
    const emit = vi.fn();
    const context = { emit, getConfig: () => ({ gateway: { port: 8888 }, engines: { default: "claude" } }) } as any;

    await handleTalkApi(
      makeReq(
        { sessionId: "talk-1", cardId: "link-1", patch: { url: "javascript:alert(1)" } },
        "/api/talk/card/update",
      ),
      cap.res,
      context,
    );

    expect(cap.status).toBe(400);
    expect(cap.body.error).toMatch(/patch\.url/);
    expect(emit).not.toHaveBeenCalled();
  });
});
