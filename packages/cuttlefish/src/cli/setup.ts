import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { execFile, execSync } from "node:child_process";
import { promisify } from "node:util";
import yaml from "js-yaml";
import { isInstalled, resolveBin } from "../shared/resolve-bin.js";
import { safeWriteFile } from "../shared/safe-write.js";
import { buildEngineEnv } from "../shared/engine-env.js";
import {
  CUTTLEFISH_HOME,
  CONFIG_PATH,
  CRON_JOBS,
  CRON_RUNS,
  TMP_DIR,
  TEMPLATE_DIR,
  LOGS_DIR,
  DOCS_DIR,
  SKILLS_DIR,
  ORG_DIR,
  ORCH_CONFIG_DIR,
  CLAUDE_SKILLS_DIR,
  AGENTS_SKILLS_DIR,
} from "../shared/paths.js";
import { initDb } from "../sessions/registry.js";
import { getPackageVersion } from "../shared/version.js";
import { assertSafeDestructiveHome } from "./instances.js";
import { SKILLS_NPX_SPEC } from "./skills.js";

const execFileAsync = promisify(execFile);
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function ok(msg: string) {
  console.log(`  ${GREEN}[ok]${RESET} ${msg}`);
}

function warn(msg: string) {
  console.log(`  ${YELLOW}[warn]${RESET} ${msg}`);
}

async function preCacheSkillsCli(): Promise<void> {
  try {
    await execFileAsync("npx", ["--yes", SKILLS_NPX_SPEC, "--version"], {
      env: buildEngineEnv({}),
      timeout: 15_000,
      windowsHide: true,
    });
  } catch {
    warn("Skills CLI pre-cache failed (non-fatal)");
  }
}

function fail(msg: string) {
  console.log(`  ${RED}[missing]${RESET} ${msg}`);
}

function info(msg: string) {
  console.log(`  ${DIM}${msg}${RESET}`);
}

function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` ${DIM}(${defaultValue})${RESET}` : "";
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || "");
      rl.close();
    });
    rl.on("close", () => resolve(defaultValue || ""));
  });
}

function whichBin(name: string): string | null {
  // Match the runtime's resolution (PATH + common bin dirs like ~/.local/bin),
  // not just PATH, so setup doesn't warn about an engine the gateway can find.
  return isInstalled(name) ? resolveBin(name) : null;
}

function runVersion(bin: string): string | null {
  try {
    return execSync(`${bin} --version`, { encoding: "utf-8", timeout: 10000 }).trim();
  } catch {
    return null;
  }
}

function ensureDir(dir: string): boolean {
  if (fs.existsSync(dir)) return false;
  fs.mkdirSync(dir, { recursive: true });
  return true;
}

function ensureFile(filePath: string, content: string, mode?: number): boolean {
  if (fs.existsSync(filePath)) return false;
  safeWriteFile(filePath, content, mode !== undefined ? { mode } : undefined); // atomic + fsync (setup bootstrap)
  return true;
}

/**
 * Apply template placeholder replacements to file content.
 * Only applies to .md and .yaml files.
 */
function applyTemplateReplacements(
  content: string,
  replacements: Record<string, string>,
): string {
  let result = content;
  for (const [placeholder, value] of Object.entries(replacements)) {
    result = result.replaceAll(placeholder, value);
  }
  return result;
}

/**
 * Recursively copy template directory contents into dest, skipping files that already exist.
 * Applies template placeholder replacements to .md and .yaml files.
 * Returns list of created file paths.
 */
function copyTemplateDir(
  srcDir: string,
  destDir: string,
  replacements?: Record<string, string>,
): string[] {
  const created: string[] = [];
  if (!fs.existsSync(srcDir)) return created;

  fs.mkdirSync(destDir, { recursive: true });

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      created.push(...copyTemplateDir(srcPath, destPath, replacements));
    } else if (entry.name === ".gitkeep") {
      // skip .gitkeep — directory already created
      continue;
    } else if (!fs.existsSync(destPath)) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const ext = path.extname(entry.name).toLowerCase();
      if (replacements && (ext === ".md" || ext === ".yaml" || ext === ".yml")) {
        const content = fs.readFileSync(srcPath, "utf-8");
        safeWriteFile(destPath, applyTemplateReplacements(content, replacements)); // atomic + fsync (templated setup file)
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
      created.push(destPath);
    }
  }
  return created;
}

