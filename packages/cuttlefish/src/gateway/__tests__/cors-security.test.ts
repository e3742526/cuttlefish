import { describe, expect, it } from "vitest";
import { isAllowedCorsOrigin } from "../server.js";

describe("CORS origin policy", () => {
  it("allows absent origins for same-origin requests and CLI/curl clients", () => {
    expect(isAllowedCorsOrigin(undefined)).toBe(true);
  });

  it("allows a loopback origin only when it matches the request host:port (same-origin)", () => {
    expect(isAllowedCorsOrigin("http://localhost:8888", "localhost:8888")).toBe(true);
    expect(isAllowedCorsOrigin("http://127.0.0.1:8888", "127.0.0.1:8888")).toBe(true);
    expect(isAllowedCorsOrigin("http://[::1]:8888", "[::1]:8888")).toBe(true);
  });

  it("rejects a distinct local attacker port even on loopback (AR-06)", () => {
    // A different local app on loopback is cross-origin; reflecting it with
    // credentialed CORS would leak authenticated gateway responses.
    expect(isAllowedCorsOrigin("http://localhost:3999", "localhost:8888")).toBe(false);
    expect(isAllowedCorsOrigin("http://127.0.0.1:1234", "127.0.0.1:8888")).toBe(false);
    // A loopback origin with no confirmable request host is not same-origin.
    expect(isAllowedCorsOrigin("http://localhost:8888")).toBe(false);
  });

  it("rejects arbitrary web origins instead of reflecting a wildcard", () => {
    expect(isAllowedCorsOrigin("https://evil.example")).toBe(false);
    expect(isAllowedCorsOrigin("https://localhost.evil.example")).toBe(false);
    expect(isAllowedCorsOrigin("file://localhost/tmp/x.html")).toBe(false);
    expect(isAllowedCorsOrigin("not a url")).toBe(false);
  });

  it("allows same-origin requests where the Origin host matches the request Host", () => {
    // Dashboard served by this same gateway over Tailscale/LAN: the browser's
    // Origin host equals the request's Host header, so it is genuinely same-origin.
    expect(
      isAllowedCorsOrigin(
        "https://operator-mac-mini.tail0b18b3.ts.net",
        "operator-mac-mini.tail0b18b3.ts.net",
      ),
    ).toBe(true);
    // LAN access by IP with an explicit port on the Host header.
    expect(isAllowedCorsOrigin("http://192.168.1.50:8888", "192.168.1.50:8888")).toBe(true);
  });

  it("still rejects cross-origin requests even when a Host header is present", () => {
    expect(
      isAllowedCorsOrigin("https://evil.example", "operator-mac-mini.tail0b18b3.ts.net"),
    ).toBe(false);
  });
});
