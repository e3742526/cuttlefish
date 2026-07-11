import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import yaml from "js-yaml";
import { getModelRegistry, invalidateModelRegistry, refreshCodexModels, refreshGrokModels, refreshHermesModels, refreshPiModels } from "../../../shared/models.js";
import { collectEngineLimits } from "../../../shared/engine-limits.js";
import { CONFIG_PATH, CUTTLEFISH_HOME, LOGS_DIR, TMP_DIR } from "../../../shared/paths.js";
import { saveConfigAtomic, validateConfigShape } from "../../../shared/config.js";
import { logger } from "../../../shared/logger.js";
import { redactText } from "../../../shared/redact.js";
import { downloadModel, getSttStatus, resolveLanguages, transcribe as sttTranscribe, WHISPER_LANGUAGES } from "../../../stt/stt.js";
import { onboardingNeeded, applyEngineChoice } from "../../onboarding-policy.js";
import { readJsonBody, readBodyRaw, BodyTooLargeError } from "../../http-helpers.js";
import { safeWriteFile } from "../../../shared/safe-write.js";
import type { ApiContext } from "../context.js";
import { badRequest, json, serverError } from "../responses.js";
import { sanitizeConfigForApi, deepMerge } from "../../config-sanitize.js";
import { ttsStatus, validateTtsText, streamTtsSentences } from "../../../talk/tts-stream.js";

