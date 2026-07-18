import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureSecureCuttlefishHome } from "../lifecycle.js";

describe("ensureSecureCuttlefishHome (SEC-CFDB-001)", () => {
  it("creates a fresh CUTTLEFISH_HOME directory with owner-only (0700) permissions", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-home-perm-"));
    const home = path.join(parent, "cuttlefish-home");

    ensureSecureCuttlefishHome(home);

    const mode = fs.statSync(home).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("tightens a pre-existing world-readable CUTTLEFISH_HOME back to 0700", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-home-perm-"));
    fs.chmodSync(home, 0o755); // simulate a pre-hardening world-readable install

    ensureSecureCuttlefishHome(home);

    const mode = fs.statSync(home).mode & 0o777;
    expect(mode).toBe(0o700);
  });
});
