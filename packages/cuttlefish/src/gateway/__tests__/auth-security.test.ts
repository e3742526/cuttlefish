import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  authenticateGatewayRequest,
  authRequiredForRequest,
  clearAuthCookieHeader,
  createAuthSession,
  consumePairingCode,
  createAuthState,
  createPairingCode,
  ensureGatewayAuthToken,
  listAuthSessions,
  isLoopbackHost,
  isNetworkHost,
  matchesGatewayAuthToken,
  issuePairingCode,
  normalizePairingCode,
  revokeAuthSession,
  shouldRequireGatewayAuth,
  validateGatewayExposure,
  verifyAuthSession,
} from "../auth.js";

function req(headers: Record<string, string | undefined>, remoteAddress = "127.0.0.1") {
  return { headers, socket: { remoteAddress } } as any;
}

describe("gateway auth", () => {
  it("creates a persistent token under the supplied CUTTLEFISH_HOME with owner-only permissions", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-auth-"));
    const first = ensureGatewayAuthToken(home);
    const second = ensureGatewayAuthToken(home);
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(32);

    const tokenFile = path.join(home, "gateway.json");
    const mode = fs.statSync(tokenFile).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(tokenFile, "utf-8")).token).toBe(first);
  });

  it("accepts bearer auth and revocable browser sessions without accepting legacy raw-token cookies", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-auth-cookie-"));
    const session = createAuthSession(home, req({ "user-agent": "Mozilla/5.0" }, "100.64.1.2"));
    const scheme = "Bear" + "er";
    expect(authenticateGatewayRequest(req({ authorization: `${scheme} tok` }), "tok").ok).toBe(true);
    expect(authenticateGatewayRequest(req({ cookie: `theme=dark; cuttlefish_auth=${session.secret}; cuttlefish_device=${session.device.id}` }), "tok", home).ok).toBe(true);
    expect(authenticateGatewayRequest(req({ cookie: "theme=dark; cuttlefish_auth=tok" }), "tok", home).ok).toBe(false);
    expect(authenticateGatewayRequest(req({ authorization: `${scheme} wrong`, cookie: "cuttlefish_auth=wrong" }), "tok").ok).toBe(false);
  });

  it("does not require gateway bearer auth for loopback hook relay endpoint", () => {
    expect(authRequiredForRequest("POST", "/api/internal/hook")).toBe(false);
    expect(authRequiredForRequest("GET", "/api/internal/hook")).toBe(true);
    expect(authRequiredForRequest("GET", "/api/readyz")).toBe(false);
  });

  it("requires auth for remote/network exposure but not default loopback unless explicitly enabled", () => {
    expect(isLoopbackHost("localhost:8888")).toBe(true);
    expect(isLoopbackHost("127.0.0.1:8888")).toBe(true);
    expect(isLoopbackHost("[::1]:8888")).toBe(true);
    expect(isLoopbackHost("100.95.1.62:8888")).toBe(false);
    expect(shouldRequireGatewayAuth({ gateway: { host: "127.0.0.1" } } as any)).toBe(false);
    expect(shouldRequireGatewayAuth({ gateway: { host: "0.0.0.0" } } as any)).toBe(true);
    expect(shouldRequireGatewayAuth({ gateway: { host: "192.168.1.10" } } as any)).toBe(true);
    expect(shouldRequireGatewayAuth({ gateway: { host: "127.0.0.1", authRequired: true } } as any)).toBe(true);
  });

  it("refuses unauthenticated network binds unless the explicit insecure escape hatch is set", () => {
    expect(isNetworkHost("0.0.0.0")).toBe(true);
    expect(validateGatewayExposure({ gateway: { host: "0.0.0.0", authDisabled: true } } as any).ok).toBe(false);
    expect(validateGatewayExposure({ gateway: { host: "0.0.0.0", authDisabled: true, insecureAllowUnauthenticatedNetwork: true } } as any).ok).toBe(true);
  });

  it("reports safe auth state for local, remote, and already-paired browsers", () => {
    const config = { gateway: { host: "0.0.0.0" } } as any;
    expect(createAuthState(config, req({}, "127.0.0.1"), "tok")).toMatchObject({
      authRequired: true,
      authenticated: false,
      canBootstrapLocal: true,
      networkExposed: true,
    });
    expect(createAuthState(config, req({ host: "100.95.1.62:8888" }, "127.0.0.1"), "tok")).toMatchObject({
      authRequired: true,
      authenticated: false,
      canBootstrapLocal: false,
      networkExposed: true,
    });
    expect(createAuthState(config, req({}, "100.64.1.2"), "tok")).toMatchObject({
      authRequired: true,
      authenticated: false,
      canBootstrapLocal: false,
      networkExposed: true,
    });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-auth-state-"));
    const session = createAuthSession(home, req({ "user-agent": "Mozilla/5.0" }, "100.64.1.2"));
    expect(createAuthState(config, req({ cookie: `cuttlefish_auth=${session.secret}; cuttlefish_device=${session.device.id}` }, "100.64.1.2"), "tok", home)).toMatchObject({
      authRequired: true,
      authenticated: true,
      canBootstrapLocal: false,
      networkExposed: true,
    });
  });

  it("creates single-use normalized pairing codes without storing the raw code", () => {
    const store = new Map<string, { expiresAt: number }>();
    const issued = issuePairingCode(store, 1_000, () => "ABCD-EFGH-JKLM");

    expect(issued.code).toBe("ABCD-EFGH-JKLM");
    expect(issued.expiresAt).toBe(301_000);
    expect(store.size).toBe(1);
    expect([...store.keys()][0]).not.toContain("ABCD");

    expect(normalizePairingCode("abcd efgh-jklm")).toBe("ABCDEFGHJKLM");
    expect(consumePairingCode(store, "abcd efgh jklm", 2_000)).toBe(true);
    expect(consumePairingCode(store, "ABCD-EFGH-JKLM", 2_001)).toBe(false);
  });

  it("rejects expired pairing codes and keeps gateway token fallback timing-safe", () => {
    const store = new Map<string, { expiresAt: number }>();
    const issued = issuePairingCode(store, 1_000, () => "WXYZ-2345-6789");

    expect(consumePairingCode(store, issued.code, issued.expiresAt + 1)).toBe(false);
    expect(matchesGatewayAuthToken("tok", "tok")).toBe(true);
    expect(matchesGatewayAuthToken("wrong", "tok")).toBe(false);
    expect(clearAuthCookieHeader()).toContain("Max-Age=0");
  });

  it("generates browser-friendly pairing codes", () => {
    const code = createPairingCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(code).not.toMatch(/[01OI]/);
  });

  it("creates revocable browser auth sessions without storing raw secrets", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-auth-devices-"));
    const created = createAuthSession(home, req({ "user-agent": "Mozilla/5.0 Mac OS X" }, "100.64.1.2"), {
      name: "Remote browser",
      now: 1_000,
    });

    expect(created.secret).toHaveLength(43);
    expect(verifyAuthSession(home, created.device.id, created.secret)).toBe(true);

    const file = path.join(home, "auth-devices.json");
    const raw = fs.readFileSync(file, "utf-8");
    expect(raw).not.toContain(created.secret);
    expect(JSON.parse(raw).devices[0]).toMatchObject({
      id: created.device.id,
      name: "Remote browser",
      createdAt: "1970-01-01T00:00:01.000Z",
    });

    const listed = listAuthSessions(home, created.device.id);
    expect(listed).toEqual([
      expect.objectContaining({
        id: created.device.id,
        name: "Remote browser",
        current: true,
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain("tokenHash");

    revokeAuthSession(home, created.device.id);
    expect(verifyAuthSession(home, created.device.id, created.secret)).toBe(false);
  });

  it("keeps repeated local bootstrap sessions separately revocable", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-auth-local-devices-"));
    const first = createAuthSession(home, req({ "user-agent": "Mozilla/5.0 Macintosh Chrome" }, "127.0.0.1"), {
      kind: "local",
      now: 1_000,
    });
    const second = createAuthSession(home, req({ "user-agent": "Mozilla/5.0 Macintosh Chrome" }, "127.0.0.1"), {
      kind: "local",
      now: 2_000,
    });

    expect(first.device.id).toMatch(/^d_/);
    expect(second.device.id).toMatch(/^d_/);
    expect(second.device.id).not.toBe(first.device.id);
    expect(verifyAuthSession(home, first.device.id, first.secret)).toBe(true);
    expect(verifyAuthSession(home, second.device.id, second.secret)).toBe(true);
    expect(listAuthSessions(home)).toHaveLength(2);
  });
});
