import type { CuttlefishConfig, ModelInfo } from "./types.js";
import { readCodexAppServerResult } from "./codex-app-server.js";

type JsonRecord = Record<string, unknown>;
const CODEX_MODEL_LIST_PAGE_LIMIT = 20;
const CODEX_MODEL_LIST_PAGE_TIMEOUT_MS = 8000;
const CODEX_MODEL_LIST_DISCOVERY_TIMEOUT_MS = 15000;

export interface CodexModelDiscovery {
  defaultModel?: string;
  models: ModelInfo[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function reasoningEfforts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const levels = value
    .map((entry) => isRecord(entry) ? str(entry.reasoningEffort) : str(entry))
    .filter((level): level is string => typeof level === "string" && level.length > 0);
  return Array.from(new Set(levels));
}

// The app-server `model/list` Model schema (verified via `codex app-server
// generate-json-schema` against codex-cli 0.142.5) has no context-window/token-limit
// field, so contextWindow is intentionally left unmapped here — configured fallback
// metadata (models.codex.models[].contextWindow) is the only source for it.
function modelInfoFromCodex(value: unknown): (ModelInfo & { isDefault: boolean }) | null {
  if (!isRecord(value)) return null;
  const id = str(value.id) ?? str(value.model);
  if (!id) return null;
  const effortLevels = reasoningEfforts(value.supportedReasoningEfforts);
  return {
    id,
    label: str(value.displayName) ?? id,
    supportsEffort: effortLevels.length > 0,
    effortLevels,
    isDefault: value.isDefault === true,
  };
}

export async function discoverCodexModels(config: CuttlefishConfig): Promise<CodexModelDiscovery> {
  const seen = new Set<string>();
  const seenCursors = new Set<string>();
  const models: ModelInfo[] = [];
  let defaultModel: string | undefined;
  let cursor: string | undefined;
  let pages = 0;
  const deadline = Date.now() + CODEX_MODEL_LIST_DISCOVERY_TIMEOUT_MS;

  while (pages < CODEX_MODEL_LIST_PAGE_LIMIT) {
    const remainingTimeoutMs = deadline - Date.now();
    if (remainingTimeoutMs <= 0) break;
    pages += 1;
    const result = await readCodexAppServerResult(config, {
      method: "model/list",
      params: {
        ...(cursor ? { cursor } : {}),
        includeHidden: false,
        limit: 100,
      },
      timeoutMs: Math.min(CODEX_MODEL_LIST_PAGE_TIMEOUT_MS, remainingTimeoutMs),
    });
    const data = Array.isArray(result.data) ? result.data : [];
    for (const entry of data) {
      const model = modelInfoFromCodex(entry);
      if (!model || seen.has(model.id)) continue;
      seen.add(model.id);
      if (!defaultModel && model.isDefault) defaultModel = model.id;
      models.push({
        id: model.id,
        label: model.label,
        supportsEffort: model.supportsEffort,
        effortLevels: model.effortLevels,
      });
    }
    const nextCursor = str(result.nextCursor);
    if (!nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return { defaultModel, models };
}
