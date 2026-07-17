// packages/cuttlefish/src/engines/hermes-acp.ts
import { spawn, type ChildProcess } from "node:child_process";
import type { InterruptibleEngine, EngineRunOpts, EngineResult } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { HermesRpc } from "./hermes-jsonrpc.js";
import { mapSessionUpdate, extractPromptText } from "./hermes-protocol.js";
import { buildEngineEnv } from "../shared/engine-env.js";
import { capAppend, ENGINE_OUTPUT_MAX } from "../shared/cap-append.js";

const TURN_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
const HANDSHAKE_TIMEOUT_MS = 60_000;
const ALLOW_ALWAYS = { outcome: { outcome: "selected", optionId: "allow_always" } };

interface ProcHandle {
  rpc: HermesRpc;
  killProc: () => void;
  isAliveProc: () => boolean;
  onExit: (cb: () => void) => void;
  onError: (cb: (err: Error) => void) => void;
}

interface HermesProc {
  handle: ProcHandle;
  alive: boolean;
  hermesSessionId?: string;
  currentModelId?: string;
  initialized: Promise<void>;
}

export class HermesAcpEngine implements InterruptibleEngine {
  name = "hermes" as const;
  private procs = new Map<string, HermesProc>();
  /** Guards against two concurrent turns racing on the same session's single
   *  shared HermesRpc notify callback (mirrors the `active` guard used by the
   *  claude/codex/grok/antigravity interactive engines). */
  private active = new Set<string>();
  /** Overridable in tests to shorten the handshake timeout. */
  protected handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS;

  /** Test seam — overridden in unit tests to inject a fake server. */
  protected spawnProc(bin: string, cwd: string): ProcHandle {
    const child: ChildProcess = spawn(bin, ["acp"], {
      stdio: ["pipe", "pipe", "ignore"],
      cwd,
      detached: process.platform !== "win32",
      env: buildEngineEnv({ HERMES_YOLO_MODE: "1", HERMES_ACCEPT_HOOKS: "1" }),
    });
    const rpc = new HermesRpc(child.stdin!, child.stdout!);
    return {
      rpc,
      killProc: () => {
        try { process.kill(-child.pid!, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* ignore */ } }
        // Escalate like the other engines: a child that ignores SIGTERM must
        // not survive killAll()/shutdown as an orphan.
        const force = setTimeout(() => {
          if (child.exitCode !== null) return;
          try { process.kill(-child.pid!, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* ignore */ } }
        }, 2_000);
        force.unref?.();
      },
      isAliveProc: () => child.exitCode === null && !child.killed,
      onExit: (cb) => child.on("exit", cb),
      onError: (cb) => child.on("error", cb),
    };
  }

