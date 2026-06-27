import { describe, it, expect } from "vitest";
import { discoverAiderModels, knownAiderModels } from "../aider-models.js";

describe("discoverAiderModels", () => {
  it("returns only the auto default when no provider keys are present", () => {
    const { defaultModel, models } = discoverAiderModels({});
    expect(defaultModel).toBe("default");
    expect(models.map((m) => m.id)).toEqual(["default"]);
  });

  it("surfaces Anthropic aliases when ANTHROPIC_API_KEY is set", () => {
    const ids = discoverAiderModels({ ANTHROPIC_API_KEY: "sk-ant-xxx" }).models.map((m) => m.id);
    expect(ids).toEqual(["default", "sonnet", "opus", "haiku"]);
  });

  it("unions models across multiple present providers", () => {
    const ids = discoverAiderModels({
      ANTHROPIC_API_KEY: "x",
      OPENAI_API_KEY: "y",
      GEMINI_API_KEY: "z",
    }).models.map((m) => m.id);
    expect(ids).toContain("sonnet");
    expect(ids).toContain("gpt-4o");
    expect(ids).toContain("gemini");
    expect(ids[0]).toBe("default");
  });

  it("ignores blank/whitespace-only keys", () => {
    const ids = discoverAiderModels({ OPENAI_API_KEY: "   " }).models.map((m) => m.id);
    expect(ids).toEqual(["default"]);
  });

  it("marks every model as effort-less", () => {
    const models = discoverAiderModels({ ANTHROPIC_API_KEY: "x" }).models;
    expect(models.every((m) => m.supportsEffort === false && m.effortLevels.length === 0)).toBe(true);
  });
});

describe("knownAiderModels", () => {
  it("offers just the auto default by default", () => {
    expect(knownAiderModels().models.map((m) => m.id)).toEqual(["default"]);
  });

  it("includes a pinned non-default model", () => {
    expect(knownAiderModels("sonnet").models.map((m) => m.id)).toEqual(["default", "sonnet"]);
  });
});