/**
 * Detect project context by scanning ~/Projects/ for common project indicators
 * and suggest relevant skills the user might want to install.
 */
function detectProjectContext(portalSlug: string): void {
  const projectsDir = path.join(os.homedir(), "Projects");
  if (!fs.existsSync(projectsDir)) return;

  const indicators: { check: (dir: string) => boolean; query: string; label: string }[] = [
    {
      check: (dir) => {
        try {
          return fs.readdirSync(dir).some((e) => e.endsWith(".xcodeproj"));
        } catch { return false; }
      },
      query: "ios swift xcode",
      label: "iOS",
    },
    {
      check: (dir) => fs.existsSync(path.join(dir, "Package.swift")),
      query: "ios swift xcode",
      label: "iOS/Swift",
    },
    {
      check: (dir) => fs.existsSync(path.join(dir, "Dockerfile")),
      query: "docker container",
      label: "Docker",
    },
    {
      check: (dir) => fs.existsSync(path.join(dir, ".github", "workflows")),
      query: "github actions ci",
      label: "GitHub Actions",
    },
    {
      check: (dir) => {
        try {
          return fs.readdirSync(dir).some((e) => e.startsWith("playwright.config"));
        } catch { return false; }
      },
      query: "playwright testing",
      label: "Playwright",
    },
    {
      check: (dir) => {
        const pkgPath = path.join(dir, "package.json");
        if (!fs.existsSync(pkgPath)) return false;
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
          const deps = { ...pkg.dependencies, ...pkg.devDependencies };
          return deps != null && ("react" in deps || "next" in deps);
        } catch { return false; }
      },
      query: "react nextjs",
      label: "React",
    },
  ];

  const detected = new Map<string, string>(); // label → query

  try {
    const topLevel = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory());

    const projectDirs: string[] = [];
    for (const dir of topLevel) {
      const dirPath = path.join(projectsDir, dir.name);
      projectDirs.push(dirPath);
      // One level deeper for org-style folders (e.g. ~/Projects/Personal/foo)
      try {
        const subDirs = fs.readdirSync(dirPath, { withFileTypes: true })
          .filter((e) => e.isDirectory());
        for (const sub of subDirs) {
          projectDirs.push(path.join(dirPath, sub.name));
        }
      } catch {
        // ignore permission errors
      }
    }

    for (const projDir of projectDirs) {
      for (const ind of indicators) {
        if (detected.has(ind.label)) continue;
        if (ind.check(projDir)) {
          detected.set(ind.label, ind.query);
        }
      }
    }
  } catch {
    return;
  }

  if (detected.size > 0) {
    console.log("");
    for (const [label, query] of detected) {
      console.log(`  💡 Detected ${label} projects. Run ${DIM}${portalSlug} skills find ${query}${RESET} to discover relevant skills.`);
    }
  }
}

