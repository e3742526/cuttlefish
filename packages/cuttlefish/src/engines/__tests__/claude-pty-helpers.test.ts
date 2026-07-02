import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildClaudePtyEnv } from "../claude-pty-helpers.js";

describe("buildClaudePtyEnv", () => {
  let prevSandbox: string | undefined;
  let originalGetuid: typeof process.getuid;

  beforeEach(() => {
    // Control IS_SANDBOX explicitly — the ambient test env may already set it.
    prevSandbox = process.env.IS_SANDBOX;
    delete process.env.IS_SANDBOX;
    // process.getuid is undefined on Windows; vi.spyOn would throw. Provide a
    // stub so the spies below have something to replace, and restore it after.
    originalGetuid = process.getuid;
    if (typeof process.getuid !== "function") {
      (process as { getuid?: () => number }).getuid = () => 1000;
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (prevSandbox === undefined) delete process.env.IS_SANDBOX;
    else process.env.IS_SANDBOX = prevSandbox;
    if (originalGetuid === undefined) delete (process as { getuid?: unknown }).getuid;
    else process.getuid = originalGetuid;
  });

  it("sets IS_SANDBOX=1 when running as root so --dangerously-skip-permissions is accepted", () => {
    vi.spyOn(process, "getuid").mockReturnValue(0);
    const env = buildClaudePtyEnv();
    expect(env.IS_SANDBOX).toBe("1");
  });

  it("does not force IS_SANDBOX when running as a non-root user", () => {
    vi.spyOn(process, "getuid").mockReturnValue(1000);
    const env = buildClaudePtyEnv();
    expect(env.IS_SANDBOX).toBeUndefined();
  });

  it("respects an explicit IS_SANDBOX from the environment even as root", () => {
    vi.spyOn(process, "getuid").mockReturnValue(0);
    process.env.IS_SANDBOX = "0";
    const env = buildClaudePtyEnv();
    expect(env.IS_SANDBOX).toBe("0");
  });

  it("strips subscription-billing-breaking env and points at the proxy", () => {
    vi.spyOn(process, "getuid").mockReturnValue(1000);
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-should-be-stripped";
    try {
      const env = buildClaudePtyEnv(4321);
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:4321");
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });
});
