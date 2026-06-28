import { describe, it, expect, beforeAll } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the DB at a throwaway dir BEFORE importing the registry (SESSIONS_DB is
// resolved from CUTTLEFISH_HOME at module load).
const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-pg-");

type Reg = typeof import("../registry.js");
let reg: Reg;

function insert(
  db: import("better-sqlite3").Database,
  id: string,
  fields: { source?: string; sourceRef?: string; employee?: string | null; lastActivity: string; cwd?: string | null },
) {
  const source = fields.source ?? "web";
  const sourceRef = fields.sourceRef ?? `web:${id}`;
  const employee = fields.employee ?? null;
  const groupKey = source === "cron" || sourceRef.startsWith("cron:") ? reg.CRON_GROUP : employee ?? reg.DIRECT_GROUP;
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, employee, group_key, cwd, status, created_at, last_activity)
     VALUES (?, 'claude', ?, ?, ?, ?, ?, 'idle', ?, ?)`,
  ).run(
    id,
    source,
    sourceRef,
    employee,
    groupKey,
    fields.cwd ?? null,
    fields.lastActivity,
    fields.lastActivity,
  );
}

beforeAll(async () => {
  reg = await import("../registry.js");
  const db = reg.initDb();
  // Alice: 12 chats, Bob: 3, direct: 6, cron: 20.
  let t = 0;
  const ts = () => `2026-01-01T00:00:${String(t++).padStart(2, "0")}.000Z`;
  for (let i = 0; i < 12; i++) insert(db, `alice-${i}`, { employee: "alice", lastActivity: ts() });
  for (let i = 0; i < 3; i++) insert(db, `bob-${i}`, { employee: "bob", lastActivity: ts() });
  for (let i = 0; i < 6; i++) insert(db, `direct-${i}`, { employee: null, lastActivity: ts() });
  for (let i = 0; i < 20; i++)
    insert(db, `cron-${i}`, { source: "cron", sourceRef: `cron:job:${i}`, lastActivity: ts() });
  // a titled row in its own group (old timestamp) so it doesn't perturb the
  // alice/bob/direct/cron pagination assertions above
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, employee, group_key, title, status, created_at, last_activity)
     VALUES ('titled-1','claude','web','web:t1','zoe','zoe','Quarterly budget review','idle','2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z')`,
  ).run();
});

describe("searchSessions", () => {
  it("matches title case-insensitively across all sessions", () => {
    const hits = reg.searchSessions("BUDGET");
    expect(hits.map((r) => r.id)).toContain("titled-1");
  });

  it("matches employee and id, and returns nothing for misses", () => {
    expect(reg.searchSessions("bob").length).toBeGreaterThanOrEqual(3);
    expect(reg.searchSessions("alice-7").map((r) => r.id)).toEqual(["alice-7"]);
    expect(reg.searchSessions("nonexistent-zzz")).toEqual([]);
  });
});

describe("listRecentPerGroup", () => {
  it("opens the registry database in WAL mode with NORMAL synchronous durability", () => {
    const db = reg.initDb();

    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("synchronous", { simple: true })).toBe(1);
  });

  it("caps each group at perGroup, regardless of group size", () => {
    const rows = reg.listRecentPerGroup(8);
    const byEmp = (e: string | null, cron = false) =>
      rows.filter((r) =>
        cron ? r.source === "cron" : r.source !== "cron" && (r.employee ?? null) === e,
      );

    expect(byEmp("alice").length).toBe(8); // 12 → capped at 8
    expect(byEmp("bob").length).toBe(3); // 3 → all
    expect(byEmp(null).length).toBe(6); // direct → all
    expect(byEmp(null, true).length).toBe(8); // 20 cron → capped at 8

    // 8 (alice) + 3 (bob) + 6 (direct) + 8 (cron) + 1 (zoe) = 26 instead of all
    expect(rows.length).toBe(26);
  });

  it("returns the most recent rows within a group", () => {
    const rows = reg.listRecentPerGroup(8);
    const alice = rows.filter((r) => r.employee === "alice").map((r) => r.id);
    // alice-11 is newest; alice-0..3 are the oldest and should be excluded.
    expect(alice).toContain("alice-11");
    expect(alice).not.toContain("alice-0");
  });

  it("lists recent workspace directories newest-first without duplicate paths", () => {
    const db = reg.initDb();
    insert(db, "cwd-1", { employee: "cwd-user", cwd: "/repo/a", lastActivity: "2026-03-01T00:00:00.000Z" });
    insert(db, "cwd-2", { employee: "cwd-user", cwd: "/repo/b", lastActivity: "2026-03-01T00:00:05.000Z" });
    insert(db, "cwd-3", { employee: "cwd-user", cwd: "/repo/a", lastActivity: "2026-03-01T00:00:10.000Z" });

    expect(reg.listRecentCwds(5)).toEqual(expect.arrayContaining(["/repo/a", "/repo/b"]));
    expect(reg.listRecentCwds(2)[0]).toBe("/repo/a");
  });

  it("creates composite indexes for filtered session ordering", () => {
    const db = reg.initDb();
    const queryPlan = (sql: string, value: string) =>
      db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(value) as Array<{ detail: string }>;

    expect(queryPlan(
      "SELECT * FROM sessions WHERE status = ? ORDER BY last_activity DESC",
      "idle",
    ).some((row) => row.detail.includes("idx_sessions_status_activity"))).toBe(true);
    expect(queryPlan(
      "SELECT * FROM sessions WHERE source = ? ORDER BY last_activity DESC",
      "web",
    ).some((row) => row.detail.includes("idx_sessions_source_activity"))).toBe(true);
    expect(queryPlan(
      "SELECT * FROM sessions WHERE engine = ? ORDER BY last_activity DESC",
      "claude",
    ).some((row) => row.detail.includes("idx_sessions_engine_activity"))).toBe(true);
  });
});