const DEFAULT_CONFIG = `cuttlefish:
  version: "${getPackageVersion()}"

gateway:
  port: 8888
  host: "127.0.0.1"
engines:
  default: claude
  claude:
    bin: claude
    model: opus
    effortLevel: medium
  codex:
    bin: codex
    model: gpt-5.5
  grok:
    bin: grok
    model: grok-build
  hermes:
    bin: hermes
    model: openai-codex:gpt-5.5
  ollama:
    bin: ollama
    model: gemma4
  kilo:
    bin: kilo
    model: default
  aider:
    bin: aider
    model: default
# Model + capability registry — single source of truth for the UI selectors.
# Add a model here (id + label + capability flags); no code change needed.
# effortLevels gate the effort picker (empty = no effort support). Omit the block
# to synthesize a minimal registry from engines.<name>.model.
models:
  claude:
    default: opus
    effortMechanism: claude-flag
    models:
      - { id: claude-fable-5, label: "Fable 5", supportsEffort: true, effortLevels: [low, medium, high], contextWindow: 1000000 }
      - { id: opus, label: "Opus 4.8", supportsEffort: true, effortLevels: [low, medium, high], contextWindow: 1000000 }
      - { id: claude-sonnet-5, label: "Sonnet 5", supportsEffort: true, effortLevels: [low, medium, high], contextWindow: 1000000 }
      - { id: claude-haiku-4-5, label: "Haiku 4.5", supportsEffort: true, effortLevels: [low, medium, high], contextWindow: 200000 }
  codex:
    default: gpt-5.5
    effortMechanism: codex-config
    models:
      - { id: gpt-5.5, label: "GPT-5.5 Codex", supportsEffort: true, effortLevels: [low, medium, high, xhigh], contextWindow: 1050000 }
  grok:
    default: grok-build
    effortMechanism: grok-flag
    models:
      - { id: grok-build, label: "Grok Build", supportsEffort: true, effortLevels: [low, medium, high, xhigh, max], contextWindow: 256000 }
      - { id: grok-composer-2.5-fast, label: "Grok Composer 2.5 Fast", supportsEffort: true, effortLevels: [low, medium, high, xhigh, max], contextWindow: 256000 }
  ollama:
    default: gemma4
    effortMechanism: none
    models:
      - { id: gemma4, label: "Gemma 4", supportsEffort: false, effortLevels: [] }
  kilo:
    default: default
    effortMechanism: none
    models:
      - { id: default, label: "Kilo (auto)", supportsEffort: false, effortLevels: [] }
  aider:
    default: default
    effortMechanism: none
    models:
      - { id: default, label: "Aider (auto)", supportsEffort: false, effortLevels: [] }
  antigravity:
    default: "Gemini 3.5 Flash (Medium)"
    effortMechanism: none
    models:
      - { id: "Gemini 3.5 Flash (Medium)", label: "Gemini 3.5 Flash Medium", supportsEffort: false, effortLevels: [], contextWindow: 1000000 }
      - { id: "Gemini 3.5 Flash (High)", label: "Gemini 3.5 Flash High", supportsEffort: false, effortLevels: [], contextWindow: 1000000 }
      - { id: "Gemini 3.5 Flash (Low)", label: "Gemini 3.5 Flash Low", supportsEffort: false, effortLevels: [], contextWindow: 1000000 }
      - { id: "Gemini 3.1 Pro (High)", label: "Gemini 3.1 Pro High", supportsEffort: false, effortLevels: [], contextWindow: 1000000 }
      - { id: "Gemini 3.1 Pro (Low)", label: "Gemini 3.1 Pro Low", supportsEffort: false, effortLevels: [], contextWindow: 1000000 }
      - { id: "Claude Sonnet 4.6 (Thinking)", label: "Claude Sonnet 4.6 Thinking", supportsEffort: false, effortLevels: [], contextWindow: 200000 }
      - { id: "Claude Opus 4.6 (Thinking)", label: "Claude Opus 4.6 Thinking", supportsEffort: false, effortLevels: [], contextWindow: 200000 }
      - { id: "GPT-OSS 120B (Medium)", label: "GPT-OSS 120B Medium", supportsEffort: false, effortLevels: [], contextWindow: 131072 }
connectors: {}
portal: {}

# ── Optional blocks (uncomment to customize) ──────────────────────────────
# MCP servers give employees browser, search, fetch, and messaging tools.
# mcp:
#   browser: { enabled: true, provider: playwright }
#   search:  { enabled: false, provider: brave }   # set true + add BRAVE_API_KEY
#   fetch:   { enabled: true }
#   gateway: { enabled: true }                      # built-in gateway MCP server
# Per-session safety limits (can be overridden per-employee in their YAML).
# sessions:
#   maxDurationMinutes: 30
#   maxCostUsd: 10.00
# Cron alerting — route failed scheduled jobs to a connector channel.
# cron:
#   alertConnector: slack
#   alertChannel: "#alerts"

logging:
  file: true
  stdout: true
  level: info
`;

function defaultClaudeMd(portalName: string) {
  return `# ${portalName} AI Gateway

This is the ${portalName} home directory (~/.cuttlefish).
${portalName} orchestrates multiple AI engines.
`;
}

function defaultAgentsMd(portalName: string) {
  return `# ${portalName} Agents

Agents are configured via employees in the org/ directory.
`;
}

