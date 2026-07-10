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
});
