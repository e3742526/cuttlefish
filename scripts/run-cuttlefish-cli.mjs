#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(repoRoot, "packages", "cuttlefish", "dist", "bin", "cuttlefish.js");
const srcDir = path.join(repoRoot, "packages", "cuttlefish", "src");
const servedWebIndex = path.join(repoRoot, "packages", "cuttlefish", "dist", "web", "index.html");
const webOutIndex = path.join(repoRoot, "packages", "web", "out", "index.html");
const webInputs = [
  path.join(repoRoot, "packages", "web", "src"),
  path.join(repoRoot, "packages", "web", "index.html"),
  path.join(repoRoot, "packages", "web", "package.json"),
  path.join(repoRoot, "packages", "web", "vite.config.ts"),
];

if (needsBuild()) {
  const build = spawnSync(pnpmBin(), ["build"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }
}

const run = spawnSync(process.execPath, [cliEntry, ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: "inherit",
});

if (run.error) throw run.error;
process.exit(run.status ?? 0);

function pnpmBin() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

/**
 * Rebuild when the compiled entry is missing OR any source file is newer than it
 * (an edit under src/ would otherwise run a stale dist binary). In a published /
 * packed layout there is no src/ tree, so the built artifact is authoritative.
 */
function needsBuild() {
  if (!existsSync(cliEntry)) return true;
  const cliMtime = statSync(cliEntry).mtimeMs;
  if (existsSync(srcDir) && hasFileNewerThan(srcDir, cliMtime)) return true;

  if (!existsSync(servedWebIndex)) return true;
  const servedWebMtime = statSync(servedWebIndex).mtimeMs;
  if (existsSync(webOutIndex) && statSync(webOutIndex).mtimeMs > servedWebMtime) return true;
  return hasAnyFileNewerThan(webInputs, servedWebMtime);
}

function hasAnyFileNewerThan(paths, thresholdMs) {
  return paths.some((item) => {
    if (!existsSync(item)) return false;
    const stat = statSync(item);
    if (stat.isDirectory()) return hasFileNewerThan(item, thresholdMs);
    return stat.isFile() && stat.mtimeMs > thresholdMs;
  });
}

/** Early-exit recursive walk: true on the first non-symlinked file newer than thresholdMs. */
function hasFileNewerThan(dir, thresholdMs) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (hasFileNewerThan(full, thresholdMs)) return true;
    } else if (entry.isFile()) {
      try {
        if (statSync(full).mtimeMs > thresholdMs) return true;
      } catch {
        // Vanished between readdir and stat — ignore.
      }
    }
  }
  return false;
}
