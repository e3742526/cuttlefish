import dns from "node:dns/promises";
import net from "node:net";

/**
 * SSRF guard for user-supplied URLs that the gateway fetches server-side
 * (e.g. the `url` field on POST /api/files and session attachments).
 *
 * Audit finding SEC-F-003: those handlers called `fetch(url!)` directly with no
 * scheme restriction or private-range block, letting any caller make the daemon
 * issue requests to loopback/internal addresses (cloud metadata, other local
 * services, etc.). This validates the scheme and resolves the host so every
 * resolved address is checked against private/reserved ranges before the fetch.
 *
 * Residual risk: a TOCTOU/DNS-rebinding window remains between this check and the
 * actual fetch. Pinning the validated IP into the request is tracked as follow-up.
 */

export interface UrlCheckResult {
  ok: boolean;
  reason?: string;
}

export interface UrlCheckOptions {
  allowPrivateHosts?: boolean;
}

function ipv4IsPrivate(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformed → unsafe
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

function ipv6IsPrivate(ip: string): boolean {
  const lc = ip.toLowerCase();
  if (lc === "::1" || lc === "::") return true; // loopback / unspecified
  if (lc.startsWith("fe80")) return true; // link-local
  if (lc.startsWith("fc") || lc.startsWith("fd")) return true; // unique local (fc00::/7)
  return false;
}

/** True if `ip` (a literal address) is loopback, private, link-local, or reserved. */
export function isPrivateAddress(ip: string): boolean {
  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) — check the embedded IPv4.
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  const candidate = mapped ? mapped[1] : ip;
  const kind = net.isIP(candidate);
  if (kind === 4) return ipv4IsPrivate(candidate);
  if (kind === 6) return ipv6IsPrivate(candidate);
  return true; // not a valid IP literal → treat as unsafe
}

/**
 * Validate that `rawUrl` is an http(s) URL whose host does not resolve to a
 * private/reserved address. Returns `{ ok: false, reason }` for anything the
 * gateway must refuse to fetch.
 */
export async function checkPublicUrl(rawUrl: string): Promise<UrlCheckResult> {
  return validateUrlForServerFetch(rawUrl, { allowPrivateHosts: false });
}

export async function validateUrlForServerFetch(rawUrl: string, options: UrlCheckOptions = {}): Promise<UrlCheckResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "malformed URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `unsupported protocol ${parsed.protocol}` };
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (!host) return { ok: false, reason: "missing host" };

  const lowerHost = host.toLowerCase();
  if (lowerHost === "localhost" || lowerHost.endsWith(".localhost")) {
    return options.allowPrivateHosts
      ? { ok: true }
      : { ok: false, reason: "loopback host" };
  }

  // Literal IP in the URL — check directly, no DNS.
  if (net.isIP(host)) {
    return !options.allowPrivateHosts && isPrivateAddress(host)
      ? { ok: false, reason: "private/reserved IP" }
      : { ok: true };
  }

  // Hostname — resolve and ensure every address is public (anti-rebinding).
  let addrs: Array<{ address: string }>;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    return { ok: false, reason: "DNS resolution failed" };
  }
  if (addrs.length === 0) return { ok: false, reason: "no DNS records" };
  for (const a of addrs) {
    if (!options.allowPrivateHosts && isPrivateAddress(a.address)) {
      return { ok: false, reason: "host resolves to private/reserved IP" };
    }
  }
  return { ok: true };
}

export class SsrfError extends Error {}

/**
 * Fetch a user-supplied URL server-side while re-validating every redirect hop.
 *
 * Audit finding SEC-SSRF-001: callers previously ran `checkPublicUrl(url)` once
 * and then `fetch(url)`, but `fetch` follows redirects internally with
 * `redirect: "follow"`. A public URL returning `302 Location:
 * http://169.254.169.254/…` (cloud metadata) or a loopback address defeated the
 * guard, because the guard never saw the post-redirect target. This follows
 * redirects manually (`redirect: "manual"`) and runs the same public-URL check
 * on each `Location` before following it, with a bounded hop count.
 *
 * The initial URL must already have passed `checkPublicUrl`; this re-checks it
 * defensively too. Throws `SsrfError` if any hop resolves to a private/reserved
 * address or the redirect chain is too long. Returns the final non-redirect
 * `Response`; the caller is responsible for size-limited buffering.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  opts: { maxRedirects?: number } = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 5;
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const check = await checkPublicUrl(currentUrl);
    if (!check.ok) throw new SsrfError(`Refusing to fetch URL: ${check.reason}`);
    const response = await fetch(currentUrl, { ...init, redirect: "manual" });
    // 3xx with a Location header is a redirect we must re-validate before following.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return response; // 3xx with no Location — hand back as-is.
      if (hop === maxRedirects) throw new SsrfError("Too many redirects");
      // Resolve relative Location against the current URL, then re-check next loop.
      currentUrl = new URL(location, currentUrl).toString();
      // Drain the redirect body so the socket can be reused.
      await response.body?.cancel().catch(() => {});
      continue;
    }
    return response;
  }
  throw new SsrfError("Too many redirects");
}
