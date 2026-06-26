import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { withTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

const testHome = withTempCuttlefishHome("cuttlefish-knowledge-routes-");

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
    get status() { return status; },
    get body() {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try { return JSON.parse(raw); } catch { return raw; }
    },
  };
}

function makeReq(method: string, urlPath: string) {
  const req = Readable.from([]) as any;
  Object.assign(req, {
    method,
    url: urlPath,
    headers: { host: "localhost" },
  });
  return req;
}

function makeJsonReq(method: string, urlPath: string, body: unknown) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as any;
  Object.assign(req, {
    method,
    url: urlPath,
    headers: { host: "localhost", "content-type": "application/json" },
  });
  return req;
}

async function setup() {
  vi.resetModules();
  const knowledgeRoutes = await import("../api/routes/knowledge.js");
  const reg = await import("../../sessions/registry.js");
  reg.initDb();
  return { knowledgeRoutes, reg };
}

function makeCtx() {
  return {
    getConfig: () => ({ gateway: {}, engines: {}, portal: {} }),
    connectors: new Map(),
    startTime: Date.now(),
    emit: vi.fn(),
    knowledgeReadProvider: {
      name: "test",
      search: vi.fn(async () => ({ results: [{ id: "r1", excerpt: "hit" }] })),
      context: vi.fn(async () => ({ items: [{ id: "c1", content: "ctx" }] })),
      health: vi.fn(async () => ({ ok: true })),
    },
    relayKnowledgeOutbox: vi.fn(async () => ({ attempted: 1, delivered: 1, failed: 0 })),
    sessionManager: {
      getEngine: () => undefined,
      getQueue: () => ({
        getPendingCount: () => 0,
        getTransportState: (_key: string, status: string) => status,
      }),
    },
  } as any;
}

beforeEach(() => {
  testHome.home();
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("knowledge routes", () => {
  it("lists and flushes outbox rows", async () => {
    const { knowledgeRoutes, reg } = await setup();
    const ctx = makeCtx();
    reg.enqueueExternalOutboxItem({
      sinkName: "noop",
      envelope: {
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
      },
    });

    const listCap = makeRes();
    await knowledgeRoutes.handleKnowledgeRoutes(
      "GET",
      "/api/knowledge/outbox",
      makeReq("GET", "/api/knowledge/outbox"),
      new URL("http://localhost/api/knowledge/outbox"),
      listCap.res,
      ctx,
    );
    expect(listCap.status).toBe(200);
    expect(listCap.body).toEqual([
      expect.objectContaining({ topic: "cuttlefish.session.summary.v1" }),
    ]);

    const flushCap = makeRes();
    await knowledgeRoutes.handleKnowledgeRoutes(
      "POST",
      "/api/knowledge/outbox/flush",
      makeReq("POST", "/api/knowledge/outbox/flush"),
      new URL("http://localhost/api/knowledge/outbox/flush"),
      flushCap.res,
      ctx,
    );
    expect(flushCap.status).toBe(200);
    expect(flushCap.body).toEqual({ attempted: 1, delivered: 1, failed: 0 });
  });

  it("proxies generic search and context requests to the read provider", async () => {
    const { knowledgeRoutes } = await setup();
    const ctx = makeCtx();

    const searchCap = makeRes();
    await knowledgeRoutes.handleKnowledgeRoutes(
      "POST",
      "/api/knowledge/search",
      makeJsonReq("POST", "/api/knowledge/search", { query: "alpha" }),
      new URL("http://localhost/api/knowledge/search"),
      searchCap.res,
      ctx,
    );
    expect(searchCap.status).toBe(200);
    expect(searchCap.body).toEqual({ results: [{ id: "r1", excerpt: "hit" }] });

    const contextCap = makeRes();
    await knowledgeRoutes.handleKnowledgeRoutes(
      "POST",
      "/api/knowledge/context",
      makeJsonReq("POST", "/api/knowledge/context", { sessionId: "s-1" }),
      new URL("http://localhost/api/knowledge/context"),
      contextCap.res,
      ctx,
    );
    expect(contextCap.status).toBe(200);
    expect(contextCap.body).toEqual({ items: [{ id: "c1", content: "ctx" }] });
  });
});
