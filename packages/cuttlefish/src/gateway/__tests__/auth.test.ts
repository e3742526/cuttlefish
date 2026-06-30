import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import {
  AUTH_COOKIE,
  createPtyAccessToken,
  isAuthenticatedRequest,
  verifyPtyAccessToken,
} from "../auth.js";

function req(headers: Record<string, string | undefined> = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("gateway auth", () => {
  it("accepts bearer, x-cuttlefish-token, and auth cookie tokens", () => {
    expect(isAuthenticatedRequest(req({ authorization: "Bearer secret" }), "secret")).toBe(true);
    expect(isAuthenticatedRequest(req({ "x-cuttlefish-token": "secret" }), "secret")).toBe(true);
    expect(isAuthenticatedRequest(req({ cookie: `${AUTH_COOKIE}=secret` }), "secret")).toBe(true);
    expect(isAuthenticatedRequest(req({ authorization: "Bearer wrong" }), "secret")).toBe(false);
  });

  it("PTY access tokens are bound to the session id and expire", () => {
    const token = createPtyAccessToken("s1", "secret", 1_000);
    expect(verifyPtyAccessToken("s1", token, "secret", 2_000)).toBe(true);
    expect(verifyPtyAccessToken("s2", token, "secret", 2_000)).toBe(false);
    expect(verifyPtyAccessToken("s1", token, "wrong", 2_000)).toBe(false);
    expect(verifyPtyAccessToken("s1", token, "secret", 70_000)).toBe(false);
  });
});
