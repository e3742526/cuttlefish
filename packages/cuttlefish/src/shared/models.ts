import type {
  CuttlefishConfig,
  ModelInfo,
  ModelRegistry,
  EngineRegistryEntry,
  EffortMechanism,
  EngineModelsConfig,
} from "./types.js";
import { logger } from "./logger.js";
import { resolveBin, isInstalled } from "./resolve-bin.js";
import { discoverPiModels } from "./pi-models.js";
import {
  discoverGrokModels,
  GROK_EFFORT_LEVELS,
  knownGrokModels,
  type GrokModelDiscovery,
} from "./grok-models.js";
import {
  discoverHermesModels,
  knownHermesModels,
  HERMES_EFFORT_LEVELS,
  type HermesModelDiscovery,
} from "./hermes-models.js";
import { discoverAiderModels, knownAiderModels, type AiderModelDiscovery } from "./aider-models.js";

/**
 * Model + capability registry — the single source of truth for which engines and
 * models exist and what they support (effort levels, availability).
 *
 * Sources, in precedence order per engine:
 *   1. Dynamic discovery (pi/grok), refreshed at boot and on config reload into
 *      snapshots that the (synchronous) registry reads.
 *   2. The optional `models:` block in config.yaml.
 *   3. Synthesis from `engines.<name>.model` (back-compat default).
 *
 * `available` reflects whether the engine's binary is actually installed, so the
 * UI can hide engines you don't have.
 */

/** Engines registered in this build (mirrors server.ts engine map). */
const ENGINE_NAMES = ["claude", "codex", "antigravity", "grok", "pi", "kiro", "hermes", "ollama", "kilo", "aider"] as const;
export type EngineName = (typeof ENGINE_NAMES)[number];

/** Binary name probed for each engine's availability (override via engines.<name>.bin). */
const ENGINE_BIN: Record<EngineName, string> = {
  claude: "claude",
  codex: "codex",
  antigravity: "agy",
  grok: "grok",
  pi: "pi",
  kiro: "kiro-cli",
  hermes: "hermes",
  ollama: "ollama",
  kilo: "kilo",
  aider: "aider",
};

const EFFORT_MECHANISM: Record<EngineName, EffortMechanism> = {
  claude: "claude-flag",
  codex: "codex-config",
  antigravity: "none",
  grok: "grok-flag",
  pi: "pi-flag",
  kiro: "kiro-flag",
  hermes: "none",
  ollama: "none",
  kilo: "none",
  aider: "none",
};

export const CODEX_DEFAULT_MODEL = "gpt-5.5";

