import fs from "node:fs";
import type { IPty } from "node-pty";
import type { InterruptibleEngine, EngineRunOpts, EngineResult } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { CUTTLEFISH_HOME } from "../shared/paths.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { buildEngineEnv } from "../shared/engine-env.js";
import { PtyLifecycleManager, type PtyHandle } from "./pty-lifecycle.js";
import { PtyStreamManager, createPtyHandle, setCapped, spawnPty } from "./pty-stream.js";
import { tailTranscriptLines, type TranscriptTailer } from "./transcript-tailer.js";
import type { PtyControlEvent, PtyViewEngine, PtyIdleSpawnOpts } from "./pty-view-engine.js";
import {
  transcriptPathFor,
  transcriptLineToDeltas,
  isTerminalAnswerLine,
  newToolCardState,
  estimateContextTokens,
  ensureWorkspaceTrusted,
  listConvDirs,
} from "./antigravity-protocol.js";
import { neutralizeForPaste } from "../shared/skill-commands.js";

/**
 * Antigravity (`agy`) engine — PTY-interactive, modeled on InteractiveClaudeEngine.
 *
 * Why interactive-only: `agy` has no working headless/`--print` mode, so every
 * turn is driven through a real PTY (the same instance also backs the dashboard
 * xterm view). `agy` has no hook system either, so unlike the Claude engine we
 * detect turn boundaries by tailing agy's own per-conversation transcript:
 *   ~/.gemini/antigravity-cli/brain/<convId>/.system_generated/logs/transcript.jsonl
 * A turn completes after a MODEL/PLANNER_RESPONSE/status:DONE line and a short
 * quiet window with no more transcript activity. agy can continue tool work
 * after the first DONE-looking block, so "first DONE wins" is too early.
 *
 * Auth: `agy` reuses its cached Google credential (Keychain + on-disk token) on
 * a headless spawn — no re-auth prompt. Workspace trust is pre-seeded before
 * spawn so the interactive "trust this folder?" gate never blocks us.
 */

export const ANTIGRAVITY_DEFAULT_MODEL = "Gemini 3.5 Flash (Medium)";
const TURN_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
const TURN_FINAL_QUIET_MS = 1200;      // terminal text/no-tool row: finish promptly
const TURN_QUIET_DONE_MS = 6000;       // fallback: wait longer around tool/ambiguous rows
const TAIL_POLL_MS = 200;
const CONV_DISCOVER_TIMEOUT_MS = 30 * 1000;
const CONV_POLL_MS = 150;
/** Accepted by agy without a startup error (verified); harmless in chat mode,
 *  bypasses approvals in agent mode. */
const SKIP_PERMISSIONS_FLAG = "--dangerously-skip-permissions";

/** Bracketed-paste `text` into the agy PTY and submit. The paste markers and the
 *  submit CR MUST go in a single write — empirically, sending the CR as a separate
 *  delayed write through node-pty is dropped and agy never submits the turn.
 *  neutralizeForPaste() prepends a space for mentions, bash-mode, and cuttlefish-skill
 *  slash commands, while letting engine-native /commands pass through raw.
 *  Shared by injectPromptToProc() and writeStdin(). */
function pasteAndSubmit(proc: IPty, text: string): void {
  const payload = neutralizeForPaste(text);
  proc.write(`\x1b[200~${payload}\x1b[201~\r`);
}

interface ActiveTurn {
  interrupt: (reason: string) => void;
  tailer?: TranscriptTailer;
  convWatch?: { stop: () => void };
  doneTimer?: NodeJS.Timeout;
  hardTimeout?: NodeJS.Timeout;
  /** The PTY serving this turn. A stale PTY's onExit (after a kill->respawn race)
   *  must NOT interrupt the active turn unless it owns this exact proc. */
  boundProc?: IPty;
}

interface AntigravitySpawnParams {
  resumeSessionId?: string;
  cwd?: string;
  model?: string;
  bin?: string;
}

interface AntigravitySpawnParams {
  resumeSessionId?: string;
  cwd?: string;
  model?: string;
  bin?: string;
}

export class AntigravityEngine implements InterruptibleEngine, PtyViewEngine {
  name = "antigravity" as const;
  private active = new Map<string, ActiveTurn>();
  private streams: PtyStreamManager;
  private lastGeom = new Map<string, { cols: number; rows: number }>();
  private spawnParams = new Map<string, AntigravitySpawnParams>();

