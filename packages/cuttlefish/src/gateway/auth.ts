import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import type { CuttlefishConfig } from "../shared/types.js";
import { createAuthToken, safeEqual } from "./auth-crypto.js";

// PTY access tokens and scoped session tokens live in dedicated modules
// (pty-auth.ts, scoped-token.ts). They are re-exported here so existing
// `./auth.js` import sites keep working unchanged.
export { createPtyAccessToken, verifyPtyAccessToken } from "./pty-auth.js";
export {
  createScopedSessionToken,
  verifyScopedSessionToken,
  scopedTokenForbidden,
  scopedTokenCollectionForbidden,
  scopedTokenSessionMismatch,
  principalBodySessionForbidden,
} from "./scoped-token.js";
export type { GatewayPrincipal } from "./scoped-token.js";
export { createAuthToken };

// Internal bindings: re-exports above do not create local scope, so symbols
// auth.ts uses directly are imported here too.
import { verifyScopedSessionToken } from "./scoped-token.js";
import type { GatewayPrincipal } from "./scoped-token.js";

export const AUTH_COOKIE = "cuttlefish_auth";
export const AUTH_DEVICE_COOKIE = "cuttlefish_device";
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;

export interface PairingCodeEntry {
  expiresAt: number;
}

export type PairingCodeStore = Map<string, PairingCodeEntry>;

const pairingCodes: PairingCodeStore = new Map();

export type AuthSessionKind = "local" | "remote" | "token";

export interface AuthSessionDevice {
  id: string;
  name: string;
  kind: AuthSessionKind;
  createdAt: string;
  lastSeenAt: string;
  lastIp?: string;
  userAgent?: string;
}

interface StoredAuthSessionDevice extends AuthSessionDevice {
  tokenHash: string;
}

export interface PublicAuthSessionDevice extends AuthSessionDevice {
  current: boolean;
}

export function ensureGatewayAuthToken(cuttlefishHome: string): string {
  try {
    fs.mkdirSync(cuttlefishHome, { recursive: true });
  } catch (err) {
    throw new Error(`Cannot create CUTTLEFISH_HOME (${cuttlefishHome}): ${err instanceof Error ? err.message : String(err)}. Check filesystem permissions.`);
  }
  const file = path.join(cuttlefishHome, "gateway.json");
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    existing = {};
  }
  if (typeof existing.token === "string" && existing.token.length >= 32) {
    try { fs.chmodSync(file, 0o600); } catch {}
    return existing.token;
  }
  const token = createAuthToken();
  const next = { ...existing, token };
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return token;
}

export function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    const rawValue = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(rawValue);
    } catch {
      out[key] = rawValue;
    }
  }
  return out;
}

export function matchesGatewayAuthToken(candidate: string | undefined, expectedToken: string | undefined): boolean {
  return typeof candidate === "string" && typeof expectedToken === "string" && safeEqual(candidate, expectedToken);
}

export function verifyGatewayAuth(
  headers: Record<string, string | string[] | undefined>,
  expectedToken: string | undefined,
  cuttlefishHome?: string,
): boolean {
  if (!expectedToken) return false;
  if (hasGatewayBearerAuth(headers, expectedToken)) return true;
  const cookieRaw = headers.cookie;
  const cookie = Array.isArray(cookieRaw) ? cookieRaw[0] : cookieRaw;
  const parsed = parseCookieHeader(cookie);
  const token = parsed[AUTH_COOKIE];
  const deviceId = parsed[AUTH_DEVICE_COOKIE];
  if (cuttlefishHome && typeof token === "string" && typeof deviceId === "string" && verifyAuthSession(cuttlefishHome, deviceId, token)) {
    return true;
  }
  return false;
}

export function hasGatewayBearerAuth(
  headers: Record<string, string | string[] | undefined>,
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken) return false;
  const authHeaderRaw = headers.authorization;
  const authHeader = Array.isArray(authHeaderRaw) ? authHeaderRaw[0] : authHeaderRaw;
  if (typeof authHeader !== "string") return false;
  const [scheme, ...rest] = authHeader.trim().split(/\s+/);
  return scheme?.toLowerCase() === "bearer" && safeEqual(rest.join(" "), expectedToken);
}

function getBearerToken(headers: Record<string, string | string[] | undefined>): string | undefined {
  const raw = headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== "string") return undefined;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer") return undefined;
  return rest.join(" ");
}

