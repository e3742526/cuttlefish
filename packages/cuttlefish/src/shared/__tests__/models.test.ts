import { describe, it, expect, beforeEach } from "vitest";
import type { CuttlefishConfig } from "../types.js";
import { getModelRegistry, invalidateModelRegistry, synthesizeFromEngineConfig } from "../models.js";

function cfg(partial: Partial<CuttlefishConfig["engines"]>, models?: CuttlefishConfig["models"]): CuttlefishConfig {
  return {
    gateway: { port: 8888, host: "127.0.0.1" },
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt-5.5" },
      ...partial,
    },
    models,
    connectors: {},
  } as CuttlefishConfig;
}

beforeEach(() => invalidateModelRegistry());

describe("synthesizeFromEngineConfig (backward-compat fallback)", () => {
  it("builds an entry per engine from engines.<name>.model", () => {
    const reg = synthesizeFromEngineConfig(cfg({}));
    expect(reg.claude.models[0].id).toBe("opus");
    expect(reg.claude.defaultModel).toBe("opus");
    expect(reg.codex.models[0].id).toBe("gpt-5.5");
    expect(reg.antigravity.models[0].id).toBe("Gemini 3.5 Flash (Medium)");
    expect(reg.grok.defaultModel).toBe("grok-build");
    expect(reg.grok.models.map((m) => m.id)).toEqual(["grok-build", "grok-composer-2.5-fast"]);
    expect(reg.grok.models.map((m) => m.label)).toEqual(["Grok Build", "Grok Composer 2.5 Fast"]);
    expect(reg.ollama.models[0].id).toBe("gemma4");
    expect(reg.kilo.models[0].id).toBe("default");
  });

  it("uses per-engine effort semantics: claude flag, codex config, grok flag, antigravity/ollama none", () => {
    const reg = synthesizeFromEngineConfig(cfg({}));
    expect(reg.claude.effortMechanism).toBe("claude-flag");
    expect(reg.claude.models[0].effortLevels).toEqual(["low", "medium", "high"]);
    expect(reg.codex.effortMechanism).toBe("codex-config");
    expect(reg.codex.models[0].effortLevels).toContain("xhigh");
    expect(reg.grok.effortMechanism).toBe("grok-flag");
    expect(reg.grok.models[0].effortLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(reg.antigravity.effortMechanism).toBe("none");
    expect(reg.antigravity.models[0].supportsEffort).toBe(false);
    expect(reg.antigravity.models[0].effortLevels).toEqual([]);
    expect(reg.ollama.effortMechanism).toBe("none");
    expect(reg.ollama.models[0].supportsEffort).toBe(false);
    expect(reg.kilo.effortMechanism).toBe("none");
    expect(reg.kilo.models[0].supportsEffort).toBe(false);
  });

  it("uses the pinned Grok model as default while keeping the known Grok catalog", () => {
    const reg = synthesizeFromEngineConfig(cfg({ grok: { bin: "grok", model: "grok-composer-2.5-fast" } }));
    expect(reg.grok.defaultModel).toBe("grok-composer-2.5-fast");
    expect(reg.grok.models.map((m) => m.id)).toEqual(["grok-build", "grok-composer-2.5-fast"]);
  });
});

describe("getModelRegistry with a models: block", () => {
  const models: CuttlefishConfig["models"] = {
    claude: {
      default: "claude-opus-4-8",
      effortMechanism: "claude-flag",
      models: [
        { id: "claude-opus-4-8", label: "Opus 4.8", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        { id: "claude-sonnet-5", label: "Sonnet 5", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
      ],
    },
    codex: {
      default: "gpt-5.5",
      models: [{ id: "gpt-5.5", label: "GPT-5.5 Codex", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh"] }],
    },
    antigravity: {
      models: [{ id: "gemini-3-flash-preview", label: "Gemini 3 Flash", supportsEffort: false, effortLevels: [] }],
    },
  };

  it("honors the configured models, labels, and effort levels", () => {
    const reg = getModelRegistry(cfg({}, models));
    expect(reg.claude.models.map((m) => m.id)).toEqual(["claude-opus-4-8", "claude-sonnet-5"]);
    expect(reg.claude.models[0].label).toBe("Opus 4.8");
    expect(reg.codex.models[0].effortLevels).toContain("xhigh");
    expect(reg.antigravity.models[0].supportsEffort).toBe(false);
  });

  it("resolves defaultModel from block.default, else the first model", () => {
    const reg = getModelRegistry(cfg({}, models));
    expect(reg.claude.defaultModel).toBe("claude-opus-4-8");
    expect(reg.antigravity.defaultModel).toBe("gemini-3-flash-preview"); // no default → first
  });

  it("lets engines.grok.model pin the Grok default when models.grok is configured", () => {
    const reg = getModelRegistry(cfg(
      { grok: { bin: "grok", model: "grok-composer-2.5-fast" } },
      {
        grok: {
          default: "grok-build",
          effortMechanism: "grok-flag",
          models: [
            { id: "grok-build", label: "Grok Build", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh", "max"], contextWindow: 256000 },
            { id: "grok-composer-2.5-fast", label: "Grok Composer 2.5 Fast", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh", "max"], contextWindow: 256000 },
          ],
        },
      },
    ));

    expect(reg.grok.defaultModel).toBe("grok-composer-2.5-fast");
    expect(reg.grok.models[0].label).toBe("Grok Build");
    expect(reg.grok.models[0].contextWindow).toBe(256000);
  });
});

describe("cache + invalidate", () => {
  it("caches across calls and refreshes only after invalidate", () => {
    const a = getModelRegistry(cfg({}));
    const b = getModelRegistry(cfg({ claude: { bin: "claude", model: "CHANGED" } }));
    expect(b).toBe(a); // cached — ignores the new config until invalidated
    invalidateModelRegistry();
    const c = getModelRegistry(cfg({ claude: { bin: "claude", model: "CHANGED" } }));
    expect(c.claude.models[0].id).toBe("CHANGED");
  });
});
