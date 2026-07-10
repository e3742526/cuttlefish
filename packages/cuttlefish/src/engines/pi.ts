import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { InterruptibleEngine, EngineRunOpts, EngineResult } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { CUTTLEFISH_HOME } from "../shared/paths.js";
import { buildEngineEnv } from "../shared/engine-env.js";
import { acquirePiMessageSlot, DEFAULT_PI_MESSAGES_PER_MINUTE } from "../shared/pi-throttle.js";
import { stripDisallowedCliFlags } from "../shared/cli-flag-policy.js";

interface LiveProcess {
  proc: ChildProcess;
  rl: readline.Interface;
  terminationReason: string | null;
  resultText: string;
  turnError: string | null;
  stderr: string;
  settled: boolean;
  resolve: (res: EngineResult) => void;
  sessionIdOut: string;
  hardTimeout?: NodeJS.Timeout;
  agentEndExitTimer?: NodeJS.Timeout;
}

const STDERR_MAX = 10 * 1024; // 10KB rolling window for error reporting
const TURN_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
const AGENT_END_EXIT_GRACE_MS = 5000;

/**
 * Pi coding agent (https://pi.dev) run headlessly against a local model.
 *
 * Invocation: `pi --provider <p> --model <id> -p --mode json [--system-prompt ...] \
 *   [--thinking <lvl>] --session-id <id> --session-dir <dir> "<prompt>"`.
 *
 * Pi emits one JSON event per stdout line and exits when the run ends. The final
 * assistant answer is the last `text` block of the last assistant message in the
 * terminating `agent_end` event — reasoning models (e.g. Gemma 4) also emit
 * `thinking` blocks, which we skip. Errors surface as an assistant message with
 * `stopReason === "error"` and an `errorMessage`; we propagate that as
 * EngineResult.error rather than swallowing it.
 *
 * Resume: Pi's session is keyed on the Cuttlefish session id (`--session-id` + an
 * isolated `--session-dir`), so re-running with the same id continues the same
 * Pi conversation — no need to capture Pi's own session id.
 *
 * Provider/model: registry model ids are `provider/id` (e.g. "ollama/gemma4:12b").
 * The provider is whatever the user configured in their Pi `~/.pi/agent/models.json`
 * — the gateway never assumes Ollama or any specific backend.
 */
export class PiEngine implements InterruptibleEngine {
  name = "pi" as const;
  private liveProcesses = new Map<string, LiveProcess>();

  kill(sessionId: string, reason = "Interrupted"): void {
    const live = this.liveProcesses.get(sessionId);
    if (!live) return;

    live.terminationReason = reason;
    logger.info(`Killing Pi process for session ${sessionId}`);

    try {
      live.rl.close();
    } catch {
      /* ignore */
    }

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
    const trackingId = opts.sessionId || `pi-${Date.now()}`;
    // A Pi session id keyed on the Cuttlefish session → resuming reuses the same id and
    // continues the same Pi conversation.
    const piSessionId = opts.resumeSessionId || trackingId;

    let prompt = opts.prompt;
    if (opts.attachments?.length) {
      prompt += "\n\nAttached files:\n" + opts.attachments.map((a) => `- ${a}`).join("\n");
    }

    const bin = resolveBin("pi", opts.bin);

    // Registry model ids are `provider/id`; split on the FIRST slash, since the
    // provider-native id may itself contain slashes (e.g. "ollama/hf.co/org/m:Q4").
    const rawModel = opts.model || "ollama/gemma4:12b";
    let provider: string | undefined;
    let model = rawModel;
    const slash = rawModel.indexOf("/");
    if (slash > 0) {
      provider = rawModel.slice(0, slash);
      model = rawModel.slice(slash + 1);
    }

    // Isolate each session's Pi state so resumes are deterministic and concurrent
    // sessions never clobber each other.
    const sessionDir = path.join(CUTTLEFISH_HOME, "sessions", trackingId, "pi-session");
    try {
      fs.mkdirSync(sessionDir, { recursive: true });
    } catch (err) {
      logger.error(`PiEngine failed to create session dir ${sessionDir}: ${err instanceof Error ? err.message : err}`);
    }

    const args: string[] = [];
    if (provider) args.push("--provider", provider);
    args.push("--model", model, "-p", "--mode", "json");
    if (opts.systemPrompt && !opts.resumeSessionId) {
      args.push("--system-prompt", opts.systemPrompt);
    }
    // Effort → Pi thinking level. Only reasoning-capable models ever carry an
    // effort level (the registry exposes effortLevels for those models only), so
    // passing it through verbatim is safe — mirrors codex/claude.
    if (opts.effortLevel && opts.effortLevel !== "default") {
      args.push("--thinking", opts.effortLevel);
    }
    args.push("--session-id", piSessionId, "--session-dir", sessionDir);
    if (opts.cliFlags?.length) args.push(...stripDisallowedCliFlags(opts.cliFlags));
    args.push(prompt);

    logger.info(
      `Pi engine starting: ${bin} --provider ${provider ?? "(default)"} --model ${model}` +
        `${opts.effortLevel && opts.effortLevel !== "default" ? ` --thinking ${opts.effortLevel}` : ""}` +
        ` (resume: ${opts.resumeSessionId || "none"})`,
    );

    const throttleSlot = await acquirePiMessageSlot();
    if (throttleSlot.waitedMs > 0) {
      logger.info(
        `Pi local throttle waited ${Math.ceil(throttleSlot.waitedMs / 1000)}s ` +
          `(limit: ${DEFAULT_PI_MESSAGES_PER_MINUTE} messages/minute)`,
      );
    }

    const cleanEnv = this.buildCleanEnv();

    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, {
        cwd: opts.cwd,
        env: cleanEnv,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });

