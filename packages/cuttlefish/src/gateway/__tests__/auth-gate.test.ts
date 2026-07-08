import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuthSession, createScopedSessionToken } from "../auth.js";
import { resolvePrincipalGate } from "../server/auth-gate.js";

function req(headers: Record<string, string | undefined>, remoteAddress = "127.0.0.1") {
  return { headers, socket: { remoteAddress } } as any;
}

const TOKEN = "gateway-secret-token-1234567890";

describe("resolvePrincipalGate (CF2-120)", () => {
  it("lets an unauthenticated loopback request through with no principal when auth is not required (default UX unchanged)", () => {
    const gate = resolvePrincipalGate({
      req: req({}),
      method: "GET",
      pathname: "/api/sessions",
      authRequiredNow: () => false,
      gatewayAuthToken: TOKEN,
      cuttlefishHome: "/tmp/does-not-matter",
    });
    expect(gate.status).toBe(200);
    expect(gate.principal).toBeUndefined();
  });

  it("401s when auth is required, the route requires it, and no credential is presented", () => {
    const gate = resolvePrincipalGate({
      req: req({}),
      method: "GET",
      pathname: "/api/sessions",
      authRequiredNow: () => true,
      gatewayAuthToken: TOKEN,
      cuttlefishHome: "/tmp/does-not-matter",
    });
    expect(gate.status).toBe(401);
  });

  it("403s a scoped session token hitting a forbidden control-plane path even when auth is NOT required (loopback default) — this is the CF2-120 regression", () => {
    const scoped = createScopedSessionToken("session-abc", TOKEN);
    const gate = resolvePrincipalGate({
      req: req({ authorization: `Bearer ${scoped}` }),
      method: "GET",
      pathname: "/api/config",
      authRequiredNow: () => false,
      gatewayAuthToken: TOKEN,
      cuttlefishHome: "/tmp/does-not-matter",
    });
    expect(gate.status).toBe(403);
  });

  it("403s a scoped session token confined to a different session's resource, auth not required", () => {
    const scoped = createScopedSessionToken("session-abc", TOKEN);
    const gate = resolvePrincipalGate({
      req: req({ authorization: `Bearer ${scoped}` }),
      method: "GET",
      pathname: "/api/sessions/session-xyz",
      authRequiredNow: () => false,
      gatewayAuthToken: TOKEN,
      cuttlefishHome: "/tmp/does-not-matter",
    });
    expect(gate.status).toBe(403);
  });

  it("attaches the resolved principal even when authRequiredNow() is false (CF2-112: connector-send-policy sees the real caller on loopback)", () => {
    const scoped = createScopedSessionToken("session-abc", TOKEN);
    const gate = resolvePrincipalGate({
      req: req({ authorization: `Bearer ${scoped}` }),
      method: "GET",
      pathname: "/api/connectors/slack/send",
      authRequiredNow: () => false,
      gatewayAuthToken: TOKEN,
      cuttlefishHome: "/tmp/does-not-matter",
    });
    expect(gate.status).toBe(200);
    expect(gate.principal).toEqual({ kind: "session", sessionId: "session-abc" });
  });

  it("allows a legitimately device-cookie-authenticated browser, resolving an admin principal (Ledger-0007 Finding 5 regression)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-auth-gate-device-"));
    const session = createAuthSession(home, req({ "user-agent": "Mozilla/5.0" }, "127.0.0.1"));
    const gate = resolvePrincipalGate({
      req: req({ cookie: `cuttlefish_auth=${session.secret}; cuttlefish_device=${session.device.id}` }, "127.0.0.1"),
      method: "GET",
      pathname: "/ws",
      authRequiredNow: () => true,
      gatewayAuthToken: TOKEN,
      cuttlefishHome: home,
    });
    expect(gate.status).toBe(200);
    expect(gate.principal).toEqual({ kind: "admin" });
  });

  it("still 401s a /ws upgrade with no credential when auth is required", () => {
    const gate = resolvePrincipalGate({
      req: req({}),
      method: "GET",
      pathname: "/ws",
      authRequiredNow: () => true,
      gatewayAuthToken: TOKEN,
      cuttlefishHome: "/tmp/does-not-matter",
    });
    expect(gate.status).toBe(401);
  });
});
