import { describe, it, expect } from "vitest";
import { resolveModelFallback, resolveModelFallbackPlan } from "../model-fallback.js";
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

describe("resolveModelFallbackPlan", () => {
  const planOpts = (overrides: Record<string, unknown> = {}) => ({
    employee: { name: "writer", department: "docs", rank: "senior", engine: "claude", model: "opus", modelPolicy: {
      fallback_chain: [
        { engine: "codex", model: "gpt-5.5" },
        { engine: "claude", model: "claude-sonnet-5" },
      ],
    } } as any,
    config: { ...baseConfig, modelFallback: { enabled: true, globalChain: [
      { engine: "codex", model: "gpt-5.5" }, // duplicate of the agent chain head
      { engine: "codex", model: "gpt-5.4" },
    ] } } as any,
    failureReason: "quota_exhausted" as const,
    fromEngine: "claude",
    fromModel: "opus",
    triedRungs: new Set([rungKey("claude", "opus")]),
    isAvailable: available,
    ...overrides,
  });

  it("orders the plan agent chain → global chain → ladder, deduping repeated rungs", () => {
    const plan = resolveModelFallbackPlan(planOpts());
    const rungs = plan.map((c) => `${c.source}:${c.engine}/${c.model}`);
    // gpt-5.5 appears once (agent chain wins); the global duplicate is dropped.
    expect(rungs.slice(0, 3)).toEqual([
      "agent:codex/gpt-5.5",
      "agent:claude/claude-sonnet-5",
      "global:codex/gpt-5.4",
    ]);
    const keys = plan.map((c) => rungKey(c.engine, c.model));
    expect(new Set(keys).size).toBe(keys.length); // no duplicate rungs anywhere in the plan
  });

  it("never includes the failing rung or already-tried rungs", () => {
    const plan = resolveModelFallbackPlan(planOpts({
      fromEngine: "codex",
      fromModel: "gpt-5.5",
      triedRungs: new Set([rungKey("codex", "gpt-5.5"), rungKey("codex", "gpt-5.4")]),
    }));
    expect(plan.some((c) => rungKey(c.engine, c.model) === rungKey("codex", "gpt-5.5"))).toBe(false);
    expect(plan.some((c) => rungKey(c.engine, c.model) === rungKey("codex", "gpt-5.4"))).toBe(false);
  });

  it("drops unavailable targets from the plan", () => {
    const plan = resolveModelFallbackPlan(planOpts({ isAvailable: (engine: string) => engine !== "codex" }));
    expect(plan.every((c) => c.engine !== "codex")).toBe(true);
  });

  it("plan[0] always matches the single-target resolver's decision", () => {
    const opts = planOpts();
    const plan = resolveModelFallbackPlan(opts);
    const decision = resolveModelFallback(opts);
    expect(decision.action).toBe("fallback");
    expect(decision.target).toEqual(plan[0]);
  });
});
