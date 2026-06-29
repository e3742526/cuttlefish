import { describe, it, expect, afterEach, vi } from "vitest";
import { handleHookPost, isLoopback, type HookEndpointCtx } from "../hook-endpoint.js";
import { HookRegistry } from "../hook-registry.js";

describe("isLoopback", () => {
  it("accepts loopback addresses in their common forms", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("::FFFF:127.0.0.1")).toBe(true); // case-insensitive
    expect(isLoopback("127.0.0.2")).toBe(true); // anywhere in 127.0.0.0/8
    expect(isLoopback("127.255.255.254")).toBe(true);
  });

  it("rejects non-loopback and malformed addresses", () => {
    expect(isLoopback(undefined)).toBe(false);
    expect(isLoopback("")).toBe(false);
    expect(isLoopback("10.0.0.5")).toBe(false);
    expect(isLoopback("::ffff:10.0.0.5")).toBe(false);
    expect(isLoopback("128.0.0.1")).toBe(false);
    expect(isLoopback("127.0.0.999")).toBe(false);
    expect(isLoopback("fe80::1")).toBe(false);
  });
});

describe("handleHookPost", () => {
  // Track every registry created in this suite so the sweep timer is always
  // disposed — otherwise vitest holds the event loop open between runs.
  const registries: HookRegistry[] = [];
  const makeReg = (): HookRegistry => {
    const r = new HookRegistry();
    registries.push(r);
    return r;
  };
  afterEach(() => {
    while (registries.length > 0) registries.pop()!.dispose();
  });
  const body = (overrides: Record<string, unknown> = {}) => ({
    cuttlefishSessionId: "s1",
    hook: { hook_event_name: "Stop" },
    nonce: `nonce-${Math.random().toString(36).slice(2)}`,
    timestamp: 1_000,
    ...overrides,
  });
  const ctx = (reg: HookRegistry, overrides: Partial<HookEndpointCtx> = {}): HookEndpointCtx => ({
    reg,
    secret: "sek",
    remoteAddress: "127.0.0.1",
    now: () => 1_000,
    ...overrides,
  });

  it("rejects a wrong secret with 403", () => {
    const reg = makeReg();
    const res = handleHookPost(ctx(reg), "nope", body());
    expect(res.status).toBe(403);
  });

  it("rejects a non-loopback remote with 403", () => {
    const reg = makeReg();
    const res = handleHookPost(ctx(reg, { remoteAddress: "10.0.0.5" }), "sek", body());
    expect(res.status).toBe(403);
  });

  it("accepts an IPv4-mapped loopback remote", () => {
    const reg = makeReg();
    const res = handleHookPost(ctx(reg, { remoteAddress: "::ffff:127.0.0.1" }), "sek", body());
    expect(res.status).toBe(200);
  });

  it("delivers a valid hook to the registry and returns 200", () => {
    const reg = makeReg();
    const seen: string[] = [];
    reg.register("s1", (h) => seen.push(h.hook_event_name));
    const res = handleHookPost(ctx(reg), "sek", body({ hook: { hook_event_name: "Stop", last_assistant_message: "hi" } }));
    expect(res.status).toBe(200);
    expect(seen).toEqual(["Stop"]);
  });

  it("returns 400 for a malformed body", () => {
    const reg = makeReg();
    const res = handleHookPost(ctx(reg), "sek", {});
    expect(res.status).toBe(400);
  });

  it("blocks dangerous Bash PreToolUse commands before delivery", () => {
    const reg = makeReg();
    const seen: string[] = [];
    reg.register("s1", (h) => seen.push(h.hook_event_name));
    const res = handleHookPost({ reg, secret: "sek", remoteAddress: "127.0.0.1" },
      "sek", { cuttlefishSessionId: "s1", hook: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf /" } } });
    expect(res.status).toBe(451);
    expect(seen).toEqual([]);
  });

  it("opens a security review instead of delivering a review-gated Bash command", () => {
    const reg = makeReg();
    const onSecurityReview = vi.fn();
    const res = handleHookPost(
      { reg, secret: "sek", remoteAddress: "127.0.0.1", onSecurityReview },
      "sek",
      {
        cuttlefishSessionId: "s1",
        hook: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "sudo systemctl restart nginx" } },
      },
    );
    expect(res.status).toBe(451);
    expect(onSecurityReview).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s1",
        command: "sudo systemctl restart nginx",
      }),
    );
  });

  it("lets a review-gated Bash command proceed when policy handling returns allow", () => {
    const reg = makeReg();
    const seen: string[] = [];
    reg.register("s1", (h) => seen.push(h.hook_event_name));
    const res = handleHookPost(
      {
        reg,
        secret: "sek",
        remoteAddress: "127.0.0.1",
        onSecurityReview: () => ({ action: "allow", reason: "notify policy allows this command" }),
      },
      "sek",
      {
        cuttlefishSessionId: "s1",
        hook: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "sudo systemctl restart nginx" } },
      },
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual(["PreToolUse"]);
  });

  it("returns 401 when the server secret is empty (defense-in-depth)", () => {
    const reg = makeReg();
    const res = handleHookPost(ctx(reg, { secret: "" }), "", body());
    expect(res.status).toBe(401);
  });

  it("rejects hook replays by session nonce", () => {
    const reg = makeReg();
    const replay = body({ nonce: "nonce-replay-12345" });
    expect(handleHookPost(ctx(reg), "sek", replay).status).toBe(200);
    expect(handleHookPost(ctx(reg), "sek", replay).status).toBe(409);
  });

  it("rejects stale hook timestamps", () => {
    const reg = makeReg();
    const res = handleHookPost(ctx(reg, { now: () => 10 * 60 * 1000 }), "sek", body({ timestamp: 1_000 }));
    expect(res.status).toBe(400);
  });
});
