import { describe, it, expect } from "vitest";
import { evaluatePolicy } from "../evaluator.js";
import { buildDefaultProfile, buildStrictExportProfile } from "../profiles.js";
import type { PolicyArtifactDescriptor, PolicyRule } from "../types.js";

function makeDescriptor(overrides: Partial<PolicyArtifactDescriptor> = {}): PolicyArtifactDescriptor {
  return {
    kind: "file:generated",
    locator: null,
    sizeBytes: null,
    mimeType: null,
    producingRunId: null,
    ...overrides,
  };
}

describe("evaluatePolicy", () => {
  describe("default behavior (no rules)", () => {
    it("default-allows 'retain' action when no rules match", () => {
      const verdict = evaluatePolicy(makeDescriptor(), "retain", []);
      expect(verdict.allowed).toBe(true);
      expect(verdict.reason).toContain("retain");
      expect(verdict.rule).toBeUndefined();
    });

    it("default-allows 'register' action when no rules match", () => {
      const verdict = evaluatePolicy(makeDescriptor(), "register", []);
      expect(verdict.allowed).toBe(true);
      expect(verdict.reason).toContain("register");
      expect(verdict.rule).toBeUndefined();
    });

    it("default-denies 'export' action when no rules match", () => {
      const verdict = evaluatePolicy(makeDescriptor(), "export", []);
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toContain("export");
      expect(verdict.rule).toBeUndefined();
    });

    it("default-denies 'quarantine' action when no rules match", () => {
      const verdict = evaluatePolicy(makeDescriptor(), "quarantine", []);
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toContain("quarantine");
      expect(verdict.rule).toBeUndefined();
    });
  });

  describe("allow rules", () => {
    it("returns allowed=true when a matching allow rule is found", () => {
      const rules: PolicyRule[] = [
        { id: "allow-export-all", action: "export", allow: true },
      ];
      const verdict = evaluatePolicy(makeDescriptor(), "export", rules);
      expect(verdict.allowed).toBe(true);
      expect(verdict.rule).toBe("allow-export-all");
      expect(verdict.reason).toContain("allow-export-all");
    });

    it("allows based on kindPattern match", () => {
      const rules: PolicyRule[] = [
        { id: "allow-knowledge", action: "export", kindPattern: "knowledge:*", allow: true },
      ];
      const verdict = evaluatePolicy(makeDescriptor({ kind: "knowledge:summary" }), "export", rules);
      expect(verdict.allowed).toBe(true);
      expect(verdict.rule).toBe("allow-knowledge");
    });

    it("does not match kindPattern when kind differs", () => {
      const rules: PolicyRule[] = [
        { id: "allow-knowledge", action: "export", kindPattern: "knowledge:*", allow: true },
      ];
      const verdict = evaluatePolicy(makeDescriptor({ kind: "file:generated" }), "export", rules);
      expect(verdict.allowed).toBe(false);
      expect(verdict.rule).toBeUndefined();
    });

    it("allows based on locatorPattern match", () => {
      const rules: PolicyRule[] = [
        { id: "allow-locator", action: "export", locatorPattern: "/safe/*", allow: true },
      ];
      const verdict = evaluatePolicy(
        makeDescriptor({ kind: "file:generated", locator: "/safe/output.txt" }),
        "export",
        rules,
      );
      expect(verdict.allowed).toBe(true);
      expect(verdict.rule).toBe("allow-locator");
    });

    it("locatorPattern does not match when locator is null", () => {
      const rules: PolicyRule[] = [
        { id: "allow-locator", action: "export", locatorPattern: "/safe/*", allow: true },
      ];
      const verdict = evaluatePolicy(makeDescriptor({ locator: null }), "export", rules);
      expect(verdict.allowed).toBe(false);
    });
  });

  describe("deny rules", () => {
    it("returns allowed=false when a matching deny rule is found", () => {
      const rules: PolicyRule[] = [
        { id: "deny-export", action: "export", allow: false },
      ];
      const verdict = evaluatePolicy(makeDescriptor(), "export", rules);
      expect(verdict.allowed).toBe(false);
      expect(verdict.rule).toBe("deny-export");
      expect(verdict.reason).toContain("deny-export");
    });

    it("denies export of run_bundle kind", () => {
      const rules: PolicyRule[] = [
        { id: "deny-run-bundle", action: "export", kindPattern: "cuttlefish.run_bundle*", allow: false },
      ];
      const verdict = evaluatePolicy(
        makeDescriptor({ kind: "cuttlefish.run_bundle.v1" }),
        "export",
        rules,
      );
      expect(verdict.allowed).toBe(false);
      expect(verdict.rule).toBe("deny-run-bundle");
    });

    it("denies quarantine action by default (no matching allow rule)", () => {
      const verdict = evaluatePolicy(makeDescriptor(), "quarantine", []);
      expect(verdict.allowed).toBe(false);
    });
  });

  describe("first-match wins", () => {
    it("uses the first matching rule and ignores later rules", () => {
      const rules: PolicyRule[] = [
        { id: "first-deny", action: "export", kindPattern: "knowledge:*", allow: false },
        { id: "second-allow", action: "export", kindPattern: "knowledge:*", allow: true },
      ];
      const verdict = evaluatePolicy(makeDescriptor({ kind: "knowledge:summary" }), "export", rules);
      expect(verdict.allowed).toBe(false);
      expect(verdict.rule).toBe("first-deny");
    });

    it("skips non-matching rules and uses the first matching one", () => {
      const rules: PolicyRule[] = [
        { id: "deny-file", action: "export", kindPattern: "file:*", allow: false },
        { id: "allow-knowledge", action: "export", kindPattern: "knowledge:*", allow: true },
      ];
      const verdict = evaluatePolicy(makeDescriptor({ kind: "knowledge:docs" }), "export", rules);
      expect(verdict.allowed).toBe(true);
      expect(verdict.rule).toBe("allow-knowledge");
    });

    it("action mismatch skips the rule", () => {
      const rules: PolicyRule[] = [
        { id: "deny-quarantine", action: "quarantine", allow: false },
        { id: "allow-export", action: "export", allow: true },
      ];
      const verdict = evaluatePolicy(makeDescriptor(), "export", rules);
      expect(verdict.allowed).toBe(true);
      expect(verdict.rule).toBe("allow-export");
    });
  });

  describe("wildcard pattern matching", () => {
    it("* pattern matches any kind", () => {
      const rules: PolicyRule[] = [
        { id: "allow-all", kindPattern: "*", allow: true },
      ];
      const verdict = evaluatePolicy(makeDescriptor({ kind: "anything:here" }), "export", rules);
      expect(verdict.allowed).toBe(true);
    });

    it("prefix wildcard matches correctly", () => {
      const rules: PolicyRule[] = [
        { id: "allow-cuttlefish", kindPattern: "cuttlefish.*", allow: true },
      ];
      expect(
        evaluatePolicy(makeDescriptor({ kind: "cuttlefish.run_bundle.v1" }), "export", rules).allowed,
      ).toBe(true);
      expect(
        evaluatePolicy(makeDescriptor({ kind: "other.kind" }), "export", rules).allowed,
      ).toBe(false);
    });
  });

  describe("rule without action filter", () => {
    it("matches any action when rule.action is undefined", () => {
      const rules: PolicyRule[] = [
        { id: "global-allow", allow: true },
      ];
      expect(evaluatePolicy(makeDescriptor(), "export", rules).allowed).toBe(true);
      expect(evaluatePolicy(makeDescriptor(), "retain", rules).allowed).toBe(true);
      expect(evaluatePolicy(makeDescriptor(), "quarantine", rules).allowed).toBe(true);
    });
  });
});

