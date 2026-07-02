import { describe, it, expect, beforeEach } from "vitest";
import type { CuttlefishConfig } from "../../shared/types.js";
import { validateNewSessionSelection, validateSessionPatch } from "../session-patch.js";
import { invalidateModelRegistry } from "../../shared/models.js";

function cfg(): CuttlefishConfig {
  return {
    gateway: { port: 8888, host: "127.0.0.1" },
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "claude-opus-4-8" },
      codex: { bin: "codex", model: "gpt-5.4" },
      antigravity: { model: "gemini-3-flash-preview" },
      grok: { bin: "grok", model: "grok-build" },
    },
    models: {
      claude: {
        default: "claude-opus-4-8",
        models: [
          { id: "claude-opus-4-8", label: "Opus 4.8", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
          { id: "claude-sonnet-5", label: "Sonnet 5", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        ],
      },
      codex: { default: "gpt-5.4", models: [{ id: "gpt-5.4", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh"] }] },
      antigravity: { models: [{ id: "gemini-3-flash-preview", supportsEffort: false, effortLevels: [] }] },
      grok: {
        default: "grok-build",
        effortMechanism: "grok-flag",
        models: [
          { id: "grok-build", label: "Grok Build", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh", "max"] },
          { id: "grok-composer-2.5-fast", label: "Grok Composer 2.5 Fast", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh", "max"] },
        ],
      },
    },
    connectors: {},
  } as unknown as CuttlefishConfig;
}

/**
 * Registry that mirrors the SHIPPED `cuttlefish setup` template (cli/setup.ts):
 * claude models are registered under the literal ids `opus` and `claude-haiku-4-5`
 * (NOT the date-suffixed alias targets). This is the configuration most real
 * deployments run, and the one that surfaced the opus/haiku "unknown model" 400.
 */
function shippedCfg(): CuttlefishConfig {
  return {
    gateway: { port: 8888, host: "127.0.0.1" },
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt-5.5" },
    },
    models: {
      claude: {
        default: "opus",
        models: [
          { id: "claude-fable-5", label: "Fable 5", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
          { id: "opus", label: "Opus 4.8", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
          { id: "claude-sonnet-5", label: "Sonnet 5", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
          { id: "claude-haiku-4-5", label: "Haiku 4.5", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        ],
      },
      codex: { default: "gpt-5.5", models: [{ id: "gpt-5.5", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh"] }] },
    },
    connectors: {},
  } as unknown as CuttlefishConfig;
}

beforeEach(() => invalidateModelRegistry());

describe("model alias resolution against the shipped registry (opus/haiku 400 regression)", () => {
  it("accepts model 'opus' when the registry registers it under the literal id 'opus'", () => {
    const r = validateNewSessionSelection(shippedCfg(), { engine: "claude", model: "opus" });
    // Must NOT be rewritten to claude-opus-4-8 (which is not a registered id here).
    expect(r).toMatchObject({ ok: true, engine: "claude", model: "opus" });
  });

  it("expands model 'haiku' to the shipped registry id 'claude-haiku-4-5'", () => {
    const r = validateNewSessionSelection(shippedCfg(), { engine: "claude", model: "haiku" });
    expect(r).toMatchObject({ ok: true, model: "claude-haiku-4-5" });
  });

  it("accepts the registered id 'claude-haiku-4-5' directly", () => {
    const r = validateNewSessionSelection(shippedCfg(), { engine: "claude", model: "claude-haiku-4-5" });
    expect(r).toMatchObject({ ok: true, model: "claude-haiku-4-5" });
  });

  it("still expands 'opus' to claude-opus-4-8 when THAT is the registered id", () => {
    const r = validateNewSessionSelection(cfg(), { engine: "claude", model: "opus" });
    expect(r).toMatchObject({ ok: true, model: "claude-opus-4-8" });
  });

  it("patches model to 'opus' against the shipped registry without rewriting it", () => {
    const r = validateSessionPatch(shippedCfg(), "claude", "claude-sonnet-5", { model: "opus" });
    expect(r).toMatchObject({ ok: true, updates: { model: "opus" } });
  });
});

describe("validateNewSessionSelection", () => {
  it("accepts a valid engine/model/effort selection", () => {
    const r = validateNewSessionSelection(cfg(), {
      engine: "grok",
      model: "grok-composer-2.5-fast",
      effortLevel: "max",
    });
    expect(r).toEqual({
      ok: true,
      engine: "grok",
      model: "grok-composer-2.5-fast",
      effortLevel: "max",
    });
  });

  it("uses employee engine/model/effort defaults when the request only names an employee", () => {
    const r = validateNewSessionSelection(
      cfg(),
      {},
      { engine: "claude", model: "claude-sonnet-5", effortLevel: "high" },
    );
    expect(r).toEqual({
      ok: true,
      engine: "claude",
      model: "claude-sonnet-5",
      effortLevel: "high",
    });
  });

  it("lets explicit request values override employee defaults", () => {
    const r = validateNewSessionSelection(
      cfg(),
      { model: "opus", effortLevel: "medium" },
      { engine: "claude", model: "claude-sonnet-5", effortLevel: "high" },
    );
    expect(r).toEqual({
      ok: true,
      engine: "claude",
      model: "claude-opus-4-8",
      effortLevel: "medium",
    });
  });

  it("rejects an unknown engine before persisting a session", () => {
    const r = validateNewSessionSelection(cfg(), { engine: "not-real", model: "opus" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown engine/i);
  });

  it("rejects an unknown model before persisting a session", () => {
    const r = validateNewSessionSelection(cfg(), { engine: "grok", model: "grok-not-real" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown model/i);
  });

  it("rejects an effort level not valid for the selected model", () => {
    const r = validateNewSessionSelection(cfg(), { engine: "claude", model: "opus", effortLevel: "xhigh" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid effortLevel/i);
  });

  it("drops stale effort for an engine/model with no effort support", () => {
    const r = validateNewSessionSelection(cfg(), { engine: "antigravity", model: "gemini-3-flash-preview", effortLevel: "high" });
    expect(r).toEqual({
      ok: true,
      engine: "antigravity",
      model: "gemini-3-flash-preview",
      effortLevel: undefined,
    });
  });

  it("drops stale employee-default effort when the selected engine/model has no effort support", () => {
    const r = validateNewSessionSelection(
      cfg(),
      {},
      { engine: "antigravity", model: "gemini-3-flash-preview", effortLevel: "high" },
    );
    expect(r).toEqual({
      ok: true,
      engine: "antigravity",
      model: "gemini-3-flash-preview",
      effortLevel: undefined,
    });
  });
});

describe("validateSessionPatch", () => {
  it("accepts a valid model switch for the engine", () => {
    const r = validateSessionPatch(cfg(), "claude", "opus", { model: "claude-sonnet-5" });
    expect(r.ok).toBe(true);
    expect(r.updates).toEqual({ model: "claude-sonnet-5" });
  });

  it("accepts a valid effort switch", () => {
    const r = validateSessionPatch(cfg(), "codex", "gpt-5.4", { effortLevel: "xhigh" });
    expect(r.ok).toBe(true);
    expect(r.updates).toEqual({ effortLevel: "xhigh" });
  });

  it("accepts a valid Grok effort switch", () => {
    const r = validateSessionPatch(cfg(), "grok", "grok-build", { effortLevel: "max" });
    expect(r.ok).toBe(true);
    expect(r.updates).toEqual({ effortLevel: "max" });
  });

  it("accepts model + effort together, validating effort against the NEW model", () => {
    const r = validateSessionPatch(cfg(), "claude", "opus", { model: "claude-sonnet-5", effortLevel: "high" });
    expect(r.ok).toBe(true);
    expect(r.updates).toEqual({ model: "claude-sonnet-5", effortLevel: "high" });
  });

  it("rejects an unknown model for the engine", () => {
    const r = validateSessionPatch(cfg(), "claude", "opus", { model: "gpt-4o" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown model/i);
  });

  it("rejects an effort level not valid for the model", () => {
    const r = validateSessionPatch(cfg(), "claude", "opus", { effortLevel: "xhigh" }); // claude has no xhigh
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid effortLevel/i);
  });

  it("rejects effort for a model that doesn't support effort (antigravity)", () => {
    const r = validateSessionPatch(cfg(), "antigravity", "gemini-3-flash-preview", { effortLevel: "high" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/does not support effort/i);
  });

  it("allows switching antigravity model (persisted; runtime no-op handled at engine layer)", () => {
    const c = cfg();
    c.models!.antigravity!.models.push({ id: "gemini-3-pro-preview", supportsEffort: false, effortLevels: [] });
    invalidateModelRegistry();
    const r = validateSessionPatch(c, "antigravity", "gemini-3-flash-preview", { model: "gemini-3-pro-preview" });
    expect(r.ok).toBe(true);
    expect(r.updates).toEqual({ model: "gemini-3-pro-preview" });
  });

  it("allows setting a Grok model before a Grok engine session exists", () => {
    const r = validateSessionPatch(cfg(), "grok", "grok-build", { model: "grok-composer-2.5-fast" });
    expect(r.ok).toBe(true);
    expect(r.updates).toEqual({ model: "grok-composer-2.5-fast" });
  });

  it("rejects changing Grok models after a Grok engine session exists", () => {
    const r = validateSessionPatch(
      cfg(),
      "grok",
      "grok-build",
      { model: "grok-composer-2.5-fast" },
      { engineSessionId: "grok-session-1", defaultModel: "grok-build" },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/new session/i);
  });

  it("allows a no-op Grok model patch after a Grok engine session exists", () => {
    const r = validateSessionPatch(
      cfg(),
      "grok",
      null,
      { model: "grok-build" },
      { engineSessionId: "grok-session-1", defaultModel: "grok-build" },
    );
    expect(r.ok).toBe(true);
    expect(r.updates).toEqual({ model: "grok-build" });
  });

  it("rejects empty/typeless input", () => {
    expect(validateSessionPatch(cfg(), "claude", "opus", {}).ok).toBe(false);
    expect(validateSessionPatch(cfg(), "claude", "opus", { model: 123 as unknown }).ok).toBe(false);
    expect(validateSessionPatch(cfg(), "claude", "opus", { effortLevel: "" }).ok).toBe(false);
  });
});
