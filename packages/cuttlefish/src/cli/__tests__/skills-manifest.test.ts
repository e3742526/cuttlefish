import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

const { home } = withStaticTempCuttlefishHome("cuttlefish-skills-manifest-");
const { SKILLS_JSON, readManifest, upsertManifest } = await import("../skills.js");

describe("skills manifest compatibility", () => {
  beforeEach(() => {
    fs.mkdirSync(home, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(SKILLS_JSON, { force: true });
  });

  it("reads the object-shaped manifest seeded by setup and preserves that format on update", () => {
    fs.writeFileSync(SKILLS_JSON, JSON.stringify({
      installed: {
        existing: { source: "owner/existing", installedAt: "2026-07-20T00:00:00.000Z" },
      },
    }));

    expect(readManifest()).toEqual([{
      name: "existing",
      source: "owner/existing",
      installedAt: "2026-07-20T00:00:00.000Z",
    }]);

    upsertManifest("new-skill", "owner/new-skill");

    const persisted = JSON.parse(fs.readFileSync(SKILLS_JSON, "utf8"));
    expect(persisted.installed.existing.source).toBe("owner/existing");
    expect(persisted.installed["new-skill"].source).toBe("owner/new-skill");
  });
});
