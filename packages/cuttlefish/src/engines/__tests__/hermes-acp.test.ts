// packages/cuttlefish/src/engines/__tests__/hermes-acp.test.ts
import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { HermesRpc } from "../hermes-jsonrpc.js";
import { HermesAcpEngine } from "../hermes-acp.js";

// ---------------------------------------------------------------------------
// Fake-server helpers
// ---------------------------------------------------------------------------

/** Standard fake Hermes server: answers initialize/session.new/set_mode/prompt
 *  and streams one answer chunk + usage_update before the prompt result.
 *  Accepts an optional per-message callback for capture. */
function fakeServer(onMessage?: (msg: Record<string, unknown>) => void) {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const rpc = new HermesRpc(toServer, fromServer);
  toServer.on("data", (b: Buffer) => {
    for (const line of b.toString().split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as Record<string, unknown>;
      onMessage?.(msg);
      const reply = (result: unknown) =>
        fromServer.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
      const note = (params: unknown) =>
        fromServer.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params }) + "\n");
      if (msg.method === "initialize") reply({ protocolVersion: 1 });
      else if (msg.method === "session/new")
        reply({ sessionId: "S1", models: { currentModelId: "openai-codex:gpt-5.5", availableModels: [] } });
      else if (msg.method === "session/load") reply({});
      else if (msg.method === "session/set_mode") reply({});
      else if (msg.method === "session/prompt") {
        const sid = ((msg.params as Record<string, unknown>)?.sessionId as string) ?? "S1";
        note({ sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } });
        note({ sessionId: sid, update: { sessionUpdate: "usage_update", size: 1000, used: 42 } });
        reply({ stopReason: "end_turn" });
      }
    }
  });
  return rpc;
}

/** Fake server that rejects session/load but answers session/new normally. */
function fakeServerLoadFail() {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const rpc = new HermesRpc(toServer, fromServer);
  toServer.on("data", (b: Buffer) => {
    for (const line of b.toString().split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as Record<string, unknown>;
      const reply = (result: unknown) =>
        fromServer.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
      const replyErr = (error: unknown) =>
        fromServer.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error }) + "\n");
      const note = (params: unknown) =>
        fromServer.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params }) + "\n");
      if (msg.method === "initialize") reply({ protocolVersion: 1 });
      else if (msg.method === "session/load")
        replyErr({ code: -32000, message: "session not found" });
      else if (msg.method === "session/new")
        reply({ sessionId: "NEW-1", models: { currentModelId: "hermes:default", availableModels: [] } });
      else if (msg.method === "session/set_mode") reply({});
      else if (msg.method === "session/prompt") {
        note({ sessionId: "NEW-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fallback ok" } } });
        reply({ stopReason: "end_turn" });
      }
    }
  });
  return rpc;
}

// ---------------------------------------------------------------------------
// Test engines
// ---------------------------------------------------------------------------

