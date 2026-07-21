#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const requiredFiles = [
  "LICENSE",
  "README.md",
  "package.json",
  "assets/hook-relay.mjs",
  "dist/bin/cuttlefish.js",
  "dist/web/index.html",
  "template/CLAUDE.md",
  "node_modules/@cuttlefish/contracts/dist/index.js",
];

let packOutput;
try {
  packOutput = execFileSync(npmCommand, ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: packageDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // npm.cmd is a batch wrapper; without shell, execFileSync fails on Windows.
    shell: process.platform === "win32",
  });
} catch (error) {
  const stderr = error instanceof Error && "stderr" in error ? error.stderr : undefined;
  const stdout = error instanceof Error && "stdout" in error ? error.stdout : undefined;
  const detail = [stderr, stdout, error instanceof Error ? error.message : String(error)]
    .map((part) => (part == null ? "" : String(part).trim()))
    .filter(Boolean)
    .join("\n");
  throw new Error(`npm pack --dry-run failed: ${detail || "(no output)"}`);
}

let pack;
try {
  pack = JSON.parse(packOutput);
} catch {
  throw new Error("npm pack --dry-run did not return JSON");
}

const result = pack[0];
const shippedFiles = new Set(result?.files?.flatMap((file) => (file.path ? [file.path] : [])) ?? []);
const missing = requiredFiles.filter((file) => !shippedFiles.has(file));
if (missing.length > 0) {
  throw new Error(`npm package is missing required file(s): ${missing.join(", ")}`);
}

const sourceFiles = [...shippedFiles].filter((file) => file.startsWith("src/"));
if (sourceFiles.length > 0) {
  throw new Error(`npm package must not ship TypeScript source: ${sourceFiles.join(", ")}`);
}

console.log(`Verified ${result.name}@${result.version} package contents (${shippedFiles.size} files).`);
