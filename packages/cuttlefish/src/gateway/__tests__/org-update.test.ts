import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import type { CuttlefishConfig, Employee } from "../../shared/types.js";

let tmpDir: string;

vi.mock("../../shared/paths.js", () => ({
  get ORG_DIR() {
    return tmpDir;
  },
  // safeWriteYaml(audit) appends to AUDIT_LOG; keep it inside the temp dir.
  get AUDIT_LOG() {
    return path.join(tmpDir, "audit.jsonl");
  },
}));

vi.mock("../../shared/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { createEmployeeYaml, deleteEmployeeYaml, updateEmployeeYaml, validateEmployeeCreate, validateEmployeeUpdate, scanOrg, mergeEmployeeUpdateData, buildEmployeeCreateData } from "../org.js";
import { invalidateModelRegistry } from "../../shared/models.js";

function writeYaml(subdir: string, filename: string, content: string) {
  const dir = path.join(tmpDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content, "utf-8");
}

function readYaml(subdir: string, filename: string): any {
  return yaml.load(fs.readFileSync(path.join(tmpDir, subdir, filename), "utf-8"));
}

// Minimal config with two claude models so we can exercise valid/invalid model changes.
const testConfig = {
  engines: { default: "claude" },
  models: {
    claude: {
      default: "opus",
      models: [
        { id: "opus", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        { id: "sonnet", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
      ],
    },
  },
} as unknown as CuttlefishConfig;

function emp(overrides: Partial<Employee> = {}): Employee {
  return {
    name: "dev",
    displayName: "Dev",
    department: "platform",
    rank: "senior",
    engine: "claude",
    model: "opus",
    persona: "A developer",
    ...overrides,
  };
}

describe("updateEmployeeYaml", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "org-update-test-"));
    invalidateModelRegistry();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("updates alwaysNotify field in existing YAML", () => {
    writeYaml("platform", "dev.yaml", `
name: dev
persona: A developer
rank: senior
`);
    const result = updateEmployeeYaml("dev", { alwaysNotify: false });
    expect(result).toBe(true);

    const data = readYaml("platform", "dev.yaml");
    expect(data.alwaysNotify).toBe(false);
    expect(data.name).toBe("dev");
    expect(data.persona).toBe("A developer");
    expect(data.rank).toBe("senior");
  });

  it("sets alwaysNotify to true", () => {
    writeYaml("platform", "worker.yaml", `
name: worker
persona: A worker
alwaysNotify: false
`);
    const result = updateEmployeeYaml("worker", { alwaysNotify: true });
    expect(result).toBe(true);

    const data = readYaml("platform", "worker.yaml");
    expect(data.alwaysNotify).toBe(true);
  });

  it("returns false for non-existent employee", () => {
    const result = updateEmployeeYaml("ghost", { alwaysNotify: false });
    expect(result).toBe(false);
  });

  it("preserves all other YAML fields when updating one field", () => {
    writeYaml("content", "lead.yaml", `
name: content-lead
displayName: Content Lead
department: content
rank: manager
engine: claude
model: opus
persona: The content lead
emoji: "🏠"
maxCostUsd: 5
`);
    updateEmployeeYaml("content-lead", { alwaysNotify: false });

    const data = readYaml("content", "lead.yaml");
    expect(data.displayName).toBe("Content Lead");
    expect(data.department).toBe("content");
    expect(data.rank).toBe("manager");
    expect(data.engine).toBe("claude");
    expect(data.model).toBe("opus");
    expect(data.emoji).toBe("🏠");
    expect(data.maxCostUsd).toBe(5);
    expect(data.alwaysNotify).toBe(false);
  });

  it("writes the wider field set (displayName, department, rank, engine, model, effortLevel, persona, reportsTo, cliFlags)", () => {
    writeYaml("platform", "wide.yaml", `
name: wide
persona: Original persona
rank: employee
`);
    const result = updateEmployeeYaml("wide", {
      displayName: "Wide Load",
      department: "ventures",
      rank: "manager",
      engine: "codex",
      model: "gpt-5.3-codex",
      effortLevel: "high",
      persona: "New persona",
      reportsTo: "boss",
      cliFlags: ["--chrome"],
      alwaysNotify: false,
    });
    expect(result).toBe(true);

    const data = readYaml("platform", "wide.yaml");
    expect(data.name).toBe("wide"); // immutable
    expect(data.displayName).toBe("Wide Load");
    expect(data.department).toBe("ventures");
    expect(data.rank).toBe("manager");
    expect(data.engine).toBe("codex");
    expect(data.model).toBe("gpt-5.3-codex");
    expect(data.effortLevel).toBe("high");
    expect(data.persona).toBe("New persona");
    expect(data.reportsTo).toBe("boss");
    expect(data.cliFlags).toEqual(["--chrome"]);
    expect(data.alwaysNotify).toBe(false);
  });

  it("stores a fallback model in modelPolicy and clears it when removed", () => {
    writeYaml("platform", "fallback.yaml", `
name: fallback
persona: Original persona
rank: employee
engine: claude
model: sonnet
modelPolicy:
  fallback_chain:
    - engine: claude
      model: opus
`);
    expect(updateEmployeeYaml("fallback", { fallbackModel: "haiku" })).toBe(true);
    let data = readYaml("platform", "fallback.yaml");
    expect(data.modelPolicy.fallback_chain).toEqual([{ engine: "claude", model: "haiku" }]);

    expect(updateEmployeeYaml("fallback", { fallbackModel: null })).toBe(true);
    data = readYaml("platform", "fallback.yaml");
    expect(data.modelPolicy).toBeUndefined();
  });

  it("stores a cross-engine fallback target without snapping it back to the primary engine", () => {
    writeYaml("platform", "fallback-cross.yaml", `
name: fallback-cross
persona: Original persona
rank: employee
engine: codex
model: gpt-5.5
`);
    expect(updateEmployeeYaml("fallback-cross", {
      fallbackEngine: "claude",
      fallbackModel: "sonnet",
    })).toBe(true);

    const data = readYaml("platform", "fallback-cross.yaml");
    expect(data.modelPolicy.fallback_chain).toEqual([{ engine: "claude", model: "sonnet" }]);
  });

  it("never writes/renames the immutable name field", () => {
    writeYaml("platform", "safe.yaml", `
name: safe
persona: Original persona
rank: employee
`);
    // Even if a `name` sneaks into the updates object, it must be ignored.
    updateEmployeeYaml("safe", { name: "renamed", persona: "Changed" } as any);

    const data = readYaml("platform", "safe.yaml");
    expect(data.name).toBe("safe");
    expect(data.persona).toBe("Changed");
  });

  it("merges only provided keys, preserving untouched fields", () => {
    writeYaml("platform", "merge.yaml", `
name: merge
displayName: Merge Me
department: platform
rank: senior
engine: claude
model: opus
persona: Keep me
emoji: "🧩"
`);
    updateEmployeeYaml("merge", { rank: "manager" });

    const data = readYaml("platform", "merge.yaml");
    expect(data.rank).toBe("manager");
    expect(data.displayName).toBe("Merge Me");
    expect(data.persona).toBe("Keep me");
    expect(data.emoji).toBe("🧩");
    expect(data.engine).toBe("claude");
    expect(data.model).toBe("opus");
  });

  it("persists avatar and clears any existing emoji (XOR)", () => {
    writeYaml("platform", "icon.yaml", `
name: icon
persona: Has an emoji
emoji: "🧩"
`);
    updateEmployeeYaml("icon", { avatar: "nautical:life_ring", emoji: "" });

    const data = readYaml("platform", "icon.yaml");
    expect(data.avatar).toBe("nautical:life_ring");
    expect(data.emoji).toBeUndefined();
  });

  it("persists emoji and clears any existing avatar (XOR)", () => {
    writeYaml("platform", "icon.yaml", `
name: icon
persona: Has an avatar
avatar: aquatic:octopus
`);
    updateEmployeeYaml("icon", { avatar: "", emoji: "🦊" });

    const data = readYaml("platform", "icon.yaml");
    expect(data.emoji).toBe("🦊");
    expect(data.avatar).toBeUndefined();
  });

  it("clears both icon fields when both are blank", () => {
    writeYaml("platform", "icon.yaml", `
name: icon
persona: Has an avatar
avatar: aquatic:octopus
`);
    updateEmployeeYaml("icon", { avatar: "", emoji: "" });

    const data = readYaml("platform", "icon.yaml");
    expect(data.avatar).toBeUndefined();
    expect(data.emoji).toBeUndefined();
  });

  it("normalizes legacy YAML carrying both avatar and emoji on save", () => {
    writeYaml("platform", "icon.yaml", `
name: icon
persona: Legacy both
avatar: aquatic:octopus
emoji: "🧩"
`);
    updateEmployeeYaml("icon", { avatar: "", emoji: "🦊" });

    const data = readYaml("platform", "icon.yaml");
    expect(data.emoji).toBe("🦊");
    expect(data.avatar).toBeUndefined();
  });

  it("resolves an out-of-contract both-icons-set update to avatar (precedence)", () => {
    writeYaml("platform", "icon.yaml", `
name: icon
persona: Both sent
`);
    // Direct-API caller sends both non-empty; avatar must win (matching read/create),
    // not the previous order-dependent emoji-wins.
    updateEmployeeYaml("icon", { avatar: "aquatic:octopus", emoji: "🦊" });

    const data = readYaml("platform", "icon.yaml");
    expect(data.avatar).toBe("aquatic:octopus");
    expect(data.emoji).toBeUndefined();
  });

  it("preserves an existing avatar when a non-icon field is updated", () => {
    writeYaml("platform", "icon.yaml", `
name: icon
persona: Keep my avatar
avatar: nautical:lighthouse
`);
    updateEmployeeYaml("icon", { alwaysNotify: false });

    const data = readYaml("platform", "icon.yaml");
    expect(data.avatar).toBe("nautical:lighthouse");
    expect(data.alwaysNotify).toBe(false);
  });
});