  constructor(private lifecycle: PtyLifecycleManager) {
    this.streams = new PtyStreamManager("Antigravity PTY", (id) => this.lifecycle.getWarm(id) !== undefined);
    this.lifecycle.onRelease((id) => this.spawnParams.delete(id));
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const cuttlefishSessionId = opts.sessionId;
    if (cuttlefishSessionId) {
      if (opts.onActivity) this.onActivityCbs.set(cuttlefishSessionId, opts.onActivity);
      else this.onActivityCbs.delete(cuttlefishSessionId);
    }
    if (!cuttlefishSessionId) throw new Error("AntigravityEngine.run requires opts.sessionId");
    if (this.active.has(cuttlefishSessionId)) {
      return { sessionId: opts.resumeSessionId ?? "", result: "", error: "Antigravity engine: a turn is already running for this session" };
    }

    // Use the realpath as cwd: agy records workspace trust by realpath, and on
    // macOS /tmp→/private/tmp, so spawning with the raw path while trusting the
    // realpath leaves agy stuck on the trust prompt (swallowing our input).
    const cwd = this.prepareCwd(opts.cwd);

    let convId = opts.resumeSessionId; // known iff resuming an existing conversation
    let latestAnswer: string | undefined;
    let lastContextEstimate = 0; // est. context tokens (chars/4 of the running transcript)
    let settled = false;

    let resolveFn!: (r: EngineResult) => void;
    const promise = new Promise<EngineResult>((res) => { resolveFn = res; });

    const turn: ActiveTurn = { interrupt: () => { /* set below */ } };

    const cleanup = () => {
      if (turn.doneTimer) clearTimeout(turn.doneTimer);
      if (turn.hardTimeout) clearTimeout(turn.hardTimeout);
      turn.tailer?.stop();
      turn.convWatch?.stop();
      this.active.delete(cuttlefishSessionId);
      this.lifecycle.turnEnded(cuttlefishSessionId); // lifecycle decides keep-warm vs reap
    };
    const finish = (r: EngineResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveFn(r);
    };
    turn.interrupt = (reason: string) =>
      finish({ sessionId: convId ?? opts.resumeSessionId ?? "", result: "", error: reason });

    const scheduleDone = (delayMs = TURN_QUIET_DONE_MS) => {
      if (!latestAnswer) return;
      if (turn.doneTimer) clearTimeout(turn.doneTimer);
      turn.doneTimer = setTimeout(
        () => finish({ sessionId: convId ?? "", result: latestAnswer ?? "", numTurns: 1, contextTokens: lastContextEstimate || undefined }),
        delayMs,
      );
      turn.doneTimer.unref?.();
    };

    const onDone = (content: string, delayMs: number) => {
      latestAnswer = content;
      // agy exposes NO token usage anywhere in its transcript, so an exact context
      // meter isn't possible. Emit an ESTIMATE from the running conversation size
      // (chars/4) so the chat pane gets an approximate "how full" gauge; the model's
      // 1M window makes small inaccuracy immaterial as a percentage.
      if (convId) {
        const est = estimateContextTokens(convId);
        if (est > 0) {
          lastContextEstimate = est;
          opts.onStream?.({ type: "context", content: String(est) });
        }
      }
      scheduleDone(delayMs);
    };

    // Tail the conversation transcript, emitting StreamDeltas for appended lines and
    // invoking onDone(content) for each new MODEL/PLANNER_RESPONSE/DONE. Starting at
    // the file's current EOF means a resumed conversation's history is NOT replayed
    // as fresh deltas.
    const attachTail = (cid: string, fromBeginning = false) => {
      if (turn.tailer) return;
      this.updateSpawnResumeSessionId(cuttlefishSessionId, cid);
      const tp = transcriptPathFor(cid);
      let startOffset = 0;
      if (!fromBeginning) {
        try { startOffset = fs.statSync(tp).size; } catch { /* not created yet → 0 */ }
      }
      // One tool-card state per tail so DONE-only tool rows synthesize their card
      // (and RUNNING/planner-opened cards close without duplicating).
      const toolState = newToolCardState();
      turn.tailer = tailTranscriptLines(tp, startOffset, (line) => {
        const deltas = transcriptLineToDeltas(line, toolState);
        if (deltas.length) scheduleDone(); // transcript activity — push the quiet window out
        for (const d of deltas) opts.onStream?.(d);
        const terminal = isTerminalAnswerLine(line);
        if (terminal.terminal && terminal.content) onDone(terminal.content, TURN_FINAL_QUIET_MS);
      }, { pollMs: TAIL_POLL_MS, label: "antigravity" });
    };

    this.active.set(cuttlefishSessionId, turn);

    turn.hardTimeout = setTimeout(
      () => {
        finish({
          sessionId: convId ?? opts.resumeSessionId ?? "",
          result: latestAnswer ?? "",
          error: "Antigravity turn timed out",
          contextTokens: lastContextEstimate || undefined,
        });
        this.lifecycle.releaseSession(cuttlefishSessionId);
      },
      TURN_TIMEOUT_MS,
    );
    turn.hardTimeout.unref?.();

    if (convId) {
      attachTail(convId);
    } else {
      // Fresh conversation: agy mints a new brain/<convId> dir after the first
      // prompt. Discover it by diffing the brain dir, then tail its transcript.
      const before = listConvDirs();
      const startedAt = Date.now();
      const interval = setInterval(() => {
        if (settled) { clearInterval(interval); return; }
        const fresh = [...listConvDirs()].filter((d) => !before.has(d));
        if (fresh.length === 1) {
          clearInterval(interval);
          convId = fresh[0];
          logger.info(`AntigravityEngine discovered conversation ${convId} for session ${cuttlefishSessionId}`);
          attachTail(convId, true);
        } else if (fresh.length > 1) {
          logger.warn(`AntigravityEngine: ambiguous fresh conversations for ${cuttlefishSessionId}; waiting for a unique candidate`);
          if (Date.now() - startedAt > CONV_DISCOVER_TIMEOUT_MS) {
            clearInterval(interval);
            finish({ sessionId: "", result: "", error: "Antigravity: multiple fresh conversations appeared; refusing ambiguous attach" });
            this.lifecycle.releaseSession(cuttlefishSessionId);
          }
        } else if (Date.now() - startedAt > CONV_DISCOVER_TIMEOUT_MS) {
          clearInterval(interval);
          finish({ sessionId: "", result: "", error: "Antigravity: no conversation transcript appeared" });
          this.lifecycle.releaseSession(cuttlefishSessionId);
        }
      }, CONV_POLL_MS);
      interval.unref?.();
      turn.convWatch = { stop: () => clearInterval(interval) };
    }

    // Spawn (cold) or inject (warm). Independent of conv-id discovery above.
    let warm = this.lifecycle.getWarm(cuttlefishSessionId);
    if (warm && this.spawnParamsChanged(cuttlefishSessionId, {
      resumeSessionId: convId,
      cwd,
      model: opts.model,
      bin: opts.bin,
    })) {
      this.lifecycle.releaseSession(cuttlefishSessionId);
      warm = undefined;
    }
    if (warm) {
      turn.boundProc = (warm as any)._proc as IPty | undefined;
      this.lifecycle.turnStarted(cuttlefishSessionId);
      this.injectPrompt(warm, opts);
    } else {
      const handle = this.spawn(cuttlefishSessionId, opts, cwd, convId);
      turn.boundProc = (handle as any)._proc as IPty | undefined;
      this.lifecycle.adopt(cuttlefishSessionId, handle, { turnRunning: true });
      this.lifecycle.turnStarted(cuttlefishSessionId);
    }

    return promise;
  }