describe("listSessionsForGroup", () => {
  it("paginates a single employee newest-first", () => {
    const page1 = reg.listSessionsForGroup("alice", 5, 0);
    const page2 = reg.listSessionsForGroup("alice", 5, 5);
    expect(page1.map((r) => r.id)).toEqual(["alice-11", "alice-10", "alice-9", "alice-8", "alice-7"]);
    expect(page2.map((r) => r.id)).toEqual(["alice-6", "alice-5", "alice-4", "alice-3", "alice-2"]);
  });

  it("paginates the cron and direct sentinel groups", () => {
    expect(reg.listSessionsForGroup(reg.CRON_GROUP, 100, 0).length).toBe(20);
    expect(reg.listSessionsForGroup(reg.DIRECT_GROUP, 100, 0).length).toBe(6);
    // direct must not leak cron rows
    expect(reg.listSessionsForGroup(reg.DIRECT_GROUP, 100, 0).every((r) => r.source !== "cron")).toBe(true);
  });
});

describe("getSessionGroupCounts", () => {
  it("returns true totals per group", () => {
    const counts = reg.getSessionGroupCounts();
    expect(counts["alice"]).toBe(12);
    expect(counts["bob"]).toBe(3);
    expect(counts[reg.DIRECT_GROUP]).toBe(6);
    expect(counts[reg.CRON_GROUP]).toBe(20);
  });
});

// A session whose `employee` equals the portal slug (case-insensitively) is a
// direct/COO session, not a pseudo-employee. It must fold into __direct__ so it
// never spawns a phantom group that renders with the portal's own title.
// Kept LAST so its inserts don't perturb the counts asserted above.
describe("portal-slug sessions fold into the direct group", () => {
  beforeAll(() => {
    const db = reg.initDb();
    let t = 0;
    const ts = () => `2026-02-01T00:00:${String(t++).padStart(2, "0")}.000Z`;
    // 2 lowercase + 1 mixed-case portal-slug rows = 3 phantom-prone sessions.
    insert(db, "jimbo-0", { employee: "jimbo", lastActivity: ts() });
    insert(db, "jimbo-1", { employee: "jimbo", lastActivity: ts() });
    insert(db, "jimbo-2", { employee: "Jimbo", lastActivity: ts() });
  });

  it("getSessionGroupCounts folds portal-slug rows into __direct__ (no phantom group)", () => {
    const counts = reg.getSessionGroupCounts("jimbo");
    expect(counts["jimbo"]).toBeUndefined(); // no phantom employee bucket
    expect(counts["Jimbo"]).toBeUndefined();
    expect(counts[reg.DIRECT_GROUP]).toBe(9); // 6 true-direct + 3 portal-slug
    expect(counts["alice"]).toBe(12); // real employees untouched
  });

  it("without a portal slug, the phantom bucket still exists (proves the guard fixes it)", () => {
    const counts = reg.getSessionGroupCounts();
    expect(counts["jimbo"]).toBe(2); // 'jimbo' (exact) groups separately
    expect(counts[reg.DIRECT_GROUP]).toBe(6); // unchanged
  });

  it("listSessionsForGroup(__direct__) includes portal-slug rows when slug is passed", () => {
    const direct = reg.listSessionsForGroup(reg.DIRECT_GROUP, 100, 0, "jimbo");
    const ids = direct.map((r) => r.id);
    expect(ids).toContain("jimbo-0");
    expect(ids).toContain("jimbo-2"); // mixed-case too
    expect(direct.length).toBe(9);
    expect(direct.every((r) => r.source !== "cron")).toBe(true);
  });

  it("requesting the portal slug as an employee group yields nothing (folded to direct)", () => {
    expect(reg.listSessionsForGroup("jimbo", 100, 0, "jimbo")).toEqual([]);
  });

  it("listRecentPerGroup folds portal-slug rows into direct, not a phantom group", () => {
    const rows = reg.listRecentPerGroup(50, "jimbo");
    // No row should be bucketed under its own 'jimbo' partition: all the
    // portal-slug ids appear, but they belong to the direct group.
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("jimbo-0");
    expect(ids).toContain("jimbo-2");
    // real employees still capped/grouped normally
    expect(rows.filter((r) => r.employee === "alice").length).toBe(12);
  });

  it("normalizes spaced portal names to the same slug for direct-session folding", () => {
    const db = reg.initDb();
    insert(db, "octo-ops-0", { employee: "octo-ops", lastActivity: "2026-02-01T00:00:59.000Z" });
    const counts = reg.getSessionGroupCounts("Octo Ops");
    expect(counts["octo-ops"]).toBeUndefined();
    expect(reg.listSessionsForGroup(reg.DIRECT_GROUP, 100, 0, "Octo Ops").map((row) => row.id)).toContain("octo-ops-0");
  });
});