export function authenticateGatewayRequest(
  req: Pick<IncomingMessage, "headers" | "socket">,
  expectedToken: string | undefined,
  cuttlefishHome?: string,
): { ok: boolean; reason?: string; principal?: GatewayPrincipal } {
  if (!expectedToken) return { ok: false, reason: "Gateway auth token is not configured" };
  // Operator (admin) auth: gateway bearer token or a revocable browser session cookie.
  if (verifyGatewayAuth(req.headers, expectedToken, cuttlefishHome)) {
    return { ok: true, principal: { kind: "admin" } };
  }
  // Agent (session-scoped) auth: a per-session token signed with the gateway secret.
  const bearer = getBearerToken(req.headers as Record<string, string | string[] | undefined>);
  if (bearer) {
    const sessionId = verifyScopedSessionToken(bearer, expectedToken);
    if (sessionId) return { ok: true, principal: { kind: "session", sessionId } };
  }
  return { ok: false, reason: "Missing or invalid gateway auth token" };
}

export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true;
  const raw = host.trim().toLowerCase();
  const h = raw.startsWith("[")
    ? raw.slice(1, raw.indexOf("]") >= 0 ? raw.indexOf("]") : undefined)
    : raw.replace(/:\d+$/, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "::1";
}

export function isNetworkHost(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "0.0.0.0" || !isLoopbackHost(h);
}

export function authRequiredForRequest(method: string | undefined, pathname: string): boolean {
  if (pathname === "/api/healthz") return false;
  if (pathname === "/api/status") return false;
  if (pathname === "/api/auth/state" && (method || "GET").toUpperCase() === "GET") return false;
  if (pathname === "/api/auth/bootstrap" && (method || "GET").toUpperCase() === "POST") return false;
  if (pathname === "/api/auth/pair" && (method || "GET").toUpperCase() === "POST") return false;
  if (pathname === "/api/auth/logout" && (method || "GET").toUpperCase() === "POST") return false;
  if (pathname === "/api/internal/hook" && (method || "GET").toUpperCase() === "POST") return false;
  if (pathname.startsWith("/api/")) return true;
  if (pathname === "/ws" || pathname.startsWith("/ws/pty/")) return true;
  return false;
}

export function shouldRequireGatewayAuth(config: Pick<CuttlefishConfig, "gateway">): boolean {
  const gateway = config.gateway as CuttlefishConfig["gateway"] & {
    authRequired?: boolean;
    authDisabled?: boolean;
  };
  if (gateway.authDisabled === true) return false;
  if (gateway.authRequired === true) return true;
  return isNetworkHost(gateway.host);
}

export function validateGatewayExposure(config: Pick<CuttlefishConfig, "gateway">): { ok: true } | { ok: false; error: string } {
  const gateway = config.gateway as CuttlefishConfig["gateway"] & {
    authDisabled?: boolean;
    insecureAllowUnauthenticatedNetwork?: boolean;
  };
  if (isNetworkHost(gateway.host) && gateway.authDisabled === true && gateway.insecureAllowUnauthenticatedNetwork !== true) {
    return { ok: false, error: "Refusing network-exposed gateway without auth. Set gateway.insecureAllowUnauthenticatedNetwork=true to override." };
  }
  return { ok: true };
}

export function authCookieHeader(token: string, secure = true): string {
  const secureAttr = secure ? "; Secure" : "";
  return `${AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secureAttr}`;
}

export function authDeviceCookieHeader(deviceId: string, secure = true): string {
  const secureAttr = secure ? "; Secure" : "";
  return `${AUTH_DEVICE_COOKIE}=${encodeURIComponent(deviceId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secureAttr}`;
}

export function authCookieHeaders(secret: string, deviceId: string, secure = true): string[] {
  return [authCookieHeader(secret, secure), authDeviceCookieHeader(deviceId, secure)];
}

export function clearAuthCookieHeader(secure = true): string {
  const secureAttr = secure ? "; Secure" : "";
  return `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureAttr}`;
}

export function clearAuthDeviceCookieHeader(secure = true): string {
  const secureAttr = secure ? "; Secure" : "";
  return `${AUTH_DEVICE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureAttr}`;
}

export function clearAuthCookieHeaders(secure = true): string[] {
  return [clearAuthCookieHeader(secure), clearAuthDeviceCookieHeader(secure)];
}

export function createAuthState(
  config: Pick<CuttlefishConfig, "gateway">,
  req: Pick<IncomingMessage, "headers" | "socket">,
  expectedToken: string | undefined,
  cuttlefishHome?: string,
): {
  authRequired: boolean;
  authenticated: boolean;
  canBootstrapLocal: boolean;
  networkExposed: boolean;
} {
  const authRequired = shouldRequireGatewayAuth(config);
  const authenticated = authRequired ? verifyGatewayAuth(req.headers, expectedToken, cuttlefishHome) : true;
  return {
    authRequired,
    authenticated,
    canBootstrapLocal: Boolean(expectedToken && isLoopbackAddress(req.socket.remoteAddress) && isLoopbackHost(headerValue(req.headers, "host"))),
    networkExposed: isNetworkHost(config.gateway.host),
  };
}

