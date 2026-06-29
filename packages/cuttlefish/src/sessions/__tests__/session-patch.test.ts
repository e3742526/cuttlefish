import { describe, it, expect, beforeEach } from "vitest";
import type { CuttlefishConfig } from "../../shared/types.js";
import { validateNewSessionSelection, validateSessionPatch } from "../session-patch.js";
import { invalidateModelRegistry } from "../../shared/models.js";

function cfg(): CuttlefishConfig {
  return {
    gateway: { port: 8888, host: "127.0.0.1" },
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt-5.4" },
      antigravity: { model: "gemini-3-flash-preview" },
      grok: { bin: "grok", model: "grok-build" },
    },
    models: {
      claude: {
        default: "opus",
        models: [
          { id: "opus", label: "Opus 4.8", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
          { id: "claude-sonnet-4-6", label: "Sonnet 4.6", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
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

beforeEach(() => invalidateModelRegistry());

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
      { engine: "claude", model: "claude-sonnet-4-6", effortLevel: "high" },
    );
    expect(r).toEqual({
      ok: true,
      engine: "claude",
      model: "claude-sonnet-4-6",
      effortLevel: "high",
    });
  });

  it("lets explicit request values override employee defaults", () => {
    const r = validateNewSessionSelection(
      cfg(),
      { model: "opus", effortLevel: "medium" },
      { engine: "claude", model: "claude-sonnet-4-6", effortLevel: "high" },
    );
    expect(r).toEqual({
      ok: true,
      engine: "claude",
      model: "opus",
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
    const r = validateSessionPatch(cfg(), "claude", "opus", { model: "claude-sonnet-4-6" });
    expect(r.ok).toBe(true);
    expect(r.updates).toEqual({ model: "claude-sonnet-4-6" });
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
    const r = validateSessionPatch(cfg(), "claude", "opus", { model: "claude-sonnet-4-6", effortLevel: "high" });
    expect(r.ok).toBe(true);
    expect(r.updates).toEqual({ model: "claude-sonnet-4-6", effortLevel: "high" });
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
