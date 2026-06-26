import { describe, it, expect } from "vitest";
import { checkPublicUrl, isPrivateAddress, validateUrlForServerFetch } from "../ssrf-guard.js";

describe("ssrf-guard: isPrivateAddress", () => {
  it("flags loopback, private, link-local and reserved IPv4", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.16.0.1", "169.254.1.1", "0.0.0.0", "100.64.0.1", "224.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });
  it("flags loopback / ULA / link-local IPv6 and IPv4-mapped loopback", () => {
    for (const ip of ["::1", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });
  it("allows public IPv4 literals", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe("ssrf-guard: checkPublicUrl (SEC-F-003)", () => {
  it("blocks non-http(s) schemes", async () => {
    expect((await checkPublicUrl("file:///etc/passwd")).ok).toBe(false);
    expect((await checkPublicUrl("ftp://example.com/x")).ok).toBe(false);
    expect((await checkPublicUrl("gopher://example.com")).ok).toBe(false);
  });

  it("blocks loopback hostnames without touching DNS", async () => {
    expect((await checkPublicUrl("http://localhost/x")).ok).toBe(false);
    expect((await checkPublicUrl("http://foo.localhost/x")).ok).toBe(false);
  });

  it("blocks private / loopback IP literals", async () => {
    expect((await checkPublicUrl("http://127.0.0.1:8888/api/status")).ok).toBe(false);
    expect((await checkPublicUrl("http://169.254.169.254/latest/meta-data/")).ok).toBe(false);
    expect((await checkPublicUrl("http://10.0.0.5/secret")).ok).toBe(false);
    expect((await checkPublicUrl("http://[::1]/x")).ok).toBe(false);
  });

  it("rejects malformed input", async () => {
    expect((await checkPublicUrl("not a url")).ok).toBe(false);
    expect((await checkPublicUrl("")).ok).toBe(false);
  });

  it("allows a public IP literal", async () => {
    expect((await checkPublicUrl("https://8.8.8.8/x")).ok).toBe(true);
  });

  it("can allow loopback/private targets for explicit local webhook use", async () => {
    expect((await validateUrlForServerFetch("http://127.0.0.1:9999/x", { allowPrivateHosts: true })).ok).toBe(true);
    expect((await validateUrlForServerFetch("http://localhost:9999/x", { allowPrivateHosts: true })).ok).toBe(true);
  });
});
