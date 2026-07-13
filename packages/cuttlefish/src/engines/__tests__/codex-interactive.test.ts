import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * The PTY is mocked. `spawn()` records the (bin, args) it was called with into
 * `spawnCalls` and returns a controllable fake IPty, so the effort/model arg
 * plumbing and the respawn-on-param-change behaviour can be asserted without a
 * real codex process.
 */
interface FakePty {
  pid: number;
  _exitCode: number | null;
  onData: (cb: (d: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  on: (event: string, cb: (...a: any[]) => void) => void;
  kill: (sig?: string) => void;
  resize: (cols: number, rows: number) => void;
  write: (data: string) => void;
  _exit: (code?: number) => void;
}

interface SpawnCall { bin: string; args: string[]; proc: FakePty }

const spawnCalls: SpawnCall[] = [];

function makeFakePty(): FakePty {
  let exitCb: ((e: { exitCode: number }) => void) | undefined;
  const p: FakePty = {
    pid: 5252,
    _exitCode: null,
    onData: () => {},
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
    const proc = makeFakePty();
    spawnCalls.push({ bin, args, proc });
    return proc as unknown as import("node-pty").IPty;
    }),
  };
});

/**
 * Redirect os.homedir() to a temp dir so the engine's module-level
 * CODEX_SESSIONS_DIR (~/.codex/sessions) points at a sandbox the run-level
 * tests can write transcript fixtures into. Everything else on node:os stays
 * real. The temp home is created inside the factory (runs before the engine
 * module is imported) and exposed via the hoisted state object.
 */
const osMockState = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fsm = await import("node:fs");
  const pathm = await import("node:path");
  osMockState.home = fsm.mkdtempSync(pathm.join(actual.tmpdir(), "codex-it-home-"));
  const homedir = () => osMockState.home;
  return { ...actual, homedir, default: { ...((actual as any).default ?? actual), homedir } };
});

import { codexTranscriptLineToDeltas, CodexInteractiveEngine } from "../codex-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";

/** Find the `-c model_reasoning_effort="..."` value in a codex arg list, if present. */
function reasoningEffortArg(args: string[]): string | undefined {
  const i = args.indexOf("-c");
  if (i < 0) return undefined;
  const m = /^model_reasoning_effort="(.*)"$/.exec(args[i + 1] ?? "");
  return m?.[1];
}

beforeEach(() => {
  spawnCalls.length = 0;
});

describe("CodexInteractiveEngine transcript parsing", () => {
  it("extracts the session id from session_meta", () => {
    const parsed = codexTranscriptLineToDeltas(JSON.stringify({
      type: "session_meta",
      payload: { id: "codex-session-1" },
    }));
    expect(parsed.sessionId).toBe("codex-session-1");
    expect(parsed.deltas).toEqual([]);
  });

  it("maps assistant messages to text deltas and doneText", () => {
    const parsed = codexTranscriptLineToDeltas(JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "done" }],
      },
    }));
    expect(parsed.doneText).toBe("done");
    expect(parsed.deltas).toEqual([{ type: "text", content: "done" }]);
  });

  it("maps function calls to tool deltas", () => {
    expect(codexTranscriptLineToDeltas(JSON.stringify({
      type: "response_item",
      payload: { type: "function_call", name: "exec_command", call_id: "call-1" },
    })).deltas).toEqual([{
      type: "tool_use",
      content: "Using exec_command",
      toolName: "exec_command",
      toolId: "call-1",
    }]);

    expect(codexTranscriptLineToDeltas(JSON.stringify({
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call-1" },
    })).deltas).toEqual([{
      type: "tool_result",
      content: "Done",
      toolId: "call-1",
    }]);
  });

  it("uses last_token_usage for context deltas", () => {
    const parsed = codexTranscriptLineToDeltas(JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 9_282_000 },
          last_token_usage: { input_tokens: 42_000 },
        },
      },
    }));
    expect(parsed.contextTokens).toBe(42_000);
    expect(parsed.deltas).toEqual([{ type: "context", content: "42000" }]);
  });

  it("omits the context update when only cumulative total_token_usage is present (no impossible meter)", () => {
    // A long codex session: total_token_usage is the running cumulative input
    // billed across ALL turns (here below the 1M guard, but still NOT the context
    // window fill). With no last_token_usage we must emit nothing rather than
    // surface the cumulative figure as the meter value.
    const parsed = codexTranscriptLineToDeltas(JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 800_000 } },
      },
    }));
    expect(parsed.contextTokens).toBeUndefined();
    expect(parsed.deltas).toEqual([]);
  });

  it("omits the context update when last_token_usage input_tokens is zero/missing", () => {
    const parsed = codexTranscriptLineToDeltas(JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 500_000 },
          last_token_usage: { output_tokens: 10 },
        },
      },
    }));
    expect(parsed.contextTokens).toBeUndefined();
    expect(parsed.deltas).toEqual([]);
  });
});

