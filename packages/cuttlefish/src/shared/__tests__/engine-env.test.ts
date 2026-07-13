import { afterEach, describe, expect, it } from "vitest";
import { buildEngineEnv, ENGINE_ENV_SECRET_DENYLIST, runWithEngineEnvironment } from "../engine-env.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("buildEngineEnv", () => {
  it("strips known host secret variables by default", () => {
    for (const key of ENGINE_ENV_SECRET_DENYLIST) {
      process.env[key] = `secret-${key}`;
    }

    const env = buildEngineEnv({});

    for (const key of ENGINE_ENV_SECRET_DENYLIST) {
      expect(env).not.toHaveProperty(key);
    }
  });

  it("preserves ordinary environment variables", () => {
    process.env.CUTTLEFISH_TEST_PUBLIC_FLAG = "kept";

    expect(buildEngineEnv({}).CUTTLEFISH_TEST_PUBLIC_FLAG).toBe("kept");
  });

  it("does not pass Twilio credentials into agent processes", () => {
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_AUTH_TOKEN = "twilio-secret";

    const env = buildEngineEnv({});

    expect(env.TWILIO_ACCOUNT_SID).toBeUndefined();
    expect(env.TWILIO_AUTH_TOKEN).toBeUndefined();
  });

  it("allows only an exact provider key without reopening prefix-denied integration secrets", () => {
    process.env.ANTHROPIC_API_KEY = "provider-key";
    process.env.TWILIO_SID = "twilio-sid";

    const env = buildEngineEnv({}, { allowSecretKeys: ["ANTHROPIC_API_KEY"] });

    expect(env.ANTHROPIC_API_KEY).toBe("provider-key");
    expect(env.TWILIO_SID).toBeUndefined();
  });

  it("strips caller-provided prefixes", () => {
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_SESSION = "abc";
    process.env.CODEX_HOME = "/tmp/codex";
    process.env.KEEP_ME = "yes";

    const env = buildEngineEnv({}, { stripPrefixes: ["CLAUDECODE", "CLAUDE_CODE_", "CODEX"] });

    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION).toBeUndefined();
    expect(env.CODEX_HOME).toBeUndefined();
    expect(env.KEEP_ME).toBe("yes");
  });

  it("lets explicit additions win over inherited values", () => {
    process.env.TERM = "dumb";
    process.env.ANTHROPIC_API_KEY = "inherited-secret";

    const env = buildEngineEnv({ TERM: "xterm-256color", ANTHROPIC_API_KEY: "explicit" });

    expect(env.TERM).toBe("xterm-256color");
    expect(env.ANTHROPIC_API_KEY).toBe("explicit");
  });

  it("passes a scoped per-turn credential without inheriting host session credentials", async () => {
    process.env.CUTTLEFISH_SESSION_TOKEN = "host-session-token";
    expect(buildEngineEnv({}).CUTTLEFISH_SESSION_TOKEN).toBeUndefined();

    const token = await runWithEngineEnvironment(
      { CUTTLEFISH_SESSION_TOKEN: "turn-session-token" },
      async () => buildEngineEnv({}).CUTTLEFISH_SESSION_TOKEN,
    );

    expect(token).toBe("turn-session-token");
  });
});
