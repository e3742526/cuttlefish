import { describe, expect, it } from "vitest";
import type { CuttlefishConfig, Employee } from "../../shared/types.js";
import {
  applyReviewerLossPolicy,
  buildReviewPacketPrompt,
  buildReviewerSystemPrompt,
  buildRevisionPrompt,
  buildRoleTransportMeta,
  isExecutionDepthBlocked,
  isMultiRoleEnabled,
  parseReviewResult,
  resolveEffectiveExecution,
  resolveRoleFailoverTargets,
  shouldUseMidPairExecution,
} from "../employee-execution.js";

function config(overrides: Partial<CuttlefishConfig> = {}): CuttlefishConfig {
  return {
    gateway: { port: 8888, host: "127.0.0.1" },
    engines: { default: "claude", claude: { bin: "claude", model: "sonnet" }, codex: { bin: "codex", model: "gpt-5.5" } },
    connectors: {},
    logging: { file: true, stdout: true, level: "info" },
    ...overrides,
  } as CuttlefishConfig;
}

function employee(overrides: Partial<Employee> = {}): Employee {
  return {
    name: "backend-dev",
    displayName: "Backend Dev",
    department: "engineering",
    rank: "employee",
    engine: "claude",
    model: "sonnet",
    persona: "implement services",
    ...overrides,
  };
}

describe("isMultiRoleEnabled", () => {
  it("is false by default", () => {
    expect(isMultiRoleEnabled(config())).toBe(false);
  });
  it("is true only when the feature flag is explicitly true", () => {
    expect(isMultiRoleEnabled(config({ features: { multiRoleEmployeeExecution: true } }))).toBe(true);
    expect(isMultiRoleEnabled(config({ features: { multiRoleEmployeeExecution: false } }))).toBe(false);
  });
});

describe("resolveEffectiveExecution", () => {
  it("defaults a solo employee with no execution block", () => {
    const exec = resolveEffectiveExecution(employee());
    expect(exec.tier).toBe("solo");
    expect(exec.maxInternalPasses).toBe(1);
    expect(exec.maxChildSessions).toBe(3);
    expect(exec.reviewerLossPolicy).toBe("replace_then_degrade");
    expect(exec.reviewerToolProfile).toBe("read_only");
  });

  it("applies V1 defaults on top of a partial mid_pair block", () => {
    const exec = resolveEffectiveExecution(employee({ execution: { tier: "mid_pair", maxInternalPasses: 3 } }));
    expect(exec.tier).toBe("mid_pair");
    expect(exec.maxInternalPasses).toBe(3);
    expect(exec.maxChildSessions).toBe(3); // default, not overridden
  });
});

describe("shouldUseMidPairExecution", () => {
  it("requires the feature flag, a mid_pair employee, and no role-depth guard", () => {
    const midPairEmployee = employee({ execution: { tier: "mid_pair" } });
    const flagOn = config({ features: { multiRoleEmployeeExecution: true } });
    const flagOff = config();

    expect(shouldUseMidPairExecution(flagOn, midPairEmployee, null)).toBe(true);
    expect(shouldUseMidPairExecution(flagOff, midPairEmployee, null)).toBe(false);
    expect(shouldUseMidPairExecution(flagOn, employee(), null)).toBe(false); // solo tier
    expect(shouldUseMidPairExecution(flagOn, null, null)).toBe(false);
    expect(shouldUseMidPairExecution(flagOn, midPairEmployee, { executionDepth: 1 })).toBe(false); // depth guard
    expect(shouldUseMidPairExecution(flagOn, midPairEmployee, { executionDepth: 0 })).toBe(true);
  });
});

describe("isExecutionDepthBlocked", () => {
  it("blocks only when executionDepth is a number >= 1", () => {
    expect(isExecutionDepthBlocked(null)).toBe(false);
    expect(isExecutionDepthBlocked({})).toBe(false);
    expect(isExecutionDepthBlocked({ executionDepth: 0 })).toBe(false);
    expect(isExecutionDepthBlocked({ executionDepth: 1 })).toBe(true);
    expect(isExecutionDepthBlocked({ executionDepth: "1" })).toBe(false); // wrong type, not coerced
  });
});

describe("buildRoleTransportMeta", () => {
  it("builds depth-1 metadata for a role child session", () => {
    const meta = buildRoleTransportMeta("run-1", "reviewer", "mid_pair");
    expect(meta).toEqual({
      employeeRunId: "run-1",
      executionDepth: 1,
      executionParentRunId: "run-1",
      executionOrigin: "mid_pair",
      internalRole: "reviewer",
    });
  });
});

