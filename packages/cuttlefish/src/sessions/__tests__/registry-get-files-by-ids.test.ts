import { describe, it, expect, beforeAll } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

// Point the DB at a throwaway dir BEFORE importing the registry.
withStaticTempCuttlefishHome("cuttlefish-getfilesbyids-");

type Reg = typeof import("../registry.js");
let reg: Reg;

beforeAll(async () => {
  reg = await import("../registry.js");
  reg.initDb();
});

function seedFile(id: string): void {
  reg.insertFile({
    id,
    filename: `${id}.txt`,
    size: 10,
    mimetype: "text/plain",
    path: `/tmp/${id}.txt`,
    artifactKind: "generated",
  });
}

describe("getFilesByIds (PERF-CF-001 batched lookup)", () => {
  it("returns metadata for every requested id in one call", () => {
    seedFile("gfbi-1");
    seedFile("gfbi-2");
    seedFile("gfbi-3");
    const rows = reg.getFilesByIds(["gfbi-1", "gfbi-2", "gfbi-3"]);
    expect(rows.map((r) => r.id).sort()).toEqual(["gfbi-1", "gfbi-2", "gfbi-3"]);
  });

  it("silently omits ids that don't exist", () => {
    seedFile("gfbi-4");
    const rows = reg.getFilesByIds(["gfbi-4", "gfbi-missing"]);
    expect(rows.map((r) => r.id)).toEqual(["gfbi-4"]);
  });

  it("returns an empty array for an empty input without querying", () => {
    expect(reg.getFilesByIds([])).toEqual([]);
  });

  it("matches per-id getFile results for the same ids", () => {
    seedFile("gfbi-5");
    seedFile("gfbi-6");
    const batched = reg.getFilesByIds(["gfbi-5", "gfbi-6"]);
    const individual = ["gfbi-5", "gfbi-6"].map((id) => reg.getFile(id));
    expect(batched.sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      individual.filter((f): f is NonNullable<typeof f> => !!f).sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});
