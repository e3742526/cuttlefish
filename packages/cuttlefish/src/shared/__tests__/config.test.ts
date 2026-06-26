import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import {
  normalizeBoardWorkerConfig,
  normalizeClaudeEngineConfig,
  loadConfig,
  saveConfigAtomic,
  validateConfigShape,
} from "../config.js";
import { refreshCuttlefishPaths, setCuttlefishHomeForTest } from "../paths.js";

describe("normalizeClaudeEngineConfig", () => {
  it("applies the maxLivePtys default", () => {
    const out = normalizeClaudeEngineConfig({ bin: "claude", model: "opus" });
    expect(out.maxLivePtys).toBe(8);
  });

  it("preserves a configured maxLivePtys", () => {
    const out = normalizeClaudeEngineConfig({ bin: "claude", model: "opus", maxLivePtys: 16 });
    expect(out.maxLivePtys).toBe(16);
  });
});

describe("normalizeBoardWorkerConfig", () => {
  it("fills defaults and clamps idleMinutes to [0, 60]", () => {
    const out = normalizeBoardWorkerConfig({ idleMinutes: 999 });
    expect(out.enabled).toBe(false);
    expect(out.idleMinutes).toBe(60);
    expect(out.schedule.weekday).toEqual({ start: "22:00", end: "04:00" });
    expect(out.schedule.weekend).toEqual({ start: "22:00", end: "04:00" });
    expect(out.usage.minRemainingPercent).toBe(15);
  });

  it("preserves valid configured values", () => {
    const out = normalizeBoardWorkerConfig({
      enabled: true,
      idleMinutes: 12,
      timezone: "UTC",
      schedule: {
        weekday: { start: "21:00", end: "03:00" },
        weekend: { start: "20:00", end: "02:00" },
      },
      usage: { minRemainingPercent: 25 },
    });
    expect(out).toMatchObject({
      enabled: true,
      idleMinutes: 12,
      timezone: "UTC",
      schedule: {
        weekday: { start: "21:00", end: "03:00" },
        weekend: { start: "20:00", end: "02:00" },
      },
      usage: { minRemainingPercent: 25 },
    });
  });
});