/** Conservative per-engine defaults used when synthesizing (no `models:` block). */
const SYNTH_DEFAULTS: Record<EngineName, { supportsEffort: boolean; effortLevels: string[]; fallbackModel: string }> = {
  claude: { supportsEffort: true, effortLevels: ["low", "medium", "high"], fallbackModel: "opus" },
  codex: { supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh"], fallbackModel: CODEX_DEFAULT_MODEL },
  antigravity: { supportsEffort: false, effortLevels: [], fallbackModel: "Gemini 3.5 Flash (Medium)" },
  grok: { supportsEffort: true, effortLevels: GROK_EFFORT_LEVELS, fallbackModel: "grok-build" },
  // Placeholder shown only in the brief window before pi discovery completes; the
  // provider/id form keeps it well-typed for the engine's split.
  pi: { supportsEffort: false, effortLevels: [], fallbackModel: "ollama/gemma4:12b" },
  kiro: { supportsEffort: true, effortLevels: ["low", "medium", "high"], fallbackModel: "auto" },
  hermes: { supportsEffort: false, effortLevels: HERMES_EFFORT_LEVELS, fallbackModel: "openai-codex:gpt-5.5" },
  ollama: { supportsEffort: false, effortLevels: [], fallbackModel: "gemma4" },
  kilo: { supportsEffort: false, effortLevels: [], fallbackModel: "kilo-auto/free" },
  // Aider auto-detects its model from whichever API key is in env; "default" is a
  // sentinel meaning "don't pass --model" (the engine omits the flag for it).
  aider: { supportsEffort: false, effortLevels: [], fallbackModel: "default" },
};

/** Optional per-engine `bin` override from config. */
function engineBinOverride(config: CuttlefishConfig, name: EngineName): string | undefined {
  return (config.engines as unknown as Record<string, { bin?: string } | undefined>)[name]?.bin;
}

/** Whether an engine's binary is installed (gates UI visibility). */
export function engineAvailable(config: CuttlefishConfig, name: EngineName): boolean {
  const bin = ENGINE_BIN[name];
  // Unknown engine name (e.g. a typo in config.sessions.fallbackEngine) → not available.
  if (!bin) return false;
  return isInstalled(bin, engineBinOverride(config, name));
}

/** Type guard: is `name` one of the known engines? */
export function isKnownEngine(name: string): name is EngineName {
  return (ENGINE_NAMES as readonly string[]).includes(name);
}

/** Install hint per engine, surfaced when a missing CLI blocks a session. */
const ENGINE_INSTALL_HINT: Record<EngineName, string> = {
  claude: "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  antigravity: "install the Antigravity CLI (agy)",
  grok: "npm install -g @xai-official/grok, then run grok once to authenticate",
  pi: "install the Pi CLI",
  kiro: "install kiro-cli, then authenticate it or set KIRO_API_KEY",
  hermes: "install the Hermes CLI: curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
  ollama: "install Ollama from https://ollama.com/download and pull a model, e.g. `ollama pull gemma4`",
  kilo: "npm install -g @kilocode/cli, then run `kilo` and use /connect to add a provider",
  aider: "install Aider (`python -m pip install aider-install && aider-install`, or `pipx install aider-chat`), then set an API key (e.g. ANTHROPIC_API_KEY or OPENAI_API_KEY)",
};

/** Actionable error message for a session blocked by a missing engine binary. */
export function engineUnavailableMessage(config: CuttlefishConfig, name: EngineName): string {
  const bin = engineBinOverride(config, name) || ENGINE_BIN[name];
  return `Engine "${name}" is not available — the "${bin}" CLI was not found on your PATH. Install it (${ENGINE_INSTALL_HINT[name]}) or set engines.${name}.bin in config.yaml to its full path, then retry.`;
}

/** Snapshot of dynamically-discovered Pi models (null until first discovery). */
let discoveredPiModels: ModelInfo[] | null = null;
/** Snapshot of dynamically-discovered Grok models (null until first discovery). */
let discoveredGrokModels: GrokModelDiscovery | null = null;
/** Snapshot of dynamically-discovered Hermes models (null until first discovery). */
let discoveredHermesModels: HermesModelDiscovery | null = null;
/** Snapshot of env-derived Aider models (null until first discovery). */
let discoveredAiderModels: AiderModelDiscovery | null = null;

/**
 * Discover Pi's local/custom models (`pi --list-models`) and refresh the registry.
 * Async — populates a snapshot the synchronous registry reads. Never throws;
 * degrades to the config/synthesized fallback when Pi is absent or discovery fails.
 */
export async function refreshPiModels(config: CuttlefishConfig): Promise<void> {
  if (!engineAvailable(config, "pi")) {
    discoveredPiModels = null;
    invalidateModelRegistry();
    return;
  }
  try {
    const bin = resolveBin("pi", engineBinOverride(config, "pi"));
    discoveredPiModels = await discoverPiModels(bin);
    logger.info(`Pi model discovery: ${discoveredPiModels.length} local model(s)`);
  } catch (err) {
    logger.warn(`Pi model discovery failed: ${err instanceof Error ? err.message : err}`);
    discoveredPiModels = null;
  } finally {
    invalidateModelRegistry();
  }
}

/**
 * Discover Grok's authenticated model list (`grok models`) and refresh the registry.
 * Never throws; until discovery succeeds the registry uses Cuttlefish's known Grok model
 * catalog so the UI still shows the public Grok choices.
 */
export async function refreshGrokModels(config: CuttlefishConfig): Promise<void> {
  if (!engineAvailable(config, "grok")) {
    discoveredGrokModels = null;
    invalidateModelRegistry();
    return;
  }
  try {
    const bin = resolveBin("grok", engineBinOverride(config, "grok"));
    discoveredGrokModels = await discoverGrokModels(bin);
    logger.info(`Grok model discovery: ${discoveredGrokModels.models.length} model(s)`);
  } catch (err) {
    logger.warn(`Grok model discovery failed: ${err instanceof Error ? err.message : err}`);
    discoveredGrokModels = null;
  } finally {
    invalidateModelRegistry();
  }
}

/**
 * Discover Hermes's available model list and refresh the registry.
 * Never throws; until discovery succeeds the registry uses Cuttlefish's known Hermes model
 * catalog so the UI still shows the public Hermes choices.
 */
export async function refreshHermesModels(config: CuttlefishConfig): Promise<void> {
  if (!engineAvailable(config, "hermes")) {
    discoveredHermesModels = null;
    invalidateModelRegistry();
    return;
  }
  try {
    const bin = resolveBin("hermes", engineBinOverride(config, "hermes"));
    discoveredHermesModels = await discoverHermesModels(bin);
    logger.info(`Hermes model discovery: ${discoveredHermesModels.models.length} model(s)`);
  } catch (err) {
    logger.warn(`Hermes model discovery failed: ${err instanceof Error ? err.message : err}`);
    discoveredHermesModels = null;
  } finally {
    invalidateModelRegistry();
  }
}

/**
 * Refresh the Aider model list from the gateway's provider API keys and refresh the
 * registry. Env-driven (no subprocess) — `aider --list-models` only filters litellm's
 * full catalog by substring, so it is unusable as a real "what can I run" probe.
 */
export async function refreshAiderModels(config: CuttlefishConfig): Promise<void> {
  if (!engineAvailable(config, "aider")) {
    discoveredAiderModels = null;
    invalidateModelRegistry();
    return;
  }
  try {
    discoveredAiderModels = discoverAiderModels(process.env);
    logger.info(`Aider model discovery: ${discoveredAiderModels.models.length} model(s) from provider env keys`);
  } catch (err) {
    logger.warn(`Aider model discovery failed: ${err instanceof Error ? err.message : err}`);
    discoveredAiderModels = null;
  } finally {
    invalidateModelRegistry();
  }
}

let cached: ModelRegistry | null = null;

/** Clear the cached registry. Call on config reload / PUT /api/config. */
export function invalidateModelRegistry(): void {
  cached = null;
}

/** Resolve the registry (cached). Pass the current config; cache is keyed by
 *  invalidation, not by config identity — call invalidateModelRegistry() to refresh. */
export function getModelRegistry(config: CuttlefishConfig): ModelRegistry {
  if (!cached) cached = buildRegistry(config);
  return cached;
}

/**
 * Valid effort levels for a session's engine+model, from the registry.
 * Returns [] when the engine/model doesn't support effort (e.g. antigravity) or
 * the engine is unknown. `modelId` defaults to the engine's default model.
 */
export function effortLevelsForModel(config: CuttlefishConfig, engine: string, modelId?: string): string[] {
  const entry = getModelRegistry(config)[engine];
  if (!entry) return [];
  const model =
    (modelId ? entry.models.find((m) => m.id === modelId) : undefined) ??
    entry.models.find((m) => m.id === entry.defaultModel) ??
    entry.models[0];
  return model?.supportsEffort ? model.effortLevels : [];
}

/** Context window (tokens) for a session's engine+model, or undefined if unknown. */
export function contextWindowForModel(config: CuttlefishConfig, engine: string, modelId?: string): number | undefined {
  const entry = getModelRegistry(config)[engine];
  if (!entry) return undefined;
  const model =
    (modelId ? entry.models.find((m) => m.id === modelId) : undefined) ??
    entry.models.find((m) => m.id === entry.defaultModel) ??
    entry.models[0];
  return model?.contextWindow;
}

/** Build the registry without touching the cache (used by getModelRegistry + tests). */
export function buildRegistry(config: CuttlefishConfig): ModelRegistry {
  const synthesized = synthesizeFromEngineConfig(config);
  const block = config.models;

  const registry: ModelRegistry = {};
  for (const name of ENGINE_NAMES) {
    const available = engineAvailable(config, name);
    // Dynamic engine model discovery overrides
    // both the config block and synthesis.
    if (name === "pi") {
      registry[name] = buildPiEntry(config, block?.pi, synthesized[name], available);
      continue;
    }
    if (name === "grok") {
      registry[name] = buildGrokEntry(config, block?.grok, synthesized[name], available);
      continue;
    }
    if (name === "hermes") {
      registry[name] = buildHermesEntry(config, block?.hermes, synthesized[name], available);
      continue;
    }
    if (name === "aider") {
      registry[name] = buildAiderEntry(config, block?.aider, synthesized[name], available);
      continue;
    }
    const engineBlock = block?.[name];
    registry[name] = engineBlock
      ? fromEngineModelsConfig(name, engineBlock, available)
      : synthesized[name]; // engine omitted from the block → keep the synthesized entry
  }
  return registry;
}

/** Grok registry entry: discovered models > config `models.grok` block > known catalog. */
function buildGrokEntry(
  config: CuttlefishConfig,
  grokBlock: EngineModelsConfig | undefined,
  synthEntry: EngineRegistryEntry,
  available: boolean,
): EngineRegistryEntry {
  if (discoveredGrokModels && discoveredGrokModels.models.length > 0) {
    const models = mergeDiscoveredGrokModels(discoveredGrokModels.models, grokBlock);
    const pinned = config.engines.grok?.model;
    const configuredDefault = grokBlock?.default;
    const discoveredDefault = discoveredGrokModels.defaultModel;
    const validDefault = (id: string | undefined) => id && models.some((m) => m.id === id) ? id : undefined;
    const defaultModel =
      validDefault(pinned) ??
      validDefault(configuredDefault) ??
      validDefault(discoveredDefault) ??
      models[0].id;
    return { name: "grok", available, defaultModel, effortMechanism: "grok-flag", models };
  }
  if (grokBlock) return fromEngineModelsConfig("grok", grokBlock, available, config.engines.grok?.model);

  const known = knownGrokModels(config.engines.grok?.model);
  const defaultModel = known.defaultModel || synthEntry.defaultModel;
  return {
    name: "grok",
    available,
    defaultModel,
    effortMechanism: "grok-flag",
    models: known.models,
  };
}

/** Hermes registry entry: discovered models > config `models.hermes` block > known catalog. */
function buildHermesEntry(
  config: CuttlefishConfig,
  hermesBlock: EngineModelsConfig | undefined,
  synthEntry: EngineRegistryEntry,
  available: boolean,
): EngineRegistryEntry {
  const pinned = config.engines.hermes?.model;
  if (discoveredHermesModels && discoveredHermesModels.models.length > 0) {
    const models = discoveredHermesModels.models;
    const valid = (id?: string) => (id && models.some((m) => m.id === id) ? id : undefined);
    const defaultModel = valid(pinned) ?? valid(discoveredHermesModels.defaultModel) ?? models[0].id;
    return { name: "hermes", available, defaultModel, effortMechanism: "none", models };
  }
  if (hermesBlock) return fromEngineModelsConfig("hermes", hermesBlock, available, pinned);
  const known = knownHermesModels(pinned);
  return { name: "hermes", available, defaultModel: known.defaultModel || synthEntry.defaultModel, effortMechanism: "none", models: known.models };
}

/** Aider registry entry: env-discovered models > config `models.aider` block > known catalog. */
function buildAiderEntry(
  config: CuttlefishConfig,
  aiderBlock: EngineModelsConfig | undefined,
  synthEntry: EngineRegistryEntry,
  available: boolean,
): EngineRegistryEntry {
  const pinned = config.engines.aider?.model;
  if (discoveredAiderModels && discoveredAiderModels.models.length > 0) {
    const models = mergeDiscoveredAiderModels(discoveredAiderModels.models, aiderBlock, pinned);
    const valid = (id?: string) => (id && models.some((m) => m.id === id) ? id : undefined);
    const defaultModel = valid(pinned) ?? valid(aiderBlock?.default) ?? discoveredAiderModels.defaultModel ?? models[0].id;
    return { name: "aider", available, defaultModel, effortMechanism: "none", models };
  }
  if (aiderBlock) return fromEngineModelsConfig("aider", aiderBlock, available, pinned);
  const known = knownAiderModels(pinned);
  return { name: "aider", available, defaultModel: known.defaultModel || synthEntry.defaultModel, effortMechanism: "none", models: known.models };
}

/** Union the discovered aider models with any `models.aider` block entries and a pinned id. */
function mergeDiscoveredAiderModels(
  discovered: ModelInfo[],
  block: EngineModelsConfig | undefined,
  pinned: string | undefined,
): ModelInfo[] {
  const seen = new Set(discovered.map((m) => m.id));
  const models = [...discovered];
  if (block) {
    for (const m of block.models) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      models.push(modelInfoFromConfigEntry(m));
    }
  }
  if (pinned && pinned !== "default" && !seen.has(pinned)) {
    models.push({ id: pinned, label: pinned, supportsEffort: false, effortLevels: [] });
  }
  return models;
}

