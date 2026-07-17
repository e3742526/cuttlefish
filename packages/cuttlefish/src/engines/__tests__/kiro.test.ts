import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { StreamDelta } from "../../shared/types.js";

interface FakeProc {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: () => void };
  exitCode: number | null;
  killed: boolean;
  pid: number;
  on: (event: string, cb: (...args: any[]) => void) => FakeProc;
  emitStdout: (text: string) => void;
  emitStderr: (text: string) => void;
  close: (code: number | null) => void;
  _handlers: Record<string, (...args: any[]) => void>;
}

interface SpawnCall {
  bin: string;
  args: string[];
  opts: unknown;
  proc: FakeProc;
}

const { spawnCalls, execFileMock, recordKiroCreditUsageMock, nextKiroCreditResetAtMock } = vi.hoisted(() => ({
  spawnCalls: [] as SpawnCall[],
  execFileMock: vi.fn(),
  recordKiroCreditUsageMock: vi.fn(),
  nextKiroCreditResetAtMock: vi.fn(() => 1_750_000_000),
}));

function makeFakeProc(): FakeProc {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const handlers: Record<string, (...args: any[]) => void> = {};
  const proc: FakeProc = {
    stdout,
    stderr,
    stdin: { end: () => {} },
    exitCode: null,
    killed: false,
    pid: 4242,
    _handlers: handlers,
    on(event, cb) {
      handlers[event] = cb;
      return proc;
    },
    emitStdout(text) {
      stdout.emit("data", Buffer.from(text));
    },
    emitStderr(text) {
      stderr.emit("data", Buffer.from(text));
    },
    close(code) {
      proc.exitCode = code;
      handlers.close?.(code);
    },
  };
  return proc;
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn((bin: string, args: string[], opts: unknown) => {
    const proc = makeFakeProc();
    spawnCalls.push({ bin, args, opts, proc });
    return proc;
  }),
  execFile: execFileMock,
}));

vi.mock("../../shared/usage-status.js", () => ({
  recordKiroCreditUsage: (...args: unknown[]) => recordKiroCreditUsageMock(...args),
  nextKiroCreditResetAt: () => nextKiroCreditResetAtMock(),
}));

import { KiroEngine, isKiroCreditExhaustion, parseKiroOutput, parseKiroSessionList, stripKiroAnsi } from "../kiro.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Kiro helpers", () => {
  it("strips ANSI and parses the footer into credits", () => {
    expect(stripKiroAnsi("\u001b[32mhi\u001b[0m")).toBe("hi");
    expect(parseKiroOutput("Answer\nCredits: 1.25 - Time: 1s\n")).toEqual({
      text: "Answer",
      credits: 1.25,
    });
    expect(parseKiroOutput("Answer\n▸ Credits: 0.03 • Time: 1s\n")).toEqual({
      text: "Answer",
      credits: 0.03,
    });
  });

  it("extracts the latest session id from nested list-sessions JSON", () => {
    const sessionId = parseKiroSessionList(JSON.stringify([
      {
        cwd: "/tmp/project",
        sessions: [
          { sessionId: "older", updatedAt: "2026-06-21T00:00:00.000Z" },
          { session_id: "newer", updatedAt: "2026-06-22T00:00:00.000Z" },
        ],
      },
    ]));
    expect(sessionId).toBe("newer");
  });

  it("scopes session recovery to the turn's cwd instead of picking the globally most-recent session (TMP-CUT-012)", () => {
    const output = JSON.stringify([
      { cwd: "/tmp/other-project", sessions: [{ sessionId: "other-newest", updatedAt: "2026-07-17T00:00:00.000Z" }] },
      { cwd: "/tmp/project", sessions: [{ sessionId: "mine-older", updatedAt: "2026-07-01T00:00:00.000Z" }] },
    ]);
    // Without a cwd filter, blind recency picks the other workspace's session.
    expect(parseKiroSessionList(output)).toBe("other-newest");
    // Scoped to this turn's cwd, the correct (if older) session wins instead.
    expect(parseKiroSessionList(output, { cwd: "/tmp/project" })).toBe("mine-older");
  });

  it("detects credit exhaustion failures", () => {
    expect(isKiroCreditExhaustion("Insufficient credits for this request")).toBe(true);
    expect(isKiroCreditExhaustion("ordinary tool error")).toBe(false);
  });
});

