import { spawn, type ChildProcess } from "node:child_process";
import type { EngineHistoryMessage, InterruptibleEngine, EngineRunOpts, EngineResult } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { buildEngineEnv } from "../shared/engine-env.js";
import { getMessages } from "../sessions/registry/messages.js";
import { stripDisallowedCliFlags } from "../shared/cli-flag-policy.js";

const TURN_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
const STDERR_MAX = 10 * 1024;

interface LiveProcess {
  proc: ChildProcess;
  terminationReason: string | null;
}

function promptRole(role: string): "User" | "Assistant" | "System" | null {
  if (role === "user") return "User";
  if (role === "assistant") return "Assistant";
  if (role === "system" || role === "notification") return "System";
  return null;
}

export function buildOllamaPrompt(
  opts: Pick<EngineRunOpts, "prompt" | "systemPrompt" | "attachments" | "sessionId">,
  history?: Pick<EngineHistoryMessage, "role" | "content" | "partial">[],
): string {
  const lines: string[] = [];
  const transcript = (history ?? [])
    .filter((msg) => !msg.partial)
    .map((msg) => ({ role: promptRole(msg.role), content: msg.content.trim() }))
    .filter((msg): msg is { role: "User" | "Assistant" | "System"; content: string } => Boolean(msg.role && msg.content));

  if (opts.systemPrompt?.trim()) {
    lines.push("System instructions:");
    lines.push(opts.systemPrompt.trim());
  }

  if (transcript.length > 0) {
    lines.push("Conversation transcript:");
    for (const msg of transcript) {
      lines.push(`${msg.role}:\n${msg.content}`);
    }
  } else if (opts.prompt.trim()) {
    lines.push(`User:\n${opts.prompt.trim()}`);
  }

  if (transcript.length === 0 || transcript[transcript.length - 1]?.role !== "User") {
    if (opts.prompt.trim()) lines.push(`User:\n${opts.prompt.trim()}`);
  }

  if (opts.attachments?.length) {
    lines.push(`Attached files for the latest user turn:\n${opts.attachments.map((file) => `- ${file}`).join("\n")}`);
  }

  lines.push("Assistant:");
  return lines.join("\n\n");
}

export class OllamaEngine implements InterruptibleEngine {
  name = "ollama" as const;
  private liveProcesses = new Map<string, LiveProcess>();

  kill(sessionId: string, reason = "Interrupted"): void {
    const live = this.liveProcesses.get(sessionId);
    if (!live) return;
    live.terminationReason = reason;
    logger.info(`Killing Ollama process for session ${sessionId}`);
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
    const trackingId = opts.sessionId || opts.resumeSessionId || `ollama-${Date.now()}`;
    const bin = resolveBin("ollama", opts.bin);
    const model = opts.model || "gemma4";
    const history = opts.historyMessages ?? (opts.sessionId ? getMessages(opts.sessionId) : []);
    const prompt = buildOllamaPrompt(opts, history);
    const args = ["run", ...stripDisallowedCliFlags(opts.cliFlags ?? []), model, prompt];

    logger.info(
      `Ollama engine starting: ${bin} run ${model} (history messages: ${history.length}, resume: ${opts.resumeSessionId || "synthetic"})`,
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
        live.terminationReason = "Ollama turn timed out";
        logger.warn(`Ollama turn timed out for session ${trackingId}; terminating process`);
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
        stdout += text;
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
            ...(result ? {} : { error: "Ollama exited without producing a final assistant response" }),
          });
          return;
        }
        finish({
          sessionId: trackingId,
          result,
          error: stderr.trim() || `Ollama exited with code ${code ?? "unknown"}`,
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
      logger.debug(`Failed to send ${signal} to Ollama process: ${err instanceof Error ? err.message : err}`);
    }
  }
}