export async function handleSystemRoutes(
  method: string,
  pathname: string,
  req: HttpRequest,
  url: URL,
  res: ServerResponse,
  context: ApiContext,
): Promise<boolean> {
  if (method === "GET" && pathname === "/api/engines") {
    const config = context.getConfig();
    json(res, { default: config.engines.default, engines: getModelRegistry(config) });
    return true;
  }

  if (method === "POST" && pathname === "/api/engines/refresh") {
    const config = context.getConfig();
    await refreshCodexModels(config);
    await refreshPiModels(config);
    await refreshGrokModels(config);
    await refreshHermesModels(config);
    context.emit("engines:updated", {});
    json(res, { default: config.engines.default, engines: getModelRegistry(config) });
    return true;
  }

  if (method === "GET" && pathname === "/api/engine-limits") {
    const engine = url.searchParams.get("engine") || undefined;
    json(res, await collectEngineLimits(context.getConfig(), { engine }));
    return true;
  }

  if (method === "POST" && pathname === "/api/engine-limits/refresh") {
    const engine = url.searchParams.get("engine") || undefined;
    json(res, await collectEngineLimits(context.getConfig(), { engine }));
    return true;
  }

  if (method === "GET" && pathname === "/api/config") {
    json(res, sanitizeConfigForApi(context.getConfig()));
    return true;
  }

  if (method === "PUT" && pathname === "/api/config") {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      badRequest(res, "Config must be a JSON object");
      return true;
    }
    let existing: Record<string, unknown> = {};
    try {
      existing = yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown> || {};
    } catch { /* start fresh if unreadable */ }
    const merged = deepMerge(existing, body);
    const configProblems = validateConfigShape(merged);
    if (configProblems.length > 0) {
      badRequest(res, `Invalid config:\n- ${configProblems.join("\n- ")}`);
      return true;
    }
    saveConfigAtomic(merged);
    context.reloadConfig?.();
    invalidateModelRegistry();
    logger.info("Config updated via API");
    json(res, { status: "ok" });
    return true;
  }

  if (method === "GET" && pathname === "/api/logs") {
    const logFile = path.join(LOGS_DIR, "gateway.log");
    if (!fs.existsSync(logFile)) {
      json(res, { lines: [] });
      return true;
    }
    const n = parseInt(url.searchParams.get("n") || "100", 10);
    const maxBytes = 64 * 1024;
    const stat = fs.statSync(logFile);
    const readSize = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(logFile, "r");
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);
    const allLines = redactText(buf.toString("utf-8")).split("\n").filter(Boolean);
    json(res, { lines: allLines.slice(-n) });
    return true;
  }

  if (method === "GET" && pathname === "/api/onboarding") {
    const sessions = (await import("../../../sessions/registry.js")).listSessions();
    const hasEmployees = fs.existsSync(path.join(CUTTLEFISH_HOME, "org")) &&
      fs.readdirSync(path.join(CUTTLEFISH_HOME, "org"), { recursive: true }).some(
        (entry) => String(entry).endsWith(".yaml") && !String(entry).endsWith("department.yaml"),
      );
    const config = context.getConfig();
    const onboarded = config.portal?.onboarded === true;
    const setupComplete = config.portal?.setupComplete === true || onboarded;
    json(res, {
      needed: onboardingNeeded(onboarded),
      onboarded,
      setupComplete,
      conversationNeeded: !setupComplete,
      sessionsCount: sessions.length,
      hasEmployees,
      portalName: config.portal?.portalName ?? null,
      operatorName: config.portal?.operatorName ?? null,
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/onboarding") {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as Record<string, unknown>;
    const portalName = typeof body.portalName === "string" ? body.portalName : undefined;
    const operatorName = typeof body.operatorName === "string" ? body.operatorName : undefined;
    const language = typeof body.language === "string" ? body.language : undefined;
    const engine = typeof body.engine === "string" ? body.engine : undefined;
    const model = typeof body.model === "string" ? body.model : undefined;
    const effortLevel = typeof body.effortLevel === "string" ? body.effortLevel : undefined;

    const config = context.getConfig();
    const updated = {
      ...applyEngineChoice(config, { engine, model, effortLevel }),
      portal: {
        ...config.portal,
        onboarded: true,
        setupComplete: true,
        ...(portalName !== undefined && { portalName: portalName || undefined }),
        ...(operatorName !== undefined && { operatorName: operatorName || undefined }),
        ...(language !== undefined && { language: language || undefined }),
      },
    };

    saveConfigAtomic(updated, { lineWidth: -1 });
    context.reloadConfig?.();
    logger.info(`Onboarding: portal name="${portalName}", operator="${operatorName}", language="${language}"`);

    const effectiveName = String(portalName || "Cuttlefish");
    const languageSection = language && language !== "English"
      ? `\n\n## Language\nAlways respond in ${language}. All communication with the user must be in ${language}.`
      : "";

    const personalizeManual = (filePath: string) => {
      let md = fs.readFileSync(filePath, "utf-8");
      md = md.replace(/^You are \*\*[^*]+\*\*/m, `You are **${effectiveName}**`);
      md = md.replace(/\n\n## Language\nAlways respond in .+\. All communication with the user must be in .+\./m, "");
      if (languageSection) md = md.trimEnd() + languageSection + "\n";
      safeWriteFile(filePath, md);
    };

    const claudeMdPath = path.join(CUTTLEFISH_HOME, "CLAUDE.md");
    if (fs.existsSync(claudeMdPath)) personalizeManual(claudeMdPath);
    const agentsMdPath = path.join(CUTTLEFISH_HOME, "AGENTS.md");
    if (fs.existsSync(agentsMdPath) && !fs.lstatSync(agentsMdPath).isSymbolicLink()) {
      personalizeManual(agentsMdPath);
    }

    context.emit("config:updated", { portal: updated.portal });
    json(res, { status: "ok", portal: updated.portal });
    return true;
  }

  if (method === "GET" && pathname === "/api/stt/status") {
    const config = context.getConfig();
    const languages = resolveLanguages(config.stt);
    json(res, getSttStatus(config.stt?.model, languages));
    return true;
  }

  if (method === "POST" && pathname === "/api/stt/download") {
    const config = context.getConfig();
    const model = config.stt?.model || "small";

    downloadModel(model, (progress) => {
      context.emit("stt:download:progress", { progress });
    }).then(() => {
      try {
        const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
        const cfg = yaml.load(raw) as Record<string, unknown>;
        if (!cfg.stt || typeof cfg.stt !== "object") cfg.stt = {};
        const sttCfg = cfg.stt as Record<string, unknown>;
        sttCfg.enabled = true;
        sttCfg.model = model;
        if (!sttCfg.languages) sttCfg.languages = ["en"];
        saveConfigAtomic(cfg, { lineWidth: -1 });
      } catch (err) {
        logger.error(`Failed to update config after STT download: ${err}`);
      }
      context.emit("stt:download:complete", { model });
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`STT download failed: ${msg}`);
      context.emit("stt:download:error", { error: msg });
    });

    json(res, { status: "downloading", model });
    return true;
  }

  if (method === "POST" && pathname === "/api/stt/transcribe") {
    const config = context.getConfig();
    const model = config.stt?.model || "small";
    const languages = resolveLanguages(config.stt);
    const requestedLang = url.searchParams.get("language");
    const language = requestedLang && languages.includes(requestedLang) ? requestedLang : languages[0];

    // Cap the raw audio while streaming so an oversized upload is rejected before
    // the whole buffer is held in memory, not after (AR-07).
    const STT_MAX_AUDIO_BYTES = 100 * 1024 * 1024;
    let audioBuffer: Buffer;
    try {
      audioBuffer = await readBodyRaw(req, { maxBytes: STT_MAX_AUDIO_BYTES });
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        badRequest(res, "Audio too large (100MB max)");
        return true;
      }
      throw err;
    }
    if (audioBuffer.length === 0) {
      badRequest(res, "No audio data");
      return true;
    }

    const contentType = req.headers["content-type"] || "audio/webm";
    const ext = contentType.includes("wav") ? ".wav"
      : contentType.includes("mp4") || contentType.includes("m4a") ? ".m4a"
      : contentType.includes("ogg") ? ".ogg"
      : ".webm";

    const tmpFile = path.join(TMP_DIR, `stt-${crypto.randomUUID()}${ext}`);
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.writeFileSync(tmpFile, audioBuffer);

    try {
      json(res, { text: await sttTranscribe(tmpFile, model, language) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`STT transcription failed: ${msg}`);
      serverError(res, `Transcription failed: ${msg}`);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
    return true;
  }

  if (method === "PUT" && pathname === "/api/stt/config") {
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const body = parsed.body as { languages?: unknown[] };
    const langs = body.languages;
    if (!Array.isArray(langs) || langs.length === 0) {
      badRequest(res, "languages must be a non-empty array");
      return true;
    }
    const invalid = langs.filter((lang) => typeof lang !== "string" || !WHISPER_LANGUAGES[lang]);
    if (invalid.length > 0) {
      badRequest(res, `Invalid language codes: ${invalid.join(", ")}`);
      return true;
    }
    try {
      const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
      const cfg = yaml.load(raw) as Record<string, unknown>;
      if (!cfg.stt || typeof cfg.stt !== "object") cfg.stt = {};
      const sttCfg = cfg.stt as Record<string, unknown>;
      sttCfg.languages = langs;
      delete sttCfg.language;
      saveConfigAtomic(cfg, { lineWidth: -1 });
      json(res, { status: "ok", languages: langs });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      serverError(res, `Failed to update STT config: ${msg}`);
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/tts") {
    const { available, voice } = ttsStatus(context.getConfig().talk?.kokoro);
    json(res, { available, voice });
    return true;
  }

  if (method === "POST" && pathname === "/api/tts") {
    const kokoroOpts = context.getConfig().talk?.kokoro;
    if (!ttsStatus(kokoroOpts).available) {
      json(res, { available: false }, 503);
      return true;
    }
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return true;
    const valid = validateTtsText((parsed.body as { text?: unknown } | null)?.text);
    if (!valid.ok) {
      badRequest(res, valid.error);
      return true;
    }

    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });
    let cancelled = false;
    req.on("close", () => {
      cancelled = true;
    });
    try {
      await streamTtsSentences(
        valid.text,
        kokoroOpts,
        (wav) => {
          const header = Buffer.allocUnsafe(4);
          header.writeUInt32BE(wav.length, 0);
          res.write(header);
          res.write(wav);
        },
        () => cancelled || res.writableEnded,
      );
    } catch (err) {
      logger.warn(`TTS stream failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.writableEnded) res.end();
    return true;
  }

  return false;
}
