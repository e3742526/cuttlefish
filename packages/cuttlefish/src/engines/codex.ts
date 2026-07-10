import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { InterruptibleEngine, EngineRunOpts, EngineResult, StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { buildEngineEnv } from "../shared/engine-env.js";
import { readFirstLineSync } from "../shared/first-line.js";
import { codexMcpConfigFlagsFromFile } from "../mcp/resolver.js";
import { stripDisallowedCliFlags } from "../shared/cli-flag-policy.js";

const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");

// Hard backstop so a genuinely stuck turn (no terminal event ever) can't hang
// forever. This is not a normal turn limit; long-running work can span days.
const TURN_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;

interface LiveProcess {
  proc: ChildProcess;
  terminationReason: string | null;
}

export interface CodexEngineOpts {
  codexSessionsDir?: string;
}

export function codexCliFlags(flags: string[] | undefined): string[] {
  // `--chrome` is a Claude Code flag. Older shared employee/config paths can
  // still provide it via cliFlags; Codex rejects it before a session starts.
  return stripDisallowedCliFlags(flags ?? []).filter((flag) => flag !== "--chrome");
}

/**
 * Most-recent-turn input-context size from a codex per-turn usage object.
 * codex's `cached_input_tokens` is a SUBSET of `input_tokens` (OpenAI semantics),
 * so the window fill is `input_tokens` alone — summing would double-count.
 * Best-effort: returns undefined on any shape mismatch.
 */
export function extractCodexContextTokens(usage: unknown): number | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const last = (usage as Record<string, unknown>).last_token_usage;
  if (last && typeof last === "object") {
    const n = Number((last as Record<string, unknown>).input_tokens ?? 0);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  const n = Number((usage as Record<string, unknown>).input_tokens ?? 0);
  // Some Codex CLI builds report cumulative/billed input tokens here, not the
  // active context window. A value above any supported Codex window is unusable
  // for the UI context meter, so omit it instead of showing impossible values
  // like 9282k/272k.
  if (n > 1_000_000) return undefined;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function walkJsonl(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(p, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function codexSessionIdFromTranscript(filePath: string): string | undefined {
  try {
    const first = readFirstLineSync(filePath);
    if (!first) return undefined;
    const msg = JSON.parse(first);
    const id = msg?.payload?.id;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}

function latestCodexTranscript(sessionId: string, root: string): string | undefined {
  return walkJsonl(root)
    .map((file) => {
      try { return { file, mtimeMs: fs.statSync(file).mtimeMs }; }
      catch { return undefined; }
    })
    .filter((entry): entry is { file: string; mtimeMs: number } => !!entry)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .find(({ file }) => codexSessionIdFromTranscript(file) === sessionId)?.file;
}

export function lastCodexTranscriptContextTokens(sessionId: string, root = CODEX_SESSIONS_DIR): number | undefined {
  const file = latestCodexTranscript(sessionId, root);
  if (!file) return undefined;
  let last: number | undefined;
  try {
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg?.type !== "event_msg" || msg?.payload?.type !== "token_count") continue;
      const ctx = extractCodexContextTokens(msg.payload.info?.last_token_usage);
      if (ctx) last = ctx;
    }
  } catch {
    return undefined;
  }
  return last;
}

export class CodexEngine implements InterruptibleEngine {
  name = "codex" as const;
  private liveProcesses = new Map<string, LiveProcess>();

  constructor(private readonly opts: CodexEngineOpts = {}) {}

  kill(sessionId: string, reason = "Interrupted"): void {
    const live = this.liveProcesses.get(sessionId);
    if (!live) return;

    live.terminationReason = reason;
    logger.info(`Killing Codex process for session ${sessionId}`);
    this.signalProcess(live.proc, "SIGTERM");
    setTimeout(() => {
      if (live.proc.exitCode === null) {
        this.signalProcess(live.proc, "SIGKILL");
      }
    }, 2000);
  }

  killAll(): void {
    for (const sessionId of this.liveProcesses.keys()) {
      this.kill(sessionId, "Interrupted: gateway shutting down");
    }
  }

  /** Batch engine: no warm-PTY reuse, every live process is an in-flight turn.
   *  Nothing idle to recycle on org-reload — no-op. */
  killIdle(): void {
    /* no-op */
  }

  isAlive(sessionId: string): boolean {
    const live = this.liveProcesses.get(sessionId);
    return !!live && !live.proc.killed && live.proc.exitCode === null;
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    let prompt = opts.prompt;
    // Only inject the system prompt on the FIRST turn of a conversation. On a
    // resume (warm follow-up / restored session), codex already has it in the
    // thread, so re-prepending it every turn just duplicates/bloats context.
    if (opts.systemPrompt && !opts.resumeSessionId) {
      prompt = opts.systemPrompt + "\n\n---\n\n" + prompt;
    }
    if (opts.attachments?.length) {
      prompt += "\n\nAttached files:\n" + opts.attachments.map((a) => `- ${a}`).join("\n");
    }

    const bin = resolveBin("codex", opts.bin);
    const isResume = !!opts.resumeSessionId;
    const args = isResume
      ? this.buildResumeArgs(opts, prompt)
      : this.buildFreshArgs(opts, prompt);

    logger.info(
      `Codex engine starting: ${bin} ${args[0]}${isResume ? " resume" : ""} --model ${opts.model || "default"} (resume: ${opts.resumeSessionId || "none"})`,
    );

    const cleanEnv = this.buildCleanEnv();

    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, {
        cwd: opts.cwd,
        env: cleanEnv,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });

      const sessionId = opts.sessionId || `codex-${Date.now()}`;
      this.liveProcesses.set(sessionId, {
        proc,
        terminationReason: null,
      });

      let stderr = "";
      let settled = false;
      let threadId = "";
      let resultText = "";
      let numTurns = 0;
      let turnError: string | null = null;
      let lastContextTokens: number | undefined;
      let lineBuf = "";
      let hardTimeout: NodeJS.Timeout | undefined;
      let terminalSettleTimer: NodeJS.Timeout | undefined;
      const onStream = opts.onStream || null;
      let lastStreamedTextBlock: string | null = null;
      const STDERR_MAX = 10 * 1024; // 10KB rolling window for error reporting

      const clearTimers = () => {
        if (hardTimeout) { clearTimeout(hardTimeout); hardTimeout = undefined; }
        if (terminalSettleTimer) { clearTimeout(terminalSettleTimer); terminalSettleTimer = undefined; }
      };
      const resetTextBlockRun = () => { lastStreamedTextBlock = null; };
      const streamTextBlock = (delta: StreamDelta) => {
        if (!onStream) return;
        const needsBoundary =
          lastStreamedTextBlock !== null &&
          !lastStreamedTextBlock.endsWith("\n") &&
          !delta.content.startsWith("\n");
        onStream(needsBoundary ? { ...delta, content: `\n\n${delta.content}` } : delta);
        lastStreamedTextBlock = delta.content;
      };

      // Settle the turn on codex's parsed terminal event (`turn.completed` →
      // "usage" / `turn.failed` → "turn_failed"), decoupled from proc.on("close").
      // `close` only fires once every fd onto the child's stdout pipe is gone, but a
      // bash/shell tool call can leave a grandchild that inherits and holds that pipe
      // after codex itself exits, hanging the turn forever (the same freeze class
      // fixed for grok in 94a50cc). Mirrors GrokEngine.settleOnTerminal / PiEngine.
      const settleOnTerminal = () => {
        if (settled) return;
        settled = true;
        clearTimers();
        this.liveProcesses.delete(sessionId);
        // Detached child has signalled turn end and will exit; don't let its (or a
        // lingering grandchild's) open stdout pipe keep the event loop busy.
        try { proc.unref?.(); } catch { /* not detached / already gone */ }

        const resolvedThreadId = threadId || opts.resumeSessionId || "";
        if (resolvedThreadId) {
          const transcriptCtx = lastCodexTranscriptContextTokens(
            resolvedThreadId,
            this.opts.codexSessionsDir ?? CODEX_SESSIONS_DIR,
          );
          if (transcriptCtx) lastContextTokens = transcriptCtx;
        }

        logger.info(`Codex turn settled on terminal event (thread: ${threadId || "none"}, turns: ${numTurns})`);
        resolve({
          sessionId: resolvedThreadId,
          result: resultText,
          error: resultText.trim() ? undefined : (turnError ?? undefined),
          numTurns: numTurns || undefined,
          ...(typeof lastContextTokens === "number" ? { contextTokens: lastContextTokens } : {}),
        });
      };

      // Defer the terminal settle one tick: lets the rest of the current stdout
      // chunk finish parsing (so multiple `turn.completed` events accumulate) and a
      // promptly-firing `close` win with its own accounting, while still resolving
      // the turn when `close` never comes (held-pipe hang).
      const scheduleTerminalSettle = () => {
        if (settled || terminalSettleTimer) return;
        terminalSettleTimer = setTimeout(settleOnTerminal, 0);
        terminalSettleTimer.unref?.();
      };

      hardTimeout = setTimeout(() => {
        if (settled) return;
        const live = this.liveProcesses.get(sessionId);
        if (live) live.terminationReason = "Codex turn timed out";
        logger.warn(`Codex turn timed out after ${TURN_TIMEOUT_MS}ms for session ${sessionId}; terminating process`);
        // Group-kill (signalProcess uses process.kill(-pid)) tears down any lingering
        // grandchild too, so close fires and settle() reports the termination reason.
        this.signalProcess(proc, "SIGTERM");
        setTimeout(() => {
          if (proc.exitCode === null) this.signalProcess(proc, "SIGKILL");
        }, 2000).unref?.();
      }, TURN_TIMEOUT_MS);
      hardTimeout.unref?.();

      proc.stdout.on("data", (d: Buffer) => {
        lineBuf += d.toString();
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() || "";
        for (const line of lines) {
          const parsed = this.processJsonlLine(line);
          if (!parsed) continue;

          switch (parsed.type) {
            case "thread_id":
              threadId = parsed.threadId;
              logger.info(`Codex session got thread ID: ${threadId}`);
              break;
            case "tool_start":
              resetTextBlockRun();
              if (onStream) onStream(parsed.delta);
              break;
            case "tool_end":
              resetTextBlockRun();
              if (onStream) onStream(parsed.delta);
              break;
            case "text":
              // Each agent_message item is a COMPLETE assistant message; codex emits
              // several per turn (preamble + final). The result must be the FINAL
              // message, not all of them concatenated — so replace, don't append.
              // Adjacent live blocks need a paragraph boundary because the web UI
              // appends text deltas like chunks.
              resultText = parsed.delta.content;
              streamTextBlock(parsed.delta);
              break;
            case "error":
              resetTextBlockRun();
              turnError = parsed.message;
              if (onStream) onStream({ type: "error", content: parsed.message });
              break;
            case "usage":
              resetTextBlockRun();
              numTurns++;
              if (parsed.contextTokens) lastContextTokens = parsed.contextTokens;
              scheduleTerminalSettle(); // turn.completed = end of turn
              break;
            case "turn_failed":
              resetTextBlockRun();
              turnError = parsed.message;
              if (onStream) onStream({ type: "error", content: parsed.message });
              scheduleTerminalSettle(); // turn.failed = end of turn
              break;
          }
        }
      });

      proc.stderr.on("data", (d: Buffer) => {
        const chunk = d.toString();
        stderr += chunk;
        // Keep only the last 10KB of stderr to bound memory usage
        if (stderr.length > STDERR_MAX) {
          stderr = stderr.slice(stderr.length - STDERR_MAX);
        }
        for (const line of chunk.trim().split("\n").filter(Boolean)) {
          logger.debug(`[codex stderr] ${line}`);
        }
      });

      proc.stdin.end();

      proc.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimers();

        const terminationReason = this.liveProcesses.get(sessionId)?.terminationReason ?? null;
        this.liveProcesses.delete(sessionId);

        if (lineBuf.trim()) {
          const parsed = this.processJsonlLine(lineBuf);
          if (parsed) {
            switch (parsed.type) {
              case "thread_id":
                threadId = parsed.threadId;
                break;
              case "text":
                resultText = parsed.delta.content; // final message wins (see above)
                break;
              case "usage":
                numTurns++;
                if (parsed.contextTokens) lastContextTokens = parsed.contextTokens;
                break;
              case "error":
                turnError = parsed.message;
                break;
              case "turn_failed":
                turnError = parsed.message;
                break;
            }
          }
        }

        const resolvedThreadId = threadId || opts.resumeSessionId || "";
        if (resolvedThreadId) {
          const transcriptCtx = lastCodexTranscriptContextTokens(
            resolvedThreadId,
            this.opts.codexSessionsDir ?? CODEX_SESSIONS_DIR,
          );
          if (transcriptCtx) lastContextTokens = transcriptCtx;
        }

        logger.info(`Codex engine exited with code ${code} (thread: ${threadId || "none"}, turns: ${numTurns})`);

        if (terminationReason) {
          resolve({
            sessionId: resolvedThreadId,
            result: resultText,
            error: terminationReason,
            numTurns: numTurns || undefined,
            ...(typeof lastContextTokens === "number" ? { contextTokens: lastContextTokens } : {}),
          });
          return;
        }

        if (code === 0 || (code !== null && threadId)) {
          // A non-empty agent message means the turn genuinely succeeded — don't
          // surface a transient/benign error item (e.g. the `web_search_request`
          // deprecation notice that codex emits before the answer) as a failure.
          resolve({
            sessionId: resolvedThreadId,
            result: resultText,
            error: resultText.trim() ? undefined : (turnError ?? undefined),
            numTurns: numTurns || undefined,
            ...(typeof lastContextTokens === "number" ? { contextTokens: lastContextTokens } : {}),
          });
          return;
        }

        const errMsg = turnError || `Codex exited with code ${code}: ${stderr.slice(0, 500)}`;
        logger.error(errMsg);
        resolve({
          sessionId: resolvedThreadId,
          result: resultText,
          error: errMsg,
          ...(typeof lastContextTokens === "number" ? { contextTokens: lastContextTokens } : {}),
        });
      });

      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimers();
        this.liveProcesses.delete(sessionId);
        reject(new Error(`Failed to spawn Codex CLI: ${err.message}`));
      });
    });
  }

  private buildFreshArgs(opts: EngineRunOpts, prompt: string): string[] {
    const args = ["exec"];
    if (opts.model) args.push("--model", opts.model);
    if (opts.effortLevel && opts.effortLevel !== "default") args.push("-c", `model_reasoning_effort="${opts.effortLevel}"`);
    args.push("--json", "--color", "never", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check");
    if (opts.cwd) args.push("-C", opts.cwd);
    args.push(...codexMcpConfigFlagsFromFile(opts.mcpConfigPath));
    args.push(...codexCliFlags(opts.cliFlags));
    args.push(prompt);
    return args;
  }

  private buildResumeArgs(opts: EngineRunOpts, prompt: string): string[] {
    const args = ["exec", "resume"];
    if (opts.model) args.push("--model", opts.model);
    if (opts.effortLevel && opts.effortLevel !== "default") args.push("-c", `model_reasoning_effort="${opts.effortLevel}"`);
    args.push("--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check");
    args.push(...codexMcpConfigFlagsFromFile(opts.mcpConfigPath));
    args.push(...codexCliFlags(opts.cliFlags));
    args.push(opts.resumeSessionId!);
    args.push(prompt);
    return args;
  }

  private processJsonlLine(
    line: string,
  ):
    | { type: "thread_id"; threadId: string }
    | { type: "tool_start"; delta: StreamDelta }
    | { type: "tool_end"; delta: StreamDelta }
    | { type: "text"; delta: StreamDelta }
    | { type: "error"; message: string }
    | { type: "usage"; contextTokens?: number }
    | { type: "turn_failed"; message: string }
    | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      logger.debug(`[codex stream] unparseable line: ${trimmed.slice(0, 100)}`);
      return null;
    }

    const eventType = String(msg.type || "");

    if (eventType === "thread.started") {
      return { type: "thread_id", threadId: String(msg.thread_id || "") };
    }

    if (eventType === "item.started") {
      const item = msg.item as Record<string, unknown> | undefined;
      if (!item) return null;
      const itemType = String(item.type || "");

      if (itemType === "command_execution") {
        const command = String(item.command || "shell");
        return {
          type: "tool_start",
          delta: {
            type: "tool_use",
            content: `Running: ${command}`,
            toolName: "command_execution",
            toolId: String(item.id || ""),
          },
        };
      }

      if (itemType === "file_edit") {
        const filePath = String(item.file_path || item.filename || "file");
        return {
          type: "tool_start",
          delta: {
            type: "tool_use",
            content: `Editing: ${filePath}`,
            toolName: "file_edit",
            toolId: String(item.id || ""),
          },
        };
      }

      if (itemType === "file_read") {
        const filePath = String(item.file_path || item.filename || "file");
        return {
          type: "tool_start",
          delta: {
            type: "tool_use",
            content: `Reading: ${filePath}`,
            toolName: "file_read",
            toolId: String(item.id || ""),
          },
        };
      }

      return null;
    }

    if (eventType === "item.completed") {
      const item = msg.item as Record<string, unknown> | undefined;
      if (!item) return null;
      const itemType = String(item.type || "");

      if (itemType === "agent_message") {
        const text = String(item.text || "");
        if (text) {
          return { type: "text", delta: { type: "text", content: text } };
        }
      }

      if (itemType === "command_execution") {
        const output = String(item.aggregated_output || "");
        const exitCode = item.exit_code;
        const command = String(item.command || "shell");
        return {
          type: "tool_end",
          delta: {
            type: "tool_result",
            content: output
              ? `${command} (exit ${exitCode}): ${output.slice(0, 500)}`
              : `${command} (exit ${exitCode})`,
          },
        };
      }

      if (itemType === "file_edit") {
        const filePath = String(item.file_path || item.filename || "file");
        return { type: "tool_end", delta: { type: "tool_result", content: `Edited: ${filePath}` } };
      }

      if (itemType === "file_read") {
        const filePath = String(item.file_path || item.filename || "file");
        return { type: "tool_end", delta: { type: "tool_result", content: `Read: ${filePath}` } };
      }

      if (itemType === "error") {
        const message = String(item.message || "Unknown error");
        // Benign notices codex emits as `error` items but that don't fail the turn.
        if (
          message.includes("Under-development features") ||
          message.includes("Model metadata") ||
          message.includes("deprecated") ||
          message.includes("web_search_request")
        ) {
          logger.debug(`[codex] suppressed warning: ${message.slice(0, 200)}`);
          return null;
        }
        return { type: "error", message };
      }

      return null;
    }

    if (eventType === "turn.completed") {
      const usage = msg.usage as Record<string, unknown> | undefined;
      return { type: "usage", contextTokens: extractCodexContextTokens(usage?.last_token_usage) };
    }

    if (eventType === "turn.failed") {
      const error = msg.error as Record<string, unknown> | undefined;
      return { type: "turn_failed", message: String(error?.message || "Turn failed") };
    }

    if (eventType === "error") {
      return { type: "error", message: String(msg.message || "Unknown error") };
    }

    return null;
  }

  private buildCleanEnv(): Record<string, string> {
    return buildEngineEnv({}, { stripPrefixes: ["CLAUDECODE", "CLAUDE_CODE_", "CODEX"] });
  }

  private signalProcess(proc: ChildProcess, signal: NodeJS.Signals): void {
    if (proc.exitCode !== null) return;
    try {
      if (process.platform !== "win32" && proc.pid) {
        process.kill(-proc.pid, signal);
      } else {
        proc.kill(signal);
      }
    } catch (err) {
      logger.debug(`Failed to send ${signal} to Codex process: ${err instanceof Error ? err.message : err}`);
    }
  }
}