describe("parseReviewResult", () => {
  it("parses a clean JSON verdict", () => {
    const result = parseReviewResult(JSON.stringify({
      verdict: "approved",
      summary: "Looks good.",
      requiredChanges: [],
      riskAreas: [],
      confidence: "high",
    }));
    expect(result).toEqual({
      verdict: "approved",
      summary: "Looks good.",
      requiredChanges: [],
      riskAreas: [],
      confidence: "high",
    });
  });

  it("strips a markdown code fence around the JSON", () => {
    const raw = "```json\n" + JSON.stringify({ verdict: "changes_requested", summary: "needs tests" }) + "\n```";
    const result = parseReviewResult(raw);
    expect(result?.verdict).toBe("changes_requested");
    expect(result?.summary).toBe("needs tests");
    expect(result?.requiredChanges).toEqual([]); // defaulted
    expect(result?.confidence).toBe("medium"); // defaulted
  });

  it("returns null for invalid JSON", () => {
    expect(parseReviewResult("not json at all")).toBeNull();
  });

  it("returns null for an unrecognized verdict value", () => {
    expect(parseReviewResult(JSON.stringify({ verdict: "looks_fine_i_guess" }))).toBeNull();
  });

  it("returns null for valid JSON that isn't an object", () => {
    expect(parseReviewResult("42")).toBeNull();
    expect(parseReviewResult("[1,2,3]")).toBeNull();
  });
});

describe("resolveRoleFailoverTargets", () => {
  const orgLookup = (name: string) =>
    ({
      "sec-reviewer": { name: "sec-reviewer", engine: "codex", model: "gpt-5.4", effortLevel: "medium" },
      "cheap-checker": { name: "cheap-checker", engine: "claude", model: "haiku" },
      "no-engine": { name: "no-engine", engine: "", model: "" },
    } as Record<string, { name: string; engine: string; model: string; effortLevel?: string }>)[name];

  const base = {
    primary: { engine: "claude", model: "sonnet" },
    currentEmployeeName: "backend-dev",
    lookupEmployee: orgLookup,
    isEngineAvailable: () => true,
  };

  it("returns an empty list for an absent role or empty chain", () => {
    expect(resolveRoleFailoverTargets({ ...base, role: undefined })).toEqual([]);
    expect(resolveRoleFailoverTargets({ ...base, role: { fallbackChain: [] } })).toEqual([]);
  });

  it("preserves chain order and passes through direct agent targets", () => {
    const targets = resolveRoleFailoverTargets({
      ...base,
      role: { fallbackChain: [
        { engine: "codex", model: "gpt-5.5", effortLevel: "high" },
        { engine: "gemini", model: "gemini-pro" },
      ] },
    });
    expect(targets).toEqual([
      { engine: "codex", model: "gpt-5.5", effortLevel: "high" },
      { engine: "gemini", model: "gemini-pro", effortLevel: undefined },
    ]);
  });

  it("resolves external-agent (employee) targets from the org lookup", () => {
    const targets = resolveRoleFailoverTargets({
      ...base,
      role: { fallbackChain: [{ employee: "sec-reviewer" }] },
    });
    expect(targets).toEqual([
      { engine: "codex", model: "gpt-5.4", effortLevel: "medium", viaEmployee: "sec-reviewer" },
    ]);
  });

  it("lets an explicit effortLevel on the chain entry override the external employee's own", () => {
    const targets = resolveRoleFailoverTargets({
      ...base,
      role: { fallbackChain: [{ employee: "sec-reviewer", effortLevel: "high" }] },
    });
    expect(targets[0]?.effortLevel).toBe("high");
  });

  it("drops unknown, incomplete, and self-referential employee targets", () => {
    const targets = resolveRoleFailoverTargets({
      ...base,
      role: { fallbackChain: [
        { employee: "ghost" },
        { employee: "no-engine" },
        { employee: "backend-dev" },
        { engine: "codex", model: "gpt-5.5" },
      ] },
    });
    expect(targets).toEqual([{ engine: "codex", model: "gpt-5.5", effortLevel: undefined }]);
  });

  it("dedupes targets on the same engine+model rung and drops the primary rung", () => {
    const targets = resolveRoleFailoverTargets({
      ...base,
      role: { fallbackChain: [
        { engine: "claude", model: "sonnet" }, // == primary
        { engine: "codex", model: "gpt-5.5" },
        { engine: "Codex", model: "GPT-5.5" }, // duplicate rung, case-insensitive
        { employee: "cheap-checker" },
        { engine: "claude", model: "haiku" }, // duplicate of the resolved employee target
      ] },
    });
    expect(targets).toEqual([
      { engine: "codex", model: "gpt-5.5", effortLevel: undefined },
      { engine: "claude", model: "haiku", effortLevel: undefined, viaEmployee: "cheap-checker" },
    ]);
  });

  it("drops targets whose engine is unavailable", () => {
    const targets = resolveRoleFailoverTargets({
      ...base,
      isEngineAvailable: (engine: string) => engine !== "codex",
      role: { fallbackChain: [
        { engine: "codex", model: "gpt-5.5" },
        { engine: "gemini", model: "gemini-pro" },
      ] },
    });
    expect(targets).toEqual([{ engine: "gemini", model: "gemini-pro", effortLevel: undefined }]);
  });

  it("is bounded: never returns more than the chain cap", () => {
    const chain = Array.from({ length: 10 }, (_, i) => ({ engine: "e" + i, model: "m" + i }));
    const targets = resolveRoleFailoverTargets({ ...base, role: { fallbackChain: chain } });
    expect(targets.length).toBeLessThanOrEqual(5);
  });
});

