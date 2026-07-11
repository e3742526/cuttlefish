import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import type { InterruptibleEngine, EngineRunOpts, EngineResult } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { buildEngineEnv } from "../shared/engine-env.js";
import { getMessages } from "../sessions/registry/messages.js";
import { buildOllamaPrompt } from "./ollama.js";
import { aiderHistoryPathFor, ensureAiderHistoryDir, extractAssistantText } from "./aider-protocol.js";
import { stripDisallowedCliFlags } from "../shared/cli-flag-policy.js";
import { capAppend, ENGINE_OUTPUT_MAX } from "../shared/cap-append.js";

const TURN_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
const STDERR_MAX = 10 * 1024;

interface LiveProcess {
  proc: ChildProcess;
  terminationReason: string | null;
}

/** Aider has no resume-by-id and auto-detects its model from env API keys; "default"
 *  (and empty) is a sentinel meaning "don't pass --model". */
function aiderModelFlag(model: string | undefined): string[] {
  return model && model !== "default" ? ["--model", model] : [];
}

/**
 * Aider (`aider` CLI) engine — headless, spawn-per-turn, modeled on KiloEngine.
 *
 * Each work turn runs `aider --message <prompt>` (one-shot, then exits). Aider has no
 * resume-by-id, so prior turns are folded back into the prompt via buildOllamaPrompt
 * (same as ollama/kilo). `--no-auto-commits` keeps aider to editing files only — no
 * engine commits on its own. `--yes-always` makes it non-interactive (note: in a
 * non-git cwd this also lets aider initialize a git repo). Aider auto-detects its
 * model from whichever API key is in env (ANTHROPIC_API_KEY / OPENAI_API_KEY / ...),
 * which buildEngineEnv preserves.
 */
export class AiderEngine implements InterruptibleEngine {
  name = "aider" as const;
  private liveProcesses = new Map<string, LiveProcess>();

  kill(sessionId: string, reason = "Interrupted"): void {
    const live = this.liveProcesses.get(sessionId);
    if (!live) return;
    live.terminationReason = reason;
    logger.info(`Killing Aider process for session ${sessionId}`);
    this.signalProcess(live.proc, "SIGTERM");
    setTimeout(() => {
      if (live.proc.exitCode === null) this.signalProcess(live.proc, "SIGKILL");
    }, 2000).unref?.();
  }

  killAll(): void {
    for (const sessionId of this.liveProcesses.keys()) {
      this.kill(sessionId, "Interrupted: gateway shutting down");
    }
  }

  killIdle(): void {
    /* no-op */
  }

  isAlive(sessionId: string): boolean {
    const live = this.liveProcesses.get(sessionId);
    return !!live && !live.proc.killed && live.proc.exitCode === null;
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const trackingId = opts.sessionId || opts.resumeSessionId || `aider-${Date.now()}`;
    const bin = resolveBin("aider", opts.bin);
    const history = opts.historyMessages ?? (opts.sessionId ? getMessages(opts.sessionId) : []);
    const prompt = buildOllamaPrompt(opts, history);
    // Point aider at a per-session chat-history file and remember where it ends now,
    // so after the turn we can read back just THIS turn's assistant prose (clean) — far
    // better than aider's stdout chrome (banner, token/cost lines, edit summaries).
    const historyPath = ensureAiderHistoryDir(trackingId);
    let historyStartOffset = 0;
    try { historyStartOffset = fs.statSync(historyPath).size; } catch { /* not created yet → 0 */ }
    const args = [
      "--yes-always",
      "--no-auto-commits",
      "--no-pretty",
      "--no-check-update",
      "--chat-history-file",
      historyPath,
      ...aiderModelFlag(opts.model),
      ...(opts.attachments ?? []).flatMap((file) => ["--file", file]),
      ...stripDisallowedCliFlags(opts.cliFlags ?? []),
      "--message",
      prompt,
    ];

    logger.info(
      `Aider engine starting: ${bin} --message${opts.model && opts.model !== "default" ? ` --model ${opts.model}` : " (auto model)"}` +
        ` (history messages: ${history.length}, resume: ${opts.resumeSessionId || "synthetic"})`,
    );

    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, {
        cwd: opts.cwd,
        env: this.buildCleanEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });

