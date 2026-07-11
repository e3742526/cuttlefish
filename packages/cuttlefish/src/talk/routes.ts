/**
 * Cuttlefish Talk — HTTP route dispatcher (Path 1).
 *
 * Single entry point `handleTalkApi(req, res, context)` for everything under
 * `/api/talk/*`. Registered from gateway/api.ts near the STT routes. Returns
 * `true` when it owns the path (so api.ts can early-return), `false` otherwise.
 *
 * Path 1 — the voice orchestrator is a REAL gateway session, not an in-process
 * Agent-SDK loop. So this dispatcher is thin: it only bootstraps/returns the
 * orchestrator session and exposes Kokoro TTS readiness/download. Actual voice
 * turns go through the normal POST /api/sessions/:id/message; the orchestrator's
 * spoken reply is synthesized server-side (see talk/tts-stream.ts, driven from
 * the run loop in api.ts) and streamed as talk:audio over the WebSocket.
 */
import fs from "node:fs";
import yaml from "js-yaml";
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import type { ApiContext } from "../gateway/api.js";
import { principalBodySessionForbidden, type GatewayPrincipal } from "../gateway/auth.js";
import { assertFetchOk, jsonApiHeaders } from "../gateway/internal-auth.js";
import { gatewayBaseUrl } from "../gateway/gateway-info.js";
import { readJsonBody } from "../gateway/http-helpers.js";
import type { CuttlefishConfig, JsonObject } from "../shared/types.js";
import { CONFIG_PATH } from "../shared/paths.js";
import { saveConfigAtomic } from "../shared/config.js";
import { logger } from "../shared/logger.js";
import {
  createSession,
  getSession,
  getSessionBySessionKey,
  listChildSessions,
  updateSession,
  searchSessions,
  searchMessages,
} from "../sessions/registry.js";
import { engineAvailable, isKnownEngine, type EngineName } from "../shared/models.js";
import { resolveTalkEngine, type TalkEngineResolution } from "./engine-resolver.js";
import { validateCard, validateCardPatch } from "./card-validate.js";
import { delegateToThread } from "./delegate.js";
import { attach, detach, listAttachments } from "./attachments.js";
import { setTalkMuted } from "./mute-state.js";
import { TALK_EVENTS } from "./protocol.js";
import { buildGraphSnapshot, emitAttachmentChange, resolveTalkRoot } from "./graph.js";
import { searchTalkSessions } from "./search.js";
import { getTalkTts } from "./tts-stream.js";

/** Stable session key for the single hands-free orchestrator surface. */
const TALK_SESSION_KEY = "talk:main";

/** Default orchestrator model when `talk.orchestratorModel` is unset (capable enough to orchestrate; override via talk.orchestratorModel). */
const DEFAULT_TALK_MODEL = "sonnet";

/** The orchestrator model the talk session should run on. */
function talkModel(config: CuttlefishConfig): string {
  return config.talk?.orchestratorModel ?? DEFAULT_TALK_MODEL;
}

/**
 * Candidate engines in priority order: gateway default first, then every other
 * configured+known engine. Used as the fallback search order by the resolver.
 */
function talkEngineCandidates(config: CuttlefishConfig): string[] {
  const def = config.engines.default;
  const rest = Object.keys(config.engines).filter(
    (k) => k !== "default" && k !== def && isKnownEngine(k),
  );
  return [def, ...rest];
}

/**
 * Resolve which engine the voice orchestrator should use, with seamless fallback:
 * talk.engine → engines.default → first available. Availability reuses resolve-bin
 * (via engineAvailable) so an uninstalled CLI is never chosen. Returns the choice,
 * whether a fallback occurred, and the available set (see engine-resolver.ts).
 */
function resolveActiveTalkEngine(config: CuttlefishConfig): TalkEngineResolution {
  return resolveTalkEngine({
    configured: config.talk?.engine,
    defaultEngine: config.engines.default,
    candidates: talkEngineCandidates(config),
    isAvailable: (e) => isKnownEngine(e) && engineAvailable(config, e as EngineName),
  });
}

/** Actionable message when no engine binary is installed for the orchestrator. */
function noEngineMessage(): string {
  return (
    "No engine is available for the voice orchestrator — no engine CLI was found " +
    "on your PATH. Install one (e.g. npm install -g @anthropic-ai/claude-code) or " +
    "set engines.<name>.bin in config.yaml, then retry."
  );
}

/**
 * Dispatch any `/api/talk/*` request. Returns `true` if handled (caller should
 * early-return), `false` if the path is not a talk route.
 */
