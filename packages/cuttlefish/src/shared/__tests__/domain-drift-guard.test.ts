import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanDomainDrift } from "../domain-drift-guard.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REPO = join(PKG, "..", "..");

describe("program drift guard", () => {
  it("keeps tracked generic surfaces free of downstream program vocabulary", () => {
    expect(scanDomainDrift(REPO)).toEqual([]);
  });

  it("rejects a deliberate violating fixture for both filename and content", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "cuttlefish-domain-drift-"));
    const blocked = [["DA", "WES"].join("")].join("");
    const docsDir = join(tempRoot, "docs");
    const file = join(docsDir, `generic-${blocked.toLowerCase()}-surface.md`);

    mkdirSync(docsDir, { recursive: true });
    writeFileSync(file, `example: ${blocked}\n`, "utf-8");

    try {
      const findings = scanDomainDrift(tempRoot, [docsDir]);
      expect(findings).toContain(`docs/generic-${blocked.toLowerCase()}-surface.md path contains "${blocked.toLowerCase()}"`);
      expect(findings).toContain(`docs/generic-${blocked.toLowerCase()}-surface.md:1 contains "${blocked.toLowerCase()}"`);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