/** Pi registry entry: discovered models > config `models.pi` block > synthesized. */
function buildPiEntry(
  config: CuttlefishConfig,
  piBlock: EngineModelsConfig | undefined,
  synthEntry: EngineRegistryEntry,
  available: boolean,
): EngineRegistryEntry {
  if (discoveredPiModels && discoveredPiModels.length > 0) {
    let models = discoveredPiModels;
    const pinned = config.engines.pi?.model;
    if (pinned && !models.some((m) => m.id === pinned)) {
      models = [{
        id: pinned,
        label: pinned,
        supportsEffort: false,
        effortLevels: [],
      }, ...models];
    }
    const defaultModel = pinned || models[0].id;
    return { name: "pi", available, defaultModel, effortMechanism: "pi-flag", models };
  }
  if (piBlock) return fromEngineModelsConfig("pi", piBlock, available, config.engines.pi?.model);
  return { ...synthEntry, available };
}

/** Backward-compat: synthesize a minimal registry from engines.<name>.model. */
export function synthesizeFromEngineConfig(config: CuttlefishConfig): ModelRegistry {
  const registry: ModelRegistry = {};
  for (const name of ENGINE_NAMES) {
    const defaults = SYNTH_DEFAULTS[name];
    const engineCfg = (config.engines as unknown as Record<string, { model?: string } | undefined>)[name];
    const modelId = engineCfg?.model || defaults.fallbackModel;
    if (name === "grok") {
      const known = knownGrokModels(modelId);
      registry[name] = {
        name,
        available: engineAvailable(config, name),
        defaultModel: known.defaultModel || modelId,
        effortMechanism: EFFORT_MECHANISM[name],
        models: known.models,
      };
      continue;
    }
    const model: ModelInfo = {
      id: modelId,
      label: modelId,
      supportsEffort: defaults.supportsEffort,
      effortLevels: defaults.supportsEffort ? [...defaults.effortLevels] : [],
    };
    registry[name] = {
      name,
      available: engineAvailable(config, name),
      defaultModel: modelId,
      effortMechanism: EFFORT_MECHANISM[name],
      models: [model],
    };
  }
  return registry;
}