      const rl = readline.createInterface({ input: proc.stdout, terminal: false });

      const live: LiveProcess = {
        proc,
        rl,
        terminationReason: null,
        resultText: "",
        turnError: null,
        stderr: "",
        settled: false,
        resolve,
        sessionIdOut: piSessionId,
      };
      this.liveProcesses.set(trackingId, live);
      live.hardTimeout = setTimeout(() => {
        const l = this.liveProcesses.get(trackingId);
        if (!l || l.settled) return;
        l.terminationReason = "Pi turn timed out";
        logger.warn(`Pi turn timed out for session ${trackingId}; terminating process`);
        this.signalProcess(l.proc, "SIGTERM");
        setTimeout(() => {
          if (l.proc.exitCode === null) this.signalProcess(l.proc, "SIGKILL");
        }, 2000).unref?.();
      }, TURN_TIMEOUT_MS);
      live.hardTimeout.unref?.();

      const onStream = opts.onStream || null;

      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          logger.debug(`[pi stream] unparseable line: ${trimmed.slice(0, 100)}`);
          return;
        }
        if (!parsed || typeof parsed !== "object") return;

        switch (parsed.type) {
          case "message_update": {
            // Best-effort live delta for the UI; the authoritative answer comes
            // from agent_end below.
            const delta = this.extractDelta(parsed);
            if (delta && onStream) onStream({ type: "text", content: delta });
            break;
          }
          case "tool_execution_start": {
            if (onStream) {
              onStream({
                type: "tool_use",
                content: this.describeTool(parsed),
                toolName: typeof parsed.toolName === "string" ? parsed.toolName : undefined,
                toolId: typeof parsed.toolCallId === "string" ? parsed.toolCallId : undefined,
              });
            }
            break;
          }
          case "tool_execution_end": {
            if (onStream) {
              onStream({
                type: "tool_result",
                content: this.toolResultText(parsed),
                toolName: typeof parsed.toolName === "string" ? parsed.toolName : undefined,
                toolId: typeof parsed.toolCallId === "string" ? parsed.toolCallId : undefined,
              });
            }
            break;
          }
          case "auto_retry_start": {
            logger.debug(
              `[pi] auto-retry ${parsed.attempt}/${parsed.maxAttempts}: ${String(parsed.errorMessage ?? "").slice(0, 200)}`,
            );
            break;
          }
          case "agent_end": {
            const { text, error } = this.extractFromMessages(parsed.messages);
            if (text) live.resultText = text;
            if (error) live.turnError = error;
            if (live.agentEndExitTimer) clearTimeout(live.agentEndExitTimer);
            live.agentEndExitTimer = setTimeout(() => {
              const l = this.liveProcesses.get(trackingId);
              if (!l || l.settled || l.proc.exitCode !== null) return;
              logger.warn(`Pi emitted agent_end for session ${trackingId} but did not exit; terminating process`);
              this.signalProcess(l.proc, "SIGTERM");
              setTimeout(() => {
                if (l.proc.exitCode === null) this.signalProcess(l.proc, "SIGKILL");
              }, 2000).unref?.();
            }, AGENT_END_EXIT_GRACE_MS);
            live.agentEndExitTimer.unref?.();
            break;
          }
        }
      });

      proc.stderr.on("data", (d: Buffer) => {
        const chunk = d.toString();
        live.stderr = (live.stderr + chunk).slice(-STDERR_MAX);
        for (const l of chunk.trim().split("\n").filter(Boolean)) logger.debug(`[pi stderr] ${l}`);
      });

      // -p mode reads the prompt from argv; no stdin input is needed.
      proc.stdin.end();

      proc.on("close", (code) => this.settle(trackingId, code));

      proc.on("error", (err) => {
        const l = this.liveProcesses.get(trackingId);
        if (!l || l.settled) return;
        l.settled = true;
        this.clearTimers(l);
        this.liveProcesses.delete(trackingId);
        reject(new Error(`Failed to spawn Pi agent CLI: ${err.message}`));
      });
    });
  }

  /** Resolve a live run exactly once, mirroring Codex's close semantics. */
  private settle(trackingId: string, code: number | null): void {
    const live = this.liveProcesses.get(trackingId);
    if (!live || live.settled) return;
    live.settled = true;
    this.clearTimers(live);

    try {
      live.rl.close();
    } catch {
      /* ignore */
    }
    // `close` should mean the child is gone, but keep this defensive guard for
    // abnormal streams/errors where settle() is called before exit accounting lands.
    if (live.proc.exitCode === null) {
      try {
        live.proc.kill();
      } catch {
        /* ignore */
      }
    }
    this.liveProcesses.delete(trackingId);

    const result = live.resultText;

    if (live.terminationReason) {
      live.resolve({ sessionId: live.sessionIdOut, result: "", error: live.terminationReason });
      return;
    }
    // A non-empty answer means the turn succeeded even if a benign error item
    // also appeared — don't surface it as a failure.
    if (result.trim()) {
      live.resolve({
        sessionId: live.sessionIdOut,
        result,
        error: undefined,
      });
      return;
    }

    const errMsg = live.turnError
      || (code === 0
        ? "Pi process exited successfully without a final assistant response"
        : code === null
          ? `Interrupted: agent process exited via signal (${live.stderr.slice(0, 200)})`
          : `Interrupted: agent process exited with code ${code} (${live.stderr.slice(0, 200)})`);
    logger.error(errMsg);
    live.resolve({ sessionId: live.sessionIdOut, result, error: errMsg });
  }

  private clearTimers(live: LiveProcess): void {
    if (live.hardTimeout) clearTimeout(live.hardTimeout);
    if (live.agentEndExitTimer) clearTimeout(live.agentEndExitTimer);
    live.hardTimeout = undefined;
    live.agentEndExitTimer = undefined;
  }

  /**
   * Extract the final assistant answer + any error from an `agent_end` messages[]
   * array. The answer is the last non-empty `text` content block across assistant
   * messages (reasoning `thinking` blocks are ignored).
   */
  private extractFromMessages(messages: unknown): { text: string; error: string | null } {
    let text = "";
    let error: string | null = null;
    if (!Array.isArray(messages)) return { text, error };

    for (const m of messages) {
      if (!m || typeof m !== "object") continue;
      const msg = m as Record<string, unknown>;
      if (msg.role !== "assistant") continue;

      if (msg.stopReason === "error" && typeof msg.errorMessage === "string") {
        error = msg.errorMessage;
      }
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
            const t = (block as Record<string, unknown>).text;
            if (typeof t === "string" && t) text = t; // last non-empty text block wins
          }
        }
      }
    }
    return { text, error };
  }

  /** Pull a streaming text delta out of a json-mode message_update (tolerant of shape). */
  private extractDelta(parsed: Record<string, unknown>): string {
    const d = parsed.delta;
    if (typeof d === "string") return d;
    if (d && typeof d === "object" && typeof (d as Record<string, unknown>).text === "string") {
      return (d as Record<string, unknown>).text as string;
    }
    const ev = parsed.event;
    if (ev && typeof ev === "object" && typeof (ev as Record<string, unknown>).delta === "string") {
      return (ev as Record<string, unknown>).delta as string;
    }
    return "";
  }

  /** Human-readable summary of a tool_execution_start event for live streaming. */
  private describeTool(parsed: Record<string, unknown>): string {
    const name = typeof parsed.toolName === "string" ? parsed.toolName : "tool";
    const args = parsed.args;
    if (args && typeof args === "object") {
      const a = args as Record<string, unknown>;
      const detail = a.command ?? a.path ?? a.file_path;
      if (typeof detail === "string") return `${name}: ${detail}`;
    }
    return `Running ${name}`;
  }

  /** Extract a short text summary from a tool_execution_end result payload. */
  private toolResultText(parsed: Record<string, unknown>): string {
    const r = parsed.result;
    if (r && typeof r === "object" && Array.isArray((r as Record<string, unknown>).content)) {
      const content = (r as Record<string, unknown>).content as unknown[];
      const t = content.find((b) => b && typeof b === "object" && (b as Record<string, unknown>).type === "text");
      if (t && typeof (t as Record<string, unknown>).text === "string") {
        return ((t as Record<string, unknown>).text as string).slice(0, 500);
      }
    }
    return "";
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
      logger.debug(`Failed to send ${signal} to Pi process: ${err instanceof Error ? err.message : err}`);
    }
  }
}
