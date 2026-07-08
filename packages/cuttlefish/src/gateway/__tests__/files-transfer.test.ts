import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-transfer-sec-"));
process.env.CUTTLEFISH_HOME = tmpHome;

type Transfer = typeof import("../files/transfer.js");

let transfer: Transfer;

beforeAll(async () => {
  transfer = await import("../files/transfer.js");
});

function fakeContext(overrides: Record<string, unknown> = {}): any {
  return {
    getConfig: () => ({ gateway: {} }),
    ...overrides,
  };
}

describe("resolveFileSpec (CF2-202)", () => {
  it("refuses to transfer a blocked secret path", () => {
    const secretDir = path.join(tmpHome, "secrets");
    fs.mkdirSync(secretDir, { recursive: true });
    const secret = path.join(secretDir, "api.txt");
    fs.writeFileSync(secret, "TOKEN=should-not-leak");

    expect(() => transfer.resolveFileSpec({ file: secret }, fakeContext())).toThrow();
  });

  it("refuses to transfer SSH private keys", () => {
    const sshKey = path.join(os.homedir(), ".ssh", "id_rsa");
    expect(() => transfer.resolveFileSpec({ file: sshKey }, fakeContext())).toThrow();
  });

  it("refuses a path outside a configured fileReadRoots allowlist", () => {
    const outside = path.join(tmpHome, "notes.txt");
    fs.writeFileSync(outside, "hello");
    const rootedContext = fakeContext({
      getConfig: () => ({ gateway: { fileReadRoots: [path.join(tmpHome, "allowed-only")] } }),
    });
    expect(() => transfer.resolveFileSpec({ file: outside }, rootedContext)).toThrow(/fileReadRoots/);
  });

  it("allows a normal file inside the configured roots", () => {
    const allowedDir = path.join(tmpHome, "allowed-only");
    fs.mkdirSync(allowedDir, { recursive: true });
    const file = path.join(allowedDir, "report.txt");
    fs.writeFileSync(file, "hello");
    const rootedContext = fakeContext({
      getConfig: () => ({ gateway: { fileReadRoots: [allowedDir] } }),
    });
    const result = transfer.resolveFileSpec({ file }, rootedContext);
    expect(result.buffer.toString()).toBe("hello");
    expect(result.filename).toBe("report.txt");
  });

  it("allows a normal file when no fileReadRoots is configured", () => {
    const file = path.join(tmpHome, "plain.txt");
    fs.writeFileSync(file, "plain content");
    const result = transfer.resolveFileSpec({ file }, fakeContext());
    expect(result.buffer.toString()).toBe("plain content");
  });
});
