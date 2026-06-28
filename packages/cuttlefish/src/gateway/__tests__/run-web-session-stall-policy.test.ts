import { describe, it, expect } from "vitest";
import { resolveTurnStallWatchdogConfig, shouldNotifyLeaderReviewOnStall, shouldRetrySameEngineAfterStall } from "../run-web-session.js";

describe("resolveTurnStallWatchdogConfig", () => {
  it("uses the tuned defaults when the gateway block omits stall settings", () => {
    const policy = resolveTurnStallWatchdogConfig({
      gateway: { port: 8888, host: "127.0.0.1" },
      engines: {
        default: "claude",
        claude: { bin: "claude", model: "opus" },
        codex: { bin: "codex", model: "gpt-5.5" },
      },
      connectors: {},
      logging: { file: true, stdout: true, level: "info" },
    });

    expect(policy).toMatchObject({
      tickMs: 30_000,
      leaderCheckMs: 240_000,
      inactivityMs: 900_000,
      hardCeilingMs: 2_700_000,
      maxRetries: 0,
    });
  });

  it("accepts explicit gateway stall overrides", () => {
    const policy = resolveTurnStallWatchdogConfig({
      gateway: {
        port: 8888,
        host: "127.0.0.1",
        turnStallLeaderCheckMs: 240_000,
        turnStallInactivityMs: 120_000,
        turnStallCeilingMs: 900_000,
        turnStallRetries: 2,
      },
      engines: {
        default: "claude",
        claude: { bin: "claude", model: "opus" },
        codex: { bin: "codex", model: "gpt-5.5" },
      },
      connectors: {},
      logging: { file: true, stdout: true, level: "info" },
    });

    expect(policy).toMatchObject({
      leaderCheckMs: 240_000,
      inactivityMs: 120_000,
      hardCeilingMs: 900_000,
      maxRetries: 2,
    });
  });
});

describe("shouldRetrySameEngineAfterStall", () => {
  it("allows one same-engine retry when maxRetries is 1", () => {
    expect(shouldRetrySameEngineAfterStall(0, 1)).toBe(true);
    expect(shouldRetrySameEngineAfterStall(1, 1)).toBe(false);
  });

  it("supports immediate fallback when maxRetries is 0", () => {
    expect(shouldRetrySameEngineAfterStall(0, 0)).toBe(false);
  });
});

describe("shouldNotifyLeaderReviewOnStall", () => {
  it("fires once after the leader-check threshold and before the hard inactivity kill", () => {
    expect(shouldNotifyLeaderReviewOnStall({
      idleMs: 239_000,
      leaderCheckMs: 240_000,
      inactivityMs: 900_000,
      alreadyNotified: false,
    })).toBe(false);

    expect(shouldNotifyLeaderReviewOnStall({
      idleMs: 240_000,
      leaderCheckMs: 240_000,
      inactivityMs: 900_000,
      alreadyNotified: false,
    })).toBe(true);

    expect(shouldNotifyLeaderReviewOnStall({
      idleMs: 500_000,
      leaderCheckMs: 240_000,
      inactivityMs: 900_000,
      alreadyNotified: true,
    })).toBe(false);

    expect(shouldNotifyLeaderReviewOnStall({
      idleMs: 900_000,
      leaderCheckMs: 240_000,
      inactivityMs: 900_000,
      alreadyNotified: false,
    })).toBe(false);
  });
});
