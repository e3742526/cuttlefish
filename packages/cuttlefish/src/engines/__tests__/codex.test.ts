import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * codex.ts spawns the codex CLI via node:child_process `spawn`. The parsing
 * pipeline (processJsonlLine), the final-result assembly, the systemPrompt
 * injection, and usage extraction are all private to CodexEngine, so we exercise
 * them through the smallest available seam: a fake ChildProcess whose stdout we
 * drive line-by-line. No real process is ever spawned.
 */

// A controllable fake ChildProcess. Each spawn() pushes one here and records the
// args it was called with, so tests can assert on what got passed to the CLI and
// drive stdout/stderr/close deterministically.
interface FakeProc {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: () => void };
  exitCode: number | null;
  killed: boolean;
  kill: (sig?: string) => boolean;
  pid: number;
  on: (event: string, cb: (...a: any[]) => void) => FakeProc;
  _handlers: Record<string, (...a: any[]) => void>;
  /** Feed a chunk of stdout (may contain partial lines). */
  emitStdout: (s: string) => void;
  emitStderr: (s: string) => void;
  /** Fire the "close" event with an exit code. */
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
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const handlers: Record<string, (...a: any[]) => void> = {};
  const p: FakeProc = {
    stdout,
    stderr,
    stdin: { end: () => {} },
    exitCode: null,
    killed: false,
    pid: 4242,
    kill: () => true,
    _handlers: handlers,
    on(event, cb) {
      handlers[event] = cb;
      return p;
    },
    emitStdout(s) {
      stdout.emit("data", Buffer.from(s));
    },
    emitStderr(s) {
      stderr.emit("data", Buffer.from(s));
    },
    close(code) {
      p.exitCode = code;
      handlers["close"]?.(code);
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

import { CodexEngine, type CodexEngineOpts } from "../codex.js";
import type { StreamDelta, EngineResult } from "../../shared/types.js";

const flush = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// JSONL line builders mirroring the codex CLI `--json` event shapes.
const threadStarted = (id: string) => JSON.stringify({ type: "thread.started", thread_id: id });
const agentMessage = (text: string) =>
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
const turnCompleted = (usage: Record<string, unknown>) =>
  JSON.stringify({ type: "turn.completed", usage });
const turnFailed = (message: string) =>
  JSON.stringify({ type: "turn.failed", error: { message } });
const errorItem = (message: string) =>
  JSON.stringify({ type: "item.completed", item: { type: "error", message } });
const cmdStart = (id: string, command: string) =>
  JSON.stringify({ type: "item.started", item: { type: "command_execution", id, command } });
const cmdEnd = (command: string, exit_code: number, output: string) =>
  JSON.stringify({
    type: "item.completed",
    item: { type: "command_execution", command, exit_code, aggregated_output: output },
  });

/**
 * Drive a full run: kick off engine.run, feed stdout lines, then close.
 * Returns the resolved EngineResult and the deltas captured via onStream.
 */
async function runWith(
  opts: Record<string, unknown>,
  stdoutLines: string[],
  {
    closeCode = 0,
    trailingNoNewline,
    engineOpts,
  }: { closeCode?: number | null; trailingNoNewline?: string; engineOpts?: CodexEngineOpts } = {},
): Promise<{ result: EngineResult; deltas: StreamDelta[]; call: SpawnCall }> {
  const deltas: StreamDelta[] = [];
  const safeEngineOpts = {
    codexSessionsDir: fs.mkdtempSync(path.join(os.tmpdir(), "codex-test-sessions-")),
    ...engineOpts,
  };
  const engine = new CodexEngine(safeEngineOpts);
  const promise = engine.run({
    prompt: "hello",
    cwd: "/tmp",
    onStream: (d: StreamDelta) => deltas.push(d),
    ...opts,
  } as any);

  await flush();
  const call = spawnCalls[spawnCalls.length - 1];
  expect(call).toBeDefined();

  // Feed each complete line (with newline). Multiple lines in one chunk is fine.
  if (stdoutLines.length) call.proc.emitStdout(stdoutLines.join("\n") + "\n");
  // Optionally leave a trailing line WITHOUT a newline to exercise the
  // close-time lineBuf flush.
  if (trailingNoNewline) call.proc.emitStdout(trailingNoNewline);

  call.proc.close(closeCode);
  const result = await promise;
  return { result, deltas, call };
}

beforeEach(() => {
  spawnCalls.length = 0;
});

function envFrom(call: SpawnCall): Record<string, string> {
  return (call.opts as { env: Record<string, string> }).env;
}

describe("CodexEngine — child process environment", () => {
  it("strips host secrets and engine loop variables from spawned env", async () => {
    const prevGithub = process.env.GITHUB_TOKEN;
    const prevClaude = process.env.CLAUDE_CODE_SESSION;
    const prevCodex = process.env.CODEX_HOME;
    try {
      process.env.GITHUB_TOKEN = "host-secret";
      process.env.CLAUDE_CODE_SESSION = "hook";
      process.env.CODEX_HOME = "/tmp/codex-loop";

      const { call } = await runWith({}, [threadStarted("t1"), agentMessage("ok")]);
      const env = envFrom(call);

      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.CLAUDE_CODE_SESSION).toBeUndefined();
      expect(env.CODEX_HOME).toBeUndefined();
    } finally {
      if (prevGithub === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prevGithub;
      if (prevClaude === undefined) delete process.env.CLAUDE_CODE_SESSION;
      else process.env.CLAUDE_CODE_SESSION = prevClaude;
      if (prevCodex === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodex;
    }
  });
});

describe("CodexEngine — JSONL stream parsing into deltas", () => {
  it("maps an agent_message item to a text delta via onStream", async () => {
    const { deltas } = await runWith({}, [threadStarted("t1"), agentMessage("Hello world")]);
    expect(deltas).toContainEqual({ type: "text", content: "Hello world" });
  });

  it("maps command_execution start/end to tool_use and tool_result deltas", async () => {
    const { deltas } = await runWith({}, [
      threadStarted("t1"),
      cmdStart("c1", "ls -la"),
      cmdEnd("ls -la", 0, "file1\nfile2"),
      agentMessage("done"),
    ]);
    expect(deltas).toContainEqual({
      type: "tool_use",
      content: "Running: ls -la",
      toolName: "command_execution",
      toolId: "c1",
    });
    expect(deltas).toContainEqual({
      type: "tool_result",
      content: "ls -la (exit 0): file1\nfile2",
    });
  });

  it("skips malformed/garbage JSONL lines gracefully without crashing", async () => {
    const { result, deltas } = await runWith({}, [
      "this is not json {{{",
      "",
      "   ",
      threadStarted("t1"),
      "<another garbage line>",
      agentMessage("survived"),
    ]);
    expect(result.result).toBe("survived");
    // Only the real agent_message produced a text delta.
    expect(deltas.filter((d) => d.type === "text")).toEqual([{ type: "text", content: "survived" }]);
  });

  it("suppresses benign error notices (e.g. web_search_request) — not surfaced as error delta", async () => {
    const { deltas, result } = await runWith({}, [
      threadStarted("t1"),
      errorItem("web_search_request is deprecated"),
      agentMessage("real answer"),
    ]);
    expect(deltas.find((d) => d.type === "error")).toBeUndefined();
    expect(result.result).toBe("real answer");
    expect(result.error).toBeUndefined();
  });

  it("surfaces a genuine error item as an error delta", async () => {
    const { deltas } = await runWith({}, [
      threadStarted("t1"),
      errorItem("something genuinely broke"),
    ]);
    expect(deltas).toContainEqual({ type: "error", content: "something genuinely broke" });
  });
});

describe("CodexEngine — final result assembly (last agent_message wins, NOT concatenated)", () => {
  it("uses the FINAL agent_message, replacing earlier ones (= not +=)", async () => {
    const { result } = await runWith({}, [
      threadStarted("t1"),
      agentMessage("preamble: let me think..."),
      agentMessage("intermediate note"),
      agentMessage("FINAL ANSWER"),
    ]);
    // If the code concatenated, result would contain all three. It must be ONLY
    // the last one.
    expect(result.result).toBe("FINAL ANSWER");
    expect(result.result).not.toContain("preamble");
    expect(result.result).not.toContain("intermediate");
  });

  it("separates adjacent live agent_message blocks without changing the final result", async () => {
    const { result, deltas } = await runWith({}, [
      threadStarted("t1"),
      agentMessage("First block."),
      agentMessage("Second block."),
    ]);

    const liveText = deltas.filter((d) => d.type === "text").map((d) => d.content).join("");
    expect(liveText).toBe("First block.\n\nSecond block.");
    expect(result.result).toBe("Second block.");
  });

  it("flushes a trailing agent_message that arrives without a newline (close-time lineBuf)", async () => {
    const { result } = await runWith(
      {},
      [threadStarted("t1"), agentMessage("earlier")],
      { trailingNoNewline: agentMessage("last via buffer flush") },
    );
    expect(result.result).toBe("last via buffer flush");
  });

  it("returns the thread id from thread.started as sessionId", async () => {
    const { result } = await runWith({}, [threadStarted("thread-xyz"), agentMessage("ok")]);
    expect(result.sessionId).toBe("thread-xyz");
  });
});

describe("CodexEngine — systemPrompt / developer_instructions injection", () => {
  it("prepends systemPrompt to the prompt on the FIRST turn (no resumeSessionId)", async () => {
    const { call } = await runWith(
      { systemPrompt: "YOU ARE JIMBO" },
      [threadStarted("t1"), agentMessage("ok")],
    );
    // Fresh args: ["exec", ..., <prompt>] — prompt is the last arg.
    const finalArg = call.args[call.args.length - 1];
    expect(finalArg).toContain("YOU ARE JIMBO");
    expect(finalArg).toContain("---");
    expect(finalArg).toContain("hello");
    expect(call.args[0]).toBe("exec");
    expect(call.args).not.toContain("resume");
  });

  it("does NOT prepend systemPrompt on a resume turn (resumeSessionId present)", async () => {
    const { call } = await runWith(
      { systemPrompt: "YOU ARE JIMBO", resumeSessionId: "prev-thread" },
      [threadStarted("t2"), agentMessage("ok")],
    );
    // Resume args: ["exec", "resume", ..., <resumeId>, <prompt>] — prompt last.
    const finalArg = call.args[call.args.length - 1];
    expect(finalArg).toBe("hello");
    expect(finalArg).not.toContain("YOU ARE JIMBO");
    expect(call.args[0]).toBe("exec");
    expect(call.args[1]).toBe("resume");
    expect(call.args).toContain("prev-thread");
  });

  it("appends attachments to the prompt", async () => {
    const { call } = await runWith(
      { attachments: ["/tmp/a.png", "/tmp/b.txt"] },
      [threadStarted("t1"), agentMessage("ok")],
    );
    const finalArg = call.args[call.args.length - 1];
    expect(finalArg).toContain("Attached files:");
    expect(finalArg).toContain("- /tmp/a.png");
    expect(finalArg).toContain("- /tmp/b.txt");
  });

  it("drops Claude-only --chrome cliFlags before spawning codex exec", async () => {
    const { call } = await runWith(
      { cliFlags: ["--chrome", "--some-codex-flag"] },
      [threadStarted("t1"), agentMessage("ok")],
    );
    expect(call.args).not.toContain("--chrome");
    expect(call.args).toContain("--some-codex-flag");
  });

  it("drops Claude-only --chrome cliFlags on resume too", async () => {
    const { call } = await runWith(
      { resumeSessionId: "prev-thread", cliFlags: ["--chrome"] },
      [threadStarted("t1"), agentMessage("ok")],
    );
    expect(call.args).not.toContain("--chrome");
    expect(call.args).toContain("prev-thread");
  });

  it("passes Cuttlefish MCP config to Codex as mcp_servers overrides", async () => {
    const mcpConfigPath = path.join(os.tmpdir(), `codex-mcp-${Date.now()}.json`);
    fs.writeFileSync(mcpConfigPath, JSON.stringify({
      mcpServers: {
        browser: { command: "npx", args: ["-y", "@playwright/mcp@0.0.78"] },
      },
    }));

    const { call } = await runWith(
      { mcpConfigPath },
      [threadStarted("t1"), agentMessage("ok")],
    );

    expect(call.args).toContain("-c");
    expect(call.args).toContain('mcp_servers.browser.command="npx"');
    expect(call.args).toContain('mcp_servers.browser.args=["-y", "@playwright/mcp@0.0.78"]');
  });
});

describe("CodexEngine — usage / context-token extraction", () => {
  it("does not use flat turn.completed input_tokens as contextTokens (headless Codex reports it cumulatively)", async () => {
    const { result } = await runWith({}, [
      threadStarted("t1"),
      agentMessage("ok"),
      turnCompleted({ input_tokens: 1000, cached_input_tokens: 300, output_tokens: 50 }),
    ]);
    expect(result.contextTokens).toBeUndefined();
  });

  it("increments numTurns per turn.completed event", async () => {
    const { result } = await runWith({}, [
      threadStarted("t1"),
      agentMessage("a"),
      turnCompleted({ input_tokens: 100, last_token_usage: { input_tokens: 100 } }),
      turnCompleted({ input_tokens: 300, last_token_usage: { input_tokens: 200 } }),
    ]);
    expect(result.numTurns).toBe(2);
    // Last turn's per-turn usage wins, not cumulative input_tokens.
    expect(result.contextTokens).toBe(200);
  });

  it("omits contextTokens when usage is missing or input_tokens is zero/invalid", async () => {
    const { result } = await runWith({}, [
      threadStarted("t1"),
      agentMessage("a"),
      turnCompleted({ output_tokens: 50 }), // no input_tokens
    ]);
    expect(result.contextTokens).toBeUndefined();
  });

  it("omits cumulative Codex usage values from contextTokens", async () => {
    const { result } = await runWith({}, [
      threadStarted("t1"),
      agentMessage("a"),
      turnCompleted({ input_tokens: 310_356, output_tokens: 50 }),
    ]);
    expect(result.contextTokens).toBeUndefined();
  });

  it("uses nested last_token_usage when available instead of cumulative totals", async () => {
    const { result } = await runWith({}, [
      threadStarted("t1"),
      agentMessage("a"),
      turnCompleted({
        input_tokens: 9_282_000,
        last_token_usage: { input_tokens: 42_000, output_tokens: 50 },
      }),
    ]);
    expect(result.contextTokens).toBe(42_000);
  });

  it("backfills headless contextTokens from the Codex rollout transcript", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-context-"));
    const dir = path.join(root, "2026", "06", "11");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "rollout-2026-06-11T00-00-00-thread-rollout.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { id: "thread-rollout" } }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { input_tokens: 9_282_000 },
              last_token_usage: { input_tokens: 58_463, cached_input_tokens: 5_000 },
            },
          },
        }),
        "",
      ].join("\n"),
    );

    const { result } = await runWith(
      {},
      [
        threadStarted("thread-rollout"),
        agentMessage("ok"),
        turnCompleted({ input_tokens: 494_290, output_tokens: 50 }),
      ],
      { engineOpts: { codexSessionsDir: root } },
    );
    expect(result.contextTokens).toBe(58_463);
  });
});