describe("validateConfigShape", () => {
  it("accepts a minimal valid config", () => {
    expect(validateConfigShape({
      gateway: { port: 8888, host: "127.0.0.1" },
      engines: { claude: { bin: "claude", model: "opus" } },
      logging: { file: true, stdout: true, level: "info" },
    })).toEqual([]);
  });

  it("accepts a full default-shaped config", () => {
    expect(validateConfigShape({
      cuttlefish: { version: "1.0.0" },
      workspaces: {
        roots: ["/tmp/project"],
        defaultCwd: "/tmp/project",
      },
      gateway: {
        port: 8888,
        host: "127.0.0.1",
        streaming: true,
        turnStallInactivityMs: 180000,
        turnStallCeilingMs: 2700000,
        turnStallRetries: 1,
        fileReadRoots: ["/tmp"],
        allowArbitraryFileRead: false,
        exposeResolvedFilePaths: false,
        userHeader: ["x-auth-request-user", "x-forwarded-user"],
      },
      engines: { default: "claude", claude: { bin: "claude", model: "opus" }, codex: { bin: "codex", model: "gpt-5.5" } },
      connectors: {},
      logging: { file: true, stdout: true, level: "info" },
      modelFallback: {
        enabled: true,
        defaultMode: "auto",
        globalChain: [{ engine: "codex", model: "gpt-5.5", effortLevel: "high" }],
      },
      sessions: {
        autoResumeOnBoot: false,
      },
      mcp: {
        browser: { enabled: true, provider: "playwright" },
        fetch: { enabled: true },
        gateway: { enabled: true },
      },
      knowledge: {
        sink: {
          type: "webhook",
          webhook: { url: "http://127.0.0.1:9999/events", batchSize: 10 },
        },
        readProvider: {
          type: "webhook",
          webhook: { url: "http://127.0.0.1:9999/search", timeoutMs: 1234 },
        },
      },
    })).toEqual([]);
  });

  it("accepts a config without a gateway block (loadConfig fills runtime defaults)", () => {
    expect(validateConfigShape({ engines: { claude: {} } })).toEqual([]);
  });

  it("rejects null / empty files", () => {
    expect(validateConfigShape(null)).toHaveLength(1);
    expect(validateConfigShape(undefined)).toHaveLength(1);
  });

  it("rejects a config that parsed to a scalar or array", () => {
    expect(validateConfigShape("oops")[0]).toContain("expected a YAML mapping");
    expect(validateConfigShape([1, 2])[0]).toContain("expected a YAML mapping");
  });

  it("rejects a non-numeric gateway.port", () => {
    const problems = validateConfigShape({
      gateway: { port: "8888", host: "127.0.0.1" },
      engines: { claude: {} },
      logging: { file: true, stdout: true, level: "info" },
    });
    expect(problems.some((p) => p.includes("gateway.port"))).toBe(true);
  });

  it("rejects out-of-range gateway ports", () => {
    for (const port of [0, -1, 65536, 1.5, Number.NaN]) {
      const problems = validateConfigShape({
        gateway: { port, host: "127.0.0.1" },
        engines: { claude: {} },
        logging: { file: true, stdout: true, level: "info" },
      });

      expect(problems).toContain("gateway.port must be an integer from 1 to 65535");
    }
  });

  it("rejects unknown top-level config keys", () => {
    const problems = validateConfigShape({
      engines: { claude: { bin: "claude", model: "opus" } },
      surprise: true,
    });
    expect(problems.some((p) => p.includes("unknown config keys: surprise"))).toBe(true);
  });

  it("validates provider-neutral knowledge config", () => {
    expect(validateConfigShape({
      engines: { claude: { bin: "claude", model: "opus" } },
      knowledge: {
        sink: { type: "jsonl", jsonl: { path: "/tmp/outbox.jsonl" } },
        readProvider: { type: "none" },
      },
    })).toEqual([]);

    const problems = validateConfigShape({
      engines: { claude: { bin: "claude", model: "opus" } },
      knowledge: {
        sink: { type: "webhook" },
        readProvider: { type: "webhook" },
      },
    });
    expect(problems).toContain("knowledge.sink.webhook.url is required when knowledge.sink.type=webhook");
    expect(problems).toContain("knowledge.readProvider.webhook.url is required when knowledge.readProvider.type=webhook");
  });

  it("rejects unknown gateway keys and invalid gateway arrays", () => {
    let problems = validateConfigShape({ gateway: { surprise: true }, engines: { claude: {} } });
    expect(problems.some((p) => p.includes("unknown gateway config keys: surprise"))).toBe(true);

    problems = validateConfigShape({ gateway: { userHeader: [123] }, engines: { claude: {} } });
    expect(problems.some((p) => p.includes("gateway.userHeader"))).toBe(true);

    problems = validateConfigShape({ gateway: { turnStallRetries: "1" }, engines: { claude: {} } });
    expect(problems.some((p) => p.includes("gateway.turnStallRetries"))).toBe(true);
  });

  it("rejects unknown nested keys in broader config sections", () => {
    let problems = validateConfigShape({
      engines: { claude: { bin: "claude", model: "opus" } },
      workspaces: { roots: ["/tmp"], extra: true },
    });
    expect(problems.some((p) => p.includes("unknown workspaces config keys: extra"))).toBe(true);

    problems = validateConfigShape({
      engines: { claude: { bin: "claude", model: "opus" } },
      modelFallback: { enabled: true, bogus: true },
    });
    expect(problems.some((p) => p.includes("unknown modelFallback config keys: bogus"))).toBe(true);

    problems = validateConfigShape({
      engines: { claude: { bin: "claude", model: "opus" } },
      connectors: { slack: { botToken: "x", extra: true } },
    });
    expect(problems.some((p) => p.includes("unknown connectors.slack config keys: extra"))).toBe(true);
  });

  it("rejects missing engines / engines.claude", () => {
    expect(validateConfigShape({})[0]).toContain("engines");
    const problems = validateConfigShape({ engines: { default: "codex" } });
    expect(problems.some((p) => p.includes("engines.claude"))).toBe(true);
  });

  it("validates optional Kiro credit config types", () => {
    expect(validateConfigShape({
      engines: {
        claude: { bin: "claude", model: "opus" },
        kiro: { creditBudget: 25, billingAnchorDay: 5 },
      },
    })).toEqual([]);

    const problems = validateConfigShape({
      engines: {
        claude: { bin: "claude", model: "opus" },
        kiro: { creditBudget: "25", billingAnchorDay: "5" },
      },
    });
    expect(problems.some((p) => p.includes("engines.kiro.creditBudget"))).toBe(true);
    expect(problems.some((p) => p.includes("engines.kiro.billingAnchorDay"))).toBe(true);
  });

  it("accepts Hermes engine and model configuration generated by setup", () => {
    expect(validateConfigShape({
      engines: {
        default: "hermes",
        claude: { bin: "claude", model: "opus" },
        hermes: { bin: "hermes", model: "auto" },
      },
      models: {
        hermes: {
          default: "auto",
          models: [{ id: "auto", label: "Hermes" }],
        },
      },
      sessions: { fallbackEngine: "hermes" },
    })).toEqual([]);
  });

  it("accepts Ollama engine and model configuration generated by setup", () => {
    expect(validateConfigShape({
      engines: {
        default: "ollama",
        claude: { bin: "claude", model: "opus" },
        ollama: { bin: "ollama", model: "gemma4" },
      },
      models: {
        ollama: {
          default: "gemma4",
          models: [{ id: "gemma4", label: "Gemma 4" }],
        },
      },
      sessions: { fallbackEngine: "ollama" },
    })).toEqual([]);
  });

  it("accepts Kilo engine and model configuration generated by setup", () => {
    expect(validateConfigShape({
      engines: {
        default: "kilo",
        claude: { bin: "claude", model: "opus" },
        kilo: { bin: "kilo", model: "kilo-auto/free" },
      },
      models: {
        kilo: {
          default: "kilo-auto/free",
          models: [{ id: "kilo-auto/free", label: "Kilo Auto Free" }],
        },
      },
      sessions: { fallbackEngine: "kilo" },
    })).toEqual([]);
  });

  it("validates sessions.autoResumeOnBoot as an optional boolean", () => {
    expect(validateConfigShape({
      engines: { claude: { bin: "claude", model: "opus" } },
      sessions: { autoResumeOnBoot: true },
    })).toEqual([]);

    const problems = validateConfigShape({
      engines: { claude: { bin: "claude", model: "opus" } },
      sessions: { autoResumeOnBoot: "true" },
    });
    expect(problems.some((p) => p.includes("sessions.autoResumeOnBoot"))).toBe(true);
  });

  it("validates orchestration same-family reviewer fallback as an optional boolean", () => {
    expect(validateConfigShape({
      engines: { claude: { bin: "claude", model: "opus" } },
      orchestration: {
        enabled: true,
        sameFamilyReviewerFallback: true,
        empiricalRouting: false,
      },
    })).toEqual([]);

    const problems = validateConfigShape({
      engines: { claude: { bin: "claude", model: "opus" } },
      orchestration: { sameFamilyReviewerFallback: "true", empiricalRouting: "yes" },
    });
    expect(problems.some((p) => p.includes("orchestration.sameFamilyReviewerFallback"))).toBe(true);
    expect(problems.some((p) => p.includes("orchestration.empiricalRouting"))).toBe(true);
  });

  it("validates boardWorker schedule and timezone fields", () => {
    const ok = validateConfigShape({
      engines: { claude: { bin: "claude", model: "opus" } },
      boardWorker: {
        enabled: true,
        idleMinutes: 30,
        timezone: "UTC",
        schedule: {
          weekday: { start: "22:00", end: "04:00" },
          weekend: { start: "20:00", end: "02:00" },
        },
        usage: { minRemainingPercent: 15 },
      },
    });
    expect(ok).toEqual([]);

    const problems = validateConfigShape({
      engines: { claude: { bin: "claude", model: "opus" } },
      boardWorker: {
        timezone: "Not/A_Zone",
        schedule: { weekday: { start: "25:00", end: "nope" } },
      },
    });
    expect(problems.some((p) => p.includes("boardWorker.timezone"))).toBe(true);
    expect(problems.some((p) => p.includes("boardWorker.schedule.weekday.start"))).toBe(true);
    expect(problems.some((p) => p.includes("boardWorker.schedule.weekday.end"))).toBe(true);
  });
});

