import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { EngineRunOpts, EngineResult, InterruptibleEngine, CuttlefishConfig } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { nextKiroCreditResetAt, recordKiroCreditUsage } from "../shared/usage-status.js";
import { buildEngineEnv } from "../shared/engine-env.js";
import { stripDisallowedCliFlags } from "../shared/cli-flag-policy.js";

const TURN_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
const OUTPUT_MAX = 2 * 1024 * 1024;
const STDERR_MAX = 10 * 1024;

interface LiveProcess {
  proc: ChildProcess;
  terminationReason: string | null;
}

export interface KiroEngineOpts {
  configProvider?: () => CuttlefishConfig;
  listSessions?: (bin: string, cwd: string) => Promise<string | undefined>;
  authProbe?: (bin: string, cwd: string) => Promise<{ ok: boolean; error?: string }>;
}

export interface KiroFooterParse {
  text: string;
  credits?: number;
}

const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\x1b\\))/g;
const CREDIT_FOOTER_RE = /^\s*(?:▸\s*)?Credits:\s*([0-9]+(?:\.[0-9]+)?)\s*(?:-|•)\s*Time:\s*.+$/i;
const CREDIT_EXHAUSTION_RE =
  /(?:credit|credits|quota).*(?:exhaust|insufficient|limit|exceeded|unavailable)|(?:insufficient|exhausted).*credits/i;
const AUTH_FAILURE_RE =
  /(?:api key|auth(?:entication)?|credential|login|sign in|unauthorized|forbidden|permission).*(?:missing|required|failed|invalid|expired|denied|not found)|(?:missing|required|invalid|expired).*(?:api key|credential|token)/i;

export function stripKiroAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

export function parseKiroOutput(raw: string): KiroFooterParse {
  const clean = stripKiroAnsi(raw).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let credits: number | undefined;
  const lines = clean
    .split("\n")
    .filter((line) => {
      const match = line.match(CREDIT_FOOTER_RE);
      if (!match) return true;
      credits = Number(match[1]);
      return false;
    })
    .filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed.length > 0 &&
        !trimmed.startsWith("All tools are now trusted") &&
        !trimmed.startsWith("Agents can sometimes do unexpected things") &&
        !trimmed.startsWith("Learn more at ")
      );
    });

  return {
    text: lines.join("\n").trim().replace(/^>\s*/, ""),
    ...(Number.isFinite(credits) ? { credits } : {}),
  };
}

function capAppend(base: string, chunk: string, max: number): string {
  const next = base + chunk;
  return next.length > max ? next.slice(next.length - max) : next;
}

