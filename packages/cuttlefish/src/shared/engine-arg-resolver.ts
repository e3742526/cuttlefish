/**
 * Engine invocation arg resolution — reconciles EXPLICIT requirements (operator
 * effortLevel, employee cliFlags) against an engine's IMPLICIT capabilities (what
 * its CLI actually accepts, per the model registry).
 *
 * The canonical conflict: an engine with no reasoning-effort mechanism (e.g. kilo,
 * ollama, aider, hermes, antigravity) is handed an effort level or an explicit
 * `--effort`/`--reasoning-effort` flag. The engine's CLI rejects the unknown flag
 * and the turn fails. Rather than let explicit config silently break a harness, we
 * strip the conflicting inputs here and log what was dropped, so the implicit
 * capability wins deterministically.
 *
 * This is the single chokepoint both dispatch paths (sessions/manager.ts and
 * gateway/run-web-session.ts) call right before engine.run().
 */
import { logger } from "./logger.js";
import { getModelRegistry } from "./models.js";
import type { CuttlefishConfig } from "./types.js";

/** Reasoning-effort flags we recognize, so we can strip them from cliFlags when
 *  the target engine has no effort mechanism. Compared on the flag's bare name
 *  (the part before any `=`), case-insensitively. */
const EFFORT_FLAG_NAMES = new Set([
  "--effort",
  "--effort-level",
  "--reasoning-effort",
  "--reasoning",
  "--thinking",
  "--thinking-tokens",
  "--thinking-budget",
]);

function bareFlagName(token: string): string {
  return token.split("=", 1)[0].toLowerCase();
}

function isEffortFlag(token: string): boolean {
  return EFFORT_FLAG_NAMES.has(bareFlagName(token));
}

export interface EngineInvocationInput {
  effortLevel?: string;
  cliFlags?: string[];
}

export interface ResolvedEngineInvocation {
  effortLevel?: string;
  cliFlags?: string[];
  /** Human-readable notes about what was reconciled (also logged at warn level). */
  warnings: string[];
}

/**
 * Reconcile explicit invocation inputs against the engine's implicit capabilities.
 * Currently resolves the effort conflict; extend here for future capability gates
 * (e.g. attachments, MCP) as engines diverge.
 */
export function resolveEngineInvocation(
  config: CuttlefishConfig,
  engine: string,
  input: EngineInvocationInput,
): ResolvedEngineInvocation {
  const entry = getModelRegistry(config)[engine];
  // Unknown engine → leave inputs untouched (the dispatcher will surface the real
  // "engine not available" error); we only gate KNOWN capability mismatches.
  const supportsEffort = entry ? entry.effortMechanism !== "none" : true;
  const warnings: string[] = [];

  let effortLevel = input.effortLevel;
  let cliFlags = input.cliFlags;

  if (!supportsEffort) {
    if (effortLevel && effortLevel !== "default") {
      warnings.push(
        `engine "${engine}" has no reasoning-effort mechanism — dropping effortLevel "${effortLevel}" (explicit request yields to engine capability).`,
      );
      effortLevel = undefined;
    }
    if (cliFlags?.length) {
      const kept: string[] = [];
      for (let i = 0; i < cliFlags.length; i++) {
        const token = cliFlags[i];
        if (isEffortFlag(token)) {
          // Drop the flag, and its value when supplied as a separate token
          // (`--effort high`) rather than inline (`--effort=high`).
          const hasInlineValue = token.includes("=");
          const next = cliFlags[i + 1];
          const consumesNext = !hasInlineValue && next !== undefined && !next.startsWith("-");
          warnings.push(
            `engine "${engine}" rejects effort flag "${token}${consumesNext ? ` ${next}` : ""}" — stripped (engine has no effort mechanism).`,
          );
          if (consumesNext) i++;
          continue;
        }
        kept.push(token);
      }
      cliFlags = kept;
    }
  }

  for (const w of warnings) logger.warn(`[engine-args] ${w}`);
  return { effortLevel, cliFlags, warnings };
}