describe("saveConfigAtomic", () => {
  let tmpHome: string;
  const prevHome = process.env.CUTTLEFISH_HOME;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-config-save-"));
    process.env.CUTTLEFISH_HOME = tmpHome;
    setCuttlefishHomeForTest(tmpHome);
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.CUTTLEFISH_HOME;
    else process.env.CUTTLEFISH_HOME = prevHome;
    refreshCuttlefishPaths();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("writes valid YAML to config.yaml and leaves no tmp file behind", () => {
    const configPath = path.join(tmpHome, "config.yaml");
    const cfg = { gateway: { port: 8888 }, talk: { engine: "claude", note: "x".repeat(200) } };

    saveConfigAtomic(cfg, { lineWidth: -1 });

    expect(yaml.load(fs.readFileSync(configPath, "utf-8"))).toEqual(cfg);
    // lineWidth: -1 → the long string must not be folded across lines
    expect(fs.readFileSync(configPath, "utf-8")).toContain("x".repeat(200));
    expect(fs.readdirSync(tmpHome).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("replaces an existing config.yaml", () => {
    const configPath = path.join(tmpHome, "config.yaml");
    fs.writeFileSync(configPath, "old: true\n");

    saveConfigAtomic({ fresh: 1 });

    expect(yaml.load(fs.readFileSync(configPath, "utf-8"))).toEqual({ fresh: 1 });
  });

  it("fills runtime defaults for minimal config files", () => {
    const configPath = path.join(tmpHome, "config.yaml");
    fs.writeFileSync(configPath, "engines:\n  claude: {}\n");

    const config = loadConfig();

    expect(config.gateway).toEqual({ port: 8888, host: "127.0.0.1" });
    expect(config.engines.default).toBe("claude");
    expect(config.connectors).toEqual({});
    expect(config.logging).toEqual({ file: true, stdout: true, level: "info" });
    expect(config.knowledge).toMatchObject({
      sink: {
        type: "noop",
        jsonl: { path: expect.stringContaining("knowledge/outbox.jsonl") },
        webhook: {
          batchSize: 25,
          timeoutMs: 10000,
          retry: { baseDelayMs: 1000, maxDelayMs: 60000 },
        },
      },
      readProvider: {
        type: "none",
        webhook: { timeoutMs: 10000 },
      },
    });
  });

  // config.yaml holds plaintext connector secrets (Slack/Discord/Telegram
  // tokens) — it must be owner-only (0o600), never group/world-readable.
  it("writes config.yaml with owner-only (0o600) permissions", () => {
    const configPath = path.join(tmpHome, "config.yaml");
    saveConfigAtomic({ connectors: { slack: { botToken: "xoxb-secret" } } });
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it("repairs an over-permissive existing config.yaml on load", () => {
    const configPath = path.join(tmpHome, "config.yaml");
    fs.writeFileSync(configPath, "engines:\n  claude: {}\n");
    fs.chmodSync(configPath, 0o644); // simulate a pre-hardening world-readable install

    loadConfig();

    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });
});
