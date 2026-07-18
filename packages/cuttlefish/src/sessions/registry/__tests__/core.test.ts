import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { withStaticTempCuttlefishHome } from "../../../test-utils/cuttlefish-home.js";

// Point CUTTLEFISH_HOME at a temp dir BEFORE importing the module under test so
// SESSIONS_DB resolves inside it (SESSIONS_DB is a live binding read at call
// time, but initDb()'s module-level `db` singleton must be the first thing to
// open a connection for this file).
withStaticTempCuttlefishHome("cuttlefish-sessions-core-perm-");

const { initDb } = await import("../core.js");
const { SESSIONS_DB } = await import("../../../shared/paths.js");

describe("sessions registry initDb — file permissions (SEC-CFDB-001)", () => {
  it("creates the sessions DB file with owner-only (0600) permissions", () => {
    initDb();
    const mode = fs.statSync(SESSIONS_DB).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
