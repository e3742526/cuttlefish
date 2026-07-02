import { describe, it, expect } from "vitest";
import { resolveModelEscalation, rungKey, DEFAULT_MODEL_LADDER } from "../model-escalation.js";

const allAvailable = () => true;

describe("resolveModelEscalation (default ladder)", () => {
  it("user example: a small model (haiku) climbs to the mid tier (gpt-5.4 first)", () => {
    const got = resolveModelEscalation({
      fromEngine: "claude",
      fromModel: "claude-haiku-4-5",
      triedRungs: new Set([rungKey("claude", "claude-haiku-4-5")]),
      isAvailable: allAvailable,
    });
    expect(got).toEqual({ engine: "codex", model: "gpt-5.4", via: "higher" });
  });

  it("user example: gemini-flash (small) climbs to the mid tier", () => {
    const got = resolveModelEscalation({
      fromEngine: "antigravity",
      fromModel: "Gemini 3.5 Flash (High)",
      triedRungs: new Set([rungKey("antigravity", "Gemini 3.5 Flash (High)")]),
      isAvailable: allAvailable,
    });
    expect(got?.via).toBe("higher");
    expect(got).toEqual({ engine: "codex", model: "gpt-5.4", via: "higher" });
  });

  it("user example: sonnet (mid) climbs to the large tier (gpt-5.5 first)", () => {
    const got = resolveModelEscalation({
      fromEngine: "claude",
      fromModel: "claude-sonnet-5",
      triedRungs: new Set([rungKey("claude", "claude-sonnet-5")]),
      isAvailable: allAvailable,
    });
    expect(got).toEqual({ engine: "codex", model: "gpt-5.5", via: "higher" });
  });

  it("usage exhaustion: excluding the current engine forces a higher model on another provider", () => {
    // sonnet on claude is rate-limited → exclude claude → large tier, non-claude → gpt-5.5.
    const got = resolveModelEscalation({
      fromEngine: "claude",
      fromModel: "claude-sonnet-5",
      triedRungs: new Set([rungKey("claude", "claude-sonnet-5")]),
      excludeEngines: new Set(["claude"]),
      isAvailable: allAvailable,
    });
    expect(got).toEqual({ engine: "codex", model: "gpt-5.5", via: "higher" });
  });

  it("usage exhaustion from a cheap codex model rolls to sonnet (codex excluded)", () => {
    const got = resolveModelEscalation({
      fromEngine: "codex",
      fromModel: "gpt-5.4-mini",
      triedRungs: new Set([rungKey("codex", "gpt-5.4-mini")]),
      excludeEngines: new Set(["codex"]),
      isAvailable: allAvailable,
    });
    // tier 1 with codex excluded → sonnet.
    expect(got).toEqual({ engine: "claude", model: "claude-sonnet-5", via: "higher" });
  });

  it("stall from gpt-5.4 (mid) climbs to gpt-5.5 on the SAME engine (no exclusion)", () => {
    const got = resolveModelEscalation({
      fromEngine: "codex",
      fromModel: "gpt-5.4",
      triedRungs: new Set([rungKey("codex", "gpt-5.4")]),
      isAvailable: allAvailable,
    });
    expect(got).toEqual({ engine: "codex", model: "gpt-5.5", via: "higher" });
  });

  it("top tier whose engine is exhausted falls sideways to a same-tier peer (sibling)", () => {
    // opus on claude is rate-limited; nothing higher exists → sibling on another engine.
    const got = resolveModelEscalation({
      fromEngine: "claude",
      fromModel: "opus",
      triedRungs: new Set([rungKey("claude", "opus")]),
      excludeEngines: new Set(["claude"]),
      isAvailable: allAvailable,
    });
    expect(got?.via).toBe("sibling");
    expect(["codex", "antigravity"]).toContain(got?.engine);
    expect(got?.engine).not.toBe("claude");
  });

  it("returns null at the top tier when no higher/sibling engine is available", () => {
    const got = resolveModelEscalation({
      fromEngine: "codex",
      fromModel: "gpt-5.5",
      triedRungs: new Set([rungKey("codex", "gpt-5.5")]),
      // every other top-tier engine down
      isAvailable: (e) => e === "codex",
    });
    expect(got).toBeNull();
  });

  it("skips already-tried rungs so repeated escalations keep climbing", () => {
    // Already tried gpt-5.4 (mid). Next escalation from haiku should skip it and
    // take the other mid rung (sonnet) before climbing further.
    const got = resolveModelEscalation({
      fromEngine: "claude",
      fromModel: "claude-haiku-4-5",
      triedRungs: new Set([rungKey("claude", "claude-haiku-4-5"), rungKey("codex", "gpt-5.4")]),
      isAvailable: allAvailable,
    });
    expect(got).toEqual({ engine: "claude", model: "claude-sonnet-5", via: "higher" });
  });

  it("unknown current model is treated as lowest tier and climbs into tier 1", () => {
    const got = resolveModelEscalation({
      fromEngine: "codex",
      fromModel: "some-custom-model-not-on-ladder",
      triedRungs: new Set([rungKey("codex", "some-custom-model-not-on-ladder")]),
      isAvailable: allAvailable,
    });
    expect(got?.via).toBe("higher");
    expect(got).toEqual({ engine: "codex", model: "gpt-5.4", via: "higher" });
  });

  it("honors a custom ladder override", () => {
    const ladder = [
      [{ engine: "pi", model: "qwen" }],
      [{ engine: "codex", model: "gpt-x" }],
    ];
    const got = resolveModelEscalation({
      fromEngine: "pi",
      fromModel: "qwen",
      ladder,
      triedRungs: new Set([rungKey("pi", "qwen")]),
      isAvailable: allAvailable,
    });
    expect(got).toEqual({ engine: "codex", model: "gpt-x", via: "higher" });
  });

  it("sanity: the default ladder is ordered low → high", () => {
    expect(DEFAULT_MODEL_LADDER).toHaveLength(3);
    expect(DEFAULT_MODEL_LADDER[0].some((r) => r.model === "claude-haiku-4-5")).toBe(true);
    expect(DEFAULT_MODEL_LADDER[2].some((r) => r.model === "gpt-5.5")).toBe(true);
  });
});