describe("scanOrg maxCostUsd mapping (G2)", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "org-scan-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips maxCostUsd on load", () => {
    writeYaml("platform", "costly.yaml", `
name: costly
persona: Pricey worker
maxCostUsd: 12.5
`);
    const registry = scanOrg();
    expect(registry.get("costly")?.maxCostUsd).toBe(12.5);
  });

  it("leaves maxCostUsd undefined when absent or non-numeric", () => {
    writeYaml("platform", "free.yaml", `
name: free
persona: No cap
maxCostUsd: "lots"
`);
    const registry = scanOrg();
    expect(registry.get("free")?.maxCostUsd).toBeUndefined();
  });

  it("preserves an explicit blank department instead of falling back to the folder", () => {
    writeYaml("general", "security.yaml", `
name: security
persona: Watches the gates
department: ""
`);
    const registry = scanOrg();
    expect(registry.get("security")?.department).toBe("");
  });
});

describe("createEmployeeYaml", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "org-create-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a new employee yaml with a fallback policy", () => {
    expect(createEmployeeYaml({
      name: "platform-lead",
      displayName: "Platform Lead",
      department: "platform",
      rank: "manager",
      engine: "claude",
      model: "sonnet",
      fallbackModel: "opus",
      persona: "Lead the platform team.",
      alwaysNotify: true,
    })).toBe(true);

    const data = readYaml("platform", "platform-lead.yaml");
    expect(data.name).toBe("platform-lead");
    expect(data.displayName).toBe("Platform Lead");
    expect(data.modelPolicy.fallback_chain).toEqual([{ engine: "claude", model: "opus" }]);
  });

  it("creates a new employee yaml with a cross-engine fallback policy", () => {
    expect(createEmployeeYaml({
      name: "platform-router",
      displayName: "Platform Router",
      department: "platform",
      rank: "manager",
      engine: "codex",
      model: "gpt-5.5",
      fallbackEngine: "claude",
      fallbackModel: "sonnet",
      persona: "Route platform work.",
      alwaysNotify: true,
    })).toBe(true);

    const data = readYaml("platform", "platform-router.yaml");
    expect(data.modelPolicy.fallback_chain).toEqual([{ engine: "claude", model: "sonnet" }]);
  });

  it("writes a chosen ocean avatar and no emoji", () => {
    expect(createEmployeeYaml({
      name: "icon-a",
      displayName: "Icon A",
      department: "platform",
      rank: "senior",
      engine: "claude",
      model: "sonnet",
      persona: "Has an avatar.",
      avatar: "nautical:anchor",
      emoji: "",
    })).toBe(true);

    const data = readYaml("platform", "icon-a.yaml");
    expect(data.avatar).toBe("nautical:anchor");
    expect(data.emoji).toBeUndefined();
  });

  it("writes a chosen plain emoji and no avatar", () => {
    expect(createEmployeeYaml({
      name: "icon-b",
      displayName: "Icon B",
      department: "platform",
      rank: "senior",
      engine: "claude",
      model: "sonnet",
      persona: "Has an emoji.",
      avatar: "",
      emoji: "🦊",
    })).toBe(true);

    const data = readYaml("platform", "icon-b.yaml");
    expect(data.emoji).toBe("🦊");
    expect(data.avatar).toBeUndefined();
  });

  it("writes neither icon field when both are blank", () => {
    expect(createEmployeeYaml({
      name: "icon-c",
      displayName: "Icon C",
      department: "platform",
      rank: "senior",
      engine: "claude",
      model: "sonnet",
      persona: "No icon.",
      avatar: "",
      emoji: "",
    })).toBe(true);

    const data = readYaml("platform", "icon-c.yaml");
    expect(data.avatar).toBeUndefined();
    expect(data.emoji).toBeUndefined();
  });
});

