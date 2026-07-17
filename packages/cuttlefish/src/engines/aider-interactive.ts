import fs from "node:fs";
import type { IPty } from "node-pty";
import type { InterruptibleEngine, EngineRunOpts, EngineResult } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { CUTTLEFISH_HOME } from "../shared/paths.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { buildAiderEngineEnv } from "./aider-env.js";
import { neutralizeForPaste } from "../shared/skill-commands.js";
import { PtyLifecycleManager, type PtyHandle } from "./pty-lifecycle.js";
import { PtyStreamManager, createPtyHandle, setCapped, spawnPty } from "./pty-stream.js";
import { tailTranscriptLines, type TranscriptTailer } from "./transcript-tailer.js";
import type { PtyControlEvent, PtyIdleSpawnOpts, PtyViewEngine } from "./pty-view-engine.js";
import { aiderHistoryPathFor, ensureAiderHistoryDir, parseAiderHistoryLine } from "./aider-protocol.js";

/**
 * Aider (`aider` CLI) PTY view engine — modeled on CodexInteractiveEngine.
 *
 * Why a second adapter: the headless AiderEngine runs work turns, but aider is a REPL,
 * so the dashboard's live xterm view (and explicit `mode:"interactive"` turns) need a
 * warm PTY we spawn, stream, and inject prompts into via bracketed paste.
 *
 * Turn detection is simpler than codex/antigravity: we assign each session its own
 * `--chat-history-file` (deterministic path), so there is NO transcript-discovery race.
 * We tail that file — aider appends a `#### <prompt>` line then the assistant prose then
 * a `> Tokens: …` usage blockquote — and settle the turn on a quiet window after the
 * assistant text (shorter once the tokens line is seen).
 */

const TURN_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
const TURN_QUIET_MS = 8000;       // assistant text still flowing: wait for more
const TURN_FINAL_QUIET_MS = 1500; // tokens/usage line seen: settle promptly
const TAIL_POLL_MS = 250;

/** Aider auto-detects its model from env API keys; "default"/empty ⇒ omit --model. */
function aiderModelFlag(model: string | undefined): string[] {
  return model && model !== "default" ? ["--model", model] : [];
}

function pasteAndSubmit(proc: IPty, text: string): void {
  const payload = neutralizeForPaste(text);
  proc.write(`\x1b[200~${payload}\x1b[201~\r`);
}

interface ActiveTurn {
  interrupt: (reason: string) => void;
  tailer?: TranscriptTailer;
  doneTimer?: NodeJS.Timeout;
  hardTimeout?: NodeJS.Timeout;
  boundProc?: IPty;
}

interface AiderSpawnParams {
  model?: string;
  cwd?: string;
  bin?: string;
}

export class AiderInteractiveEngine implements InterruptibleEngine, PtyViewEngine {
  name = "aider" as const;
  private active = new Map<string, ActiveTurn>();
  private streams: PtyStreamManager;
  private lastGeom = new Map<string, { cols: number; rows: number }>();
  private spawnParams = new Map<string, AiderSpawnParams>();

