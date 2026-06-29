import fs from "node:fs";
import path from "node:path";
import type { Employee, CuttlefishConfig } from "../shared/types.js";
import { getModelRegistry, effortLevelsForModel } from "../shared/models.js";
import { logger } from "../shared/logger.js";

export interface CwdValidationResult {
  ok: boolean;
  /** Realpath-resolved absolute directory when ok. */
  cwd?: string;
  error?: string;
}

/**
 * Validate a requested working directory for a new session.
 *
 * No silent fallback (AGENTS.md "never silently fail"): a missing/invalid/
 * out-of-bounds path returns `{ ok:false, error }` for the caller to surface as
 * a 400 — it does NOT quietly revert to CUTTLEFISH_HOME. Resolves realpath first so
 * `..` traversal and symlinks cannot escape `roots`.
 *
 * @param roots Optional allow-list. Empty/omitted = free-browse (any readable
 *   directory) — appropriate for single-user loopback; operators fronting the
 *   gateway with SSO should configure `workspaces.roots` to lock this down.
 */
export function validateCwd(input: unknown, opts?: { roots?: string[] }): CwdValidationResult {
  if (typeof input !== "string" || input.trim() === "") {
    return { ok: false, error: "cwd must be a non-empty string" };
  }
  let resolved: string;
  try {
    resolved = fs.realpathSync(path.resolve(input));
  } catch {
    return { ok: false, error: `cwd does not exist: ${input}` };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { ok: false, error: `cwd is not accessible: ${input}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: `cwd is not a directory: ${input}` };
  }
  const roots = (opts?.roots ?? []).filter((r) => typeof r === "string" && r.trim() !== "");
  if (roots.length > 0) {
    const realRoots = roots.map((r) => {
      try {
        return fs.realpathSync(path.resolve(r));
      } catch {
        return path.resolve(r);
      }
    });
    const inside = realRoots.some((r) => resolved === r || resolved.startsWith(r + path.sep));
    if (!inside) {
      return { ok: false, error: `cwd is outside allowed workspace roots: ${input}` };
    }
  }
  return { ok: true, cwd: resolved };
}

/**
 * Validate a mid-chat model/effort change for an existing session.
 *
 * Engine is NOT switchable mid-chat (new-chat only), so this only handles
 * `model` and `effortLevel`, validated against the registry for the session's
 * (fixed) engine. The change applies from the NEXT turn — the SessionManager
 * reads session.model / session.effortLevel fresh on every turn and passes them
 * (with resumeSessionId) to the engine, which our spike confirmed honors a
 * changed --model in place (no fork needed). Antigravity supports --model; if
 * its CLI is already warm, the new model applies on the next cold spawn/resume.
 */

export interface SessionPatchResult {
  ok: boolean;
  updates?: { model?: string; effortLevel?: string };
  error?: string;
}

export interface NewSessionSelectionResult {
  ok: boolean;
  engine?: string;
  model?: string;
  effortLevel?: string;
  error?: string;
}

export interface SessionPatchContext {
  engineSessionId?: string | null;
  defaultModel?: string | null;
}

export function validateNewSessionSelection(
  config: CuttlefishConfig,
  body: { engine?: unknown; model?: unknown; effortLevel?: unknown },
  defaults: { engine?: string; model?: string; effortLevel?: string } = {},
): NewSessionSelectionResult {
  const registry = getModelRegistry(config);
  let engine: string = defaults.engine?.trim() || config.engines.default;

  if (body.engine !== undefined) {
    if (typeof body.engine !== "string" || !body.engine.trim()) {
      return { ok: false, error: "engine must be a non-empty string" };
    }
    engine = body.engine.trim();
  }

  const entry = registry[engine];
  if (!entry) return { ok: false, error: `unknown engine "${engine}"` };

  let model: string | undefined;
  const requestedModel = body.model !== undefined ? body.model : defaults.model;
  if (requestedModel !== undefined) {
    if (typeof requestedModel !== "string" || !requestedModel.trim()) {
      return { ok: false, error: "model must be a non-empty string" };
    }
    model = requestedModel.trim();
    if (!entry.models.some((m) => m.id === model)) {
      if (engine === "pi") {
        // Pi models are discovered dynamically; tolerate an id the snapshot hasn't
        // caught yet (e.g. just after a restart, before discovery completes).
        logger.warn(`pi model "${model}" not in discovered set yet — allowing`);
      } else {
        const known = entry.models.map((m) => m.id).join(", ");
        return { ok: false, error: `unknown model "${model}" for engine "${engine}" (known: ${known || "none"})` };
      }
    }
  }

  let effortLevel: string | undefined;
  const requestedEffortLevel = body.effortLevel !== undefined ? body.effortLevel : defaults.effortLevel;
  if (requestedEffortLevel !== undefined) {
    if (typeof requestedEffortLevel !== "string" || !requestedEffortLevel.trim()) {
      return { ok: false, error: "effortLevel must be a non-empty string" };
    }
    effortLevel = requestedEffortLevel.trim();
    const effectiveModel = model ?? undefined;
    const valid = effortLevelsForModel(config, engine, effectiveModel);
    if (valid.length === 0) {
      logger.warn(
        `Ignoring effortLevel "${effortLevel}" for engine "${engine}"${effectiveModel ? ` model "${effectiveModel}"` : ""} because it does not support effort levels`,
      );
      effortLevel = undefined;
    } else if (!valid.includes(effortLevel)) {
      return { ok: false, error: `invalid effortLevel "${effortLevel}" (valid: ${valid.join(", ")})` };
    }
  }

  return { ok: true, engine, model, effortLevel };
}

export function validateSessionPatch(
  config: CuttlefishConfig,
  engine: string,
  currentModel: string | null | undefined,
  body: { model?: unknown; effortLevel?: unknown },
  context: SessionPatchContext = {},
): SessionPatchResult {
  const updates: { model?: string; effortLevel?: string } = {};

  const entry = getModelRegistry(config)[engine];

  // --- model ---
  if (body.model !== undefined) {
    if (typeof body.model !== "string" || !body.model.trim()) {
      return { ok: false, error: "model must be a non-empty string" };
    }
    const modelId = body.model.trim();
    if (entry && !entry.models.some((m) => m.id === modelId)) {
      if (engine === "pi") {
        // Pi models are discovered dynamically; tolerate an id the snapshot hasn't
        // caught yet (e.g. just after a restart, before discovery completes).
        logger.warn(`pi model "${modelId}" not in discovered set yet — allowing`);
      } else {
        const known = entry.models.map((m) => m.id).join(", ");
        return { ok: false, error: `unknown model "${modelId}" for engine "${engine}" (known: ${known || "none"})` };
      }
    }
    const effectiveCurrentModel = currentModel ?? context.defaultModel ?? undefined;
    if (engine === "grok" && context.engineSessionId && effectiveCurrentModel && modelId !== effectiveCurrentModel) {
      return {
        ok: false,
        error: "Grok model changes require a new session because Grok binds existing transcripts to a model-specific agent.",
      };
    }
    updates.model = modelId;
  }

  // --- effortLevel (validated against the *resulting* model) ---
  if (body.effortLevel !== undefined) {
    if (typeof body.effortLevel !== "string" || !body.effortLevel.trim()) {
      return { ok: false, error: "effortLevel must be a non-empty string" };
    }
    const level = body.effortLevel.trim();
    const effectiveModel = updates.model ?? currentModel ?? undefined;
    const valid = effortLevelsForModel(config, engine, effectiveModel);
    if (valid.length === 0) {
      return { ok: false, error: `engine "${engine}"${effectiveModel ? ` model "${effectiveModel}"` : ""} does not support effort levels` };
    }
    if (!valid.includes(level)) {
      return { ok: false, error: `invalid effortLevel "${level}" (valid: ${valid.join(", ")})` };
    }
    updates.effortLevel = level;
  }

  if (updates.model === undefined && updates.effortLevel === undefined) {
    return { ok: false, error: "no valid fields to update (expected model and/or effortLevel)" };
  }
  return { ok: true, updates };
}