describe("deleteEmployeeYaml", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "org-delete-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes the YAML file for an existing employee", () => {
    writeYaml("platform", "dev.yaml", `
name: dev
persona: A developer
rank: senior
`);
    const filePath = path.join(tmpDir, "platform", "dev.yaml");
    expect(fs.existsSync(filePath)).toBe(true);

    expect(deleteEmployeeYaml("dev")).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("returns false for a non-existent employee", () => {
    expect(deleteEmployeeYaml("ghost")).toBe(false);
  });
});

describe("validateEmployeeUpdate", () => {
  beforeEach(() => {
    invalidateModelRegistry();
  });

  it("accepts a valid multi-field update and returns coerced updates", () => {
    const r = validateEmployeeUpdate(testConfig, emp(), {
      displayName: "New Name",
      rank: "manager",
      model: "sonnet",
      effortLevel: "high",
      persona: "Fresh persona",
    });
    expect(r.ok).toBe(true);
    expect(r.updates).toMatchObject({
      displayName: "New Name",
      rank: "manager",
      model: "sonnet",
      effortLevel: "high",
      persona: "Fresh persona",
    });
  });

  it("accepts fallbackModel and clears blank fallbackModel to null", () => {
    const ok = validateEmployeeUpdate(testConfig, emp(), { fallbackModel: "sonnet" });
    expect(ok.ok).toBe(true);
    expect(ok.updates?.fallbackModel).toBe("sonnet");

    const cleared = validateEmployeeUpdate(testConfig, emp(), { fallbackModel: "  " });
    expect(cleared.ok).toBe(true);
    expect(cleared.updates?.fallbackModel).toBeNull();
  });

  it("accepts a cross-engine fallback target when the model is valid for that engine", () => {
    const ok = validateEmployeeUpdate(testConfig, emp(), {
      fallbackEngine: "codex",
      fallbackModel: "gpt-5.5",
    });
    expect(ok.ok).toBe(true);
    expect(ok.updates).toMatchObject({
      fallbackEngine: "codex",
      fallbackModel: "gpt-5.5",
    });
  });

  it("rejects a cross-engine fallback model when it is invalid for the selected fallback engine", () => {
    const bad = validateEmployeeUpdate(testConfig, emp(), {
      fallbackEngine: "codex",
      fallbackModel: "sonnet",
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/fallbackModel/i);
  });

  it("rejects the immutable name field", () => {
    const r = validateEmployeeUpdate(testConfig, emp(), { name: "renamed" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/name/i);
  });

  it("rejects unknown keys", () => {
    const r = validateEmployeeUpdate(testConfig, emp(), { bogusField: 1 } as any);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/bogusField|unknown/i);
  });

  describe("execution.roles validation", () => {
    const rolesUpdate = (roles: unknown) => validateEmployeeUpdate(
      testConfig, emp(), { execution: { tier: "mid_pair", roles } }, ["alpha", "sec-reviewer"],
    );

    it("accepts per-role overrides and a mixed direct/external fallback chain", () => {
      const r = rolesUpdate({
        implementer: { override: { engine: "codex", model: "gpt-5.5", effortLevel: "high" } },
        reviewer: {
          override: { model: "haiku" },
          fallbackChain: [
            { engine: "codex", model: "gpt-5.4" },
            { employee: "sec-reviewer" },
          ],
        },
      });
      expect(r.ok).toBe(true);
    });

    it("rejects unknown role keys", () => {
      const r = rolesUpdate({ architect: {} });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/architect/);
    });

    it("rejects unknown policy and override keys", () => {
      expect(rolesUpdate({ reviewer: { fallbackModel: "x" } }).ok).toBe(false);
      expect(rolesUpdate({ reviewer: { override: { temperature: 1 } } }).ok).toBe(false);
    });

    it("rejects a chain entry that mixes employee with engine/model", () => {
      const r = rolesUpdate({ reviewer: { fallbackChain: [{ employee: "sec-reviewer", engine: "codex", model: "gpt-5.5" }] } });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/either employee OR engine\+model/);
    });

    it("rejects a chain entry missing model", () => {
      const r = rolesUpdate({ reviewer: { fallbackChain: [{ engine: "codex" }] } });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/employee, or both engine and model/);
    });

    it("rejects a self-referential external-agent target", () => {
      const r = validateEmployeeUpdate(
        testConfig, emp(), { execution: { tier: "mid_pair", roles: { reviewer: { fallbackChain: [{ employee: emp().name }] } } } },
      );
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/itself/);
    });

    it("rejects an external-agent target for an unknown employee when names are provided", () => {
      const r = rolesUpdate({ reviewer: { fallbackChain: [{ employee: "ghost" }] } });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/unknown employee "ghost"/);
    });

    it("rejects a chain longer than the cap", () => {
      const chain = Array.from({ length: 6 }, (_, i) => ({ engine: "codex", model: `m${i}` }));
      const r = rolesUpdate({ reviewer: { fallbackChain: chain } });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/maximum of 5/);
    });

    it("still validates reportsTo against known names after the roles check consumed them (iterator safety)", () => {
      function* names() { yield "alpha"; yield "sec-reviewer"; }
      const r = validateEmployeeUpdate(
        testConfig, emp(),
        {
          reportsTo: "alpha",
          execution: { tier: "mid_pair", roles: { reviewer: { fallbackChain: [{ employee: "sec-reviewer" }] } } },
        },
        names(),
      );
      expect(r.ok).toBe(true);
    });
  });

  it("rejects an invalid rank enum", () => {
    const r = validateEmployeeUpdate(testConfig, emp(), { rank: "boss" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/rank/i);
  });

  it("rejects an unknown model for the engine", () => {
    const r = validateEmployeeUpdate(testConfig, emp(), { model: "ultrabad" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/model/i);
  });

  it("rejects an invalid effort level", () => {
    const r = validateEmployeeUpdate(testConfig, emp(), { effortLevel: "ultra" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/effort/i);
  });

  it("rejects an unknown engine", () => {
    const r = validateEmployeeUpdate(testConfig, emp(), { engine: "wat" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/engine/i);
  });

  it("validates model against the NEW engine when engine changes", () => {
    // switching to codex with a valid codex model should pass
    const ok = validateEmployeeUpdate(testConfig, emp(), {
      engine: "codex",
      model: "gpt-5.5",
    });
    expect(ok.ok).toBe(true);
    // a claude model is invalid for codex
    const bad = validateEmployeeUpdate(testConfig, emp(), {
      engine: "codex",
      model: "opus",
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/model/i);
  });

  it("rejects an empty/whitespace persona (G3)", () => {
    const empty = validateEmployeeUpdate(testConfig, emp(), { persona: "" });
    expect(empty.ok).toBe(false);
    expect(empty.error).toMatch(/persona/i);
    const blank = validateEmployeeUpdate(testConfig, emp(), { persona: "   " });
    expect(blank.ok).toBe(false);
  });

  it("rejects an empty/whitespace displayName (G3)", () => {
    const r = validateEmployeeUpdate(testConfig, emp(), { displayName: "  " });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/displayName/i);
  });

  it("allows clearing department to an explicit blank string", () => {
    const result = validateEmployeeUpdate(testConfig, emp(), { department: "  " });
    expect(result.ok).toBe(true);
    expect(result.updates?.department).toBe("");
  });

  it("rejects unsafe department path values", () => {
    expect(validateEmployeeUpdate(testConfig, emp(), { department: "../security" }).ok).toBe(false);
    expect(validateEmployeeUpdate(testConfig, emp(), { department: "/tmp/security" }).ok).toBe(false);
  });

  it("rejects wrong-typed cliFlags / alwaysNotify / reportsTo", () => {
    expect(validateEmployeeUpdate(testConfig, emp(), { cliFlags: "nope" as any }).ok).toBe(false);
    expect(validateEmployeeUpdate(testConfig, emp(), { alwaysNotify: "yes" as any }).ok).toBe(false);
    expect(validateEmployeeUpdate(testConfig, emp(), { reportsTo: 42 as any }).ok).toBe(false);
  });

  it("accepts reportsTo as a string or string array", () => {
    expect(validateEmployeeUpdate(testConfig, emp(), { reportsTo: "lead" }).ok).toBe(true);
    expect(validateEmployeeUpdate(testConfig, emp(), { reportsTo: ["a", "b"] }).ok).toBe(true);
  });

  it("rejects reportsTo values that do not exist in the known org roster", () => {
    const result = validateEmployeeUpdate(testConfig, emp(), { reportsTo: "cuttlefish" }, ["parliamentarian", "hr-manager"]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown employee/i);
  });

  it("rejects reportsTo values that point at the employee itself", () => {
    const result = validateEmployeeUpdate(testConfig, emp({ name: "senior-security-officer" } as any), {
      reportsTo: "senior-security-officer",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/itself/i);
  });

  it("accepts reportsTo null to clear the supervisor chain", () => {
    const result = validateEmployeeUpdate(testConfig, emp(), { reportsTo: null });
    expect(result.ok).toBe(true);
    expect(result.updates?.reportsTo).toEqual([]);
  });

  it("accepts machine-readable security gate fields", () => {
    const result = validateEmployeeUpdate(testConfig, emp(), {
      approvalPolicy: "notify",
      reviewTriggers: ["privileged_shell", "external_network"],
      securityReviewer: "senior-security-officer",
    });
    expect(result.ok).toBe(true);
    expect(result.updates).toMatchObject({
      approvalPolicy: "notify",
      reviewTriggers: ["privileged_shell", "external_network"],
      securityReviewer: "senior-security-officer",
    });
  });

  it("accepts reviewTriggers without explicit approvalPolicy and relies on runtime notify default", () => {
    const result = validateEmployeeUpdate(testConfig, emp(), {
      reviewTriggers: ["privileged_shell"],
    });
    expect(result.ok).toBe(true);
    expect(result.updates).toMatchObject({
      reviewTriggers: ["privileged_shell"],
    });
  });

  it("accepts string avatar/emoji including the empty-string clear signal", () => {
    expect(validateEmployeeUpdate(testConfig, emp(), { avatar: "nautical:anchor" }).ok).toBe(true);
    expect(validateEmployeeUpdate(testConfig, emp(), { emoji: "🦊" }).ok).toBe(true);
    const cleared = validateEmployeeUpdate(testConfig, emp(), { avatar: "", emoji: "🦊" });
    expect(cleared.ok).toBe(true);
    expect(cleared.updates).toMatchObject({ avatar: "", emoji: "🦊" });
  });

  it("rejects non-string avatar/emoji", () => {
    expect(validateEmployeeUpdate(testConfig, emp(), { avatar: 123 as any }).ok).toBe(false);
    expect(validateEmployeeUpdate(testConfig, emp(), { emoji: {} as any }).ok).toBe(false);
  });

  it("rejects an empty update with no recognized fields", () => {
    const r = validateEmployeeUpdate(testConfig, emp(), {});
    expect(r.ok).toBe(false);
  });

  it("validates a create payload for a new employee", () => {
    const result = validateEmployeeCreate(testConfig, {
      name: "reviewer",
      displayName: "Reviewer",
      department: "platform",
      rank: "senior",
      engine: "claude",
      model: "sonnet",
      fallbackModel: "opus",
      persona: "Review changes.",
      approvalPolicy: "checkpoint",
      reviewTriggers: ["destructive_shell"],
      securityReviewer: "senior-security-officer",
    }, []);
    expect(result.ok).toBe(true);
    expect(result.employee).toMatchObject({
      name: "reviewer",
      fallbackModel: "opus",
      approvalPolicy: "checkpoint",
    });
  });

  it("validates a create payload for a cross-engine fallback target", () => {
    const result = validateEmployeeCreate(testConfig, {
      name: "router",
      displayName: "Router",
      department: "platform",
      rank: "senior",
      engine: "codex",
      model: "gpt-5.5",
      fallbackEngine: "claude",
      fallbackModel: "sonnet",
      persona: "Route work.",
    }, []);
    expect(result.ok).toBe(true);
    expect(result.employee).toMatchObject({
      name: "router",
      fallbackEngine: "claude",
      fallbackModel: "sonnet",
    });
  });

  it("carries the execution profile through create so it actually persists (regression)", () => {
    const result = validateEmployeeCreate(testConfig, {
      name: "pairer",
      displayName: "Pairer",
      department: "platform",
      rank: "senior",
      engine: "claude",
      model: "sonnet",
      persona: "Pair on changes.",
      execution: {
        tier: "mid_pair",
        reviewerLossPolicy: "replace_then_degrade",
        reviewerToolProfile: "read_only",
        maxInternalPasses: 2,
      },
    }, []);
    expect(result.ok).toBe(true);
    // Before the fix the returned employee object omitted `execution`, so the
    // create path silently dropped the operator's reviewer config.
    expect(result.employee?.execution).toMatchObject({ tier: "mid_pair", maxInternalPasses: 2 });
    // And it must survive into the persisted YAML data.
    const data = buildEmployeeCreateData(result.employee!);
    expect(data.execution).toMatchObject({ tier: "mid_pair", reviewerToolProfile: "read_only" });
  });

  it("accepts reportsTo to an existing employee when known names are a one-shot iterator (regression: F1)", () => {
    // Production passes `registry.keys()` — a single-use Map iterator. The
    // duplicate-name guard used to consume it via Array.from() before the reportsTo
    // check ran, leaving that check an empty set, so every valid manager reference
    // was rejected as "unknown employee". Passing an iterator here locks the contract.
    const knownNames = new Map([["eng-lead", 1], ["frontend-dev", 1]]).keys();
    const result = validateEmployeeCreate(testConfig, {
      name: "backend-dev",
      displayName: "Backend Dev",
      department: "engineering",
      rank: "employee",
      engine: "claude",
      model: "sonnet",
      persona: "Implement services.",
      reportsTo: "eng-lead",
    }, knownNames);
    expect(result.ok).toBe(true);
    expect(result.employee?.reportsTo).toBe("eng-lead");
  });

  it("still rejects reportsTo to a non-existent employee with an iterator roster (regression: F1)", () => {
    const knownNames = new Map([["eng-lead", 1]]).keys();
    const result = validateEmployeeCreate(testConfig, {
      name: "ghost",
      displayName: "Ghost",
      department: "engineering",
      rank: "employee",
      engine: "claude",
      model: "sonnet",
      persona: "Report to nobody real.",
      reportsTo: "does-not-exist",
    }, knownNames);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown employee");
  });

  it("replaces the execution block wholesale on mid_pair → solo downgrade (regression)", () => {
    // Existing YAML carries a full mid_pair reviewer config.
    const existing = {
      name: "pairer",
      engine: "claude",
      execution: {
        tier: "mid_pair",
        reviewerLossPolicy: "replace_then_degrade",
        reviewerToolProfile: "read_only",
        maxInternalPasses: 3,
        maxChildSessions: 3,
      },
    };
    // Operator downgrades to solo — the editor sends only { tier: "solo" }.
    const merged = mergeEmployeeUpdateData(existing, { execution: { tier: "solo" } });
    // The stale reviewer-only fields must be gone, not deep-merged through.
    expect(merged.execution).toEqual({ tier: "solo" });
  });

  it("clears the execution block when execution is null", () => {
    const existing = { name: "pairer", engine: "claude", execution: { tier: "mid_pair" } };
    const merged = mergeEmployeeUpdateData(existing, { execution: null });
    expect(merged.execution).toBeUndefined();
  });
});