  constructor(private lifecycle: PtyLifecycleManager) {
    this.streams = new PtyStreamManager("Aider PTY", (id) => this.lifecycle.getWarm(id) !== undefined);
    this.lifecycle.onRelease((id) => this.spawnParams.delete(id));
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const cuttlefishSessionId = opts.sessionId;
    if (!cuttlefishSessionId) throw new Error("AiderInteractiveEngine.run requires opts.sessionId");
    if (this.active.has(cuttlefishSessionId)) {
      return { sessionId: "", result: "", error: "Aider interactive engine: a turn is already running for this session" };
    }

    let prompt = opts.prompt;
    if (opts.systemPrompt && !opts.resumeSessionId) prompt = `${opts.systemPrompt}\n\n---\n\n${prompt}`;
    if (opts.attachments?.length) prompt += "\n\nAttached files:\n" + opts.attachments.map((a) => `- ${a}`).join("\n");

    const historyPath = ensureAiderHistoryDir(cuttlefishSessionId);
    let latestAnswer = "";
    let settled = false;
    let resolveFn!: (r: EngineResult) => void;
    const promise = new Promise<EngineResult>((res) => { resolveFn = res; });
    const turn: ActiveTurn = { interrupt: () => {} };

    const cleanup = () => {
      if (turn.doneTimer) clearTimeout(turn.doneTimer);
      if (turn.hardTimeout) clearTimeout(turn.hardTimeout);
      turn.tailer?.stop();
      this.active.delete(cuttlefishSessionId);
      this.lifecycle.turnEnded(cuttlefishSessionId);
    };
    const finish = (r: EngineResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveFn(r);
    };
    turn.interrupt = (reason: string) => finish({ sessionId: "", result: latestAnswer, error: reason });

    const scheduleDone = (delayMs: number) => {
      if (!latestAnswer.trim()) return;
      if (turn.doneTimer) clearTimeout(turn.doneTimer);
      turn.doneTimer = setTimeout(
        () => finish({ sessionId: "", result: latestAnswer.trim(), numTurns: 1 }),
        delayMs,
      );
      turn.doneTimer.unref?.();
    };

    const attachTail = () => {
      if (turn.tailer) return;
      let offset = 0;
      try { offset = fs.statSync(historyPath).size; } catch { /* not created yet → 0 */ }
      turn.tailer = tailTranscriptLines(historyPath, offset, (line) => {
        if (settled) return;
        const parsed = parseAiderHistoryLine(line);
        for (const d of parsed.deltas) opts.onStream?.(d);
        if (parsed.userTurn) return; // our own injected prompt echo
        if (parsed.assistantText) {
          latestAnswer += parsed.assistantText;
          scheduleDone(TURN_QUIET_MS);
        }
        if (parsed.tokensLine) scheduleDone(TURN_FINAL_QUIET_MS);
      }, { pollMs: TAIL_POLL_MS, label: "Aider" });
    };

    this.active.set(cuttlefishSessionId, turn);
    turn.hardTimeout = setTimeout(() => {
      finish({ sessionId: "", result: latestAnswer, error: "Aider interactive turn timed out" });
      this.lifecycle.releaseSession(cuttlefishSessionId);
    }, TURN_TIMEOUT_MS);
    turn.hardTimeout.unref?.();

    attachTail();

    let warm = this.lifecycle.getWarm(cuttlefishSessionId);
    if (warm && this.spawnParamsChanged(cuttlefishSessionId, opts)) {
      this.lifecycle.releaseSession(cuttlefishSessionId); // onRelease purges spawnParams
      warm = undefined;
    }
    if (warm) {
      turn.boundProc = (warm as any)._proc as IPty | undefined;
      this.lifecycle.turnStarted(cuttlefishSessionId);
      if (turn.boundProc) pasteAndSubmit(turn.boundProc, prompt);
      else turn.interrupt("Interrupted: aider PTY unavailable");
    } else {
      try {
        const handle = this.spawn(cuttlefishSessionId, opts, prompt);
        turn.boundProc = (handle as any)._proc as IPty | undefined;
        this.lifecycle.adopt(cuttlefishSessionId, handle, { turnRunning: true });
        this.lifecycle.turnStarted(cuttlefishSessionId);
      } catch (err) {
        // Spawn failed before any PTY handle was adopted (binary missing, EACCES,
        // resource exhaustion, ...). Fail just this turn via the normal finish/cleanup
        // path so `this.active` and the hard timeout are cleared and a later run()
        // for this session can retry — never let the throw escape with the session
        // still marked as having a turn in flight.
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`AiderInteractiveEngine spawn failed for ${cuttlefishSessionId}: ${message}`);
        turn.interrupt(`Interrupted: failed to spawn aider process: ${message}`);
      }
    }

