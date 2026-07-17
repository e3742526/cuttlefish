import { describe, expect, it, vi } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import type {
  Connector,
  Engine,
  IncomingMessage,
  Target,
} from "../../shared/types.js";

withStaticTempCuttlefishHome("cuttlefish-manager-meta-race-");

const reg = await import("../registry.js");
const { SessionManager } = await import("../manager.js");

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("SessionManager transport metadata concurrency", () => {
  it("preserves an interleaved writer while untrusted screening is awaited", async () => {
    reg.initDb();
    const session = reg.createSession({
      engine: "fixture",
      source: "slack",
      sourceRef: "race-source",
      sessionKey: "race-session",
      transportMeta: { existing: "kept" },
    });

    const engine: Engine = {
      name: "fixture",
      run: vi.fn().mockResolvedValue({
        sessionId: "engine-session",
        result: "done",
      }),
    };
    const connector = {
      name: "fixture",
      getCapabilities: () => ({
        threading: false,
        messageEdits: false,
        reactions: false,
        attachments: false,
      }),
      replyMessage: vi.fn().mockResolvedValue(undefined),
    } as unknown as Connector;
    const manager = new SessionManager({
      gateway: { port: 8888, host: "127.0.0.1" },
      engines: { default: "fixture" },
      connectors: {},
      mcp: {},
      contextManager: { mode: "off" },
    } as any, new Map([[engine.name, engine]]));

    const gateEntered = deferred();
    const releaseGate = deferred();
    manager.setUntrustedContentGate(async () => {
      gateEntered.resolve();
      await releaseGate.promise;
      return {
        action: "allow",
        prompt: "screened prompt",
        screening: {
          source: "connector_message",
          verdict: "benign",
          action: "allow",
          screener: "fixture",
          summary: "allowed",
          suspiciousSpans: [],
          sanitizedText: null,
          occurredAt: "2026-07-16T00:00:00.000Z",
        },
      };
    });

    const message: IncomingMessage = {
      connector: "fixture",
      source: "slack",
      sessionKey: session.sessionKey,
      replyContext: {},
      channel: "channel",
      user: "user",
      userId: "user-id",
      text: "external text",
      attachments: [],
      raw: null,
      transportMeta: { incoming: "kept" },
    };
    const target: Target = { channel: "channel" };

    const run = (manager as unknown as {
      runSession: (
        current: typeof session,
        incoming: IncomingMessage,
        attachments: string[],
        replyConnector: Connector,
        replyTarget: Target,
      ) => Promise<void>;
    }).runSession(session, message, [], connector, target);

    await gateEntered.promise;
    reg.patchSessionTransportMeta(session.id, { concurrent: "kept" });
    releaseGate.resolve();
    await run;

    expect(reg.getSession(session.id)?.transportMeta).toMatchObject({
      existing: "kept",
      incoming: "kept",
      concurrent: "kept",
      latestUntrustedContentScreening: {
        verdict: "benign",
        action: "allow",
      },
    });
  });

  it("clears a dead engine session without deleting an interleaved metadata write", async () => {
    const session = reg.createSession({
      engine: "fixture",
      source: "web",
      sourceRef: "dead-race-source",
      sessionKey: "dead-race-session",
      transportMeta: {
        engineSessions: { fixture: "stale-engine-session" },
        engineOverride: "fixture",
        existing: "kept",
      },
    });
    reg.updateSession(session.id, { engineSessionId: "stale-engine-session" });

    const engineEntered = deferred();
    const releaseEngine = deferred();
    const engine: Engine = {
      name: "fixture",
      run: vi.fn().mockImplementation(async () => {
        engineEntered.resolve();
        await releaseEngine.promise;
        return {
          sessionId: "stale-engine-session",
          result: "",
          error: "session not found",
          cost: 0,
          numTurns: 0,
        };
      }),
    };
    const connector = {
      name: "fixture",
      getCapabilities: () => ({
        threading: false,
        messageEdits: false,
        reactions: false,
        attachments: false,
      }),
      replyMessage: vi.fn().mockResolvedValue(undefined),
    } as unknown as Connector;
    const manager = new SessionManager({
      gateway: { port: 8888, host: "127.0.0.1" },
      engines: { default: "fixture" },
      connectors: {},
      mcp: {},
      contextManager: { mode: "off" },
    } as any, new Map([[engine.name, engine]]));
    const message: IncomingMessage = {
      connector: "fixture",
      source: "web",
      sessionKey: session.sessionKey,
      replyContext: {},
      channel: "channel",
      user: "user",
      userId: "user-id",
      text: "resume",
      attachments: [],
      raw: null,
    };

    const run = (manager as unknown as {
      runSession: (
        current: typeof session,
        incoming: IncomingMessage,
        attachments: string[],
        replyConnector: Connector,
        replyTarget: Target,
      ) => Promise<void>;
    }).runSession(session, message, [], connector, { channel: "channel" });

    await engineEntered.promise;
    reg.patchSessionTransportMeta(session.id, { concurrent: "kept" });
    releaseEngine.resolve();
    await run;

    const updated = reg.getSession(session.id);
    expect(updated?.engineSessionId).toBeNull();
    expect(updated?.transportMeta).toMatchObject({
      existing: "kept",
      concurrent: "kept",
    });
    expect(updated?.transportMeta).not.toHaveProperty("engineSessions");
    expect(updated?.transportMeta).not.toHaveProperty("engineOverride");
  });
});
