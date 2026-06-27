import type { ModelInfo } from "./types.js";

/**
 * Aider model "discovery" is env-driven, not CLI-driven. `aider --list-models` only
 * filters litellm's full static catalog by substring (hundreds of entries, key-agnostic,
 * and it writes `.gitignore` as a side effect), so it is useless as a "what can I run"
 * probe. Instead we surface aider's stable model handles for whichever provider API keys
 * are actually present in the gateway env — exactly the models aider could auth and run.
 * The model field stays free-text, so anything not listed here still works.
 */

export interface AiderModelDiscovery {
  defaultModel?: string;
  models: ModelInfo[];
}

interface AiderProvider {
  /** Any of these env vars present ⇒ this provider's models are usable. */
  envKeys: string[];
  /** Curated handles. Prefer aider's self-updating aliases (sonnet, opus, gemini, …)
   *  over dated ids so the list does not rot as providers ship new model versions. */
  models: Array<{ id: string; label: string }>;
}

const AIDER_PROVIDERS: AiderProvider[] = [
  {
    envKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
    models: [
      { id: "sonnet", label: "Claude Sonnet (aider alias)" },
      { id: "opus", label: "Claude Opus (aider alias)" },
      { id: "haiku", label: "Claude Haiku (aider alias)" },
    ],
  },
  {
    envKeys: ["OPENAI_API_KEY"],
    models: [
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "gpt-4.1", label: "GPT-4.1" },
      { id: "o3", label: "OpenAI o3" },
      { id: "o4-mini", label: "OpenAI o4-mini" },
    ],
  },
  {
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    models: [
      { id: "gemini", label: "Gemini 2.5 Pro (aider alias)" },
      { id: "flash", label: "Gemini 2.5 Flash (aider alias)" },
    ],
  },
  {
    envKeys: ["DEEPSEEK_API_KEY"],
    models: [
      { id: "deepseek", label: "DeepSeek Chat (aider alias)" },
      { id: "r1", label: "DeepSeek R1 (aider alias)" },
    ],
  },
  {
    envKeys: ["XAI_API_KEY"],
    models: [{ id: "xai/grok-3", label: "xAI Grok 3" }],
  },
  {
    envKeys: ["GROQ_API_KEY"],
    models: [{ id: "groq/llama-3.3-70b-versatile", label: "Groq Llama 3.3 70B" }],
  },
  {
    envKeys: ["MISTRAL_API_KEY"],
    models: [{ id: "mistral/mistral-large-latest", label: "Mistral Large" }],
  },
];

/** The "let aider auto-detect from env" sentinel — always offered, always default. */
const AUTO_MODEL: ModelInfo = { id: "default", label: "Aider (auto)", supportsEffort: false, effortLevels: [] };

function toModelInfo(m: { id: string; label: string }): ModelInfo {
  return { id: m.id, label: m.label, supportsEffort: false, effortLevels: [] };
}

/** Minimal fallback when no provider keys are detected: just auto (+ any pinned model). */
export function knownAiderModels(pinned?: string): AiderModelDiscovery {
  const models: ModelInfo[] = [AUTO_MODEL];
  if (pinned && pinned !== "default") models.push(toModelInfo({ id: pinned, label: pinned }));
  return { defaultModel: "default", models };
}

/** Build the aider model list from the provider API keys present in `env`. */
export function discoverAiderModels(env: NodeJS.ProcessEnv = process.env): AiderModelDiscovery {
  const models: ModelInfo[] = [AUTO_MODEL];
  const seen = new Set<string>(["default"]);
  for (const provider of AIDER_PROVIDERS) {
    if (!provider.envKeys.some((key) => (env[key] ?? "").trim())) continue;
    for (const model of provider.models) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(toModelInfo(model));
    }
  }
  return { defaultModel: "default", models };
}
