import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Resolve packages/cuttlefish/ from this test file (…/src/cli/__tests__/) — never touch
// the real ~/.cuttlefish; assert against the shipped sources statically.
const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TEMPLATE = join(PKG, "template");
const SETUP = join(PKG, "src", "cli", "setup.ts");

describe("fresh-install: talk seeding + config guidance", () => {
  it("ships the AURA voice persona + card-reference sidecar in the template", () => {
    expect(existsSync(join(TEMPLATE, "talk", "orchestrator-persona.md"))).toBe(true);
    expect(existsSync(join(TEMPLATE, "talk", "card-reference.md"))).toBe(true);
  });

  it("seeds template/talk/ into the home during setup", () => {
    expect(readFileSync(SETUP, "utf-8")).toMatch(/copyTemplateDir\(\s*path\.join\(TEMPLATE_DIR, "talk"\)/);
  });

  it("documents the mcp block in the default config so new users can enable it", () => {
    expect(readFileSync(SETUP, "utf-8")).toMatch(/#\s*mcp:/);
  });

  it("guides engine authentication after the version probe", () => {
    expect(readFileSync(SETUP, "utf-8")).toMatch(/does NOT mean the engine is logged in/);
  });

  it("the generic persona carries no maintainer-personal PII", () => {
    const persona = readFileSync(join(TEMPLATE, "talk", "orchestrator-persona.md"), "utf-8");
    const maintainerPattern = new RegExp(
      [
        ["hris", "to"].join(""),
        ["kiwi", "labs"].join(""),
        ["tucker", "@"].join(""),
        ["Kiwi", " Labs"].join(""),
      ].join("|"),
      "i",
    );
    expect(persona).not.toMatch(maintainerPattern);
  });

  it("ships an HR steward seed that knows onboarding and team-formation workflow", () => {
    const steward = readFileSync(join(TEMPLATE, "org", "personnel", "hr-manager.yaml"), "utf-8");
    expect(steward).toMatch(/skills\/onboarding\/SKILL\.md/);
    expect(steward).toMatch(/skills\/management\/SKILL\.md/);
    expect(steward).toMatch(/build a team|create a team/);
  });

  it("seeds first-run departments and reporting lines without over-attaching everyone to Parliamentarian", () => {
    const hr = readFileSync(join(TEMPLATE, "org", "personnel", "hr-manager.yaml"), "utf-8");
    const parliamentarian = readFileSync(join(TEMPLATE, "org", "compliance", "parliamentarian.yaml"), "utf-8");
    const security = readFileSync(join(TEMPLATE, "org", "compliance", "senior-security-officer.yaml"), "utf-8");
    const assistant = readFileSync(join(TEMPLATE, "org", "general", "assistant.yaml"), "utf-8");

    expect(existsSync(join(TEMPLATE, "org", "general", "hr-manager.yaml"))).toBe(false);
    expect(existsSync(join(TEMPLATE, "org", "general", "parliamentarian.yaml"))).toBe(false);
    expect(existsSync(join(TEMPLATE, "org", "general", "senior-security-officer.yaml"))).toBe(false);
    expect(hr).toMatch(/department: personnel/);
    expect(hr).not.toMatch(/reportsTo:/);
    expect(parliamentarian).toMatch(/department: compliance/);
    expect(parliamentarian).not.toMatch(/reportsTo:/);
    expect(security).toMatch(/department: compliance/);
    expect(security).toMatch(/reportsTo: parliamentarian/);
    expect(assistant).toMatch(/department: general/);
    expect(assistant).not.toMatch(/reportsTo: parliamentarian/);
  });

  it("instructs HR that new managers report to the COO unless the user says otherwise", () => {
    const managementSkill = readFileSync(join(TEMPLATE, "skills", "management", "SKILL.md"), "utf-8");
    const manual = readFileSync(join(TEMPLATE, "CLAUDE.md"), "utf-8");

    expect(managementSkill).toMatch(/rank` is `manager`, omit `reportsTo`/);
    expect(managementSkill).toMatch(/Smart defaults attach managers to \{\{portalName\}\} \/ COO root/);
    expect(manual).toMatch(/managers → \{\{portalName\}\} \/ COO root unless the user explicitly says otherwise/);
  });
});
