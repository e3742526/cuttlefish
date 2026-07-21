import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { CUTTLEFISH_HOME, SKILLS_DIR } from "../shared/paths.js";
import { safeWriteFile } from "../shared/safe-write.js";
import { safeRmSync } from "../shared/safe-delete.js";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export const SKILLS_JSON = path.join(CUTTLEFISH_HOME, "skills.json");
export const SKILLS_NPX_SPEC = "skills@1.5.12";

/** Well-known directories where `npx skills add -g` may install skills. */
const GLOBAL_SKILL_DIRS = [
  path.join(os.homedir(), ".claude", "skills"),
  path.join(os.homedir(), ".agents", "skills"),
  path.join(os.homedir(), ".codex", "skills"),
];

// ── Manifest helpers ──────────────────────────────────────────────

export interface SkillManifestEntry {
  name: string;
  source: string;
  installedAt: string;
}

interface StoredSkillManifest {
  installed?: Record<string, Partial<Omit<SkillManifestEntry, "name">>>;
}

export function readManifest(): SkillManifestEntry[] {
  if (!fs.existsSync(SKILLS_JSON)) return [];
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(SKILLS_JSON, "utf-8"));
    if (Array.isArray(parsed)) return parsed.filter(isSkillManifestEntry);
    if (parsed && typeof parsed === "object" && "installed" in parsed) {
      const installed = (parsed as StoredSkillManifest).installed;
      if (!installed || typeof installed !== "object" || Array.isArray(installed)) return [];
      return Object.entries(installed)
        .filter(([, value]) => value && typeof value.source === "string" && typeof value.installedAt === "string")
        .map(([name, value]) => ({ name, source: value.source!, installedAt: value.installedAt! }));
    }
    return [];
  } catch {
    return [];
  }
}

export function writeManifest(entries: SkillManifestEntry[]): void {
  const installed = Object.fromEntries(entries.map(({ name, source, installedAt }) => [name, { source, installedAt }]));
  safeWriteFile(SKILLS_JSON, JSON.stringify({ installed }, null, 2) + "\n"); // atomic + fsync (skills registry)
}

function isSkillManifestEntry(value: unknown): value is SkillManifestEntry {
  return !!value &&
    typeof value === "object" &&
    typeof (value as SkillManifestEntry).name === "string" &&
    typeof (value as SkillManifestEntry).source === "string" &&
    typeof (value as SkillManifestEntry).installedAt === "string";
}

export function upsertManifest(name: string, source: string): void {
  const manifest = readManifest();
  const idx = manifest.findIndex((e) => e.name === name);
  const entry: SkillManifestEntry = {
    name,
    source,
    installedAt: new Date().toISOString(),
  };
  if (idx >= 0) {
    manifest[idx] = entry;
  } else {
    manifest.push(entry);
  }
  writeManifest(manifest);
}

export function removeFromManifest(name: string): boolean {
  const manifest = readManifest();
  const idx = manifest.findIndex((e) => e.name === name);
  if (idx < 0) return false;
  manifest.splice(idx, 1);
  writeManifest(manifest);
  return true;
}

// ── Snapshot helpers for detecting newly installed skills ─────────

export function snapshotDirs(): Map<string, Set<string>> {
  const snap = new Map<string, Set<string>>();
  for (const dir of GLOBAL_SKILL_DIRS) {
    if (!fs.existsSync(dir)) {
      snap.set(dir, new Set());
      continue;
    }
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    snap.set(dir, new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name)));
  }
  return snap;
}

export function diffSnapshots(
  before: Map<string, Set<string>>,
  after: Map<string, Set<string>>,
): Array<{ dir: string; name: string }> {
  const newEntries: Array<{ dir: string; name: string }> = [];
  for (const [dir, afterSet] of after) {
    const beforeSet = before.get(dir) || new Set();
    for (const name of afterSet) {
      if (!beforeSet.has(name)) {
        newEntries.push({ dir, name });
      }
    }
  }
  return newEntries;
}

// ── Helpers ───────────────────────────────────────────────────────