  /** env for the agy PTY: force a real TERM and strip common host secrets.
   *  Do NOT strip GEMINI_*; agy uses cached Gemini auth outside this env. */
  private buildPtyEnv(): Record<string, string> {
    return buildEngineEnv({ TERM: "xterm-256color" });
  }

  private buildArgs(resumeConvId: string | undefined, model?: string): string[] {
    const args: string[] = [];
    if (resumeConvId) args.push("--conversation", resumeConvId);
    if (model) args.push("--model", model);
    args.push(SKIP_PERMISSIONS_FLAG);
    return args;
  }

  private prepareCwd(cwd: string | undefined): string {
    let resolved = cwd || CUTTLEFISH_HOME;
    try { resolved = fs.realpathSync(resolved); } catch { /* dir may not exist — use as-is */ }
    ensureWorkspaceTrusted(resolved);
    return resolved;
  }

  private spawnParamsChanged(cuttlefishSessionId: string, next: AntigravitySpawnParams): boolean {
    const prev = this.spawnParams.get(cuttlefishSessionId);
    if (!prev) return false;
    const norm = (v: string | undefined) => v || undefined;
    return norm(prev.resumeSessionId) !== norm(next.resumeSessionId)
      || norm(prev.cwd) !== norm(next.cwd)
      || norm(prev.model) !== norm(next.model)
      || norm(prev.bin) !== norm(next.bin);
  }