describe("codexTranscriptLineToDeltas — terminal markers", () => {
  it("parses task_complete with last_agent_message", () => {
    const line = JSON.stringify({
      timestamp: "2026-06-10T06:19:26.649Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "t-1", last_agent_message: "All done." },
    });
    const parsed = codexTranscriptLineToDeltas(line);
    expect(parsed.taskComplete).toEqual({ lastAgentMessage: "All done.", turnId: "t-1" });
    expect(parsed.deltas).toEqual([]);
  });

  it("parses task_complete without last_agent_message", () => {
    const line = JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "t-2" } });
    expect(codexTranscriptLineToDeltas(line).taskComplete).toEqual({ lastAgentMessage: undefined, turnId: "t-2" });
  });

  it("parses turn_aborted", () => {
    const line = JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted", turn_id: "t-3" } });
    expect(codexTranscriptLineToDeltas(line).turnAborted).toEqual({ turnId: "t-3" });
  });

  it("parses task_started with turn id", () => {
    const line = JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t-9" } });
    expect(codexTranscriptLineToDeltas(line).taskStarted).toEqual({ turnId: "t-9" });
  });

  it("empty-string last_agent_message is preserved as a string", () => {
    const line = JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "t-5", last_agent_message: "" } });
    expect(codexTranscriptLineToDeltas(line).taskComplete).toEqual({ lastAgentMessage: "", turnId: "t-5" });
  });

  it("task_started carries no terminal markers", () => {
    const line = JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t-4" } });
    const parsed = codexTranscriptLineToDeltas(line);
    expect(parsed.taskComplete).toBeUndefined();
    expect(parsed.turnAborted).toBeUndefined();
  });
});

