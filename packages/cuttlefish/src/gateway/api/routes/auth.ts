import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import {
  authenticateGatewayRequest,
  authCookieHeaders,
  clearAuthCookieHeaders,
  consumePairingCode,
  createAuthSession,
  createAuthState,
  currentAuthDeviceId,
  hasGatewayBearerAuth,
  isLoopbackHost,
  issuePairingCode,
  listAuthSessions,
  matchesGatewayAuthToken,
  revokeAuthSession,
  touchAuthSession,
} from "../../auth.js";
import { isLoopback } from "../../hook-endpoint.js";
import { readJsonBody } from "../../http-helpers.js";
import { CUTTLEFISH_HOME } from "../../../shared/paths.js";
import type { ApiContext } from "../context.js";
import { badRequest, json } from "../responses.js";

const AUTH_BODY_MAX_BYTES = 16 * 1024;

export async function handleAuthRoutes(
  method: string,
  pathname: string,
  req: HttpRequest,
  res: ServerResponse,
  context: ApiContext,
): Promise<boolean> {
  const cuttlefishHome = context.cuttlefishHome ?? CUTTLEFISH_HOME;

  if (method === "GET" && pathname === "/api/auth/state") {
    const state = createAuthState(context.getConfig(), req, context.gatewayAuthToken, cuttlefishHome);
    if (state.authenticated) touchAuthSession(cuttlefishHome, req);
    json(res, state);
    return true;
  }

  if (method === "POST" && pathname === "/api/auth/bootstrap") {
    if (!context.gatewayAuthToken) {
      json(res, { authRequired: false });
      return true;
    }
    if (!isLoopback(req.socket.remoteAddress) || !isLoopbackHost(Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host)) {
      json(res, { error: "Bootstrap is loopback-only" }, 403);
      return true;
    }
    const session = createAuthSession(cuttlefishHome, req, { kind: "local" });
    const secureBootstrap = !isLoopbackHost(Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host);
    res.setHeader("Set-Cookie", authCookieHeaders(session.secret, session.device.id, secureBootstrap));
    json(res, { status: "ok", authRequired: true, device: { ...session.device, current: true } });
    return true;
  }

  if (method === "POST" && pathname === "/api/auth/pairing-codes") {
    const parsed = await readJsonBody(req, res, { allowEmpty: true, maxBytes: AUTH_BODY_MAX_BYTES });
    if (!parsed.ok) return true;
    if (!context.gatewayAuthToken) {
      json(res, { error: "Gateway auth token is not configured" }, 503);
      return true;
    }
    const auth = authenticateGatewayRequest(req, context.gatewayAuthToken, cuttlefishHome);
    if (!auth.ok) {
      json(res, { error: auth.reason || "Unauthorized" }, 401);
      return true;
    }
    const bearer = hasGatewayBearerAuth(req.headers, context.gatewayAuthToken);
    const localBrowser = isLoopback(req.socket.remoteAddress)
      && isLoopbackHost(Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host);
    if (!bearer && !localBrowser) {
      json(res, { error: "Pairing codes can only be created locally" }, 403);
      return true;
    }
    const issued = issuePairingCode();
    json(res, {
      status: "ok",
      code: issued.code,
      expiresAt: new Date(issued.expiresAt).toISOString(),
      ttlSeconds: Math.floor((issued.expiresAt - Date.now()) / 1000),
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/auth/pair") {
    const parsed = await readJsonBody(req, res, { maxBytes: AUTH_BODY_MAX_BYTES });
    if (!parsed.ok) return true;
    const body = parsed.body && typeof parsed.body === "object" ? parsed.body as Record<string, unknown> : {};
    const code = typeof body.code === "string" ? body.code : undefined;
    const token = typeof body.token === "string" ? body.token : undefined;
    const pairedWithToken = matchesGatewayAuthToken(token, context.gatewayAuthToken);
    const ok = consumePairingCode(undefined, code) || pairedWithToken;
    if (!ok || !context.gatewayAuthToken) {
      json(res, { error: "Invalid or expired pairing code" }, 401);
      return true;
    }
    const session = createAuthSession(cuttlefishHome, req, { kind: pairedWithToken ? "token" : "remote" });
    const securePair = !isLoopbackHost(Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host);
    res.setHeader("Set-Cookie", authCookieHeaders(session.secret, session.device.id, securePair));
    json(res, { status: "ok", authRequired: true, device: { ...session.device, current: true } });
    return true;
  }

  if (method === "GET" && pathname === "/api/auth/devices") {
    const auth = authenticateGatewayRequest(req, context.gatewayAuthToken, cuttlefishHome);
    if (!auth.ok) {
      json(res, { error: auth.reason || "Unauthorized" }, 401);
      return true;
    }
    touchAuthSession(cuttlefishHome, req);
    json(res, { devices: listAuthSessions(cuttlefishHome, currentAuthDeviceId(req.headers)) });
    return true;
  }

  if (method === "DELETE" && pathname.startsWith("/api/auth/devices/")) {
    const auth = authenticateGatewayRequest(req, context.gatewayAuthToken, cuttlefishHome);
    if (!auth.ok) {
      json(res, { error: auth.reason || "Unauthorized" }, 401);
      return true;
    }
    const rawDeviceId = pathname.slice("/api/auth/devices/".length);
    let deviceId = "";
    try {
      deviceId = decodeURIComponent(rawDeviceId);
    } catch {
      badRequest(res, "Invalid paired browser id");
      return true;
    }
    if (!deviceId) {
      badRequest(res, "Missing paired browser id");
      return true;
    }
    const currentDevice = currentAuthDeviceId(req.headers);
    const removed = revokeAuthSession(cuttlefishHome, deviceId);
    if (!removed) {
      json(res, { error: "Paired browser not found" }, 404);
      return true;
    }
    const current = Boolean(currentDevice && currentDevice === deviceId);
    if (current) {
      const secureRevoke = !isLoopbackHost(Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host);
      res.setHeader("Set-Cookie", clearAuthCookieHeaders(secureRevoke));
    }
    json(res, { status: "ok", current });
    return true;
  }

  if (method === "POST" && pathname === "/api/auth/logout") {
    const parsed = await readJsonBody(req, res, { allowEmpty: true, maxBytes: AUTH_BODY_MAX_BYTES });
    if (!parsed.ok) return true;
    const currentDevice = currentAuthDeviceId(req.headers);
    if (currentDevice) revokeAuthSession(cuttlefishHome, currentDevice);
    const secureLogout = !isLoopbackHost(Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host);
    res.setHeader("Set-Cookie", clearAuthCookieHeaders(secureLogout));
    json(res, { status: "ok" });
    return true;
  }

  return false;
}