    return promise;
  }

  private buildEnv(): Record<string, string> {
    return buildAiderEngineEnv({ TERM: "xterm-256color" });
  }

  private buildArgs(sessionId: string, model?: string): string[] {
    return [
      "--no-pretty",
      "--no-check-update",
      "--yes-always",
      "--no-auto-commits",
      "--chat-history-file",
      aiderHistoryPathFor(sessionId),
      ...aiderModelFlag(model),
    ];
  }

  private spawnParamsChanged(cuttlefishSessionId: string, opts: EngineRunOpts): boolean {
    const prev = this.spawnParams.get(cuttlefishSessionId);
    if (!prev) return false;
    const norm = (v: string | undefined) => (v && v !== "default" ? v : undefined);
    return norm(prev.model) !== norm(opts.model)
      || norm(prev.cwd) !== norm(opts.cwd)
      || norm(prev.bin) !== norm(opts.bin);
  }

  private spawn(cuttlefishSessionId: string, opts: EngineRunOpts, prompt?: string): PtyHandle {
    const bin = resolveBin("aider", opts.bin);
    const args = this.buildArgs(cuttlefishSessionId, opts.model);
    const geom = this.lastGeom.get(cuttlefishSessionId);
    ensureAiderHistoryDir(cuttlefishSessionId);
    logger.info(`AiderInteractiveEngine spawning ${bin} (geom: ${geom ? `${geom.cols}x${geom.rows}` : "default"})`);
    const proc = spawnPty(bin, args, {
      name: "xterm-256color",
      cols: geom?.cols ?? 120,
      rows: geom?.rows ?? 40,
      cwd: opts.cwd || CUTTLEFISH_HOME,
      env: this.buildEnv(),
    });
    this.spawnParams.set(cuttlefishSessionId, { model: opts.model, cwd: opts.cwd, bin: opts.bin });
    // Inject once aider's TUI is ready: wait for first output then a quiet window
    // (the prompt readline), with a hard cap so we never wait forever.
    if (prompt) this.scheduleColdInject(proc, prompt);
    return this.wireProcToStream(cuttlefishSessionId, proc);
  }

  /** Wait for aider's REPL to settle (first output, then ~1.2s quiet) before sending the
   *  prompt; fall back to a hard cap. Prevents dropping the prompt before the readline. */
  private scheduleColdInject(proc: IPty, prompt: string): void {
    const QUIET_MS = 1200;
    const HARD_CAP_MS = 12000;
    const startedAt = Date.now();
    let lastData = Date.now();
    let sawData = false;
    let injected = false;
    const sub = proc.onData(() => { lastData = Date.now(); sawData = true; });
    const timer = setInterval(() => {
      if (injected) return;
      const idleFor = Date.now() - lastData;
      const elapsed = Date.now() - startedAt;
      if ((sawData && idleFor > QUIET_MS) || elapsed > HARD_CAP_MS) {
        injected = true;
        clearInterval(timer);
        try { sub.dispose(); } catch { /* ignore */ }
        pasteAndSubmit(proc, prompt);
      }
    }, 250);
    timer.unref?.();
  }

  private wireProcToStream(cuttlefishSessionId: string, proc: IPty): PtyHandle {
    const handle = createPtyHandle(proc);
    this.streams.attach(cuttlefishSessionId, proc);
    proc.onExit(() => {
      const isCurrent = this.lifecycle.getWarm(cuttlefishSessionId) === handle;
      if (isCurrent) {
        this.streams.onPtyExit(cuttlefishSessionId);
        this.lifecycle.releaseSession(cuttlefishSessionId);
      }
      const e = this.active.get(cuttlefishSessionId);
      if (e && e.boundProc === proc) e.interrupt("Interrupted: aider process exited");
    });
    return handle;
  }

  ensureIdleSpawn(cuttlefishSessionId: string, opts: PtyIdleSpawnOpts): void {
    if (this.active.has(cuttlefishSessionId)) return;
    if (opts.cols && opts.rows) setCapped(this.lastGeom, cuttlefishSessionId, { cols: opts.cols, rows: opts.rows });
    const warm = this.lifecycle.getWarm(cuttlefishSessionId);
    const nextOpts: EngineRunOpts = {
      prompt: "",
      sessionId: cuttlefishSessionId,
      cwd: opts.cwd || CUTTLEFISH_HOME,
      model: opts.model,
      bin: opts.bin,
    };
    if (warm && !this.spawnParamsChanged(cuttlefishSessionId, nextOpts)) return;
    if (warm) this.lifecycle.releaseSession(cuttlefishSessionId);
    const handle = this.spawn(cuttlefishSessionId, nextOpts, undefined);
    this.lifecycle.adopt(cuttlefishSessionId, handle);
  }

  getScrollback(sessionId: string): Buffer {
    return this.streams.getScrollback(sessionId);
  }

  subscribeOutput(sessionId: string, cb: (data: Buffer) => void, onControl?: (event: PtyControlEvent) => void): () => void {
    return this.streams.subscribe(sessionId, cb, onControl);
  }

  writeStdin(sessionId: string, text: string): void {
    const proc = (this.lifecycle.getWarm(sessionId) as any)?._proc as IPty | undefined;
    if (proc) pasteAndSubmit(proc, text);
  }

  writeRaw(sessionId: string, data: string): void {
    const proc = (this.lifecycle.getWarm(sessionId) as any)?._proc as IPty | undefined;
    if (proc) proc.write(data);
  }

  resizePty(sessionId: string, cols: number, rows: number): void {
    setCapped(this.lastGeom, sessionId, { cols, rows });
    const proc = (this.lifecycle.getWarm(sessionId) as any)?._proc as IPty | undefined;
    try { proc?.resize(cols, rows); } catch { /* gone */ }
  }

  setViewing(sessionId: string, viewing: boolean): void {
    if (viewing) this.lifecycle.viewerEnter(sessionId);
    else this.lifecycle.viewerLeave(sessionId);
  }

  hasWarmPty(sessionId: string): boolean {
    return this.lifecycle.getWarm(sessionId) !== undefined;
  }

  isTurnRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  kill(sessionId: string, reason = "Interrupted"): void {
    this.active.get(sessionId)?.interrupt(reason.startsWith("Interrupted") ? reason : `Interrupted: ${reason}`);
    this.lifecycle.releaseSession(sessionId);
  }

  killAll(): void {
    for (const id of [...this.active.keys()]) this.kill(id, "Interrupted: gateway shutting down");
    this.lifecycle.killAll();
  }

  /** Recycle idle warm PTYs only (org-reload). Sessions with an in-flight turn are skipped. */
  killIdle(): void {
    this.lifecycle.releaseIdle((id) => this.active.has(id));
  }

  isAlive(sessionId: string): boolean {
    return this.active.has(sessionId) || this.lifecycle.getWarm(sessionId) !== undefined;
  }
}