  private updateSpawnResumeSessionId(cuttlefishSessionId: string, resumeSessionId: string): void {
    const prev = this.spawnParams.get(cuttlefishSessionId);
    if (prev && !prev.resumeSessionId) this.spawnParams.set(cuttlefishSessionId, { ...prev, resumeSessionId });
  }

  private spawn(cuttlefishSessionId: string, opts: EngineRunOpts, cwd: string, resumeConvId: string | undefined): PtyHandle {
    const bin = resolveBin("agy", opts.bin);
    const args = this.buildArgs(resumeConvId, opts.model);
    const geom = this.lastGeom.get(cuttlefishSessionId);
    logger.info(`AntigravityEngine spawning ${bin} (resume: ${resumeConvId || "none"}, geom: ${geom ? `${geom.cols}×${geom.rows}` : "default"})`);
    const proc = spawnPty(bin, args, {
      name: "xterm-256color",
      cols: geom?.cols ?? 120,
      rows: geom?.rows ?? 40,
      cwd,
      env: this.buildPtyEnv(),
    });
    this.spawnParams.set(cuttlefishSessionId, {
      resumeSessionId: resumeConvId,
      cwd,
      model: opts.model,
      bin: opts.bin,
    });
    // Inject once the TUI is ready. A fixed delay is unreliable — agy needs a
    // few seconds to render and start accepting input. Gate on output quiescence:
    // inject after the PTY has emitted something and then gone quiet (TUI settled),
    // with a hard cap so we never wait forever.
    this.scheduleColdInject(proc, opts);
    return this.wireProcToStream(cuttlefishSessionId, proc, () => {
      this.active.get(cuttlefishSessionId)?.interrupt("Interrupted: agy process exited");
    });
  }