describe("CodexInteractiveEngine — effort/model PTY args + respawn", () => {
  let lifecycle: PtyLifecycleManager;
  let engine: CodexInteractiveEngine;

  beforeEach(() => {
    lifecycle = new PtyLifecycleManager({ maxLivePtys: 8 });
    engine = new CodexInteractiveEngine(lifecycle);
  });

  function lastArgs(): string[] {
    return spawnCalls[spawnCalls.length - 1]!.args;
  }

  it("forwards model and effortLevel into the idle-spawned codex CLI args", () => {
    engine.ensureIdleSpawn("sess-1", {
      model: "gpt-5.5",
      effortLevel: "high",
      cwd: "/tmp",
      cols: 100,
      rows: 40,
    });
    const args = lastArgs();
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.5");
    expect(reasoningEffortArg(args)).toBe("high");
    lifecycle.dispose();
  });

  it("drops Claude-only --chrome cliFlags before spawning the interactive codex PTY", async () => {
    const run = engine.run({
      prompt: "hello",
      sessionId: "sess-flags",
      cwd: "/tmp",
      model: "gpt-5.5",
      cliFlags: ["--chrome", "--some-codex-flag"],
    } as any);
    const args = lastArgs();
    expect(args).not.toContain("--chrome");
    expect(args).toContain("--some-codex-flag");
    spawnCalls[spawnCalls.length - 1]!.proc._exit(0);
    await run;
    lifecycle.dispose();
  });

  it("passes Cuttlefish MCP config to interactive Codex as mcp_servers overrides", async () => {
    const mcpConfigPath = path.join(osMockState.home, "mcp.json");
    fs.writeFileSync(mcpConfigPath, JSON.stringify({
      mcpServers: {
        browser: { command: "npx", args: ["-y", "@playwright/mcp@0.0.78"] },
      },
    }));

    const run = engine.run({
      prompt: "hello",
      sessionId: "sess-mcp",
      cwd: "/tmp",
      model: "gpt-5.5",
      mcpConfigPath,
    } as any);
    const args = lastArgs();
    expect(args).toContain('mcp_servers.browser.command="npx"');
    expect(args).toContain('mcp_servers.browser.args=["-y", "@playwright/mcp@0.0.78"]');
    spawnCalls[spawnCalls.length - 1]!.proc._exit(0);
    await run;
    lifecycle.dispose();
  });

  it('omits the reasoning-effort flag when effortLevel is "default" or absent', () => {
    engine.ensureIdleSpawn("sess-default", { model: "gpt-5.5", effortLevel: "default" });
    expect(reasoningEffortArg(lastArgs())).toBeUndefined();

    engine.ensureIdleSpawn("sess-none", { model: "gpt-5.5" });
    expect(reasoningEffortArg(lastArgs())).toBeUndefined();
    lifecycle.dispose();
  });

  it("does NOT respawn the idle PTY when model/effort are unchanged", () => {
    engine.ensureIdleSpawn("sess-2", { model: "gpt-5.5", effortLevel: "low" });
    expect(spawnCalls).toHaveLength(1);
    // Same params again (e.g. a reconnecting viewer) — reuse the warm PTY.
    engine.ensureIdleSpawn("sess-2", { model: "gpt-5.5", effortLevel: "low" });
    expect(spawnCalls).toHaveLength(1);
    lifecycle.dispose();
  });

  it("respawns the idle PTY when effortLevel changes (CLI binds effort at spawn)", () => {
    engine.ensureIdleSpawn("sess-3", { model: "gpt-5.5", effortLevel: "low" });
    expect(spawnCalls).toHaveLength(1);
    engine.ensureIdleSpawn("sess-3", { model: "gpt-5.5", effortLevel: "high" });
    expect(spawnCalls).toHaveLength(2);
    expect(reasoningEffortArg(lastArgs())).toBe("high");
    lifecycle.dispose();
  });

  it("respawns the idle PTY when the model changes", () => {
    engine.ensureIdleSpawn("sess-4", { model: "gpt-5.5", effortLevel: "medium" });
    expect(spawnCalls).toHaveLength(1);
    engine.ensureIdleSpawn("sess-4", { model: "gpt-5.5-codex", effortLevel: "medium" });
    expect(spawnCalls).toHaveLength(2);
    const args = lastArgs();
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.5-codex");
    lifecycle.dispose();
  });

  it("respawns the idle PTY when the resume session id changes", () => {
    engine.ensureIdleSpawn("sess-resume", { engineSessionId: "codex-a", cwd: "/tmp" });
    expect(spawnCalls).toHaveLength(1);
    engine.ensureIdleSpawn("sess-resume", { engineSessionId: "codex-b", cwd: "/tmp" });
    expect(spawnCalls).toHaveLength(2);
    const args = lastArgs();
    expect(args).toContain("resume");
    expect(args).toContain("codex-b");
    lifecycle.dispose();
  });

  it("respawns the idle PTY when cwd or bin changes", () => {
    engine.ensureIdleSpawn("sess-env", { cwd: "/tmp/a", bin: "/tmp/codex-a" });
    expect(spawnCalls).toHaveLength(1);

    engine.ensureIdleSpawn("sess-env", { cwd: "/tmp/b", bin: "/tmp/codex-a" });
    expect(spawnCalls).toHaveLength(2);

    engine.ensureIdleSpawn("sess-env", { cwd: "/tmp/b", bin: "/tmp/codex-b" });
    expect(spawnCalls).toHaveLength(3);
    expect(spawnCalls[2]!.bin).toBe("/tmp/codex-b");
    lifecycle.dispose();
  });

  it("respawns a warm PTY when run-level cliFlags change", async () => {
    engine.ensureIdleSpawn("sess-run-flags", { cwd: "/tmp" });
    expect(spawnCalls).toHaveLength(1);

    const run = engine.run({
      prompt: "hello",
      sessionId: "sess-run-flags",
      cwd: "/tmp",
      cliFlags: ["--some-codex-flag"],
    } as any);
    expect(spawnCalls).toHaveLength(2);
    expect(lastArgs()).toContain("--some-codex-flag");
    spawnCalls[spawnCalls.length - 1]!.proc._exit(0);
    await run;
    lifecycle.dispose();
  });
});