function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  let a = addr.trim().toLowerCase();
  if (a.startsWith("::ffff:")) a = a.slice("::ffff:".length);
  if (a === "::1") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  return m !== null && m.slice(1).every((octet) => Number(octet) <= 255);
}

function authDevicesPath(cuttlefishHome: string): string {
  return path.join(cuttlefishHome, "auth-devices.json");
}

function authSessionHash(secret: string): string {
  return crypto.createHash("sha256").update(`cuttlefish-auth-session:${secret}`).digest("base64url");
}

function headerValue(headers: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const raw = headers[key] ?? headers[key.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw;
}

function loadStoredAuthSessions(cuttlefishHome: string): StoredAuthSessionDevice[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(authDevicesPath(cuttlefishHome), "utf-8")) as { devices?: unknown };
    if (!Array.isArray(parsed.devices)) return [];
    return parsed.devices.filter((device): device is StoredAuthSessionDevice => {
      if (!device || typeof device !== "object") return false;
      const d = device as Record<string, unknown>;
      return typeof d.id === "string"
        && typeof d.name === "string"
        && typeof d.kind === "string"
        && typeof d.createdAt === "string"
        && typeof d.lastSeenAt === "string"
        && typeof d.tokenHash === "string";
    });
  } catch {
    return [];
  }
}

function saveStoredAuthSessions(cuttlefishHome: string, devices: StoredAuthSessionDevice[]): void {
  fs.mkdirSync(cuttlefishHome, { recursive: true });
  const file = authDevicesPath(cuttlefishHome);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ devices }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function inferAuthSessionName(req: Pick<IncomingMessage, "headers" | "socket">, kind: AuthSessionKind): string {
  if (kind === "local") return "This Mac";
  const ua = headerValue(req.headers, "user-agent") || "";
  if (/iphone|ipad/i.test(ua)) return "iPhone or iPad browser";
  if (/android/i.test(ua)) return "Android browser";
  if (/macintosh|mac os/i.test(ua)) return "Mac browser";
  if (/windows/i.test(ua)) return "Windows browser";
  if (/linux/i.test(ua)) return "Linux browser";
  return kind === "token" ? "Setup-token browser" : "Remote browser";
}