describe("applyReviewerLossPolicy", () => {
  it("blocks unconditionally once a prior non-approved verdict exists, regardless of policy", () => {
    expect(applyReviewerLossPolicy("degrade", "changes_requested", true).action).toBe("block");
    expect(applyReviewerLossPolicy("replace_then_degrade", "blocked", true).action).toBe("block");
  });

  it("'block' policy always blocks when there is no prior verdict", () => {
    expect(applyReviewerLossPolicy("block", null, true).action).toBe("block");
  });

  it("'replace_then_block' replaces when a fallback exists, else blocks", () => {
    expect(applyReviewerLossPolicy("replace_then_block", null, true)).toEqual({ action: "replace" });
    expect(applyReviewerLossPolicy("replace_then_block", null, false).action).toBe("block");
  });

  it("'replace_then_degrade' replaces when a fallback exists, else degrades", () => {
    expect(applyReviewerLossPolicy("replace_then_degrade", null, true)).toEqual({ action: "replace" });
    expect(applyReviewerLossPolicy("replace_then_degrade", null, false).action).toBe("degrade");
  });

  it("'degrade' policy always degrades when there is no prior verdict", () => {
    expect(applyReviewerLossPolicy("degrade", null, true).action).toBe("degrade");
    expect(applyReviewerLossPolicy("degrade", null, false).action).toBe("degrade");
  });
});

describe("prompt builders", () => {
  it("buildReviewerSystemPrompt reflects the tool profile", () => {
    expect(buildReviewerSystemPrompt("read_only")).toMatch(/READ-ONLY/);
    expect(buildReviewerSystemPrompt("read_plus_inspect")).toMatch(/read, search, and grep/);
    expect(buildReviewerSystemPrompt("patch_suggestions")).toMatch(/suggest patches/);
  });

  it("buildReviewPacketPrompt includes the task and a truncated summary", () => {
    const prompt = buildReviewPacketPrompt("Add a healthz endpoint", "x".repeat(5000));
    expect(prompt).toContain("Add a healthz endpoint");
    expect(prompt).toContain("x".repeat(4000));
    expect(prompt).not.toContain("x".repeat(4001));
  });

  it("buildRevisionPrompt includes the task, prior summary, and required changes", () => {
    const prompt = buildRevisionPrompt("Add a healthz endpoint", "implemented it", {
      verdict: "changes_requested",
      summary: "missing tests",
      requiredChanges: ["add a unit test", "handle the 500 case"],
      riskAreas: [],
      confidence: "medium",
    });
    expect(prompt).toContain("Add a healthz endpoint");
    expect(prompt).toContain("implemented it");
    expect(prompt).toContain("missing tests");
    expect(prompt).toContain("add a unit test");
    expect(prompt).toContain("handle the 500 case");
  });

  it("buildRevisionPrompt handles an empty requiredChanges list gracefully", () => {
    const prompt = buildRevisionPrompt("task", "summary", {
      verdict: "changes_requested",
      summary: "vague concern",
      requiredChanges: [],
      riskAreas: [],
      confidence: "low",
    });
    expect(prompt).toContain("no specific changes listed");
  });
});
