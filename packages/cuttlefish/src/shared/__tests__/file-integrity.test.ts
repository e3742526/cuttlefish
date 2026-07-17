import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertFileIntegrity, sha256File } from "../file-integrity.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-integrity-"));
  dirs.push(dir);
  const file = path.join(dir, "asset.bin");
  fs.writeFileSync(file, content);
  return file;
}

describe("downloaded file integrity", () => {
  it("accepts exact bytes and rejects a size mismatch", async () => {
    const file = fixture("trusted model bytes");
    const sha256 = crypto.createHash("sha256").update("trusted model bytes").digest("hex");
    await expect(assertFileIntegrity(file, { size: 19, sha256, label: "fixture" })).resolves.toBeUndefined();
    await expect(assertFileIntegrity(file, { size: 20, sha256, label: "fixture" })).rejects.toThrow(/size mismatch/);
  });

  it("rejects same-size substituted bytes", async () => {
    const file = fixture("bad!");
    const trusted = crypto.createHash("sha256").update("good").digest("hex");
    await expect(assertFileIntegrity(file, { size: 4, sha256: trusted, label: "fixture" })).rejects.toThrow(/SHA-256 mismatch/);
    await expect(sha256File(file)).resolves.toBe(crypto.createHash("sha256").update("bad!").digest("hex"));
  });
});

