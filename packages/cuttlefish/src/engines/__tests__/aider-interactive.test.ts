import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The PTY is mocked (same pattern as codex-interactive.test.ts): `spawnPty()`
 * records calls into `spawnCalls` and returns a controllable fake IPty, unless
 * `spawnShouldThrow` is set, in which case it throws synchronously the way a
 * real spawn failure (binary missing, EACCES, resource exhaustion, ...) would.
 */
interface FakePty {
  pid: number;
  _exitCode: number | null;
  onData: (cb: (d: string) => void) => { dispose: () => void };
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  on: (event: string, cb: (...a: any[]) => void) => void;
  kill: (sig?: string) => void;
  resize: (cols: number, rows: number) => void;
  write: (data: string) => void;
  _exit: (code?: number) => void;
}

interface SpawnCall { bin: string; args: string[]; proc: FakePty }

const spawnCalls: SpawnCall[] = [];
let spawnShouldThrow = false;

function makeFakePty(): FakePty {
  let exitCb: ((e: { exitCode: number }) => void) | undefined;
  const p: FakePty = {
    pid: 6161,
    _exitCode: null,
    onData: () => ({ dispose: () => {} }),
    onExit: (cb) => { exitCb = cb; },
    on: () => {},
    kill: () => {},
    resize: () => {},
    write: () => {},
    _exit: (code = 0) => { p._exitCode = code; exitCb?.({ exitCode: code }); },
  };
  return p;
}

vi.mock("../pty-stream.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pty-stream.js")>();
  return {
    ...actual,
    spawnPty: vi.fn((bin: string, args: string[]) => {
      if (spawnShouldThrow) {
        throw new Error("Interactive PTY support is unavailable: spawn aider ENOENT");
      }
      const proc = makeFakePty();
      spawnCalls.push({ bin, args, proc });
      return proc as unknown as import("node-pty").IPty;
    }),
  };
});

import { AiderInteractiveEngine } from "../aider-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";

beforeEach(() => {
  spawnCalls.length = 0;
  spawnShouldThrow = false;
});

describe("AiderInteractiveEngine — spawn failure recovery (FSR-CF-006)", () => {
  let lifecycle: PtyLifecycleManager;
  let engine: AiderInteractiveEngine;

  beforeEach(() => {
    lifecycle = new PtyLifecycleManager({ maxLivePtys: 8 });
    engine = new AiderInteractiveEngine(lifecycle);
  });

  it("fails just that turn (does not throw/reject) when the aider spawn throws", async () => {
    spawnShouldThrow = true;
    const result = await engine.run({ prompt: "hi", sessionId: "sess-spawn-fail", cwd: "/tmp" });
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/failed to spawn aider process/i);
    lifecycle.dispose();
  });

  it("clears in-flight-turn state so a subsequent run() can retry after a spawn failure", async () => {
    spawnShouldThrow = true;
    const first = await engine.run({ prompt: "hi", sessionId: "sess-retry", cwd: "/tmp" });
    expect(first.error).toMatch(/failed to spawn aider process/i);

    // The session must not be left looking "alive" or permanently marked as
    // having a turn running — that would brick every future retry.
    expect(engine.isTurnRunning("sess-retry")).toBe(false);
    expect(engine.isAlive("sess-retry")).toBe(false);
    expect(engine.hasWarmPty("sess-retry")).toBe(false);

    // A retry must actually attempt to spawn again, not bounce off the
    // "a turn is already running for this session" guard.
    spawnShouldThrow = false;
    const runPromise = engine.run({ prompt: "hi again", sessionId: "sess-retry", cwd: "/tmp" });
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0]!.bin).toMatch(/aider/);

    spawnCalls[0]!.proc._exit(0);
    const second = await runPromise;
    expect(second.error).not.toMatch(/a turn is already running/i);

    lifecycle.dispose();
  });
});
