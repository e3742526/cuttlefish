import { afterEach, describe, expect, it } from "vitest";
import { buildAiderEngineEnv } from "../aider-env.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("buildAiderEngineEnv", () => {
  it("passes only Aider's exact provider credentials, never Twilio or gateway secrets", () => {
    process.env.ANTHROPIC_API_KEY = "provider-key";
    process.env.OPENAI_API_KEY = "openai-key";
    process.env.TWILIO_SID = "twilio-sid";
    process.env.TWILIO_CLIENT_SECRET = "twilio-secret";
    process.env.GITHUB_TOKEN = "github-secret";
    process.env.CUTTLEFISH_GATEWAY_TOKEN = "gateway-secret";

    const env = buildAiderEngineEnv();

    expect(env.ANTHROPIC_API_KEY).toBe("provider-key");
    expect(env.OPENAI_API_KEY).toBe("openai-key");
    expect(env.TWILIO_SID).toBeUndefined();
    expect(env.TWILIO_CLIENT_SECRET).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.CUTTLEFISH_GATEWAY_TOKEN).toBeUndefined();
  });
});