export function extractSkillName(pkg: string): string {
  // "owner/repo@skill-name" → "skill-name"
  const atIdx = pkg.lastIndexOf("@");
  if (atIdx > 0) return pkg.slice(atIdx + 1);
  // "owner/repo" → "repo"
  const slashIdx = pkg.lastIndexOf("/");
  if (slashIdx >= 0) return pkg.slice(slashIdx + 1);
  return pkg;
}

export function findExistingSkill(name: string): { name: string; dir: string } | null {
  for (const dir of GLOBAL_SKILL_DIRS) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) {
      return { name, dir: candidate };
    }
  }
  return null;
}

export function runNpxSkills(args: string[], stdio: "inherit" | "pipe" = "inherit"): ReturnType<typeof spawnSync> {
  return spawnSync("npx", ["skills", ...args], {
    stdio,
    shell: false,
  });
}

export function copySkillToInstance(name: string, sourceDir: string): void {
  // Path-traversal guard (CRC-01): `name` derives from package strings that can
  // contain `..` or separators (e.g. `cuttlefish skills add owner/../../evil`). Ensure
  // the resolved destination stays inside SKILLS_DIR before writing anything.
  const root = path.resolve(SKILLS_DIR);
  const destDir = path.resolve(root, name);
  if (destDir !== root && !destDir.startsWith(root + path.sep)) {
    throw new Error(`Refusing to install skill outside skills directory: ${name}`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  copyDirRecursive(sourceDir, destDir);
}

export interface SkillsAddDependencies {
  runInstaller?: (args: string[]) => ReturnType<typeof spawnSync>;
  findGlobalSkill?: (name: string) => { name: string; dir: string } | null;
  snapshot?: () => Map<string, Set<string>>;
  diffSnapshots?: (
    before: Map<string, Set<string>>,
    after: Map<string, Set<string>>,
  ) => Array<{ dir: string; name: string }>;
}

function addExistingSkillToInstance(source: string, existing: { name: string; dir: string }): void {
  copySkillToInstance(existing.name, existing.dir);
  upsertManifest(existing.name, source);
  console.log(`\n${GREEN}Skill "${existing.name}" added to ${SKILLS_DIR}${RESET}`);
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ── CLI action functions ──────────────────────────────────────────

export function skillsFind(query?: string): void {
  const args = ["find"];
  if (query) args.push(query);
  const result = runNpxSkills(args);
  process.exitCode = result.status ?? 1;
}

export function skillsAdd(pkg: string, dependencies: SkillsAddDependencies = {}): void {
  const skillName = extractSkillName(pkg);
  const manifestEntry = readManifest().find((entry) => entry.name === skillName);
  const instanceDir = path.join(SKILLS_DIR, skillName);
  if (manifestEntry && fs.existsSync(instanceDir)) {
    console.log(`\n${DIM}Skill "${skillName}" is already installed in ${SKILLS_DIR}${RESET}`);
    return;
  }

  const findGlobalSkill = dependencies.findGlobalSkill ?? findExistingSkill;
  const existingGlobal = findGlobalSkill(skillName);
  if (existingGlobal) {
    addExistingSkillToInstance(pkg, existingGlobal);
    return;
  }

  console.log(`\nInstalling skill: ${pkg}\n`);
  const snapshot = dependencies.snapshot ?? snapshotDirs;
  const detectNewDirs = dependencies.diffSnapshots ?? diffSnapshots;
  const before = snapshot();
  // Keep installer output out of the command's final status. Some global
  // installers exit non-zero after writing the skill, so state inspection
  // below—not that noisy process status alone—determines the truthful result.
  const result = (dependencies.runInstaller ?? ((args) => runNpxSkills(args, "pipe")))(["add", pkg, "-g", "-y"]);
  const newDirs = detectNewDirs(before, snapshot());
  const installed = newDirs[0]
    ? { name: newDirs[0].name, dir: path.join(newDirs[0].dir, newDirs[0].name) }
    : findGlobalSkill(skillName);

  if (installed) {
    addExistingSkillToInstance(pkg, installed);
    if (result.status !== 0) {
      console.log(`${YELLOW}The global installer reported a non-zero exit after creating the skill; the instance install completed.${RESET}`);
    }
    return;
  }

  console.error(`\n${RED}Failed to install skill.${RESET}`);
  process.exitCode = 1;
}

export function skillsRemove(name: string): void {
  const skillDir = path.join(SKILLS_DIR, name);
  if (!fs.existsSync(skillDir)) {
    console.error(`${RED}Skill "${name}" not found in ${SKILLS_DIR}${RESET}`);
    process.exitCode = 1;
    return;
  }

  safeRmSync(skillDir, { within: SKILLS_DIR, label: `skill directory "${name}"` });
  removeFromManifest(name);
  console.log(`${GREEN}Skill "${name}" removed.${RESET}`);
}

export function skillsList(): void {
  if (!fs.existsSync(SKILLS_DIR)) {
    console.log("No skills installed.");
    return;
  }

  const manifest = readManifest();
  const manifestMap = new Map(manifest.map((e) => [e.name, e]));

  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  const skillDirs = entries.filter((e) => e.isDirectory());

  if (skillDirs.length === 0) {
    console.log("No skills installed.");
    return;
  }

  console.log(`\n  Skills in ${DIM}${SKILLS_DIR}${RESET}\n`);
  for (const dir of skillDirs) {
    const meta = manifestMap.get(dir.name);
    const source = meta ? `${DIM}(${meta.source})${RESET}` : `${DIM}(local)${RESET}`;
    const skillMd = path.join(SKILLS_DIR, dir.name, "SKILL.md");
    let description = "";
    if (fs.existsSync(skillMd)) {
      const content = fs.readFileSync(skillMd, "utf-8");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const descMatch = fmMatch[1].match(/description:\s*(.+)/);
        if (descMatch) description = `  ${DIM}${descMatch[1].trim()}${RESET}`;
      }
    }
    console.log(`  ${GREEN}${dir.name}${RESET} ${source}${description}`);
  }
  console.log("");
}

export function skillsUpdate(): void {
  const manifest = readManifest();
  if (manifest.length === 0) {
    console.log("No skills in manifest to update.");
    return;
  }

  console.log(`\nUpdating ${manifest.length} skill(s)...\n`);
  for (const entry of manifest) {
    console.log(`  Updating ${entry.name} from ${entry.source}...`);
    const before = snapshotDirs();
    const result = runNpxSkills(["add", entry.source, "-g", "-y"], "pipe");

    if (result.status !== 0) {
      console.log(`  ${RED}Failed to update ${entry.name}${RESET}`);
      continue;
    }

    const after = snapshotDirs();
    const newDirs = diffSnapshots(before, after);
    if (newDirs.length > 0) {
      copySkillToInstance(newDirs[0].name, path.join(newDirs[0].dir, newDirs[0].name));
    } else {
      const existing = findExistingSkill(entry.name);
      if (existing) {
        copySkillToInstance(existing.name, existing.dir);
      }
    }
    upsertManifest(entry.name, entry.source);
    console.log(`  ${GREEN}Updated ${entry.name}${RESET}`);
  }
  console.log("");
}

export function skillsRestore(): void {
  const manifest = readManifest();
  if (manifest.length === 0) {
    console.log("No skills in manifest to restore.");
    return;
  }

  console.log(`\nRestoring ${manifest.length} skill(s)...\n`);
  for (const entry of manifest) {
    const destDir = path.join(SKILLS_DIR, entry.name);
    if (fs.existsSync(destDir)) {
      console.log(`  ${DIM}${entry.name} already exists, skipping${RESET}`);
      continue;
    }

    console.log(`  Installing ${entry.name} from ${entry.source}...`);
    const before = snapshotDirs();
    const result = runNpxSkills(["add", entry.source, "-g", "-y"], "pipe");

    if (result.status !== 0) {
      console.log(`  ${RED}Failed to install ${entry.name}${RESET}`);
      continue;
    }

    const after = snapshotDirs();
    const newDirs = diffSnapshots(before, after);
    if (newDirs.length > 0) {
      copySkillToInstance(newDirs[0].name, path.join(newDirs[0].dir, newDirs[0].name));
    } else {
      const existing = findExistingSkill(entry.name);
      if (existing) {
        copySkillToInstance(existing.name, existing.dir);
      }
    }
    console.log(`  ${GREEN}Restored ${entry.name}${RESET}`);
  }
  console.log("");
}