describe("CodexEngine — error / failure handling", () => {
  it("does not surface a turn error when a non-empty answer was produced", async () => {
    const { result } = await runWith({}, [
      threadStarted("t1"),
      turnFailed("transient hiccup"),
      agentMessage("but here is the answer"),
    ]);
    expect(result.result).toBe("but here is the answer");
    // Non-empty result.trim() => error is suppressed.
    expect(result.error).toBeUndefined();
  });

  it("surfaces turn_failed as error when there is no answer text", async () => {
    const { result } = await runWith({}, [threadStarted("t1"), turnFailed("hard failure")], {
      closeCode: 0,
    });
    expect(result.result).toBe("");
    expect(result.error).toBe("hard failure");
  });

  it("reports a non-zero exit with no thread id as an error", async () => {
    const { result } = await runWith({}, [], { closeCode: 1 });
    expect(result.error).toMatch(/Codex exited with code 1/);
  });
});

describe("CodexEngine — process lifecycle", () => {
  it("tracks a live process and clears it after close (isAlive)", async () => {
    const engine = new CodexEngine();
    const promise = engine.run({
      prompt: "hi",
      cwd: "/tmp",
      sessionId: "sess-1",
    } as any);
    await flush();
    expect(engine.isAlive("sess-1")).toBe(true);

    const call = spawnCalls[spawnCalls.length - 1];
    call.proc.emitStdout(threadStarted("t1") + "\n" + agentMessage("done") + "\n");
    call.proc.close(0);
    await promise;
    expect(engine.isAlive("sess-1")).toBe(false);
  }, 20_000);

  it("settles on the terminal turn.completed event even if the process never closes", async () => {
    // Regression (same hang class as grok 94a50cc): a bash/shell tool call can leave
    // a grandchild that inherits codex's stdout pipe, so proc.on("close") never fires
    // even after codex itself exits. The turn must still settle from the parsed
    // terminal event (turn.completed) — never hang.
    const engine = new CodexEngine({
      codexSessionsDir: fs.mkdtempSync(path.join(os.tmpdir(), "codex-hang-")),
    });
    const deltas: StreamDelta[] = [];
    const promise = engine.run({
      prompt: "run a bash command",
      cwd: "/tmp",
      sessionId: "codex-session-hang",
      onStream: (d: StreamDelta) => deltas.push(d),
    } as any);

    await flush();
    const call = spawnCalls[spawnCalls.length - 1];
    expect(call).toBeDefined();

    // Stream thread id + answer + the terminal turn.completed. Crucially we NEVER
    // call call.proc.close(...) — the pipe is "held open" by a grandchild.
    call.proc.emitStdout(
      [
        threadStarted("thread-hang"),
        agentMessage("Done — the command ran."),
        turnCompleted({ last_token_usage: { input_tokens: 1234 } }),
        "",
      ].join("\n"),
    );

    // Resolves promptly from the terminal event (no close). A 1s race guard proves
    // we do not depend on `close` (which would hang here, failing pre-fix).
    const raced = await Promise.race([promise, sleep(1000).then(() => "TIMED_OUT" as const)]);
    expect(raced).not.toBe("TIMED_OUT");
    const result = raced as EngineResult;
    expect(result).toMatchObject({
      sessionId: "thread-hang",
      result: "Done — the command ran.",
      numTurns: 1,
      contextTokens: 1234,
    });
    expect(result.error).toBeUndefined();
    expect(engine.isAlive("codex-session-hang")).toBe(false);
  });

  it("settles on the terminal turn.completed event even if the process never closes", async () => {
    // Regression (same hang class as grok 94a50cc): a bash/shell tool call can leave
    // a grandchild that inherits codex's stdout pipe, so proc.on("close") never fires
    // even after codex itself exits. The turn must still settle from the parsed
    // terminal event (turn.completed) — never hang.
    const engine = new CodexEngine({
      codexSessionsDir: fs.mkdtempSync(path.join(os.tmpdir(), "codex-hang-")),
    });
    const deltas: StreamDelta[] = [];
    const promise = engine.run({
      prompt: "run a bash command",
      cwd: "/tmp",
      sessionId: "codex-session-hang",
      onStream: (d: StreamDelta) => deltas.push(d),
    } as any);

    await flush();
    const call = spawnCalls[spawnCalls.length - 1];
    expect(call).toBeDefined();

    // Stream thread id + answer + the terminal turn.completed. Crucially we NEVER
    // call call.proc.close(...) — the pipe is "held open" by a grandchild.
    call.proc.emitStdout(
      [
        threadStarted("thread-hang"),
        agentMessage("Done — the command ran."),
        turnCompleted({ last_token_usage: { input_tokens: 1234 } }),
        "",
      ].join("\n"),
    );

    // Resolves promptly from the terminal event (no close). A 1s race guard proves
    // we do not depend on `close` (which would hang here, failing pre-fix).
    const raced = await Promise.race([promise, sleep(1000).then(() => "TIMED_OUT" as const)]);
    expect(raced).not.toBe("TIMED_OUT");
    const result = raced as EngineResult;
    expect(result).toMatchObject({
      sessionId: "thread-hang",
      result: "Done — the command ran.",
      numTurns: 1,
      contextTokens: 1234,
    });
    expect(result.error).toBeUndefined();
    expect(engine.isAlive("codex-session-hang")).toBe(false);
  });

  it("kill() sets the termination reason as the result error", async () => {
    const engine = new CodexEngine();
    let resolved: EngineResult | undefined;
    void engine
      .run({ prompt: "hi", cwd: "/tmp", sessionId: "sess-2" } as any)
      .then((r) => (resolved = r));
    await flush();

    engine.kill("sess-2", "Interrupted: new message");
    const call = spawnCalls[spawnCalls.length - 1];
    // Process eventually closes after the kill signal.
    call.proc.close(null);
    await flush();
    expect(resolved?.error).toBe("Interrupted: new message");
  });
});