function modelInfoFromConfigEntry(m: EngineModelsConfig["models"][number]): ModelInfo {
  const supportsEffort = m.supportsEffort ?? false;
  return {
    id: m.id,
    label: m.label || m.id,
    supportsEffort,
    effortLevels: supportsEffort ? (m.effortLevels ?? []) : [],
    ...(typeof m.contextWindow === "number" ? { contextWindow: m.contextWindow } : {}),
  };
}

function fromEngineModelsConfig(
  name: EngineName,
  block: EngineModelsConfig,
  available: boolean,
  pinnedModel?: string,
): EngineRegistryEntry {
  const models: ModelInfo[] = (block.models ?? []).map((m) => {
    return modelInfoFromConfigEntry(m);
  });
  const validDefault = (id: string | undefined) => id && models.some((m) => m.id === id) ? id : undefined;
  const defaultModel = validDefault(pinnedModel) ?? validDefault(block.default) ?? models[0]?.id ?? SYNTH_DEFAULTS[name].fallbackModel;
  return {
    name,
    available,
    defaultModel,
    effortMechanism: block.effortMechanism ?? EFFORT_MECHANISM[name],
    models,
  };
}

function mergeDiscoveredGrokModels(discovered: ModelInfo[], block: EngineModelsConfig | undefined): ModelInfo[] {
  if (!block) return discovered;

  const configured = new Map(block.models.map((m) => [m.id, m]));
  const seen = new Set<string>();
  const merged = discovered.map((model) => {
    seen.add(model.id);
    const configuredModel = configured.get(model.id);
    if (!configuredModel) return model;

    const supportsEffort = configuredModel.supportsEffort ?? model.supportsEffort;
    return {
      id: model.id,
      label: configuredModel.label || model.label,
      supportsEffort,
      effortLevels: supportsEffort ? (configuredModel.effortLevels ?? model.effortLevels) : [],
      ...(typeof configuredModel.contextWindow === "number"
        ? { contextWindow: configuredModel.contextWindow }
        : typeof model.contextWindow === "number"
          ? { contextWindow: model.contextWindow }
          : {}),
    };
  });

  for (const configuredModel of block.models) {
    if (!seen.has(configuredModel.id)) merged.push(modelInfoFromConfigEntry(configuredModel));
  }

  return merged;
}