describe("CodexInteractiveEngine — terminal-marker gating + transcript discovery (run level)", () => {
  // os.homedir() is mocked to a temp dir (see vi.mock above), so the engine's
  // CODEX_SESSIONS_DIR points at <tmp>/.codex/sessions and these tests can plant
  // transcript fixtures the discovery poll (200ms) + tailer (250ms) pick up live.
  let lifecycle: PtyLifecycleManager;
  let engine: CodexInteractiveEngine;
  let sessionsDir: string;
  let fileSeq = 0;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const line = (obj: unknown) => JSON.stringify(obj) + "\n";
  const sessionMeta = (id: string) => line({ type: "session_meta", payload: { id } });
  const taskStarted = (turnId: string) => line({ type: "event_msg", payload: { type: "task_started", turn_id: turnId } });
  const taskComplete = (turnId: string, msg: string) =>
    line({ type: "event_msg", payload: { type: "task_complete", turn_id: turnId, last_agent_message: msg } });
  const turnAborted = (turnId: string) => line({ type: "event_msg", payload: { type: "turn_aborted", turn_id: turnId } });
  const assistantMessage = (text: string) =>
    line({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });

  beforeEach(() => {
    lifecycle = new PtyLifecycleManager({ maxLivePtys: 8 });
    engine = new CodexInteractiveEngine(lifecycle);
    sessionsDir = path.join(osMockState.home, ".codex", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
  });

  function freshTranscriptPath(): string {
    return path.join(sessionsDir, `rollout-it-${++fileSeq}.jsonl`);
  }

  it("ignores a stale task_complete replayed before task_started, settles on the matched one", async () => {
    const run = engine.run({ prompt: "hi", sessionId: "it-gate-1", cwd: "/tmp" });
    let settled = false;
    void run.then(() => { settled = true; });

    // The fresh rollout appears pre-seeded with a STALE terminal marker (no
    // task_started) — e.g. replayed history. It must NOT settle the turn.
    const file = freshTranscriptPath();
    fs.writeFileSync(file, sessionMeta("codex-it-1") + taskComplete("t-old", "STALE"));
    await sleep(800); // discovery (200ms) + tailer attach/replay window
    expect(settled).toBe(false);

    // The real turn: matched task_started → task_complete settles immediately.
    fs.appendFileSync(file, taskStarted("t-new") + assistantMessage("fresh answer") + taskComplete("t-new", "fresh answer"));
    const result = await run;
    expect(result.result).toBe("fresh answer");
    expect(result.error).toBeUndefined();
    expect(result.sessionId).toBe("codex-it-1");
    lifecycle.dispose();
  }, 15000);

  it("ignores a terminal marker whose turn id mismatches the started turn", async () => {
    const run = engine.run({ prompt: "hi", sessionId: "it-gate-2", cwd: "/tmp" });
    let settled = false;
    void run.then(() => { settled = true; });

    const file = freshTranscriptPath();
    fs.writeFileSync(file, sessionMeta("codex-it-2") + taskStarted("t-a") + taskComplete("t-b", "WRONG"));
    await sleep(800);
    expect(settled).toBe(false);

    fs.appendFileSync(file, taskComplete("t-a", "RIGHT"));
    const result = await run;
    expect(result.result).toBe("RIGHT");
    lifecycle.dispose();
  }, 15000);

  it("turn_aborted settles the turn only after this turn's task_started", async () => {
    const run = engine.run({ prompt: "hi", sessionId: "it-gate-3", cwd: "/tmp" });
    let settled = false;
    void run.then(() => { settled = true; });

    const file = freshTranscriptPath();
    fs.writeFileSync(file, sessionMeta("codex-it-3") + turnAborted("t-old"));
    await sleep(800); // stale abort ignored — turn still pending
    expect(settled).toBe(false);

    fs.appendFileSync(file, taskStarted("t-x") + turnAborted("t-x"));
    const result = await run;
    expect(result.error).toBe("Interrupted: codex turn aborted");
    lifecycle.dispose();
  }, 15000);

  it("discovery ignores a pre-existing transcript that another process appends to", async () => {
    // A foreign rollout exists BEFORE this turn starts...
    const foreign = path.join(sessionsDir, `rollout-foreign-${++fileSeq}.jsonl`);
    fs.writeFileSync(foreign, sessionMeta("codex-foreign"));

    const run = engine.run({ prompt: "hi", sessionId: "it-disc-1", cwd: "/tmp" });
    // ...and gets appended (mtime bump) by the OTHER codex process mid-discovery.
    // The old mtime arm would attach fromBeginning and settle with FOREIGN.
    fs.appendFileSync(foreign, taskStarted("t-f") + taskComplete("t-f", "FOREIGN"));
    await sleep(800);

    // Our own brand-new rollout appears — discovery must pick it, not the foreign one.
    const own = freshTranscriptPath();
    fs.writeFileSync(own, sessionMeta("codex-own") + taskStarted("t-o") + taskComplete("t-o", "OWN"));
    const result = await run;
    expect(result.result).toBe("OWN");
    expect(result.sessionId).toBe("codex-own");
    lifecycle.dispose();
  }, 15000);

  it("does not debounce-complete an assistant message when tool activity follows", async () => {
    const run = engine.run({ prompt: "hi", sessionId: "it-tool-1", cwd: "/tmp" });
    let settled = false;
    void run.then(() => { settled = true; });

    const file = freshTranscriptPath();
    fs.writeFileSync(file, sessionMeta("codex-tool-1") + taskStarted("t-tool") + assistantMessage("working"));
    await sleep(800);
    fs.appendFileSync(file, line({
      type: "response_item",
      payload: { type: "function_call", name: "exec_command", call_id: "call-1" },
    }));
    await sleep(3500);
    expect(settled).toBe(false);

    fs.appendFileSync(file, taskComplete("t-tool", "finished"));
    const result = await run;
    expect(result.result).toBe("finished");
    lifecycle.dispose();
  }, 15000);
});