function sessionTimestamp(session: Record<string, unknown>): number {
  for (const key of ["updatedAt", "lastActivityAt", "lastUsedAt", "createdAt", "timestamp"]) {
    const raw = session[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string") {
      const parsed = Date.parse(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

export function parseKiroSessionList(output: string, filter?: { cwd?: string }): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }

  const roots = Array.isArray(parsed) ? parsed : [parsed];
  const sessions = roots
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
    // Scope recovery to this turn's workspace when the listing groups sessions by
    // cwd, so a concurrent Kiro session running against a different cwd can never
    // be picked as "most recent" for this turn (TMP-CUT-012). Groups that don't
    // report a cwd can't be scoped, so they're kept as-is rather than dropped.
    .filter((root) => !filter?.cwd || typeof root.cwd !== "string" || root.cwd === filter.cwd)
    .flatMap((root) => {
      const nested = root.sessions;
      if (Array.isArray(nested)) return nested;
      return root.id || root.sessionId || root.session_id ? [root] : [];
    });

  return sessions
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
    .sort((a, b) => sessionTimestamp(b) - sessionTimestamp(a))
    .map((session) => session.id ?? session.sessionId ?? session.session_id)
    .find((id): id is string => typeof id === "string" && id.length > 0);
}

export function isKiroCreditExhaustion(text: string): boolean {
  return CREDIT_EXHAUSTION_RE.test(text);
}

export class KiroEngine implements InterruptibleEngine {
  name = "kiro" as const;
  private liveProcesses = new Map<string, LiveProcess>();
  // Recovery correlation state (TMP-CUT-012): recoverSessionId() has no run/task
  // id to key off (Kiro assigns its own session id and we only learn it after
  // the fact via `--list-sessions`), so two fresh Kiro sessions finishing around
  // the same time in the same cwd could otherwise both resolve to the same
  // "most recent" session and mis-attribute it to the wrong turn. Serialize
  // recovery per cwd and refuse to hand out a session id that a concurrent
  // recovery already claimed, rather than silently guessing.
  private recoveryLocks = new Map<string, Promise<unknown>>();
  private claimedSessionIds = new Set<string>();

  constructor(private readonly opts: KiroEngineOpts = {}) {}

  kill(sessionId: string, reason = "Interrupted"): void {
    const live = this.liveProcesses.get(sessionId);
    if (!live) return;
    live.terminationReason = reason;
    logger.info(`Killing Kiro process for session ${sessionId}`);
    this.signalProcess(live.proc, "SIGTERM");
    setTimeout(() => {
      if (live.proc.exitCode === null) this.signalProcess(live.proc, "SIGKILL");
    }, 2000).unref?.();
  }

  killAll(): void {
    for (const sessionId of this.liveProcesses.keys()) this.kill(sessionId, "Interrupted: gateway shutting down");
  }

  killIdle(): void {
    /* batch engine: no idle warm process */
  }

  isAlive(sessionId: string): boolean {
    const live = this.liveProcesses.get(sessionId);
    return !!live && !live.proc.killed && live.proc.exitCode === null;
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    let prompt = opts.prompt;
    if (opts.systemPrompt && !opts.resumeSessionId) {
      prompt = `${opts.systemPrompt}\n\n---\n\n${prompt}`;
    }
    if (opts.attachments?.length) {
      prompt += "\n\nAttached files:\n" + opts.attachments.map((a) => `- ${a}`).join("\n");
    }

    const trackingId = opts.sessionId || `kiro-${Date.now()}`;
    const bin = resolveBin("kiro-cli", opts.bin);
    const args = this.buildArgs(opts, prompt);
    const auth = await this.preflightAuth(bin, opts.cwd);
    if (!auth.ok) {
      return {
        sessionId: opts.resumeSessionId ?? "",
        result: "",
        error: auth.error ?? "Kiro authentication is unavailable. Authenticate Kiro locally or set KIRO_API_KEY.",
      };
    }

    logger.info(
      `Kiro engine starting: ${bin} chat --model ${opts.model || this.opts.configProvider?.()?.engines.kiro?.model || "auto"}` +
        `${opts.resumeSessionId ? " --resume-id <redacted>" : ""}`,
    );

    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, {
        cwd: opts.cwd,
        env: this.buildCleanEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });

      this.liveProcesses.set(trackingId, { proc, terminationReason: null });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let hardTimeout: NodeJS.Timeout | undefined;

      const clearTimer = () => {
        if (hardTimeout) clearTimeout(hardTimeout);
        hardTimeout = undefined;
      };

      hardTimeout = setTimeout(() => {
        if (settled) return;
        const live = this.liveProcesses.get(trackingId);
        if (live) live.terminationReason = "Kiro turn timed out";
        logger.warn(`Kiro turn timed out for session ${trackingId}; terminating process`);
        this.signalProcess(proc, "SIGTERM");
        setTimeout(() => {
          if (proc.exitCode === null) this.signalProcess(proc, "SIGKILL");
        }, 2000).unref?.();
      }, TURN_TIMEOUT_MS);
      hardTimeout.unref?.();

      proc.stdout.on("data", (d: Buffer) => {
        opts.onActivity?.();
        stdout = capAppend(stdout, d.toString(), OUTPUT_MAX);
      });

      proc.stderr.on("data", (d: Buffer) => {
        opts.onActivity?.();
        const chunk = d.toString();
        stderr = capAppend(stderr, chunk, STDERR_MAX);
        for (const line of chunk.trim().split("\n").filter(Boolean)) logger.debug(`[kiro stderr] ${line}`);
      });

      proc.stdin.end();

      proc.on("close", async (code) => {
        if (settled) return;
        settled = true;
        clearTimer();

        const live = this.liveProcesses.get(trackingId);
        const terminationReason = live?.terminationReason ?? null;
        this.liveProcesses.delete(trackingId);

        const parsed = parseKiroOutput(stdout);
        const config = this.opts.configProvider?.();
        if (typeof parsed.credits === "number" && config) {
          recordKiroCreditUsage(config, parsed.credits);
        }

        const sessionId = opts.resumeSessionId
          ?? await this.recoverSessionId(bin, opts.cwd)
          ?? "";

        if (terminationReason) {
          resolve({ sessionId, result: parsed.text, error: terminationReason });
          return;
        }

        const combinedError = stripKiroAnsi(`${stderr}\n${stdout}`).trim();
        if (isKiroCreditExhaustion(combinedError)) {
          const resetsAt = config ? nextKiroCreditResetAt(config) : undefined;
          resolve({
            sessionId,
            result: parsed.text,
            error: combinedError || "Kiro credits exhausted",
            rateLimit: { status: "rejected", ...(resetsAt ? { resetsAt } : {}) },
          });
          return;
        }

        if (code === 0) {
          resolve({
            sessionId,
            result: parsed.text,
            error: parsed.text ? undefined : "Kiro exited successfully without a final answer",
          });
          return;
        }

        const errMsg = stripKiroAnsi(stderr).trim() || `Kiro exited with code ${code}`;
        logger.error(errMsg);
        resolve({
          sessionId,
          result: parsed.text,
          error: errMsg.slice(0, 1000),
        });
      });

      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimer();
        this.liveProcesses.delete(trackingId);
        reject(new Error(`Failed to spawn Kiro CLI: ${err.message}`));
      });
    });
  }

  private buildArgs(opts: EngineRunOpts, prompt: string): string[] {
    const config = this.opts.configProvider?.();
    const model = opts.model || config?.engines.kiro?.model || "auto";
    const args = ["chat", "--no-interactive", "--trust-all-tools", "--model", model];
    if (opts.effortLevel && opts.effortLevel !== "default") args.push("--effort", opts.effortLevel);
    if (opts.resumeSessionId) args.push("--resume-id", opts.resumeSessionId);
    if (opts.cliFlags?.length) args.push(...stripDisallowedCliFlags(opts.cliFlags));
    args.push(prompt);
    return args;
  }

  private recoverSessionId(bin: string, cwd: string): Promise<string | undefined> {
    // Chain onto any in-flight recovery for this cwd so concurrent turns don't
    // race the same `--list-sessions` probe and both land on the same answer.
    const prior = this.recoveryLocks.get(cwd) ?? Promise.resolve();
    const attempt = prior.then(
      () => this.recoverSessionIdOnce(bin, cwd),
      () => this.recoverSessionIdOnce(bin, cwd),
    );
    const tracked = attempt.catch(() => undefined);
    this.recoveryLocks.set(cwd, tracked);
    void tracked.finally(() => {
      if (this.recoveryLocks.get(cwd) === tracked) this.recoveryLocks.delete(cwd);
    });
    return attempt;
  }

  private async recoverSessionIdOnce(bin: string, cwd: string): Promise<string | undefined> {
    const id = this.opts.listSessions
      ? await this.opts.listSessions(bin, cwd)
      : await new Promise<string | undefined>((resolve) => {
          execFile(bin, ["chat", "--list-sessions", "--format", "json"], { cwd, timeout: 5000 }, (err, stdout) => {
            if (err) return resolve(undefined);
            resolve(parseKiroSessionList(stdout, { cwd }));
          });
        });

    if (!id) return id;
    if (this.claimedSessionIds.has(id)) {
      // Another concurrent recovery already attributed this session id to a
      // different turn; handing it out again would cross-wire two sessions.
      // Fail safe (no resume id) rather than guess.
      logger.warn(`Kiro session recovery for ${cwd} resolved to an already-claimed session id; skipping to avoid a cross-turn mixup`);
      return undefined;
    }
    this.claimedSessionIds.add(id);
    return id;
  }

  private preflightAuth(bin: string, cwd: string): Promise<{ ok: boolean; error?: string }> {
    if (process.env.KIRO_API_KEY) return Promise.resolve({ ok: true });
    if (this.opts.authProbe) return this.opts.authProbe(bin, cwd);
    return new Promise((resolve) => {
      execFile(bin, ["chat", "--list-sessions", "--format", "json"], { cwd, timeout: 5000 }, (err, stdout, stderr) => {
        if (!err) {
          resolve({ ok: true });
          return;
        }
        const combined = stripKiroAnsi(`${stderr ?? ""}\n${stdout ?? ""}\n${err instanceof Error ? err.message : String(err)}`).trim();
        if (AUTH_FAILURE_RE.test(combined)) {
          resolve({
            ok: false,
            error: `Kiro authentication is unavailable: ${combined.slice(0, 500)}`,
          });
          return;
        }
        // Non-auth list failures (for example no saved sessions yet) should not
        // block local-auth installs from starting the real turn.
        resolve({ ok: true });
      });
    });
  }

  private buildCleanEnv(): Record<string, string> {
    return buildEngineEnv(
      process.env.KIRO_API_KEY ? { KIRO_API_KEY: process.env.KIRO_API_KEY } : {},
      { stripPrefixes: ["CLAUDECODE", "CLAUDE_CODE_", "CODEX"] },
    );
  }

  private signalProcess(proc: ChildProcess, signal: NodeJS.Signals): void {
    if (proc.exitCode !== null) return;
    try {
      if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, signal);
      else proc.kill(signal);
    } catch (err) {
      logger.debug(`Failed to send ${signal} to Kiro process: ${err instanceof Error ? err.message : err}`);
    }
  }
}
