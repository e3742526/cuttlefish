import { spawn, type ChildProcess } from "node:child_process";
import type { InterruptibleEngine, EngineRunOpts, EngineResult } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { buildEngineEnv } from "../shared/engine-env.js";
import { getMessages } from "../sessions/registry/messages.js";
import { buildOllamaPrompt } from "./ollama.js";
import { stripDisallowedCliFlags } from "../shared/cli-flag-policy.js";
import { capAppend, ENGINE_OUTPUT_MAX } from "../shared/cap-append.js";

const TURN_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
const STDERR_MAX = 10 * 1024;
const KILO_AUTO_MODEL = "kilo-auto/free";

interface LiveProcess {
  proc: ChildProcess;
  terminationReason: string | null;
}

export class KiloEngine implements InterruptibleEngine {
  name = "kilo" as const;
  private liveProcesses = new Map<string, LiveProcess>();

  kill(sessionId: string, reason = "Interrupted"): void {
    const live = this.liveProcesses.get(sessionId);
    if (!live) return;
    live.terminationReason = reason;
    logger.info(`Killing Kilo process for session ${sessionId}`);
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
    const trackingId = opts.sessionId || opts.resumeSessionId || `kilo-${Date.now()}`;
    const bin = resolveBin("kilo", opts.bin);
    const model = opts.model || KILO_AUTO_MODEL;
    const history = opts.historyMessages ?? (opts.sessionId ? getMessages(opts.sessionId) : []);
    const prompt = buildOllamaPrompt(opts, history);
    const args = [
      "run",
      "--auto",
      "--dangerously-skip-permissions",
      "--dir",
      opts.cwd,
      ...(model !== KILO_AUTO_MODEL ? ["--model", model] : []),
      ...(opts.attachments ?? []).flatMap((file) => ["--file", file]),
      ...stripDisallowedCliFlags(opts.cliFlags ?? []),
      prompt,
    ];

    logger.info(
      `Kilo engine starting: ${bin} run${model !== KILO_AUTO_MODEL ? ` --model ${model}` : " (default model)"}` +
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
        live.terminationReason = "Kilo turn timed out";
        logger.warn(`Kilo turn timed out for session ${trackingId}; terminating process`);
        this.signalProcess(live.proc, "SIGTERM");
        setTimeout(() => {
          if (live.proc.exitCode === null) this.signalProcess(live.proc, "SIGKILL");
        }, 2000).unref?.();
      }, TURN_TIMEOUT_MS);
      hardTimeout.unref?.();

      proc.stdout.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        if (!text) return;
        opts.onActivity?.();
        stdout = capAppend(stdout, text, ENGINE_OUTPUT_MAX); // bound long-turn retention (AR-09)
        if (opts.onStream) opts.onStream({ type: "text", content: text });
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
        const result = stdout.trim();
        if (terminationReason) {
          finish({ sessionId: trackingId, result: "", error: terminationReason });
          return;
        }
        if (code === 0) {
          finish({
            sessionId: trackingId,
            result,
            ...(result ? {} : { error: "Kilo exited without producing a final assistant response" }),
          });
          return;
        }
        finish({
          sessionId: trackingId,
          result,
          error: stderr.trim() || `Kilo exited with code ${code ?? "unknown"}`,
        });
      });
    });
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
      logger.debug(`Failed to send ${signal} to Kilo process: ${err instanceof Error ? err.message : err}`);
    }
  }
}