  /** Wait for agy's TUI to settle (first output, then ~1.2s quiet) before sending
   *  the prompt; fall back to a hard cap. Prevents dropping the prompt into a
   *  not-yet-ready terminal (the cause of "no conversation transcript appeared"). */
  private scheduleColdInject(proc: IPty, opts: EngineRunOpts): void {
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
        this.injectPromptToProc(proc, opts);
      }
    }, 250);
    timer.unref?.();
  }

  private injectPromptToProc(proc: IPty, opts: EngineRunOpts): void {
    let text = opts.prompt;
    // Inject the system prompt only on the FIRST turn of a conversation. agy
    // persists the conversation (resume via --conversation retains it), so on a
    // resume / warm follow-up re-sending it just re-logs the whole Cuttlefish system
    // prompt as a fresh USER_INPUT step every turn (context bloat).
    if (opts.systemPrompt && !opts.resumeSessionId) text = `${opts.systemPrompt}\n\n---\n\n${text}`;
    if (opts.attachments?.length) {
      text += "\n\nAttached files:\n" + opts.attachments.map((a) => `- ${a}`).join("\n");
    }
    pasteAndSubmit(proc, text);
  }

  private injectPrompt(handle: PtyHandle, opts: EngineRunOpts): void {
    const proc = (handle as any)._proc as IPty | undefined;
    if (proc) this.injectPromptToProc(proc, opts);
  }

  // --- PTY stream plumbing (shared PtyStreamManager, mirrors InteractiveClaudeEngine) ---

  /** Per-session stall-watchdog liveness callback (opts.onActivity), looked up
   *  dynamically from the PTY onData closure so a warm-reused PTY calls the CURRENT
   *  turn's callback. Any raw output = proof-of-life. */
  private onActivityCbs = new Map<string, () => void>();

  private wireProcToStream(cuttlefishSessionId: string, proc: IPty, onExitExtra?: () => void): PtyHandle {
    const handle = createPtyHandle(proc);
    this.streams.attach(cuttlefishSessionId, proc, () => this.onActivityCbs.get(cuttlefishSessionId)?.());
    proc.onExit(() => {
      // Identity-gate session cleanup. In a kill->respawn race the lifecycle/stream
      // entries already point at the NEW PTY by the time THIS (old, killed) PTY's exit
      // fires; releaseSession is keyed by sessionId, so an unguarded call would kill the
      // freshly-adopted PTY. Only clean up if this PTY is still the session's warm handle.
      const isCurrent = this.lifecycle.getWarm(cuttlefishSessionId) === handle;
      if (isCurrent) {
        this.streams.onPtyExit(cuttlefishSessionId);
        this.lifecycle.releaseSession(cuttlefishSessionId);
        this.onActivityCbs.delete(cuttlefishSessionId);
      }
      // Settle the active turn as interrupted ONLY if this dying proc is the one bound
      // to it — after a kill->respawn race the active entry holds the NEW turn's proc and
      // this old proc must not poison it.
      const e = this.active.get(cuttlefishSessionId);
      if (e && e.boundProc === proc) onExitExtra?.();
    });
    return handle;
  }

  /** Spawn an idle PTY for the xterm view (before the user sends a message).
   *  Resumes `engineSessionId` if given, else a fresh agy TUI. */
  ensureIdleSpawn(cuttlefishSessionId: string, opts: PtyIdleSpawnOpts): void {
    if (this.active.has(cuttlefishSessionId)) return; // a turn is starting — let run() spawn
    const cwd = this.prepareCwd(opts.cwd);
    const warm = this.lifecycle.getWarm(cuttlefishSessionId);
    if (warm && !this.spawnParamsChanged(cuttlefishSessionId, {
      resumeSessionId: opts.engineSessionId,
      cwd,
      model: opts.model,
      bin: opts.bin,
    })) return;
    if (warm) this.lifecycle.releaseSession(cuttlefishSessionId);
    const bin = resolveBin("agy", opts.bin);
    const args = this.buildArgs(opts.engineSessionId, opts.model);
    const cols = opts.cols ?? this.lastGeom.get(cuttlefishSessionId)?.cols ?? 120;
    const rows = opts.rows ?? this.lastGeom.get(cuttlefishSessionId)?.rows ?? 40;
    if (opts.cols && opts.rows) setCapped(this.lastGeom, cuttlefishSessionId, { cols: opts.cols, rows: opts.rows });
    logger.info(`AntigravityEngine ensureIdleSpawn for session ${cuttlefishSessionId} (resume ${opts.engineSessionId || "none — fresh"}, geom ${cols}×${rows})`);
    const proc = spawnPty(bin, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: this.buildPtyEnv(),
    });
    this.spawnParams.set(cuttlefishSessionId, {
      resumeSessionId: opts.engineSessionId,
      cwd,
      model: opts.model,
      bin: opts.bin,
    });
    const handle = this.wireProcToStream(cuttlefishSessionId, proc);
    this.lifecycle.adopt(cuttlefishSessionId, handle);
  }

  getScrollback(sessionId: string): Buffer {
    return this.streams.getScrollback(sessionId);
  }

  subscribeOutput(
    sessionId: string,
    cb: (data: Buffer) => void,
    onControl?: (event: PtyControlEvent) => void,
  ): () => void {
    return this.streams.subscribe(sessionId, cb, onControl);
  }

  writeStdin(sessionId: string, text: string): void {
    const handle = this.lifecycle.getWarm(sessionId);
    const proc = handle ? ((handle as any)._proc as IPty | undefined) : undefined;
    if (!proc) return;
    pasteAndSubmit(proc, text);
  }

  writeRaw(sessionId: string, data: string): void {
    const proc = (this.lifecycle.getWarm(sessionId) as any)?._proc as IPty | undefined;
    if (proc) proc.write(data);
  }

  resizePty(sessionId: string, cols: number, rows: number): void {
    setCapped(this.lastGeom, sessionId, { cols, rows });
    const handle = this.lifecycle.getWarm(sessionId);
    const proc = handle ? ((handle as any)._proc as IPty | undefined) : undefined;
    if (!proc) return;
    try { proc.resize(cols, rows); } catch { /* gone */ }
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

  // --- InterruptibleEngine ---

  kill(sessionId: string, reason = "Interrupted"): void {
    this.active.get(sessionId)?.interrupt(reason.startsWith("Interrupted") ? reason : `Interrupted: ${reason}`);
    this.lifecycle.releaseSession(sessionId);
  }

  killAll(): void {
    for (const id of [...this.active.keys()]) this.kill(id, "Interrupted: gateway shutting down");
    this.lifecycle.killAll();
  }

  /** Recycle idle warm PTYs only (org-reload). Sessions with an in-flight turn
   *  (`this.active`) are skipped so the active turn is never interrupted. */
  killIdle(): void {
    this.lifecycle.releaseIdle((id) => this.active.has(id));
  }

  isAlive(sessionId: string): boolean {
    return this.active.has(sessionId) || this.lifecycle.getWarm(sessionId) !== undefined;
  }
}
