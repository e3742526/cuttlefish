import { describe, it, expect, beforeAll } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

// Point the DB at a throwaway dir BEFORE importing the registry.
withStaticTempCuttlefishHome("cuttlefish-artlimit-");

type Reg = typeof import("../registry.js");
let reg: Reg;

beforeAll(async () => {
  reg = await import("../registry.js");
  reg.initDb();
});

function seedArtifact(id: string): void {
  reg.insertFile({
    id,
    filename: `${id}.txt`,
    size: 10,
    mimetype: "text/plain",
    path: `/tmp/${id}.txt`,
    artifactKind: "generated",
  });
}

describe("listArtifacts limit guard (NaN regression)", () => {
  it("treats a non-finite limit as the default instead of crashing SQLite", () => {
    seedArtifact("art-nan-1");
    seedArtifact("art-nan-2");
    // Number("abc") = NaN — before the fix this produced `LIMIT NaN` → datatype mismatch.
    expect(() => reg.listArtifacts({ limit: Number("abc") })).not.toThrow();
    const rows = reg.listArtifacts({ limit: Number("abc") });
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("still honors a valid finite limit", () => {
    expect(reg.listArtifacts({ limit: 1 }).length).toBe(1);
  });
});
