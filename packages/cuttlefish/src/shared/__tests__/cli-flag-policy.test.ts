import { describe, expect, it } from "vitest";
import { findDisallowedCliFlag, stripDisallowedCliFlags } from "../cli-flag-policy.js";

describe("cli-flag policy (audit A-F2/F-10)", () => {
  it("flags permission-bypass and config-injection flags", () => {
    expect(findDisallowedCliFlag(["--dangerously-skip-permissions"])).toBe("--dangerously-skip-permissions");
    expect(findDisallowedCliFlag(["--mcp-config", "/tmp/evil.json"])).toBe("--mcp-config");
    expect(findDisallowedCliFlag(["--settings=/tmp/x"])).toBe("--settings=/tmp/x");
    expect(findDisallowedCliFlag(["--Dangerously-Skip-Permissions"])).toBe("--Dangerously-Skip-Permissions");
  });
  it("allows benign flags", () => {
    expect(findDisallowedCliFlag(["--verbose", "--model", "opus"])).toBeUndefined();
  });
  it("strips disallowed flags on the spawn path", () => {
    expect(stripDisallowedCliFlags(["--verbose", "--dangerously-skip-permissions", "--foo"]))
      .toEqual(["--verbose", "--foo"]);
  });

  // ARC-CF-001: the Claude CLI headless-bypass flags let the CLI skip its
  // interactive permission/sandbox prompts. These were previously only
  // guarded in the unwired orchestration/adapter/real-adapter.ts path; the
  // shared policy is what actually gates production config-load
  // (gateway/org-validation.ts) and spawn (engines/claude-interactive-args.ts).
  it("flags Claude headless-bypass flags (config-load-time check, as used by org-validation)", () => {
    expect(findDisallowedCliFlag(["-p"])).toBe("-p");
    expect(findDisallowedCliFlag(["--print"])).toBe("--print");
    expect(findDisallowedCliFlag(["--json"])).toBe("--json");
    expect(findDisallowedCliFlag(["--headless"])).toBe("--headless");
    expect(findDisallowedCliFlag(["--output-format", "json"])).toBe("--output-format");
    expect(findDisallowedCliFlag(["--Output-Format=json"])).toBe("--Output-Format=json");
  });

  it("strips Claude headless-bypass flags on the spawn path (as used by claude-interactive-args)", () => {
    expect(stripDisallowedCliFlags(["--verbose", "-p", "--json", "--foo"]))
      .toEqual(["--verbose", "--foo"]);
    expect(stripDisallowedCliFlags(["--model", "opus", "--output-format=json"]))
      .toEqual(["--model", "opus"]);
  });
});