class TestEngine extends HermesAcpEngine {
  protected spawnProc() {
    const rpc = fakeServer();
    return { rpc, killProc: () => {}, isAliveProc: () => true, onExit: (_cb: () => void) => {}, onError: (_cb: (e: Error) => void) => {} };
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HermesAcpEngine.run", () => {
  it("streams text + context and returns the hermes session id", async () => {
    const eng = new TestEngine();
    const deltas: any[] = [];
    const r = await eng.run({ prompt: "hi", cwd: "/tmp", sessionId: "cuttlefish-1", onStream: (d) => deltas.push(d) });
    expect(r.sessionId).toBe("S1");
    expect(r.result).toBe("ok");
    expect(r.contextTokens).toBe(42);
    expect(deltas).toContainEqual({ type: "text", content: "ok" });
    expect(eng.isAlive("cuttlefish-1")).toBe(true);
  });

  // Fix 1 — systemPrompt prepended on fresh session
  it("prepends systemPrompt to prompt on a fresh (non-resume) session", async () => {
    let capturedPromptText = "";

    class SysPromptEngine extends HermesAcpEngine {
      protected spawnProc() {
        const rpc = fakeServer((msg) => {
          if (msg.method === "session/prompt") {
            const params = msg.params as Record<string, unknown>;
            const arr = params?.prompt as Array<{ text: string }> | undefined;
            capturedPromptText = arr?.[0]?.text ?? "";
          }
        });
        return { rpc, killProc: () => {}, isAliveProc: () => true, onExit: (_cb: () => void) => {}, onError: (_cb: (e: Error) => void) => {} };
      }
    }

    const eng = new SysPromptEngine();
    await eng.run({ prompt: "user question", cwd: "/tmp", sessionId: "sys-1", systemPrompt: "PERSONA-XYZ" });
    expect(capturedPromptText).toContain("PERSONA-XYZ");
    expect(capturedPromptText).toContain("user question");
  });

  // Fix 1 — systemPrompt NOT prepended on resume
  it("does NOT prepend systemPrompt when resumeSessionId is set", async () => {
    let capturedPromptText = "";

    class ResumeEngine extends HermesAcpEngine {
      protected spawnProc() {
        const rpc = fakeServer((msg) => {
          if (msg.method === "session/prompt") {
            const params = msg.params as Record<string, unknown>;
            const arr = params?.prompt as Array<{ text: string }> | undefined;
            capturedPromptText = arr?.[0]?.text ?? "";
          }
        });
        return { rpc, killProc: () => {}, isAliveProc: () => true, onExit: (_cb: () => void) => {}, onError: (_cb: (e: Error) => void) => {} };
      }
    }

    const eng = new ResumeEngine();
    await eng.run({
      prompt: "user question",
      cwd: "/tmp",
      sessionId: "cuttlefish-resume",
      resumeSessionId: "S1",
      systemPrompt: "PERSONA-XYZ",
    });
    expect(capturedPromptText).not.toContain("PERSONA-XYZ");
    expect(capturedPromptText).toContain("user question");
  });

  // Fix 2(b) — handshake timeout: run() resolves with error instead of hanging
  it("resolves with error (not hangs) when handshake times out", async () => {
    class HangEngine extends HermesAcpEngine {
      protected handshakeTimeoutMs = 50; // milliseconds — fast for tests

      protected spawnProc() {
        const toServer = new PassThrough();
        const fromServer = new PassThrough();
        // fromServer never emits anything — initialize request never resolves
        const rpc = new HermesRpc(toServer, fromServer);
        return { rpc, killProc: () => {}, isAliveProc: () => true, onExit: (_cb: () => void) => {}, onError: (_cb: (e: Error) => void) => {} };
      }
    }

    const eng = new HangEngine();
    const r = await eng.run({ prompt: "hi", cwd: "/tmp", sessionId: "cuttlefish-hang" });
    expect(r.error).toMatch(/handshake timeout/);
    expect(r.sessionId).toBe("");
    expect(r.result).toBe("");
    // The timed-out proc must be evicted so the next turn respawns clean.
    expect(eng.isAlive("cuttlefish-hang")).toBe(false);
  }, 5_000);

  // Fix 3 — session/load failure falls back to session/new
  it("falls back to session/new when session/load fails, returning the new session id", async () => {
    class LoadFailEngine extends HermesAcpEngine {
      protected spawnProc() {
        const rpc = fakeServerLoadFail();
        return { rpc, killProc: () => {}, isAliveProc: () => true, onExit: (_cb: () => void) => {}, onError: (_cb: (e: Error) => void) => {} };
      }
    }

    const eng = new LoadFailEngine();
    const r = await eng.run({
      prompt: "hi",
      cwd: "/tmp",
      sessionId: "cuttlefish-stale",
      resumeSessionId: "stale-id",
    });
    expect(r.error).toBeUndefined();
    expect(r.sessionId).toBe("NEW-1");
    expect(r.result).toBe("fallback ok");
  });

  // TMP-CUT-007 — concurrent-turn guard: a second run() on the same
  // cuttlefish session id while a turn is in flight must be rejected instead
  // of racing on the shared HermesRpc notify callback.
  it("rejects a second concurrent turn on the same session id", async () => {
    class SlowEngine extends HermesAcpEngine {
      protected spawnProc() {
        const toServer = new PassThrough();
        const fromServer = new PassThrough();
        const rpc = new HermesRpc(toServer, fromServer);
        toServer.on("data", (b: Buffer) => {
          for (const line of b.toString().split("\n")) {
            if (!line.trim()) continue;
            const msg = JSON.parse(line) as Record<string, unknown>;
            const reply = (result: unknown) =>
              fromServer.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
            if (msg.method === "initialize") reply({ protocolVersion: 1 });
            else if (msg.method === "session/new")
              reply({ sessionId: "S1", models: { currentModelId: "hermes:default", availableModels: [] } });
            else if (msg.method === "session/set_mode") reply({});
            // session/prompt intentionally never replies — the first turn stays in flight.
          }
        });
        return { rpc, killProc: () => {}, isAliveProc: () => true, onExit: (_cb: () => void) => {}, onError: (_cb: (e: Error) => void) => {} };
      }
    }

    const eng = new SlowEngine();
    const firstTurn = eng.run({ prompt: "first", cwd: "/tmp", sessionId: "concurrent-1" });
    // Let the first turn get past the handshake and into session/prompt.
    await new Promise((r) => setTimeout(r, 20));

    const second = await eng.run({ prompt: "second", cwd: "/tmp", sessionId: "concurrent-1" });
    expect(second.error).toMatch(/already running/);

    // Cleanup: don't leave the first turn's timers/promise dangling past the test.
    void firstTurn;
  });
});
