import { describe, it, expect } from "vitest";
import { resolveModelFallback } from "../model-fallback.js";
import { rungKey } from "../model-escalation.js";

const baseConfig: any = {
  engines: {
    default: "claude",
    claude: { bin: "claude", model: "claude-sonnet-5" },
    codex: { bin: "codex", model: "gpt-5.4" },
  },
};
const available = () => true;

describe("resolveModelFallback", () => {
  it("prefers an agent fallback chain over global/default ladder", () => {
    const decision = resolveModelFallback({
      employee: { name: "writer", department: "docs", rank: "senior", engine: "claude", model: "opus", modelPolicy: {
        fallback_chain: [{ engine: "codex", model: "gpt-5.5", effortLevel: "high", reason: "backup" }],
        fallback_behavior: { mode: "auto", triggers: ["quota_exhausted"] },
      } } as any,
      config: baseConfig,
      failureReason: "quota_exhausted",
      fromEngine: "claude",
      fromModel: "opus",
      triedRungs: new Set([rungKey("claude", "opus")]),
      excludeEngines: new Set(["claude"]),
      isAvailable: available,
    });
    expect(decision.action).toBe("fallback");
    expect(decision.target).toMatchObject({ engine: "codex", model: "gpt-5.5", source: "agent" });
  });

  it("ask_user mode resolves a target but requires approval", () => {
    const decision = resolveModelFallback({
      employee: { name: "infra", department: "infra", rank: "senior", engine: "claude", model: "opus", modelPolicy: {
        fallback_chain: [{ engine: "codex", model: "gpt-5.5" }],
        fallback_behavior: { mode: "ask_user", triggers: ["timeout"] },
      } } as any,
      config: baseConfig,
      failureReason: "timeout",
      fromEngine: "claude",
      fromModel: "opus",
      triedRungs: new Set([rungKey("claude", "opus")]),
      isAvailable: available,
    });
    expect(decision.action).toBe("ask_user");
    expect(decision.target?.engine).toBe("codex");
  });

  it("honors mode never", () => {
    const decision = resolveModelFallback({
      employee: { name: "x", department: "x", rank: "employee", engine: "claude", model: "opus", modelPolicy: { fallback_behavior: { mode: "never" } } } as any,
      config: baseConfig,
      failureReason: "quota_exhausted",
      fromEngine: "claude",
      fromModel: "opus",
      triedRungs: new Set(),
      isAvailable: available,
    });
    expect(decision.action).toBe("never");
  });

  it("falls back to global chain when no agent chain is configured", () => {
    const decision = resolveModelFallback({
      config: { ...baseConfig, modelFallback: { enabled: true, defaultMode: "auto", globalChain: [{ engine: "codex", model: "gpt-5.4" }] } } as any,
      failureReason: "rate_limit",
      fromEngine: "claude",
      fromModel: "claude-sonnet-5",
      triedRungs: new Set([rungKey("claude", "claude-sonnet-5")]),
      excludeEngines: new Set(["claude"]),
      isAvailable: available,
    });
    expect(decision.action).toBe("fallback");
    expect(decision.target).toMatchObject({ engine: "codex", model: "gpt-5.4", source: "global" });
  });

  it("falls back to the capability ladder when policy chains are unavailable", () => {
    const decision = resolveModelFallback({
      config: { ...baseConfig, modelFallback: { globalChain: [{ engine: "missing", model: "x" }] } } as any,
      failureReason: "timeout",
      fromEngine: "claude",
      fromModel: "claude-haiku-4-5",
      triedRungs: new Set([rungKey("claude", "claude-haiku-4-5")]),
      isAvailable: (engine) => engine !== "missing",
    });
    expect(decision.action).toBe("fallback");
    expect(decision.target?.source).toBe("ladder");
  });
});