      this.liveProcesses.set(trackingId, { proc, terminationReason: null });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let hardTimeout: NodeJS.Timeout | undefined;

      const finish = (result: EngineResult) => {
        if (settled) return;
        settled = true;
        if (hardTimeout) clearTimeout(hardTimeout);
        this.liveProcesses.delete(trackingId);
        resolve(result);
      };

      hardTimeout = setTimeout(() => {
        const live = this.liveProcesses.get(trackingId);
        if (!live || settled) return;
        live.terminationReason = "Aider turn timed out";
        logger.warn(`Aider turn timed out for session ${trackingId}; terminating process`);
        this.signalProcess(live.proc, "SIGTERM");
        setTimeout(() => {
          if (live.proc.exitCode === null) this.signalProcess(live.proc, "SIGKILL");
        }, 2000).unref?.();
      }, TURN_TIMEOUT_MS);
      hardTimeout.unref?.();

      proc.stdout.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        if (!text) return;
        // Keep the stall watchdog alive, but DON'T stream aider's stdout chrome as chat
        // text — the clean per-turn result comes from the chat-history file on close.
        opts.onActivity?.();
        stdout = capAppend(stdout, text, ENGINE_OUTPUT_MAX); // bound long-turn retention (AR-09)
      });

      proc.stderr.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        if (!text) return;
        opts.onActivity?.();
        stderr = (stderr + text).slice(-STDERR_MAX);
      });

      proc.on("error", (err) => {
        if (hardTimeout) clearTimeout(hardTimeout);
        this.liveProcesses.delete(trackingId);
        reject(err);
      });

      proc.on("close", (code) => {
        const live = this.liveProcesses.get(trackingId);
        const terminationReason = live?.terminationReason;
        if (terminationReason) {
          finish({ sessionId: trackingId, result: "", error: terminationReason });
          return;
        }
        if (code === 0) {
          // Prefer the clean assistant prose aider wrote to the chat-history file;
          // fall back to raw stdout if that read turns up empty.
          const result = this.readTurnResult(historyPath, historyStartOffset) || stdout.trim();
          finish({
            sessionId: trackingId,
            result,
            ...(result ? {} : { error: "Aider exited without producing a final assistant response" }),
          });
          return;
        }
        finish({
          sessionId: trackingId,
          result: stdout.trim(),
          error: stderr.trim() || `Aider exited with code ${code ?? "unknown"}`,
        });
      });
    });
  }

  /** Read the assistant prose appended to the chat-history file during this turn
   *  (the byte range [startOffset, EOF)). Returns "" on any read failure. */
  private readTurnResult(historyPath: string, startOffset: number): string {
    try {
      const fd = fs.openSync(historyPath, "r");
      try {
        const size = fs.fstatSync(fd).size;
        if (size <= startOffset) return "";
        const len = size - startOffset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, startOffset);
        return extractAssistantText(buf.toString("utf-8"));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return "";
    }
  }

  private buildCleanEnv(): Record<string, string> {
    // Aider authenticates by reading provider keys from env (ANTHROPIC_API_KEY,
    // OPENAI_API_KEY, AWS_* for Bedrock, etc.) — so unlike most engines we must let
    // those through (allowUnsafeTokens), while still stripping Cuttlefish-internal
    // tokens and the Claude/Codex harness env that aider has no use for.
    return buildEngineEnv({}, {
      allowUnsafeTokens: true,
      stripPrefixes: ["CLAUDECODE", "CLAUDE_CODE_", "CODEX", "CUTTLEFISH_"],
    });
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
      logger.debug(`Failed to send ${signal} to Aider process: ${err instanceof Error ? err.message : err}`);
    }
  }
}
