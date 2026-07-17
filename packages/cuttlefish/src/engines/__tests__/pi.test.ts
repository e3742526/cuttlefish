import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import type { EngineResult } from "../../shared/types.js";
import { __resetPiThrottleForTests } from "../../shared/pi-throttle.js";

interface FakeProc {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: { end: () => void };
  exitCode: number | null;
  killed: boolean;
  kill: (sig?: string) => boolean;
  pid: number;
  on: (event: string, cb: (...a: any[]) => void) => FakeProc;
  _handlers: Record<string, (...a: any[]) => void>;
  emitStdout: (s: string) => void;
  emitStderr: (s: string) => void;
  close: (code: number | null) => void;
}

interface SpawnCall {
  bin: string;
  args: string[];
  opts: unknown;
  proc: FakeProc;
}

const spawnCalls: SpawnCall[] = [];

function makeFakeProc(): FakeProc {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const handlers: Record<string, (...a: any[]) => void> = {};
  const p: FakeProc = {
    stdout,
    stderr,
    stdin: { end: () => {} },
    exitCode: null,
    killed: false,
    pid: 8888,
    kill: () => {
      p.killed = true;
      return true;
    },
    _handlers: handlers,
    on(event, cb) {
      handlers[event] = cb;
      return p;
    },
    emitStdout(s) {
      stdout.write(Buffer.from(s));
    },
    emitStderr(s) {
      stderr.write(Buffer.from(s));
    },
    close(code) {
      p.exitCode = code;
      handlers.close?.(code);
    },
  };
  return p;
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn((bin: string, args: string[], opts: unknown) => {
    const proc = makeFakeProc();
    spawnCalls.push({ bin, args, opts, proc });
    return proc;
  }),
}));

import { PiEngine } from "../pi.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

const agentEnd = (text: string) => JSON.stringify({
  type: "agent_end",
  messages: [{
    role: "assistant",
    content: [{ type: "text", text }],
  }],
});

const agentEndWithError = (text: string, errorMessage: string) => JSON.stringify({
  type: "agent_end",
  messages: [{
    role: "assistant",
    stopReason: "error",
    errorMessage,
    content: [{ type: "text", text }],
  }],
});

async function startRun(): Promise<{ engine: PiEngine; promise: Promise<EngineResult>; call: SpawnCall }> {
  const engine = new PiEngine();
  const promise = engine.run({
    prompt: "hello",
    cwd: "/tmp",
    sessionId: "cuttlefish-pi-1",
    model: "ollama/gemma4:12b",
  });
  await flush();
  const call = spawnCalls[spawnCalls.length - 1]!;
  expect(call).toBeDefined();
  return { engine, promise, call };
}

beforeEach(() => {
  spawnCalls.length = 0;
  __resetPiThrottleForTests();
});

describe("PiEngine lifecycle", () => {
  it("records agent_end output but resolves only after the process closes", async () => {
    const { promise, call } = await startRun();
    let settled = false;
    void promise.then(() => { settled = true; });

    call.proc.emitStdout(agentEnd("final answer") + "\n");
    await flush();
    expect(settled).toBe(false);

    call.proc.close(0);
    const result = await promise;
    expect(result).toMatchObject({ sessionId: "cuttlefish-pi-1", result: "final answer" });
    expect(result.error).toBeUndefined();
  });

  it("treats exit 0 with no final assistant response as an error", async () => {
    const { promise, call } = await startRun();
    call.proc.close(0);

    const result = await promise;
    expect(result.result).toBe("");
    expect(result.error).toMatch(/without a final assistant response/);
  });

  it("still surfaces a turnError when partial text is also present (FSR-CF-005)", async () => {
    const { promise, call } = await startRun();
    call.proc.emitStdout(agentEndWithError("partial answer", "boom: tool crashed mid-turn") + "\n");
    await flush();

    call.proc.close(0);
    const result = await promise;
    expect(result.result).toBe("partial answer");
    expect(result.error).toBe("boom: tool crashed mid-turn");
  });

  it("does not return partial text as the result when interrupted", async () => {
    const { engine, promise, call } = await startRun();
    call.proc.emitStdout(agentEnd("partial") + "\n");
    await flush();

    engine.kill("cuttlefish-pi-1", "Interrupted: user stopped");
    call.proc.close(null);
    const result = await promise;
    expect(result.result).toBe("");
    expect(result.error).toBe("Interrupted: user stopped");
  });
});
