import fs from "node:fs";
import type { IPty } from "node-pty";
import type { InterruptibleEngine, EngineRunOpts, EngineResult, StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { CUTTLEFISH_HOME, CLAUDE_SETTINGS_DIR, HOOK_RELAY_SCRIPT, CLAUDE_LIMITS_DIR } from "../shared/paths.js";
import { cleanupSessionSettings, writeSessionSettings } from "../shared/claude-settings.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { PtyLifecycleManager, type PtyHandle } from "./pty-lifecycle.js";
import { PtyStreamManager, createPtyHandle, setCapped, spawnPty } from "./pty-stream.js";
import type { PtyControlEvent, PtyViewEngine, PtyIdleSpawnOpts } from "./pty-view-engine.js";
import type { HookRegistry } from "../gateway/hook-registry.js";
import { SsePtyProxy, MAIN_AGENT_SENTINEL, type SseDataEvent, type UpstreamActivityInfo } from "./sse-pty-proxy.js";
import { findTranscriptForSession } from "./claude-transcript.js";
import { buildInteractiveArgs, isNativeClaudeCommand, pasteAndSubmit } from "./claude-interactive-args.js";
import {
  computeInteractiveTurnStatsSinceAnchor,
  lastAssistantTextFromTranscript,
  stripReasoningBlocks,
  type InteractiveCumulativeStats,
} from "./claude-interactive-transcript.js";
import { claudeHookToDeltas, rateLimitFromStopFailure, sseEventToDeltas } from "./claude-interactive-stream.js";
import { TurnResolver } from "./claude-turn-resolver.js";
import { ClaudeBackgroundActivity } from "./claude-background-activity.js";
import { ClaudeLateRecovery } from "./claude-late-recovery.js";
import { buildClaudePtyEnv, injectPrompt } from "./claude-pty-helpers.js";

export { findTranscriptForSession } from "./claude-transcript.js";
export { buildInteractiveArgs, isNativeClaudeCommand, pasteAndSubmit } from "./claude-interactive-args.js";
export { lastAssistantTextFromTranscript, stripReasoningBlocks } from "./claude-interactive-transcript.js";
export { claudeHookToDeltas, sseEventToDeltas } from "./claude-interactive-stream.js";
export { TurnResolver, type TurnResolverOpts } from "./claude-turn-resolver.js";

export type { PtyControlEvent } from "./pty-view-engine.js";

const NATIVE_COMMAND_QUIET_MS = 1800;
const NATIVE_COMMAND_MIN_MS = 3000;
const NATIVE_COMMAND_MAX_MS = 90_000;
const LOST_STOP_RECOVERY_QUIET_MS = 60_000;
const LOST_STOP_RECOVERY_MIN_MS = 5 * 60_000;

export class InteractiveClaudeEngine implements InterruptibleEngine, PtyViewEngine {
  name = "claude" as const;
  /** Active turn resolvers keyed by Cuttlefish session id. `boundProc` is the specific
   *  PTY serving this turn (captured at spawn / warm-reuse). A PTY's onExit only
   *  interrupts the active resolver when it IS that bound proc — so a stale PTY
   *  released by a kill->respawn race can't poison the freshly-started turn.
   *  `onStream` is the current turn's delta callback; the per-PTY SSE proxy routes
   *  parsed events here (a PTY outlives its turn, so the proxy looks this up live). */
  private active = new Map<string, { resolver: TurnResolver; onStream?: (d: StreamDelta) => void; boundProc?: IPty }>();
  /** Sessions with an in-flight async idle-spawn (proxy.start awaited) — prevents
   *  a second ensureIdleSpawn from racing in a duplicate PTY during that gap. */
  private idleSpawning = new Set<string>();
  /** Per-session PTY output streams (scrollback ring buffer + live subscribers).
   *  Survives PTY respawn. */
  private streams: PtyStreamManager;
  /** Last terminal geometry reported by the client per session. Used to spawn
   *  follow-up PTYs at the correct dimensions when a turn comes in after the
   *  warm PTY was reaped — otherwise spawn() falls back to 120×40 and the TUI
   *  text body is locked in at the wrong width. Intentionally survives PTY
   *  release (its job is to size the NEXT spawn); growth is bounded by setCapped. */
  private lastGeom = new Map<string, { cols: number; rows: number }>();
  private lastOutputAt = new Map<string, number>();
  /** Cumulative cost/turns observed at the end of the previous turn, per
   *  session — the transcript's totals are cumulative for the whole PTY
   *  session (see computeInteractiveTurnStatsSinceAnchor), so this anchor is
   *  subtracted out each turn to report just that turn's delta. Keyed by the
   *  transcript path it was captured against so a resumed/new session's
   *  transcript never gets diffed against a stale anchor from a different
   *  transcript. Survives PTY release like lastGeom (meaningful across
   *  respawns within the same session); growth bounded by setCapped. */
  private turnStatsAnchor = new Map<string, InteractiveCumulativeStats & { transcriptPath: string }>();
  /** Per-session stall-watchdog liveness callback (opts.onActivity). Looked up
   *  dynamically from the PTY onData closure so a warm-reused PTY (wired once)
   *  always calls the CURRENT turn's callback. Any raw output = proof-of-life. */
  private onActivityCbs = new Map<string, () => void>();
  /** Model/effort the live PTY was spawned with, per session. `--model`/`--effort`
   *  apply only at spawn, so a mid-chat switch must cold-respawn rather than reuse
   *  the warm PTY (which would keep running the old model). */
  private spawnParams = new Map<string, { model?: string; effortLevel?: string; appendApplied?: boolean }>();
  private lateRecovery: ClaudeLateRecovery;
  private background = new ClaudeBackgroundActivity((id) => this.active.has(id));

  /** Test override for the post-settle clear quiet window (default 10s). */
  get backgroundClearQuietMs(): number {
    return this.background.quietMs;
  }
  set backgroundClearQuietMs(ms: number) {
    this.background.quietMs = ms;
  }

  constructor(
    private lifecycle: PtyLifecycleManager,
    private hookRegistry: HookRegistry,
  ) {
    this.streams = new PtyStreamManager("PTY", (id) => this.lifecycle.getWarm(id) !== undefined);
    this.lateRecovery = new ClaudeLateRecovery(this.hookRegistry);
    // Purge per-PTY bookkeeping whenever the session's PTY is released (kill,
    // LRU eviction, sweep reap, cold respawn) so these maps don't grow forever
    // in a long-running daemon. Both are meaningful only while a PTY is live and
    // are repopulated on the next spawn. lastGeom is NOT purged here — see above.
    this.lifecycle.onRelease((id) => {
      this.lastOutputAt.delete(id);
      this.onActivityCbs.delete(id);
      this.spawnParams.delete(id);
      // The PTY (and its SSE proxy) died — any in-flight counts are moot.
      this.clearBackground(id);
    });
  }

  onBackgroundActivity(cb: (cuttlefishSessionId: string, info: UpstreamActivityInfo | null) => void): void {
    this.background.onBackgroundActivity(cb);
  }
  private handleUpstreamActivity(cuttlefishSessionId: string, info: UpstreamActivityInfo): void { this.background.handleUpstreamActivity(cuttlefishSessionId, info); }
  private maybeEmitBackground(cuttlefishSessionId: string): void { this.background.maybeEmit(cuttlefishSessionId); }
  private suppressBackground(cuttlefishSessionId: string): void { this.background.suppress(cuttlefishSessionId); }
  private clearBackground(cuttlefishSessionId: string): void { this.background.clear(cuttlefishSessionId); }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const cuttlefishSessionId = opts.sessionId;
    if (cuttlefishSessionId) {
      if (opts.onActivity) this.onActivityCbs.set(cuttlefishSessionId, opts.onActivity);
      else this.onActivityCbs.delete(cuttlefishSessionId);
    }
    if (!cuttlefishSessionId) throw new Error("InteractiveClaudeEngine.run requires opts.sessionId");
    const turnStartedAt = Date.now();

    // Guard: refuse a second concurrent turn for the same session.
    if (this.active.has(cuttlefishSessionId)) {
      return { sessionId: opts.resumeSessionId ?? "", result: "", error: "Interactive engine: a turn is already running for this session" };
    }

    // A previous turn may have left a late-recovery listener armed; this new
    // turn owns the session (and the hook registration) now.
    this.cancelLateRecovery(cuttlefishSessionId);
    // Retract any reported post-settle background activity — the session is
    // about to be "running", which supersedes the background indicator.
    this.suppressBackground(cuttlefishSessionId);

    let warm = this.lifecycle.getWarm(cuttlefishSessionId);
    // Mid-chat model/effort switch: `--model`/`--effort` bind at spawn, so a warm
    // PTY would silently keep the OLD model. If the request differs from what this
    // PTY was spawned with, drop the warm PTY and cold-respawn (--resume keeps the
    // conversation) so the new model/effort actually takes effect.
    if (warm) {
      const prev = this.spawnParams.get(cuttlefishSessionId);
      const norm = (v?: string) => (!v || v === "default" ? "" : v);
      const modelOrEffortChanged =
        !!prev && (norm(opts.model) !== norm(prev.model) || norm(opts.effortLevel) !== norm(prev.effortLevel));
      // Idle-spawned PTYs (terminal view) are born WITHOUT --append-system-prompt, so
      // they carry neither the persona/org context nor the main-agent sentinel. Force a
      // cold respawn on the first real turn so it runs on-persona AND streams to the
      // chat pane (the sentinel is what makes the SSE proxy tee). --resume preserves
      // the conversation.
      const missingPrompt = !prev || prev.appendApplied !== true;
      if (modelOrEffortChanged || missingPrompt) {
        logger.info(`InteractiveClaudeEngine: cold respawn for ${cuttlefishSessionId} (${modelOrEffortChanged ? "model/effort changed" : "warm PTY missing --append-system-prompt"})`);
        this.lifecycle.releaseSession(cuttlefishSessionId);
        warm = undefined;
      }
    }

    // Write the per-turn --settings file AFTER any cold-respawn release above:
    // releaseSession() fires onCleanup → cleanupSessionSettings(), which DELETES this
    // exact file. Writing it earlier meant the model/effort cold-respawn spawned
    // `claude --settings <file>` against a file we'd just unlinked → the CLI/xterm
    // view showed "Settings file not found". The settings file carries HOOKS only; the
    // system prompt + main-agent sentinel go via the --append-system-prompt CLI flag at
    // spawn() (the settings-file appendSystemPrompt KEY is ignored by claude ≥2.1.x).
    const settingsPath = writeSessionSettings(CLAUDE_SETTINGS_DIR, cuttlefishSessionId, {
      sessionId: cuttlefishSessionId,
      relayScript: HOOK_RELAY_SCRIPT,
      statusLineDir: CLAUDE_LIMITS_DIR,
    });
    const nativeCommand = isNativeClaudeCommand(opts.prompt);
    const resolver = new TurnResolver({
      fallbackSessionId: opts.resumeSessionId,
      assumeStarted: !!warm, // warm PTY = SessionStart already fired (turn 1 or idle spawn)
      native: nativeCommand,
      shouldDeferStopFailure: () => this.background.hasActive(cuttlefishSessionId),
    });
    const entry: { resolver: TurnResolver; onStream?: (d: StreamDelta) => void; boundProc?: IPty; activeTools: number } = {
      resolver,
      onStream: opts.onStream,
      activeTools: 0,
    };
    let turnMarkedStarted = false;
    let watchdog: NodeJS.Timeout | undefined;
    let nativeCommandTimer: NodeJS.Timeout | undefined;
    let lostStopRecoveryTimer: NodeJS.Timeout | undefined;

    let result!: EngineResult;
    this.active.set(cuttlefishSessionId, entry);
    try {
      // Register BEFORE spawning so a fast SessionStart is buffered+drained, not lost.
      this.hookRegistry.register(cuttlefishSessionId, (h) => {
        resolver.onHook(h);
        // tool_use markers + intermediate text stream from the per-PTY SSE proxy
        // in true order. The hook only supplies tool_result; SSE has no local tool
        // completion event because tools execute between assistant messages.
        if (h.hook_event_name === "PreToolUse") {
          entry.activeTools += 1;
        }
        if (h.hook_event_name === "PostToolUse") {
          entry.activeTools = Math.max(0, entry.activeTools - 1);
          for (const delta of claudeHookToDeltas(h as Record<string, unknown>)) opts.onStream?.(delta);
        }
      });

      if (warm) {
        // Mark the turn started BEFORE injecting so the sweep timer can't
        // theoretically release the PTY mid-paste if its grace window expired
        // between getWarm() above and the proc.write() inside injectPrompt.
        this.lifecycle.turnStarted(cuttlefishSessionId);
        turnMarkedStarted = true;
        injectPrompt(warm, opts);
        entry.boundProc = (warm as any)._proc as IPty | undefined;
      } else {
        const handle = await this.spawn(cuttlefishSessionId, opts, settingsPath);
        this.lifecycle.adopt(cuttlefishSessionId, handle, { turnRunning: true });
        this.lifecycle.turnStarted(cuttlefishSessionId);
        turnMarkedStarted = true;
        entry.boundProc = (handle as any)._proc as IPty | undefined;
      }

      // Watchdog: if the bound PTY dies without the resolver settling (e.g. the
      // onExit identity-guard didn't match in a kill→respawn race), the turn would
      // hang forever — runWebSession's 5s heartbeat would zombie status:"running"
      // and the completion (session:completed + notifyParentSession parent callback)
      // would never fire. Both the stuck "in progress" badge and lost child-session
      // callbacks trace to this. Force-settle once the proc is provably dead so
      // run() always resolves and the normal completion path runs.
      watchdog = setInterval(() => {
        const p = entry.boundProc as { _exitCode?: number | null } | undefined;
        if (p && p._exitCode != null) {
          resolver.interrupt("Interrupted: claude process exited");
        }
      }, 5000);
      watchdog.unref?.();

      if (nativeCommand) {
        const startedAt = Date.now();
        nativeCommandTimer = setInterval(() => {
          const now = Date.now();
          const quietFor = now - (this.lastOutputAt.get(cuttlefishSessionId) ?? startedAt);
          const elapsed = now - startedAt;
          if ((elapsed >= NATIVE_COMMAND_MIN_MS && quietFor >= NATIVE_COMMAND_QUIET_MS) || elapsed >= NATIVE_COMMAND_MAX_MS) {
            resolver.completeNativeCommand();
          }
        }, 500);
        nativeCommandTimer.unref?.();
      }

      if (!nativeCommand) {
        const startedAt = Date.now();
        lostStopRecoveryTimer = setInterval(() => {
          if (resolver.isSettled) return;
          // A StopFailure is held in the grace window — the turn's fate is the
          // grace timer's call (Stop supersedes / expiry fails). Recovering
          // intermediate transcript text here would fabricate a wrong success.
          if (resolver.stopFailure) return;
          // Missing-Stop recovery is only safe when the model stream and local
          // tool hooks are quiet; otherwise a long-running turn can be mistaken
          // for a completed one just because transcript text exists.
          if (entry.activeTools > 0 || this.background.hasActive(cuttlefishSessionId)) return;
          const now = Date.now();
          const elapsed = now - startedAt;
          const quietFor = now - (this.lastOutputAt.get(cuttlefishSessionId) ?? startedAt);
          if (elapsed < LOST_STOP_RECOVERY_MIN_MS || quietFor < LOST_STOP_RECOVERY_QUIET_MS) return;
          const sid = resolver.sessionId ?? opts.resumeSessionId;
          const transcript = sid ? findTranscriptForSession(sid) : undefined;
          if (!transcript) return;
          try {
            if (fs.statSync(transcript).mtimeMs < startedAt - 1000) return;
          } catch {
            return;
          }
          const recovered = lastAssistantTextFromTranscript(transcript, startedAt);
          if (recovered?.trim()) {
            logger.warn(`InteractiveClaudeEngine: recovered completed turn for ${cuttlefishSessionId} after missing Stop hook`);
            resolver.completeRecovered(recovered, sid);
          }
        }, 2000);
        lostStopRecoveryTimer.unref?.();
      }

      result = await resolver.promise;
    } finally {
      if (watchdog) clearInterval(watchdog);
      if (nativeCommandTimer) clearInterval(nativeCommandTimer);
      if (lostStopRecoveryTimer) clearInterval(lostStopRecoveryTimer);
      this.hookRegistry.unregister(cuttlefishSessionId);
      this.active.delete(cuttlefishSessionId);
      if (turnMarkedStarted) this.lifecycle.turnEnded(cuttlefishSessionId); // manager decides kill vs keep-warm
      else cleanupSessionSettings(CLAUDE_SETTINGS_DIR, cuttlefishSessionId);
      // Turn settled — if the CLI still has upstream requests in flight
      // (background subagents/tasks), report them now; emission was suppressed
      // while this run owned the session.
      this.maybeEmitBackground(cuttlefishSessionId);
    }

    // Reconstruct cost from the transcript (the Stop hook carries no cost).
    // Context-meter: most recent turn's input context (input + cache), mirroring
    // headless claude.ts so interactive/CLI-view turns also populate the meter.
    // Both come from one read of the transcript. The transcript's totals are
    // cumulative for the whole PTY session, so report the delta since the
    // anchor captured at the end of the previous turn, then advance it.
    const transcriptPath = resolver.transcriptPath;
    if (transcriptPath && !result.error) {
      const anchor = this.turnStatsAnchor.get(cuttlefishSessionId);
      const previousCumulative = anchor?.transcriptPath === transcriptPath ? anchor : undefined;
      const stats = computeInteractiveTurnStatsSinceAnchor(transcriptPath, opts.model, previousCumulative);
      if (stats?.cost) { result.cost = stats.cost.cost; result.numTurns = stats.cost.turns; }
      if (stats?.contextTokens) result.contextTokens = stats.contextTokens;
      if (stats?.cumulative) setCapped(this.turnStatsAnchor, cuttlefishSessionId, { transcriptPath, ...stats.cumulative });
    }
    // Recover lost result text: if the turn settled with no text and no API-level
    // failure, the Stop hook (which carries last_assistant_message) was dropped —
    // a gateway restart deleted gateway.json mid-turn so hook-relay.mjs couldn't
    // POST it, or the PTY died / SSE proxy dropped before it landed. The real final
    // message is still on disk in the transcript; backfill it so the parent-session
    // callback shows real output instead of "(no output)". stopFailure turns are a
    // genuine no-output API error — leave those alone.
    if (!nativeCommand && !result.error && !result.result?.trim() && !resolver.stopFailure) {
      const sid = resolver.sessionId ?? opts.resumeSessionId ?? result.sessionId;
      const recoveryPath = sid ? findTranscriptForSession(sid) : undefined;
      const recovered = recoveryPath ? lastAssistantTextFromTranscript(recoveryPath, turnStartedAt) : undefined;
      if (recovered) {
        logger.info(`Recovered ${recovered.length} chars of lost turn text for session ${cuttlefishSessionId} from transcript (Stop hook missing)`);
        result.result = stripReasoningBlocks(recovered);
      }
    }
    // Map a StopFailure rate-limit into result.rateLimit so manager.ts's
    // wait/retry/fallback machinery engages exactly as it does for `claude -p`.
    const rl = rateLimitFromStopFailure(resolver.stopFailure);
    if (rl) result.rateLimit = rl;
    // Turn settled as an API-error failure — the CLI may still be retrying.
    // Keep listening for a late Stop so a wrong "failed" verdict self-corrects.
    if (result.error && resolver.stopFailure) {
      this.armLateRecovery(cuttlefishSessionId, opts);
    }
    return result;
  }

  /** Translate parsed SSE events from a PTY's proxy into StreamDeltas and route
   *  them to the active turn's onStream. A PTY outlives its turn, so we look up
   *  the live active entry here rather than capturing onStream at spawn.
   *  Any SSE event is also proof of life for a pending StopFailure grace window. */
  private handleSseEvent(cuttlefishSessionId: string, e: SseDataEvent): void {
    const entry = this.active.get(cuttlefishSessionId);
    if (!entry) return; // idle PTY / no turn in flight — nothing to stream
    entry.resolver.noteActivity();
    if (!entry.onStream) return;
    // Only the main agent's events reach here (the proxy suppresses sub-agent and
    // auxiliary streams), so deltas go straight to the transcript.
    for (const d of sseEventToDeltas(e)) entry.onStream(d);
  }

  /** Allocate + start a per-PTY SSE forward proxy. Returns the proxy and its port,
   *  or {port:0} if it failed to bind — in which case the PTY is spawned WITHOUT
   *  ANTHROPIC_BASE_URL (direct to Anthropic): the turn still works, only live
   *  word-by-word streaming degrades. */
  private async startProxy(cuttlefishSessionId: string): Promise<{ proxy: SsePtyProxy; port: number }> {
    const proxy = new SsePtyProxy(cuttlefishSessionId, (e) => this.handleSseEvent(cuttlefishSessionId, e), {
      // ALL requests (main + subagent + background tasks) count here — this is
      // how the gateway knows the CLI is still working after the turn settled.
      onUpstreamActivity: (info) => this.handleUpstreamActivity(cuttlefishSessionId, info),
    });
    try {
      const port = await proxy.start();
      return { proxy, port };
    } catch (err) {
      logger.warn(`SSE proxy failed to start for session ${cuttlefishSessionId} (streaming degraded): ${err instanceof Error ? err.message : String(err)}`);
      proxy.stop();
      return { proxy, port: 0 };
    }
  }

  /** Wrap a freshly-spawned IPty in a PtyHandle and wire its output into
   *  the session's scrollback ring buffer + live subscribers. On PTY exit, if this
   *  proc is the one bound to the active turn, the resolver is interrupted (a crash
   *  with no Stop hook); a stale proc replaced by a respawn is treated as benign.
   *  `proxy` (the per-PTY SSE forward proxy) is torn down when this PTY exits. */
  private wireProcToStream(cuttlefishSessionId: string, proc: IPty, proxy?: SsePtyProxy): PtyHandle {
    const handle = createPtyHandle(proc);
    this.streams.attach(cuttlefishSessionId, proc, () => {
      this.lastOutputAt.set(cuttlefishSessionId, Date.now());
      this.onActivityCbs.get(cuttlefishSessionId)?.(); // raw PTY bytes = proof-of-life for the stall watchdog
    });
    proc.onExit(() => {
      // Session-level cleanup MUST be identity-gated. In a kill->respawn race the
      // lifecycle/stream entries already point at the NEW PTY by the time THIS
      // (old, killed) PTY's exit fires. releaseSession is keyed by sessionId, so an
      // unguarded call here would kill the freshly-adopted PTY — whose own onExit
      // then fires the spurious second "claude process exited". Only this PTY being
      // the session's CURRENT warm handle means the cleanup is ours to do.
      const isCurrent = this.lifecycle.getWarm(cuttlefishSessionId) === handle;
      if (isCurrent) {
        this.streams.onPtyExit(cuttlefishSessionId);
        // Release the lifecycle entry so the dead handle isn't picked up by a future
        // run() as "warm" — that would inject into a corpse.
        this.lifecycle.releaseSession(cuttlefishSessionId);
      }
      // Tear down THIS PTY's SSE forward proxy (one proxy per PTY) regardless.
      proxy?.stop();
      // PTY exited without a Stop hook (crash / early exit) — settle the active turn
      // as interrupted so run()'s promise doesn't hang. BUT only if this dying proc is
      // the one bound to the active turn: after a kill->respawn race the active entry
      // holds the NEW turn's resolver+proc, and this (old, released) proc must not
      // poison it. Identity mismatch => benign cleanup, no interrupt.
      const e = this.active.get(cuttlefishSessionId);
      if (e && e.boundProc === proc) {
        e.resolver.interrupt("Interrupted: claude process exited");
      }
    });
    return handle;
  }

  /** node-pty spawn of the genuine claude binary (no -p → cc_entrypoint=cli).
   *  Allocates a per-PTY SSE forward proxy first and points the child at it. */
  private async spawn(cuttlefishSessionId: string, opts: EngineRunOpts, settingsPath: string): Promise<PtyHandle> {
    const args = buildInteractiveArgs({
      prompt: opts.prompt,
      settingsPath,
      resumeSessionId: opts.resumeSessionId,
      model: opts.model,
      effortLevel: opts.effortLevel,
      mcpConfigPath: opts.mcpConfigPath,
      cliFlags: opts.cliFlags,
      attachments: opts.attachments,
      // Persona/org context + main-agent sentinel via the CLI flag (the settings-file
      // appendSystemPrompt KEY is ignored by claude ≥2.1.x). The sentinel lets the SSE
      // proxy tee this turn's stream to the chat pane; sub-agents have no sentinel.
      appendSystemPrompt: opts.systemPrompt
        ? `${opts.systemPrompt}\n\n${MAIN_AGENT_SENTINEL}`
        : MAIN_AGENT_SENTINEL,
    });
    const { proxy, port } = await this.startProxy(cuttlefishSessionId);
    try {
      const env = buildClaudePtyEnv(port || undefined);
      const bin = resolveBin("claude", opts.bin);
      const geom = this.lastGeom.get(cuttlefishSessionId);
      logger.info(`InteractiveClaudeEngine spawning ${bin} (resume: ${opts.resumeSessionId || "none"}, geom: ${geom ? `${geom.cols}×${geom.rows}` : "default"}, sseProxy: ${port || "off"})`);
      const proc = await spawnPty(bin, args, {
        name: "xterm-256color",
        cols: geom?.cols ?? 120,
        rows: geom?.rows ?? 40,
        cwd: opts.cwd || CUTTLEFISH_HOME,
        env,
      });
      this.spawnParams.set(cuttlefishSessionId, { model: opts.model, effortLevel: opts.effortLevel, appendApplied: true });
      return this.wireProcToStream(cuttlefishSessionId, proc, port ? proxy : undefined);
    } catch (err) {
      // The proxy is normally torn down by the PTY's onExit — if the PTY never
      // spawned, stop it here or its bound port/server leaks on every retry.
      proxy.stop();
      throw err;
    }
  }

  /** Spawn an idle PTY for the CLI/xterm view. If an engineSessionId is provided,
   *  resumes that session; otherwise spawns a fresh `claude` so a brand-new CLI-mode
   *  session shows the TUI before the user types anything.
   *  Does NOTHING if a warm PTY already exists or a turn is starting.
   *  Fire-and-forget (void): allocating the per-PTY SSE proxy is async, so the
   *  actual spawn happens after a microtask; `idleSpawning` guards re-entrancy. */
  ensureIdleSpawn(cuttlefishSessionId: string, opts: PtyIdleSpawnOpts): void {
    if (this.lifecycle.getWarm(cuttlefishSessionId)) return;
    if (this.active.has(cuttlefishSessionId)) return; // a turn is starting/running — let run() spawn
    if (this.idleSpawning.has(cuttlefishSessionId)) return; // an idle spawn is already in flight
    this.idleSpawning.add(cuttlefishSessionId);

    const settingsPath = writeSessionSettings(CLAUDE_SETTINGS_DIR, cuttlefishSessionId, {
      sessionId: cuttlefishSessionId,
      relayScript: HOOK_RELAY_SCRIPT,
      statusLineDir: CLAUDE_LIMITS_DIR,
    });
    const args: string[] = [
      "--chrome",
      "--dangerously-skip-permissions",
      "--disallowedTools", "AskUserQuestion", "ExitPlanMode",
      "--settings", settingsPath,
    ];
    if (opts.engineSessionId) args.unshift("--resume", opts.engineSessionId);
    if (opts.model) args.push("--model", opts.model);
    const bin = resolveBin("claude", opts.bin);
    // Caller (pty-ws) passes the client's current cols/rows. Cache them so a
    // future cold spawn through run() picks up the right geometry too.
    const cols = opts.cols ?? this.lastGeom.get(cuttlefishSessionId)?.cols ?? 120;
    const rows = opts.rows ?? this.lastGeom.get(cuttlefishSessionId)?.rows ?? 40;
    if (opts.cols && opts.rows) setCapped(this.lastGeom, cuttlefishSessionId, { cols: opts.cols, rows: opts.rows });

    void (async () => {
      let proxy: SsePtyProxy | undefined;
      try {
        const started = await this.startProxy(cuttlefishSessionId);
        proxy = started.proxy;
        const port = started.port;
        // Re-check after the async gap: a real turn (run) or another idle spawn may
        // have claimed the session while we awaited the proxy bind. If so, don't
        // adopt a duplicate PTY — drop our proxy and bail.
        if (this.lifecycle.getWarm(cuttlefishSessionId) || this.active.has(cuttlefishSessionId)) {
          proxy.stop();
          return;
        }
        const env = buildClaudePtyEnv(port || undefined);
        logger.info(`InteractiveClaudeEngine ensureIdleSpawn for session ${cuttlefishSessionId} (resume ${opts.engineSessionId || "none — fresh"}, geom ${cols}×${rows}, sseProxy: ${port || "off"})`);
        const proc = await spawnPty(bin, args, {
          name: "xterm-256color",
          cols,
          rows,
          cwd: opts.cwd || CUTTLEFISH_HOME,
          env,
        });
        const handle = this.wireProcToStream(cuttlefishSessionId, proc, port ? proxy : undefined);
        // Idle spawn carries no --append-system-prompt (the view-only PTY); mark it so
        // the first real turn through run() cold-respawns with the persona + sentinel.
        this.spawnParams.set(cuttlefishSessionId, { model: opts.model, effortLevel: undefined, appendApplied: false });
        this.lifecycle.adopt(cuttlefishSessionId, handle);
      } catch (err) {
        // Nothing adopted the proxy (spawnPty threw before wireProcToStream) —
        // stop it or its bound port/server leaks.
        proxy?.stop();
        logger.warn(`ensureIdleSpawn failed for session ${cuttlefishSessionId}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.idleSpawning.delete(cuttlefishSessionId);
      }
    })();
  }

  /** Append-only capped output buffer for the session's current/most-recent PTY (for xterm.js reconnect replay).
   *  Returns a concatenated Buffer — pty-ws.ts forwards it directly without re-encoding. */
  getScrollback(sessionId: string): Buffer {
    return this.streams.getScrollback(sessionId);
  }

  /** Subscribe to live PTY output for a session. Returns an unsubscribe fn. Survives PTY respawn within the session.
   *  Optional `onControl` receives out-of-band events (currently just `{type:"reset"}`
   *  when the PTY is replaced mid-session — the WS should forward this to the client xterm). */
  subscribeOutput(
    sessionId: string,
    cb: (data: Buffer) => void,
    onControl?: (event: PtyControlEvent) => void,
  ): () => void {
    return this.streams.subscribe(sessionId, cb, onControl);
  }

  /** Write raw text to the warm PTY as a bracketed-paste + CR (same /@!-guard as injectPrompt). No-op if no warm PTY. */
  writeStdin(sessionId: string, text: string): void {
    const handle = this.lifecycle.getWarm(sessionId);
    if (!handle) return;
    const proc = (handle as any)._proc as IPty | undefined;
    if (!proc) return;
    pasteAndSubmit(proc, text);
  }

  writeRaw(sessionId: string, data: string): void {
    const proc = (this.lifecycle.getWarm(sessionId) as any)?._proc as IPty | undefined;
    if (proc) proc.write(data);
  }

  /** Resize the warm PTY + remember the geometry for the next cold spawn. */
  resizePty(sessionId: string, cols: number, rows: number): void {
    setCapped(this.lastGeom, sessionId, { cols, rows });
    const handle = this.lifecycle.getWarm(sessionId);
    if (!handle) return;
    const proc = (handle as any)._proc as IPty | undefined;
    if (!proc) return;
    try { proc.resize(cols, rows); } catch { /* PTY gone */ }
  }

  kill(sessionId: string, reason = "Interrupted"): void {
    this.cancelLateRecovery(sessionId);
    const e = this.active.get(sessionId);
    e?.resolver.interrupt(reason.startsWith("Interrupted") ? reason : `Interrupted: ${reason}`);
    this.lifecycle.releaseSession(sessionId);
  }

  killAll(): void {
    for (const id of [...this.active.keys()]) this.kill(id, "Interrupted: gateway shutting down");
    this.lifecycle.killAll();
  }

  /** Recycle idle warm PTYs only (org-reload). Never interrupts an in-flight
   *  turn: sessions in `this.active` are skipped, so the turn that wrote the org
   *  file runs to completion on its current persona and the next turn picks up
   *  the new one via cold respawn. */
  killIdle(): void {
    this.lifecycle.releaseIdle((id) => this.active.has(id));
  }

  /** True only while a turn is in flight (distinct from "PTY is warm"). */
  isTurnRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /** True iff a warm PTY exists for this session (in the lifecycle manager). */
  hasWarmPty(sessionId: string): boolean {
    return this.lifecycle.getWarm(sessionId) !== undefined;
  }

  /** Track viewing state from the frontend. Called by pty-ws on `viewing` messages
   *  from CliTerminal (mount/unmount + Page Visibility). Ref-counted so multiple tabs
   *  viewing the same session keep it warm until the last one leaves. */
  setViewing(sessionId: string, viewing: boolean): void {
    if (viewing) this.lifecycle.viewerEnter(sessionId);
    else this.lifecycle.viewerLeave(sessionId);
  }

  /** InterruptibleEngine.isAlive — true if a turn OR a warm PTY exists. */
  isAlive(sessionId: string): boolean {
    return this.active.has(sessionId) || this.lifecycle.getWarm(sessionId) !== undefined;
  }

  /** Keep listening for a late Stop after an API-error settle. Public visibility
   *  is for tests; used by run() and kill(). No-op when the caller didn't provide
   *  onLateRecovery. */
  armLateRecovery(cuttlefishSessionId: string, opts: EngineRunOpts): void {
    this.lateRecovery.arm(cuttlefishSessionId, opts);
  }

  /** Tear down a pending late-recovery listener (new turn starting / kill / expiry). */
  cancelLateRecovery(cuttlefishSessionId: string): void {
    this.lateRecovery.cancel(cuttlefishSessionId);
  }
}