describe("KiroEngine", () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    execFileMock.mockReset();
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      cb(new Error("no saved sessions"), "", "");
    });
    recordKiroCreditUsageMock.mockReset();
    nextKiroCreditResetAtMock.mockClear();
  });

  function envFrom(call: SpawnCall): Record<string, string> {
    return (call.opts as { env: Record<string, string> }).env;
  }

  it("strips host secrets and engine loop variables while preserving explicit Kiro auth", async () => {
    const prevGithub = process.env.GITHUB_TOKEN;
    const prevClaude = process.env.CLAUDE_CODE_SESSION;
    const prevCodex = process.env.CODEX_HOME;
    const prevKiro = process.env.KIRO_API_KEY;
    try {
      process.env.GITHUB_TOKEN = "host-secret";
      process.env.CLAUDE_CODE_SESSION = "hook";
      process.env.CODEX_HOME = "/tmp/codex-loop";
      process.env.KIRO_API_KEY = "kiro-token";
      const engine = new KiroEngine({
        authProbe: () => Promise.resolve({ ok: true }),
        listSessions: () => Promise.resolve("kiro-env-session"),
      });

      const promise = engine.run({
        prompt: "hello",
        cwd: "/tmp/project",
        sessionId: "track-env",
      } as any);

      await flush();
      const call = spawnCalls[0];
      call.proc.emitStdout("Answer\nCredits: 0.10 - Time: 1s\n");
      call.proc.close(0);
      await promise;

      const env = envFrom(call);
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.CLAUDE_CODE_SESSION).toBeUndefined();
      expect(env.CODEX_HOME).toBeUndefined();
      expect(env.KIRO_API_KEY).toBe("kiro-token");
    } finally {
      if (prevGithub === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prevGithub;
      if (prevClaude === undefined) delete process.env.CLAUDE_CODE_SESSION;
      else process.env.CLAUDE_CODE_SESSION = prevClaude;
      if (prevCodex === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodex;
      if (prevKiro === undefined) delete process.env.KIRO_API_KEY;
      else process.env.KIRO_API_KEY = prevKiro;
    }
  });

  it("spawns the documented headless command and recovers the session id", async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      cb(null, JSON.stringify([{ cwd: "/tmp/project", sessions: [{ sessionId: "kiro-s1", updatedAt: "2026-06-22T12:00:00.000Z" }] }]), "");
    });
    const engine = new KiroEngine({
      configProvider: () => ({
        gateway: { port: 8888, host: "127.0.0.1" },
        engines: { default: "kiro", claude: { bin: "claude", model: "opus" }, codex: { bin: "codex", model: "gpt-5.5" }, kiro: { model: "auto" } },
        connectors: {},
        logging: { file: false, stdout: false, level: "info" },
      } as any),
    });

    const deltas: StreamDelta[] = [];
    const promise = engine.run({
      prompt: "hello",
      cwd: "/tmp/project",
      model: "claude-sonnet-4.5",
      effortLevel: "high",
      sessionId: "track-1",
      onStream: (delta: StreamDelta) => deltas.push(delta),
    } as any);

    await flush();
    const call = spawnCalls[0];
    expect(call.args).toEqual([
      "chat",
      "--no-interactive",
      "--trust-all-tools",
      "--model",
      "claude-sonnet-4.5",
      "--effort",
      "high",
      "hello",
    ]);

    call.proc.emitStdout("Answer line 1\nCredits: 1.25 - Time: 1s\n");
    call.proc.close(0);

    const result = await promise;
    expect(result).toMatchObject({
      sessionId: "kiro-s1",
      result: "Answer line 1",
    });
    expect(result.cost).toBeUndefined();
    expect(recordKiroCreditUsageMock).toHaveBeenCalled();
    expect(deltas).toEqual([]);
  });

  it("returns a rate-limit signal when Kiro reports exhausted credits", async () => {
    const engine = new KiroEngine({
      configProvider: () => ({
        gateway: { port: 8888, host: "127.0.0.1" },
        engines: { default: "kiro", claude: { bin: "claude", model: "opus" }, codex: { bin: "codex", model: "gpt-5.5" }, kiro: { model: "auto", creditBudget: 20 } },
        connectors: {},
        logging: { file: false, stdout: false, level: "info" },
      } as any),
    });

    const promise = engine.run({
      prompt: "hello",
      cwd: "/tmp/project",
      sessionId: "track-2",
      resumeSessionId: "kiro-existing",
    } as any);

    await flush();
    const call = spawnCalls[0];
    call.proc.emitStderr("Insufficient credits for this request");
    call.proc.close(1);

    const result = await promise;
    expect(result.rateLimit).toMatchObject({ status: "rejected", resetsAt: 1_750_000_000 });
    expect(result.error).toContain("Insufficient credits");
  });

  it("passes through resume-id and preserves it when recovery is unavailable", async () => {
    const engine = new KiroEngine();
    const promise = engine.run({
      prompt: "hello",
      cwd: "/tmp/project",
      sessionId: "track-3",
      resumeSessionId: "kiro-existing",
    } as any);

    await flush();
    const call = spawnCalls[0];
    expect(call.args).toContain("--resume-id");
    expect(call.args).toContain("kiro-existing");
    call.proc.emitStdout("> resumed\nCredits: 0.50 - Time: 1s\n");
    call.proc.close(0);

    const result = await promise;
    expect(result.sessionId).toBe("kiro-existing");
    expect(result.result).toBe("resumed");
  });

  it("does not attribute the same recovered session id to two concurrent turns sharing a cwd (TMP-CUT-012)", async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      cb(null, JSON.stringify([{ cwd: "/tmp/project", sessions: [{ sessionId: "kiro-shared", updatedAt: "2026-07-17T00:00:00.000Z" }] }]), "");
    });
    const engine = new KiroEngine();

    const promise1 = engine.run({ prompt: "first", cwd: "/tmp/project", sessionId: "track-a" } as any);
    const promise2 = engine.run({ prompt: "second", cwd: "/tmp/project", sessionId: "track-b" } as any);
    await flush();

    expect(spawnCalls).toHaveLength(2);
    const [call1, call2] = spawnCalls;

    // Settle the first turn fully first (including its session-id recovery) so
    // the claim on "kiro-shared" is recorded before the second turn recovers.
    call1.proc.emitStdout("first answer\nCredits: 0.10 - Time: 1s\n");
    call1.proc.close(0);
    const result1 = await promise1;

    call2.proc.emitStdout("second answer\nCredits: 0.10 - Time: 1s\n");
    call2.proc.close(0);
    const result2 = await promise2;

    expect(result1.sessionId).toBe("kiro-shared");
    // The second concurrent turn must NOT be attributed the same session id
    // that was already claimed by the first turn.
    expect(result2.sessionId).toBe("");
  });

  it("fails before spawning when the auth probe reports missing credentials", async () => {
    execFileMock.mockImplementation((_bin, _args, _opts, cb) => {
      cb(new Error("Missing API key"), "", "Missing API key");
    });
    const engine = new KiroEngine();

    const result = await engine.run({
      prompt: "hello",
      cwd: "/tmp/project",
      sessionId: "track-4",
    } as any);

    expect(spawnCalls).toHaveLength(0);
    expect(result.error).toContain("Kiro authentication is unavailable");
  });
});
