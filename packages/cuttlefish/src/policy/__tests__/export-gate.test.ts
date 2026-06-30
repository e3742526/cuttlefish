import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gateArtifactRegister, gateExternalEmit } from "../export-gate.js";
import { invalidatePolicyCache } from "../loader.js";
import type { PolicyArtifactDescriptor } from "../types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-policy-gate-"));
  invalidatePolicyCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  invalidatePolicyCache();
  vi.restoreAllMocks();
});

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

function writePolicyFile(dir: string, name: string, rules: unknown[]): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ rules }));
}

describe("gateExternalEmit", () => {
  describe("builtin rule: knowledge envelope", () => {
    it("allows export of knowledge:* kinds via the builtin allow rule", () => {
      // Empty policy dir: no user rules; builtin allows knowledge:*
      const verdict = gateExternalEmit(makeDescriptor({ kind: "knowledge:summary" }), tmpDir);
      expect(verdict.allowed).toBe(true);
      expect(verdict.rule).toBe("builtin-allow-knowledge");
    });

    it("allows knowledge:something with locator", () => {
      const verdict = gateExternalEmit(
        makeDescriptor({ kind: "knowledge:docs", locator: "/home/user/docs.md" }),
        tmpDir,
      );
      expect(verdict.allowed).toBe(true);
      expect(verdict.rule).toBe("builtin-allow-knowledge");
    });
  });

  describe("builtin rule: run bundle allow", () => {
    it("allows export of cuttlefish.run_bundle* kinds via the builtin allow rule", () => {
      const verdict = gateExternalEmit(
        makeDescriptor({ kind: "cuttlefish.run_bundle.v1" }),
        tmpDir,
      );
      expect(verdict.allowed).toBe(true);
      expect(verdict.rule).toBe("builtin-allow-run-bundle");
    });

    it("allows export of bare cuttlefish.run_bundle kind", () => {
      const verdict = gateExternalEmit(makeDescriptor({ kind: "cuttlefish.run_bundle" }), tmpDir);
      expect(verdict.allowed).toBe(true);
      expect(verdict.rule).toBe("builtin-allow-run-bundle");
    });
  });

  describe("builtin default-allow-export", () => {
    it("allows export of arbitrary kinds when no user rules and no builtin deny applies", () => {
      const verdict = gateExternalEmit(makeDescriptor({ kind: "file:generated" }), tmpDir);
      expect(verdict.allowed).toBe(true);
      expect(verdict.rule).toBe("builtin-default-allow-export");
    });

    it("allows export of an unknown kind via the builtin default-allow", () => {
      const verdict = gateExternalEmit(makeDescriptor({ kind: "my-custom:type" }), tmpDir);
      expect(verdict.allowed).toBe(true);
      expect(verdict.rule).toBe("builtin-default-allow-export");
    });
  });

  describe("user rules take precedence over builtins", () => {
    it("user deny-all-export rule blocks even knowledge:* export", () => {
      writePolicyFile(tmpDir, "00-deny-all.json", [
        { id: "deny-all-export", action: "export", allow: false },
      ]);
      invalidatePolicyCache();
      const verdict = gateExternalEmit(makeDescriptor({ kind: "knowledge:summary" }), tmpDir);
      expect(verdict.allowed).toBe(false);
      expect(verdict.rule).toBe("deny-all-export");
    });

    it("user allow rule for a kind is respected before builtins", () => {
      writePolicyFile(tmpDir, "00-allow-special.json", [
        { id: "allow-special-export", action: "export", kindPattern: "special:*", allow: true },
      ]);
      invalidatePolicyCache();
      const verdict = gateExternalEmit(makeDescriptor({ kind: "special:report" }), tmpDir);
      expect(verdict.allowed).toBe(true);
      expect(verdict.rule).toBe("allow-special-export");
    });
  });

  describe("fail-closed behavior", () => {
    it("is not trivially open: a non-knowledge, non-bundle kind is allowed by builtin-default, not denied by default", () => {
      // Verify the default-allow-export builtin means non-special kinds still export.
      // If that builtin were removed, the policy evaluator's default-deny for 'export' would kick in.
      const verdict = gateExternalEmit(makeDescriptor({ kind: "file:output" }), tmpDir);
      expect(verdict.allowed).toBe(true);
      expect(verdict.rule).toBe("builtin-default-allow-export");
    });

    it("user strict deny-all removes the default-allow escape hatch", () => {
      writePolicyFile(tmpDir, "00-strict.json", [
        { id: "deny-all-export", action: "export", allow: false },
      ]);
      invalidatePolicyCache();
      const verdict = gateExternalEmit(makeDescriptor({ kind: "file:output" }), tmpDir);
      expect(verdict.allowed).toBe(false);
    });
  });
});

describe("gateArtifactRegister", () => {
  it("allows register by default (no rules, default-allow for register)", () => {
    const verdict = gateArtifactRegister(makeDescriptor(), tmpDir);
    expect(verdict.allowed).toBe(true);
    expect(verdict.rule).toBeUndefined();
    expect(verdict.reason).toContain("register");
  });

  it("denies register when a user rule denies it", () => {
    writePolicyFile(tmpDir, "00-deny-register.json", [
      { id: "deny-register-file", action: "register", kindPattern: "file:*", allow: false },
    ]);
    invalidatePolicyCache();
    const verdict = gateArtifactRegister(makeDescriptor({ kind: "file:generated" }), tmpDir);
    expect(verdict.allowed).toBe(false);
    expect(verdict.rule).toBe("deny-register-file");
  });

  it("allows register for a kind not matching the deny rule", () => {
    writePolicyFile(tmpDir, "00-deny-register.json", [
      { id: "deny-register-file", action: "register", kindPattern: "file:*", allow: false },
    ]);
    invalidatePolicyCache();
    const verdict = gateArtifactRegister(makeDescriptor({ kind: "knowledge:note" }), tmpDir);
    expect(verdict.allowed).toBe(true);
    // Falls through to default-allow
    expect(verdict.rule).toBeUndefined();
  });

  it("user allow rule is respected for register", () => {
    writePolicyFile(tmpDir, "00-rules.json", [
      { id: "allow-knowledge-register", action: "register", kindPattern: "knowledge:*", allow: true },
      { id: "deny-register-all", action: "register", allow: false },
    ]);
    invalidatePolicyCache();
    const verdict = gateArtifactRegister(makeDescriptor({ kind: "knowledge:doc" }), tmpDir);
    expect(verdict.allowed).toBe(true);
    expect(verdict.rule).toBe("allow-knowledge-register");
  });
});
