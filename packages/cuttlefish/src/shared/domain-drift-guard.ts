import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const TEXT_EXTENSIONS = new Set([
  ".css",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const SKIP_DIRS = new Set([
  ".git",
  ".turbo",
  "audits",
  "coverage",
  "dist",
  "logs",
  "node_modules",
  "out",
  "plans",
  "superpowers",
]);

const BLOCKED_TERMS = [["da", "wes"].join("")];

function normalizeForRepo(relativePath: string): string {
  return relativePath.split("\\").join("/");
}

function listTextFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const rootStat = statSync(root);
  if (rootStat.isFile()) {
    return TEXT_EXTENSIONS.has(extname(root)) ? [root] : [];
  }

  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(root, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listTextFiles(full));
      continue;
    }
    if (stat.isFile() && TEXT_EXTENSIONS.has(extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

export function defaultDomainDriftScanPaths(repoRoot: string): string[] {
  return [
    join(repoRoot, "README.md"),
    join(repoRoot, "docs"),
    join(repoRoot, "packages", "cuttlefish", "template"),
    join(repoRoot, "packages", "cuttlefish", "src"),
    join(repoRoot, "packages", "web", "src"),
  ];
}

export function scanDomainDrift(repoRoot: string, scanPaths = defaultDomainDriftScanPaths(repoRoot)): string[] {
  const findings: string[] = [];

  for (const file of scanPaths.flatMap(listTextFiles)) {
    const relativeFile = normalizeForRepo(relative(repoRoot, file));
    const relativeLower = relativeFile.toLowerCase();
    const text = readFileSync(file, "utf-8");
    const lower = text.toLowerCase();

    for (const term of BLOCKED_TERMS) {
      const termLower = term.toLowerCase();
      if (relativeLower.includes(termLower)) {
        findings.push(`${relativeFile} path contains "${term}"`);
      }

      const index = lower.indexOf(termLower);
      if (index === -1) continue;

      const line = text.slice(0, index).split(/\r?\n/).length;
      findings.push(`${relativeFile}:${line} contains "${term}"`);
    }
  }

  return findings.sort();
}