describe("buildDefaultProfile", () => {
  it("returns a profile with an empty rules array", () => {
    const profile = buildDefaultProfile();
    expect(profile.rules).toEqual([]);
  });

  it("default profile results in default-allow for retain", () => {
    const { rules } = buildDefaultProfile();
    const verdict = evaluatePolicy(makeDescriptor(), "retain", rules);
    expect(verdict.allowed).toBe(true);
  });

  it("default profile results in default-deny for export", () => {
    const { rules } = buildDefaultProfile();
    const verdict = evaluatePolicy(makeDescriptor(), "export", rules);
    expect(verdict.allowed).toBe(false);
  });
});

describe("buildStrictExportProfile", () => {
  it("returns a profile with a single deny-all-export rule", () => {
    const profile = buildStrictExportProfile();
    expect(profile.rules).toHaveLength(1);
    expect(profile.rules[0].id).toBe("deny-all-export");
    expect(profile.rules[0].action).toBe("export");
    expect(profile.rules[0].allow).toBe(false);
  });

  it("denies all export actions via the strict export profile", () => {
    const { rules } = buildStrictExportProfile();
    const verdict = evaluatePolicy(makeDescriptor({ kind: "knowledge:summary" }), "export", rules);
    expect(verdict.allowed).toBe(false);
    expect(verdict.rule).toBe("deny-all-export");
  });

  it("does not affect retain actions (falls through to default-allow)", () => {
    const { rules } = buildStrictExportProfile();
    const verdict = evaluatePolicy(makeDescriptor(), "retain", rules);
    expect(verdict.allowed).toBe(true);
  });
});
