import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

const { home } = withStaticTempCuttlefishHome("cuttlefish-skills-add-");
const { SKILLS_JSON, readManifest, skillsAdd, skillsRemove } = await import("../skills.js");
const skillsDir = path.join(home, "skills");

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

function snapshot(entries: string[]): Map<string, Set<string>> {
  return new Map([["/global-skills", new Set(entries)]]);
}

beforeEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  process.exitCode = undefined;
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  process.exitCode = undefined;
});

describe("skills add outcome handling (PT-SC-06)", () => {
  it("does not invoke the global installer when the instance manifest already owns the skill", () => {
    fs.mkdirSync(path.join(skillsDir, "example-skill"), { recursive: true });
    fs.writeFileSync(SKILLS_JSON, JSON.stringify({
      installed: { "example-skill": { source: "owner/repo@example-skill", installedAt: "2026-07-20T00:00:00.000Z" } },
    }));
    const runInstaller = vi.fn();

    skillsAdd("owner/repo@example-skill", { runInstaller });

    expect(runInstaller).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("already installed"));
  });

  it("treats a non-zero global installer exit as success when the new skill is present", () => {
    const globalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-skills-global-"));
    const sourceDir = path.join(globalRoot, "example-skill");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "SKILL.md"), "# Example skill\n");
    const snapshots = [snapshot([]), snapshot(["example-skill"])];

    skillsAdd("owner/repo@example-skill", {
      runInstaller: vi.fn(() => ({ status: 1 }) as ReturnType<typeof import("node:child_process").spawnSync>),
      snapshot: () => snapshots.shift() ?? snapshot(["example-skill"]),
      diffSnapshots: () => [{ dir: globalRoot, name: "example-skill" }],
      findGlobalSkill: () => null,
    });

    expect(fs.existsSync(path.join(skillsDir, "example-skill", "SKILL.md"))).toBe(true);
    expect(readManifest()).toEqual([expect.objectContaining({ name: "example-skill", source: "owner/repo@example-skill" })]);
    expect(process.exitCode).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("instance install completed"));
    fs.rmSync(globalRoot, { recursive: true, force: true });
  });

  it("re-adds a removed instance skill from the existing global copy without invoking the installer", () => {
    const globalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-skills-global-"));
    const sourceDir = path.join(globalRoot, "example-skill");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "SKILL.md"), "# Example skill\n");
    const runInstaller = vi.fn();

    skillsAdd("owner/repo@example-skill", {
      runInstaller,
      findGlobalSkill: () => ({ name: "example-skill", dir: sourceDir }),
    });
    expect(skillsRemove("example-skill")).toBeUndefined();
    skillsAdd("owner/repo@example-skill", {
      runInstaller,
      findGlobalSkill: () => ({ name: "example-skill", dir: sourceDir }),
    });

    expect(runInstaller).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(skillsDir, "example-skill", "SKILL.md"))).toBe(true);
    expect(readManifest()).toEqual([expect.objectContaining({ name: "example-skill" })]);
    fs.rmSync(globalRoot, { recursive: true, force: true });
  });
});