export async function runSetup(opts?: { force?: boolean }): Promise<void> {
  console.log("\nCuttlefish Setup\n");

  if (opts?.force && fs.existsSync(CUTTLEFISH_HOME)) {
    const safeHome = assertSafeDestructiveHome(CUTTLEFISH_HOME);
    console.log(`  ${YELLOW}[force]${RESET} Removing ${safeHome}...`);
    fs.rmSync(safeHome, { recursive: true, force: true });
    console.log(`  ${GREEN}[ok]${RESET} Removed ${safeHome}\n`);
  }

  // 1. Check Node.js version
  const nodeVersion = parseInt(process.versions.node.split(".")[0], 10);
  if (nodeVersion >= 24 && nodeVersion < 25) {
    ok(`Node.js v${process.versions.node}`);
  } else {
    warn(`Node.js v${process.versions.node} -- v24.x required by repo tooling`);
  }

  // 2. Check for claude binary
  const claudePath = whichBin("claude");
  if (claudePath) {
    ok(`claude found at ${claudePath}`);
  } else {
    fail("claude not found");
    info("Install with: npm install -g @anthropic-ai/claude-code");
  }

  // 3. Check for codex binary
  const codexPath = whichBin("codex");
  if (codexPath) {
    ok(`codex found at ${codexPath}`);
  } else {
    fail("codex not found");
    info("Install with: npm install -g @openai/codex");
  }

  // 4. Check for grok binary
  const grokPath = whichBin("grok");
  if (grokPath) {
    ok(`grok found at ${grokPath}`);
  } else {
    fail("grok not found");
    info("Install with: npm install -g @xai-official/grok");
  }

  // 4a. Check for hermes binary
  const hermesPath = whichBin("hermes");
  if (hermesPath) {
    ok(`hermes found at ${hermesPath}`);
  } else {
    fail("hermes not found");
    info("Install the Hermes CLI: curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash");
  }

  // 4b. Check for ollama binary
  const ollamaPath = whichBin("ollama");
  if (ollamaPath) {
    ok(`ollama found at ${ollamaPath}`);
  } else {
    fail("ollama not found");
    info("Install from: https://ollama.com/download");
  }

  // 4c. Check for kilo binary
  const kiloPath = whichBin("kilo");
  if (kiloPath) {
    ok(`kilo found at ${kiloPath}`);
  } else {
    fail("kilo not found");
    info("Install with: npm install -g @kilocode/cli");
  }

  // 4d. Check for aider binary
  const aiderPath = whichBin("aider");
  if (aiderPath) {
    ok(`aider found at ${aiderPath}`);
  } else {
    fail("aider not found");
    info("Install with: python -m pip install aider-install && aider-install (or: pipx install aider-chat)");
  }

  // 5. Loudly warn if NO engine is installed — the gateway will start, but it
  //     cannot run any session until at least one engine CLI is on PATH.
  if (!claudePath && !codexPath && !grokPath && !hermesPath && !ollamaPath && !kiloPath && !aiderPath) {
    console.log("");
    warn("No AI engine CLI found (claude, codex, grok, hermes, ollama, kilo, or aider).");
    warn("The gateway will start, but sessions will fail until you install one above.");
  }

  // 6. Check auth / versions
  console.log("");
  if (claudePath) {
    const ver = runVersion("claude");
    if (ver) ok(`claude --version: ${ver}`);
    else warn("claude --version failed");
  }
  if (codexPath) {
    const ver = runVersion("codex");
    if (ver) ok(`codex --version: ${ver}`);
    else warn("codex --version failed");
  }
  if (grokPath) {
    const ver = runVersion("grok");
    if (ver) ok(`grok --version: ${ver}`);
    else warn("grok --version failed");
  }
  if (hermesPath) {
    const ver = runVersion("hermes");
    if (ver) ok(`hermes --version: ${ver}`);
    else warn("hermes --version failed");
  }
  if (ollamaPath) {
    const ver = runVersion("ollama");
    if (ver) ok(`ollama --version: ${ver}`);
    else warn("ollama --version failed");
  }
  if (kiloPath) {
    const ver = runVersion("kilo");
    if (ver) ok(`kilo --version: ${ver}`);
    else warn("kilo --version failed");
  }
  if (aiderPath) {
    const ver = runVersion("aider");
    if (ver) ok(`aider --version: ${ver}`);
    else warn("aider --version failed");
  }
  // A successful --version does NOT mean the engine is authenticated — the #1
  // silent fresh-install failure. Nudge the login step explicitly.
  if (claudePath || codexPath || grokPath || hermesPath || ollamaPath || kiloPath || aiderPath) {
    warn("A successful --version does NOT mean the engine is logged in.");
    if (claudePath) info("First run? Launch `claude` once and use /login to authenticate.");
    if (codexPath) info("First run? Launch `codex` once and sign in to authenticate.");
    if (grokPath) info("First run? Launch `grok` once to authenticate, or configure XAI_API_KEY.");
    if (hermesPath) info("First run? Launch `hermes` once to authenticate, or configure your API key.");
    if (ollamaPath) info("First run? Ensure Ollama is running and pull a model, e.g. `ollama pull gemma4`.");
    if (kiloPath) info("First run? Launch `kilo` once and use /connect to add a provider and model.");
    if (aiderPath) info("First run? Set a provider API key for aider, e.g. ANTHROPIC_API_KEY or OPENAI_API_KEY.");
    info("Do this before `cuttlefish start`, or sessions will fail silently.");
  }

  // 4b. Speech-to-text (mic) prerequisites — optional. The voice/mic flow on
  // /talk and /chat transcribes audio with whisper.cpp's `whisper-cli` plus
  // `ffmpeg` (to resample to 16kHz mono WAV). These are NOT required for the
  // gateway, text chat, or voice output — only mic input — so missing deps are
  // guidance, never a hard failure.
  console.log("");
  const whisperPath = whichBin("whisper-cli");
  const ffmpegPath = whichBin("ffmpeg");
  if (whisperPath && ffmpegPath) {
    ok("Speech-to-text (mic) ready -- whisper-cli + ffmpeg found");
  } else {
    warn("Speech-to-text (mic) unavailable -- mic input will be disabled (text + voice output still work).");
    if (!ffmpegPath) info("Install ffmpeg with: brew install ffmpeg");
    if (!whisperPath) info("Install whisper-cli with: brew install whisper-cpp");
    info("The transcription model is downloaded automatically from the app the first time you use the mic -- no manual fetch needed.");
  }

  // 5. Interactive setup (only when stdin is a TTY and config doesn't exist yet)
  const isFreshSetup = !fs.existsSync(CONFIG_PATH);
  const isInteractive = process.stdin.isTTY && isFreshSetup;

  // Keep setup branded to the canonical local instance.
  const defaultName = "Cuttlefish";

  let chosenName = defaultName;
  type SetupEngine = "claude" | "codex" | "grok" | "hermes" | "ollama" | "kilo" | "aider";
  let chosenEngine: SetupEngine = "claude";

  if (isInteractive) {
    console.log("");
    chosenName = await prompt("What should your AI assistant be called?", defaultName);

    // Determine available engines
    const engines: string[] = [];
    if (claudePath) engines.push("claude");
    if (codexPath) engines.push("codex");
    if (grokPath) engines.push("grok");
    if (hermesPath) engines.push("hermes");
    if (ollamaPath) engines.push("ollama");
    if (kiloPath) engines.push("kilo");
    if (aiderPath) engines.push("aider");

    if (engines.length > 1) {
      const defaultEngine = ["claude", "codex", "grok", "hermes"].find((engine) => engines.includes(engine)) ?? engines[0];
      const engineAnswer = await prompt(`Preferred engine? (${engines.join("/")})`, defaultEngine);
      chosenEngine = engines.includes(engineAnswer) ? engineAnswer as SetupEngine : defaultEngine as SetupEngine;
    } else if (engines.length === 1) {
      chosenEngine = engines[0] as SetupEngine;
      ok(`Using ${chosenEngine} as default engine (only engine installed)`);
    }
  }

  // 6. Create ~/.cuttlefish directory structure
  console.log("");
  const created: string[] = [];

  if (ensureDir(CUTTLEFISH_HOME)) created.push(CUTTLEFISH_HOME);

  // Copy or create config files.
  // DEFAULT_CONFIG (above) is the canonical default. `template/config.yaml` is an
  // optional override the installer prefers if present (none ships by default).
  const templateConfig = path.join(TEMPLATE_DIR, "config.yaml");
  const templateClaude = path.join(TEMPLATE_DIR, "CLAUDE.md");

  if (!fs.existsSync(CONFIG_PATH)) {
    let source = fs.existsSync(templateConfig)
      ? fs.readFileSync(templateConfig, "utf-8")
      : DEFAULT_CONFIG;
    // Stamp the current package version into the config
    source = source.replace(/version:\s*"[^"]*"/, `version: "${getPackageVersion()}"`);
    // Apply interactive choices
    source = source.replace(/default:\s*claude/, `default: ${chosenEngine}`);
    if (chosenName !== "Cuttlefish") {
      source = source.replace("portal: {}", `portal:\n  portalName: "${chosenName}"`);
    }
    ensureFile(CONFIG_PATH, source, 0o600); // holds plaintext connector secrets
    created.push(CONFIG_PATH);
  }

  // Read portal name from config for template replacements
  const portalName = (() => {
    try {
      const cfg = yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as any;
      return cfg?.portal?.portalName || "Cuttlefish";
    } catch { return "Cuttlefish"; }
  })();
  const portalSlug = portalName.toLowerCase().replace(/\s+/g, "-");

  const templateReplacements: Record<string, string> = {
    "{{portalName}}": portalName,
    "{{portalSlug}}": portalSlug,
  };

  const claudeMdPath = path.join(CUTTLEFISH_HOME, "CLAUDE.md");
  if (!fs.existsSync(claudeMdPath)) {
    let source = fs.existsSync(templateClaude)
      ? fs.readFileSync(templateClaude, "utf-8")
      : defaultClaudeMd(portalName);
    source = applyTemplateReplacements(source, templateReplacements);
    ensureFile(claudeMdPath, source);
    created.push(claudeMdPath);
  }

  // AGENTS.md is a symlink to CLAUDE.md: one canonical operating manual, zero
  // drift. claude reads CLAUDE.md, codex/agy read AGENTS.md → same content.
  // Fall back to a real copy where symlinks aren't available (e.g. Windows
  // without privilege). lstatSync (not existsSync) so a pre-existing symlink
  // is treated as present and not clobbered.
  const agentsMdPath = path.join(CUTTLEFISH_HOME, "AGENTS.md");
  let agentsExists = false;
  try { fs.lstatSync(agentsMdPath); agentsExists = true; } catch { /* missing */ }
  if (!agentsExists) {
    try {
      fs.symlinkSync("CLAUDE.md", agentsMdPath); // relative target → portable within ~/.cuttlefish
    } catch {
      // Symlinks unavailable: copy the CANONICAL manual (CLAUDE.md) so the
      // fallback always matches what claude reads.
      const source = fs.existsSync(claudeMdPath)
        ? fs.readFileSync(claudeMdPath, "utf-8")
        : defaultAgentsMd(portalName);
      ensureFile(agentsMdPath, source);
    }
    created.push(agentsMdPath);
  }

  // 6. Initialize SQLite database
  try {
    initDb();
    ok("Sessions database initialized");
  } catch (err) {
    warn(`Failed to initialize sessions database: ${err}`);
  }

  // 7. Create cron/jobs.json (seed the disabled HR performance-review jobs from
  //    the template when present; they ship disabled so nothing fires by default).
  const cronTemplate = path.join(TEMPLATE_DIR, "cron", "jobs.json");
  const cronSeed = fs.existsSync(cronTemplate) ? fs.readFileSync(cronTemplate, "utf-8") : "[]";
  if (ensureFile(CRON_JOBS, cronSeed)) created.push(CRON_JOBS);

  // 8. Create cron/runs/
  if (ensureDir(CRON_RUNS)) created.push(CRON_RUNS);

  // 9. Create connectors/
  const connectorsDir = path.join(CUTTLEFISH_HOME, "connectors");
  if (ensureDir(connectorsDir)) created.push(connectorsDir);

  // 10. Create knowledge/
  const knowledgeDir = path.join(CUTTLEFISH_HOME, "knowledge");
  if (ensureDir(knowledgeDir)) created.push(knowledgeDir);

  // 11. Create tmp/
  if (ensureDir(TMP_DIR)) created.push(TMP_DIR);

  // Other standard dirs
  if (ensureDir(LOGS_DIR)) created.push(LOGS_DIR);

  // Copy template contents for docs, skills, and org (skips existing files)
  created.push(...copyTemplateDir(path.join(TEMPLATE_DIR, "docs"), DOCS_DIR, templateReplacements));
  created.push(...copyTemplateDir(path.join(TEMPLATE_DIR, "skills"), SKILLS_DIR, templateReplacements));
  created.push(...copyTemplateDir(path.join(TEMPLATE_DIR, "org"), ORG_DIR, templateReplacements));
  // Seed talk/ (AURA voice persona + card-reference sidecar). The persona points
  // the orchestrator at talk/card-reference.md, so both must land in ~/.cuttlefish/talk/.
  created.push(...copyTemplateDir(path.join(TEMPLATE_DIR, "talk"), path.join(CUTTLEFISH_HOME, "talk"), templateReplacements));
  // Seed orchestration/ (default matrix worker pool, roles, coordinator templates,
  // quotas). Loaded by loadDefaultOrchestrationConfig() when an operator sets
  // `orchestration.enabled: true`; without it, enabling orchestration errors with
  // "missing orchestration config file". copyTemplateDir skips existing files, so
  // re-running setup backfills this when older homes are upgraded.
  created.push(...copyTemplateDir(path.join(TEMPLATE_DIR, "orchestration"), ORCH_CONFIG_DIR, templateReplacements));

  // Copy skills.json manifest
  const templateSkillsJson = path.join(TEMPLATE_DIR, "skills.json");
  const destSkillsJson = path.join(CUTTLEFISH_HOME, "skills.json");
  if (fs.existsSync(templateSkillsJson) && !fs.existsSync(destSkillsJson)) {
    fs.copyFileSync(templateSkillsJson, destSkillsJson);
    created.push(destSkillsJson);
  }

  // Ensure dirs exist even if template had nothing to copy
  ensureDir(DOCS_DIR);
  ensureDir(SKILLS_DIR);
  ensureDir(ORG_DIR);

  // Create .claude/skills/ and .agents/skills/ with symlinks to skills/
  ensureDir(CLAUDE_SKILLS_DIR);
  ensureDir(AGENTS_SKILLS_DIR);

  if (fs.existsSync(SKILLS_DIR)) {
    const skillDirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const name of skillDirs) {
      const relTarget = path.join("..", "..", "skills", name);
      for (const targetDir of [CLAUDE_SKILLS_DIR, AGENTS_SKILLS_DIR]) {
        const linkPath = path.join(targetDir, name);
        if (!fs.existsSync(linkPath)) {
          try {
            fs.symlinkSync(relTarget, linkPath);
          } catch {
            // ignore — may fail on some platforms
          }
        }
      }
    }
  }

  // Create .claude/settings.local.json for engine permissions
  const settingsPath = path.join(CUTTLEFISH_HOME, ".claude", "settings.local.json");
  if (ensureFile(settingsPath, JSON.stringify({
    permissions: {
      allow: [
        "Bash(npm:*)", "Bash(pnpm:*)", "Bash(node:*)", "Bash(cuttlefish:*)",
        "Bash(curl:*)", "Bash(cat:*)", "Bash(ls:*)", "Bash(mkdir:*)",
        "Bash(cp:*)", "Bash(mv:*)", "Bash(rm:*)", "Bash(git:*)",
        "Read", "Write", "Edit", "Glob", "Grep",
      ],
    },
  }, null, 2) + "\n")) {
    created.push(settingsPath);
  }

  // Pre-cache skills CLI for instant searches later; best-effort and bounded.
  await preCacheSkillsCli();

  // Detect project context and suggest relevant skills
  detectProjectContext(portalSlug);

  // 12. Print summary
  console.log("");
  if (created.length === 0) {
    ok("Everything already set up -- nothing to do");
  } else {
    ok(`Created ${created.length} item(s):`);
    for (const item of created) {
      info(item);
    }
  }

  console.log(`\n${GREEN}Setup complete.${RESET} Run ${DIM}cuttlefish start${RESET} to launch the gateway.\n`);
}