  private getOrSpawn(cuttlefishId: string, bin: string, cwd: string): HermesProc {
    const existing = this.procs.get(cuttlefishId);
    if (existing && existing.alive) return existing;

    const handle = this.spawnProc(bin, cwd);
    // Fix 4: only auto-approve the specific permission-request method.
    handle.rpc.onServerRequest((method) =>
      method === "session/request_permission" ? ALLOW_ALWAYS : {},
    );
    const entry: HermesProc = {
      handle,
      alive: true,
      initialized: handle.rpc.request("initialize", { protocolVersion: 1, clientCapabilities: {} }).then(() => {}),
    };
    handle.onExit(() => {
      entry.alive = false;
      handle.rpc.rejectAll(new Error("hermes acp exited"));
    });
    // Fix 2(a): surface spawn/exec errors so run() never hangs on ENOENT etc.
    handle.onError((err) => {
      entry.alive = false;
      handle.rpc.rejectAll(new Error("hermes acp spawn/process error: " + err.message));
    });
    this.procs.set(cuttlefishId, entry);
    return entry;
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const cuttlefishId = opts.sessionId || opts.resumeSessionId || "default";
    // Concurrent-turn guard: two turns on the same session must not race on
    // the single shared HermesRpc notify callback (see `onNote` below).
    if (this.active.has(cuttlefishId)) {
      return { sessionId: opts.resumeSessionId ?? "", result: "", error: "Hermes engine: a turn is already running for this session" };
    }
    this.active.add(cuttlefishId);
    const bin = resolveBin("hermes", opts.bin);
    const p = this.getOrSpawn(cuttlefishId, bin, opts.cwd);
    const { rpc } = p.handle;

    // Fix 2(b): guard the entire pre-prompt handshake with a timeout so a hung
    // or dead server can't stall run() forever.
    let handshakeWatchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await p.initialized;

          // session/new or session/load (with Fix 3 fallback)
          if (!p.hermesSessionId) {
            if (opts.resumeSessionId) {
              try {
                await rpc.request("session/load", { sessionId: opts.resumeSessionId, cwd: opts.cwd, mcpServers: [] });
                p.hermesSessionId = opts.resumeSessionId;
              } catch (loadErr) {
                // Fix 3: stale/expired id — fall back to a fresh session so the
                // gateway doesn't get permanently wedged on the bad id.
                logger.warn(
                  `[hermes-acp] session/load failed for ${opts.resumeSessionId}, falling back to session/new: ` +
                  (loadErr instanceof Error ? loadErr.message : String(loadErr)),
                );
                const ns = await rpc.request<Record<string, unknown>>("session/new", { cwd: opts.cwd, mcpServers: [] });
                p.hermesSessionId = String(ns.sessionId);
                const models = ns.models as Record<string, unknown> | undefined;
                p.currentModelId = models?.currentModelId ? String(models.currentModelId) : undefined;
              }
            } else {
              const ns = await rpc.request<Record<string, unknown>>("session/new", { cwd: opts.cwd, mcpServers: [] });
              p.hermesSessionId = String(ns.sessionId);
              const models = ns.models as Record<string, unknown> | undefined;
              p.currentModelId = models?.currentModelId ? String(models.currentModelId) : undefined;
            }
            await rpc.request("session/set_mode", { sessionId: p.hermesSessionId, modeId: "dont_ask" }).catch(() => {});
          }

          if (opts.model && opts.model !== p.currentModelId) {
            await rpc.request("session/set_model", { sessionId: p.hermesSessionId, modelId: opts.model }).catch(() => {});
            p.currentModelId = opts.model;
          }
        })(),
        new Promise<never>((_, rej) => {
          handshakeWatchdog = setTimeout(
            () => rej(new Error("hermes acp handshake timeout")),
            this.handshakeTimeoutMs,
          );
          handshakeWatchdog.unref?.();
        }),
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[hermes-acp] handshake error for ${cuttlefishId}: ${msg}`);
      // Evict the mute/dead process so the next turn gets a clean respawn.
      p.alive = false;
      try { p.handle.killProc(); } catch { /* ignore */ }
      if (this.procs.get(cuttlefishId) === p) this.procs.delete(cuttlefishId);
      this.active.delete(cuttlefishId);
      return { sessionId: "", result: "", error: msg };
    } finally {
      if (handshakeWatchdog) clearTimeout(handshakeWatchdog);
    }

    // Fix 1: prepend systemPrompt on fresh (non-resume) sessions only, mirroring
    // the grok engine pattern.
    const rawPrompt =
      opts.systemPrompt && !opts.resumeSessionId
        ? `${opts.systemPrompt}\n\n${opts.prompt}`
        : opts.prompt;

    let resultText = "";
    let lastContext: number | undefined;
    const hermesSessionId = p.hermesSessionId;

    const onNote = (m: string, params: Record<string, unknown>) => {
      if (m !== "session/update" || params.sessionId !== hermesSessionId) return;
      const u = mapSessionUpdate((params.update ?? {}) as Record<string, unknown>);
      for (const d of u.deltas) {
        if (d.type === "text") resultText = capAppend(resultText, d.content, ENGINE_OUTPUT_MAX); // bound long-turn retention (AR-09)
        opts.onStream?.(d);
      }
      if (u.contextTokens != null) lastContext = u.contextTokens;
    };
    rpc.onNotification(onNote);

    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        rpc.request<Record<string, unknown>>("session/prompt", {
          sessionId: hermesSessionId,
          prompt: extractPromptText(rawPrompt),
        }),
        new Promise<never>((_, rej) => {
          watchdog = setTimeout(() => rej(new Error("hermes turn timeout")), TURN_TIMEOUT_MS);
          watchdog.unref?.();
        }),
      ]);

      const stop = String(res.stopReason ?? res.stop_reason ?? "");
      const error =
        !resultText && (stop === "refusal" || stop === "cancelled")
          ? `Hermes turn ended: ${stop}`
          : undefined;

      this.active.delete(cuttlefishId);
      return {
        sessionId: hermesSessionId!,
        result: resultText,
        contextTokens: lastContext,
        error,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[hermes-acp] turn error for ${cuttlefishId}: ${msg}`);
      this.active.delete(cuttlefishId);
      return {
        sessionId: hermesSessionId || "",
        result: resultText,
        contextTokens: lastContext,
        error: resultText ? undefined : msg,
      };
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
  }

  kill(sessionId: string): void {
    const p = this.procs.get(sessionId);
    if (!p) return;
    p.alive = false;
    try { p.handle.killProc(); } catch { /* ignore */ }
    this.procs.delete(sessionId);
  }

  isAlive(sessionId: string): boolean {
    const p = this.procs.get(sessionId);
    return !!p && p.alive && p.handle.isAliveProc();
  }

  killAll(): void {
    for (const p of this.procs.values()) {
      p.alive = false;
      try { p.handle.killProc(); } catch { /* ignore */ }
    }
    this.procs.clear();
  }

  /** No shared idle pool — per-session procs recycle via kill on org reload. */
  killIdle(): void {
    /* no-op */
  }
}