export function createAuthSession(
  cuttlefishHome: string,
  req: Pick<IncomingMessage, "headers" | "socket">,
  opts: { name?: string; kind?: AuthSessionKind; now?: number } = {},
): { secret: string; device: AuthSessionDevice } {
  const now = opts.now ?? Date.now();
  const kind = opts.kind ?? (isLoopbackAddress(req.socket.remoteAddress) ? "local" : "remote");
  const secret = createAuthToken();
  const userAgent = headerValue(req.headers, "user-agent");
  const devices = loadStoredAuthSessions(cuttlefishHome);
  const device: AuthSessionDevice = {
    id: `d_${crypto.randomBytes(12).toString("base64url")}`,
    name: opts.name || inferAuthSessionName(req, kind),
    kind,
    createdAt: new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    ...(req.socket.remoteAddress ? { lastIp: req.socket.remoteAddress } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
  const stored: StoredAuthSessionDevice = { ...device, tokenHash: authSessionHash(secret) };
  saveStoredAuthSessions(cuttlefishHome, [...devices.filter((existing) => existing.id !== stored.id), stored]);
  return { secret, device };
}

export function verifyAuthSession(cuttlefishHome: string, deviceId: string | undefined, secret: string | undefined): boolean {
  if (!deviceId || !secret) return false;
  const device = loadStoredAuthSessions(cuttlefishHome).find((d) => d.id === deviceId);
  if (!device) return false;
  return safeEqual(device.tokenHash, authSessionHash(secret));
}

export function touchAuthSession(
  cuttlefishHome: string,
  req: Pick<IncomingMessage, "headers" | "socket">,
  now = Date.now(),
): AuthSessionDevice | null {
  const cookieRaw = req.headers.cookie;
  const cookie = Array.isArray(cookieRaw) ? cookieRaw[0] : cookieRaw;
  const parsed = parseCookieHeader(cookie);
  const secret = parsed[AUTH_COOKIE];
  const deviceId = parsed[AUTH_DEVICE_COOKIE];
  if (!verifyAuthSession(cuttlefishHome, deviceId, secret)) return null;
  const devices = loadStoredAuthSessions(cuttlefishHome);
  const idx = devices.findIndex((d) => d.id === deviceId);
  if (idx < 0) return null;
  devices[idx] = {
    ...devices[idx],
    lastSeenAt: new Date(now).toISOString(),
    ...(req.socket.remoteAddress ? { lastIp: req.socket.remoteAddress } : {}),
    ...(headerValue(req.headers, "user-agent") ? { userAgent: headerValue(req.headers, "user-agent") } : {}),
  };
  saveStoredAuthSessions(cuttlefishHome, devices);
  const { tokenHash: _tokenHash, ...device } = devices[idx];
  return device;
}

export function currentAuthDeviceId(headers: Record<string, string | string[] | undefined>): string | undefined {
  const cookieRaw = headers.cookie;
  const cookie = Array.isArray(cookieRaw) ? cookieRaw[0] : cookieRaw;
  return parseCookieHeader(cookie)[AUTH_DEVICE_COOKIE];
}

export function listAuthSessions(cuttlefishHome: string, currentDeviceId?: string): PublicAuthSessionDevice[] {
  return loadStoredAuthSessions(cuttlefishHome)
    .map(({ tokenHash: _tokenHash, ...device }) => ({
      ...device,
      current: Boolean(currentDeviceId && device.id === currentDeviceId),
    }))
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export function revokeAuthSession(cuttlefishHome: string, deviceId: string): boolean {
  const devices = loadStoredAuthSessions(cuttlefishHome);
  const next = devices.filter((device) => device.id !== deviceId);
  if (next.length === devices.length) return false;
  saveStoredAuthSessions(cuttlefishHome, next);
  return true;
}

function hashPairingCode(raw: string): string {
  return crypto.createHash("sha256").update(normalizePairingCode(raw)).digest("base64url");
}

export function normalizePairingCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function createPairingCode(): string {
  let raw = "";
  for (let i = 0; i < 12; i++) {
    raw += PAIRING_CODE_ALPHABET[crypto.randomInt(PAIRING_CODE_ALPHABET.length)];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

export function issuePairingCode(
  store: PairingCodeStore = pairingCodes,
  now = Date.now(),
  codeFactory: () => string = createPairingCode,
): { code: string; expiresAt: number } {
  cleanupExpiredPairingCodes(store, now);
  const code = codeFactory();
  const expiresAt = now + PAIRING_CODE_TTL_MS;
  store.set(hashPairingCode(code), { expiresAt });
  return { code, expiresAt };
}

export function consumePairingCode(
  store: PairingCodeStore = pairingCodes,
  rawCode: string | undefined,
  now = Date.now(),
): boolean {
  if (!rawCode) return false;
  const normalized = normalizePairingCode(rawCode);
  if (normalized.length === 0) return false;
  const hash = hashPairingCode(normalized);
  const entry = store.get(hash);
  if (!entry) return false;
  store.delete(hash);
  return entry.expiresAt >= now;
}

export function cleanupExpiredPairingCodes(store: PairingCodeStore = pairingCodes, now = Date.now()): void {
  for (const [hash, entry] of store.entries()) {
    if (entry.expiresAt < now) store.delete(hash);
  }
}

// ── Simple authenticated-request check ───────────────────────────────────────

export function isAuthenticatedRequest(
  req: Pick<IncomingMessage, "headers">,
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken) return false;
  const headers = req.headers as Record<string, string | string[] | undefined>;
  // Bearer token
  const authHeaderRaw = headers["authorization"];
  const authHeader = Array.isArray(authHeaderRaw) ? authHeaderRaw[0] : authHeaderRaw;
  if (typeof authHeader === "string") {
    const [scheme, ...rest] = authHeader.trim().split(/\s+/);
    if (scheme?.toLowerCase() === "bearer" && safeEqual(rest.join(" "), expectedToken)) return true;
  }
  // X-Cuttlefish-Token header
  const xToken = headers["x-cuttlefish-token"];
  const xTokenValue = Array.isArray(xToken) ? xToken[0] : xToken;
  if (typeof xTokenValue === "string" && safeEqual(xTokenValue, expectedToken)) return true;
  // Auth cookie
  const cookieRaw = headers["cookie"];
  const cookie = Array.isArray(cookieRaw) ? cookieRaw[0] : cookieRaw;
  const parsed = parseCookieHeader(cookie);
  if (parsed[AUTH_COOKIE] && safeEqual(parsed[AUTH_COOKIE], expectedToken)) return true;
  return false;
}