export async function handleTalkApi(
  req: HttpRequest,
  res: ServerResponse,
  context: ApiContext,
): Promise<boolean> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const method = req.method || "GET";

  if (!pathname.startsWith("/api/talk/")) return false;

  // AR-04: these routes address a Talk surface by a `sessionId` in the JSON body,
  // which the transport-layer scoped-token gate (URL-only) cannot see. Resolve the
  // authenticated principal so a session-scoped agent token cannot mutate another
  // session's cards / mute / thread labels by naming a different id in the body.
  const principal = (req as HttpRequest & { cuttlefishPrincipal?: GatewayPrincipal }).cuttlefishPrincipal;
  const rejectCrossSessionBody = (bodySessionId: unknown): boolean => {
    if (!principalBodySessionForbidden(principal, bodySessionId)) return false;
    json(res, { error: "Forbidden: session-scoped token cannot target another session" }, 403);
    return true;
  };

  try {
    // POST /api/talk/session — bootstrap (or reuse) the orchestrator session.
    // The orchestrator is a normal idle gateway session with source:"talk";
    // buildContext() layers the AURA voice persona on it. Reuses the existing
    // talk session across reloads unless { fresh:true } is sent.
    if (method === "POST" && pathname === "/api/talk/session") {
      const parsed = await readJsonBody(req, res, { allowEmpty: true });
      if (!parsed.ok) return true;
      const body = (parsed.body ?? {}) as { fresh?: boolean };
      const config = context.getConfig();
      const resolved = resolveActiveTalkEngine(config);

      // No engine installed → don't let createSession spawn a raw failure; surface
      // an actionable message the UI can show.
      if (!resolved.engine) {
        json(res, { error: noEngineMessage() }, 503);
        return true;
      }

      if (!body.fresh) {
        const existing = getSessionBySessionKey(TALK_SESSION_KEY);
        // Engine is new-chat-only (mirrors PATCH /api/sessions): only reuse the
        // existing orchestrator if it already runs the resolved engine. If the
        // engine changed (e.g. via POST /api/talk/engine), fall through and create
        // a fresh session on the new engine — that's how an engine switch lands.
        if (existing && existing.source === "talk" && existing.engine === resolved.engine) {
          json(res, { sessionId: existing.id, reused: true });
          return true;
        }
      }

      const session = createSession({
        engine: resolved.engine,
        source: "talk",
        sourceRef: TALK_SESSION_KEY,
        connector: "web",
        sessionKey: TALK_SESSION_KEY,
        replyContext: { source: "talk" },
        model: talkModel(config),
        title: "Talk",
        portalName: config.portal?.portalName,
      });
      json(res, {
        sessionId: session.id,
        reused: false,
        engine: resolved.engine,
        model: talkModel(config),
        fallback: resolved.fallback,
      });
      return true;
    }

    // GET /api/talk/status — TTS engine readiness + active orchestrator engine.
    if (method === "GET" && pathname === "/api/talk/status") {
      const config = context.getConfig();
      const s = getTalkTts(config.talk?.kokoro).status();
      const resolved = resolveActiveTalkEngine(config);
      json(res, {
        ttsAvailable: s.available,
        ttsDownloading: s.downloading,
        progress: s.progress,
        voice: s.voice,
        ready: s.ready,
        engine: resolved.engine,
        model: talkModel(config),
        engineFallback: resolved.fallback,
        enginesAvailable: resolved.available,
      });
      return true;
    }

    // GET /api/talk/engine — the currently-active orchestrator engine + model, the
    // available engine set, and the live session's engine (so the UI can show it).
    if (method === "GET" && pathname === "/api/talk/engine") {
      const config = context.getConfig();
      const resolved = resolveActiveTalkEngine(config);
      const existing = getSessionBySessionKey(TALK_SESSION_KEY);
      json(res, {
        engine: resolved.engine,
        model: talkModel(config),
        fallback: resolved.fallback,
        reason: resolved.reason,
        available: resolved.available,
        configured: config.talk?.engine ?? null,
        liveSessionEngine:
          existing && existing.source === "talk" ? existing.engine : null,
      });
      return true;
    }

    // GET /api/talk/graph?root=<talkSessionId> — full delegation-tree snapshot
    // for (re)connect rehydration; live deltas stream as talk:graph WS events.
    if (method === "GET" && pathname === "/api/talk/graph") {
      const rootId = url.searchParams.get("root") || "";
      const root = rootId ? getSession(rootId) : undefined;
      if (!root || root.source !== "talk") {
        badRequest(res, "root must be an existing talk session id");
        return true;
      }
      const graphAttachmentDeps = {
        getSession,
        updateSessionMeta: (id: string, transportMeta: JsonObject | null) =>
          updateSession(id, { transportMeta }),
      };
      json(res, {
        rootId: root.id,
        nodes: buildGraphSnapshot(root.id, listChildSessions, {
          getSession,
          listAttachments: (talkId) => listAttachments(talkId, graphAttachmentDeps),
        }),
      });
      return true;
    }

    // GET /api/talk/search?q=&limit= — search sessions by title/metadata and by
    // message content (FTS). Merges both hit sources, de-duped by sessionId
    // (title hit wins position; content hits attach as hits[]). Capped at 20
    // results overall and 3 hits per session. Returns [] when FTS is degraded
    // (backfill not yet complete) — the orchestrator handles that gracefully.
    if (method === "GET" && pathname === "/api/talk/search") {
      const q = url.searchParams.get("q") ?? "";
      const limitRaw = url.searchParams.get("limit");
      const limitParsed = limitRaw !== null ? parseInt(limitRaw, 10) : undefined;
      const result = searchTalkSessions(q, {
        searchSessions,
        searchMessages,
        getSession,
        resolveTalkRoot,
      }, limitParsed);
      if (!result.ok) {
        json(res, { error: result.error }, result.status);
        return true;
      }
      json(res, result);
      return true;
    }

    // POST /api/talk/engine — switch the orchestrator engine/model on the fly.
    // Body: { engine?: string; model?: string }. Persists to config.talk and:
    //   • model — mutable mid-chat → applied to the live session immediately
    //     (takes effect on its NEXT turn, like PATCH /api/sessions).
    //   • engine — new-chat-only (a live PTY can't swap engine mid-turn). We persist
    //     the desired engine; it lands when the talk session is next (re)created.
    //     The POST /api/talk/session reuse guard refuses to reuse a session whose
    //     engine differs from the resolved one, so the next bootstrap (page reload /
    //     reconnect, or { fresh:true }) silently moves to the new engine. We do NOT
    //     tear down an in-flight conversation here.
    if (method === "POST" && pathname === "/api/talk/engine") {
      const parsed = await readJsonBody(req, res, { allowEmpty: true });
      if (!parsed.ok) return true;
      const body = (parsed.body ?? {}) as { engine?: unknown; model?: unknown };

      let engine: string | undefined;
      if (body.engine !== undefined) {
        if (typeof body.engine !== "string" || !body.engine.trim()) {
          badRequest(res, "engine must be a non-empty string");
          return true;
        }
        engine = body.engine.trim();
        if (!isKnownEngine(engine)) {
          badRequest(res, `Unknown engine "${engine}" — expected one of claude, codex, antigravity, grok, pi, hermes, ollama, kilo.`);
          return true;
        }
      }

      let model: string | undefined;
      if (body.model !== undefined) {
        if (typeof body.model !== "string" || !body.model.trim()) {
          badRequest(res, "model must be a non-empty string");
          return true;
        }
        model = body.model.trim();
      }

      if (engine === undefined && model === undefined) {
        badRequest(res, "provide engine and/or model to switch");
        return true;
      }

      // Persist to config.yaml (config.talk.{engine,orchestratorModel}); reuse the
      // read-modify-write pattern used by the STT config routes.
      try {
        const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
        const cfg = yaml.load(raw) as Record<string, unknown>;
        if (!cfg.talk || typeof cfg.talk !== "object") cfg.talk = {};
        const talkCfg = cfg.talk as Record<string, unknown>;
        if (engine !== undefined) talkCfg.engine = engine;
        if (model !== undefined) talkCfg.orchestratorModel = model;
        saveConfigAtomic(cfg, { lineWidth: -1 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        json(res, { ok: false, error: `Failed to persist talk engine: ${msg}` }, 500);
        return true;
      }
      context.reloadConfig?.(); // refresh in-memory config now (don't wait on the watcher)

      const config = context.getConfig();
      const resolved = resolveActiveTalkEngine(config);
      const activeModel = talkModel(config);

      // Apply the model switch to the live session right away (mid-chat mutable).
      if (model !== undefined) {
        const existing = getSessionBySessionKey(TALK_SESSION_KEY);
        if (existing && existing.source === "talk") {
          updateSession(existing.id, { model: activeModel });
        }
      }

      logger.info(
        `Talk engine switch → engine=${resolved.engine ?? "none"} model=${activeModel}` +
          (resolved.fallback ? " (fallback)" : ""),
      );
      context.emit(TALK_EVENTS.engine, {
        engine: resolved.engine,
        model: activeModel,
        fallback: resolved.fallback,
      });

      json(res, {
        ok: true,
        engine: resolved.engine,
        model: activeModel,
        fallback: resolved.fallback,
        reason: resolved.reason,
        available: resolved.available,
      });
      return true;
    }

    // POST /api/talk/tts/download — kick Kokoro weight download in the
    // background (progress streams over talk:tts:download:* WS events).
    if (method === "POST" && pathname === "/api/talk/tts/download") {
      getTalkTts(context.getConfig().talk?.kokoro)
        .download(context.emit)
        .catch((err) => {
          context.emit("talk:tts:download:error", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      json(res, { status: "downloading" });
      return true;
    }

    // ── Cards surface ───────────────────────────────────────────────────
    // The orchestrator (or any process acting on its behalf) pushes structured
    // content to the /talk UI by POSTing cards here. Each route validates the
    // untrusted body, then broadcasts the canonical talk:card* WS event so every
    // connected client mirrors the change. Cards are addressed by sessionId
    // (which talk surface) and, for update/dismiss, by cardId.

    // POST /api/talk/card — push a new card onto the surface.
    if (method === "POST" && pathname === "/api/talk/card") {
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return true;
      const body = (parsed.body ?? {}) as { sessionId?: unknown; card?: unknown };
      if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
        badRequest(res, "sessionId must be a non-empty string");
        return true;
      }
      if (rejectCrossSessionBody(body.sessionId)) return true;
      const validated = validateCard(body.card);
      if (!validated.ok) {
        badRequest(res, validated.error);
        return true;
      }
      context.emit(TALK_EVENTS.card, { sessionId: body.sessionId, card: validated.card });
      json(res, { ok: true });
      return true;
    }

    // POST /api/talk/card/update — patch an existing card by id.
    if (method === "POST" && pathname === "/api/talk/card/update") {
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return true;
      const body = (parsed.body ?? {}) as {
        sessionId?: unknown;
        cardId?: unknown;
        patch?: unknown;
      };
      if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
        badRequest(res, "sessionId must be a non-empty string");
        return true;
      }
      if (typeof body.cardId !== "string" || body.cardId.length === 0) {
        badRequest(res, "cardId must be a non-empty string");
        return true;
      }
      if (typeof body.patch !== "object" || body.patch === null || Array.isArray(body.patch)) {
        badRequest(res, "patch must be a non-null object");
        return true;
      }
      if (rejectCrossSessionBody(body.sessionId)) return true;
      // Field-validate the patch with the same rigor as a full card, so a patch
      // can't inject a malformed details/options/hunks/rows after the initial
      // card passed and crash the renderer.
      const patchCheck = validateCardPatch(body.patch);
      if (!patchCheck.ok) {
        badRequest(res, patchCheck.error);
        return true;
      }
      context.emit(TALK_EVENTS.cardUpdate, {
        sessionId: body.sessionId,
        cardId: body.cardId,
        patch: body.patch,
      });
      json(res, { ok: true });
      return true;
    }

    // POST /api/talk/card/dismiss — remove a single card by id.
    if (method === "POST" && pathname === "/api/talk/card/dismiss") {
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return true;
      const body = (parsed.body ?? {}) as { sessionId?: unknown; cardId?: unknown };
      if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
        badRequest(res, "sessionId must be a non-empty string");
        return true;
      }
      if (typeof body.cardId !== "string" || body.cardId.length === 0) {
        badRequest(res, "cardId must be a non-empty string");
        return true;
      }
      if (rejectCrossSessionBody(body.sessionId)) return true;
      context.emit(TALK_EVENTS.cardDismiss, {
        sessionId: body.sessionId,
        cardId: body.cardId,
      });
      json(res, { ok: true });
      return true;
    }

    // POST /api/talk/card/clear — wipe all cards for a surface.
    if (method === "POST" && pathname === "/api/talk/card/clear") {
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return true;
      const body = (parsed.body ?? {}) as { sessionId?: unknown };
      if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
        badRequest(res, "sessionId must be a non-empty string");
        return true;
      }
      if (rejectCrossSessionBody(body.sessionId)) return true;
      context.emit(TALK_EVENTS.cardClear, { sessionId: body.sessionId });
      json(res, { ok: true });
      return true;
    }

    // POST /api/talk/delegate — server-owned spawn-vs-continue for COO threads.
    // The orchestrator's ONLY delegation surface: thread:"new" spawns a COO child,
    // thread:"<id>" continues that child. Goes through the normal /api/sessions
    // routes internally so queueing/talk:focus/parent-callbacks behave identically.
    if (method === "POST" && pathname === "/api/talk/delegate") {
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return true;
      const config = context.getConfig();
      const base = gatewayBaseUrl({ port: config.gateway?.port || 8888, host: config.gateway?.host });
      const headers = jsonApiHeaders(context.apiToken ?? context.gatewayAuthToken);
      // Attachments persist by merging into the talk session's transport_meta;
      // updateSessionMeta wraps the generic updateSession meta writer.
      const attachmentDeps = {
        getSession,
        updateSessionMeta: (id: string, transportMeta: JsonObject | null) =>
          updateSession(id, { transportMeta }),
      };
      const result = await delegateToThread(parsed.body, {
        getSession,
        listChildSessions,
        updateSession: (id, updates) => updateSession(id, updates),
        emit: context.emit,
        attachments: {
          attach: (talkId, targetId, mode) => attach(talkId, targetId, mode, attachmentDeps),
          detach: (talkId, targetId) => detach(talkId, targetId, attachmentDeps),
          list: (talkId) => listAttachments(talkId, attachmentDeps),
        },
        emitAttachmentChange: (talkRootId, target, change, mode) =>
          emitAttachmentChange(talkRootId, target, change, mode, context.emit),
        spawnChild: async ({ prompt, parentSessionId, promptExcerpt }) => {
          const r = await fetch(`${base}/api/sessions`, {
            method: "POST",
            headers,
            body: JSON.stringify({ prompt, parentSessionId, promptExcerpt }),
          });
          await assertFetchOk(r, "spawn");
          return (await r.json()) as { id: string };
        },
        continueThread: async (id, message) => {
          const r = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/message`, {
            method: "POST",
            headers,
            body: JSON.stringify({ message }),
          });
          await assertFetchOk(r, "continue");
        },
      });
      if (result.ok) json(res, result);
      else
        json(
          res,
          { error: result.error, threads: result.threads, attachments: result.attachments },
          result.status,
        );
      return true;
    }

    // POST /api/talk/mute — the client's silent/read-mode toggle. When muted,
    // the run loop skips Kokoro synthesis for this talk session entirely (the
    // browser plays nothing), saving a neural-TTS call + latency per turn.
    if (method === "POST" && pathname === "/api/talk/mute") {
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return true;
      const body = (parsed.body ?? {}) as { sessionId?: unknown; muted?: unknown };
      if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
        badRequest(res, "sessionId must be a non-empty string");
        return true;
      }
      if (typeof body.muted !== "boolean") {
        badRequest(res, "muted must be a boolean");
        return true;
      }
      if (rejectCrossSessionBody(body.sessionId)) return true;
      setTalkMuted(body.sessionId, body.muted);
      json(res, { ok: true, muted: body.muted });
      return true;
    }

    // POST /api/talk/thread/label — set/refine a COO thread's topic label.
    // The orchestrator calls this so a thread shows a clean human topic in the
    // thread panel instead of the raw dispatch text. sessionId = the talk surface,
    // threadId = the COO child session id.
    if (method === "POST" && pathname === "/api/talk/thread/label") {
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return true;
      const body = (parsed.body ?? {}) as { sessionId?: unknown; threadId?: unknown; label?: unknown };
      if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
        badRequest(res, "sessionId must be a non-empty string");
        return true;
      }
      if (typeof body.threadId !== "string" || body.threadId.length === 0) {
        badRequest(res, "threadId must be a non-empty string");
        return true;
      }
      if (typeof body.label !== "string" || body.label.trim().length === 0) {
        badRequest(res, "label must be a non-empty string");
        return true;
      }
      if (rejectCrossSessionBody(body.sessionId)) return true;
      context.emit(TALK_EVENTS.threadLabel, {
        sessionId: body.sessionId,
        threadId: body.threadId,
        label: body.label.trim(),
      });
      json(res, { ok: true });
      return true;
    }

    // Unknown /api/talk/* path — let api.ts fall through to its 404.
    return false;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    json(res, { ok: false, error }, 500);
    return true;
  }
}

// ── Local copies of api.ts response helpers ─────────────────────────────
function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function badRequest(res: ServerResponse, message: string): void {
  json(res, { error: message }, 400);
}
