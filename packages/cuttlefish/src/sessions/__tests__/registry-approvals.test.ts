import { describe, it, expect, beforeAll } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import fs from "node:fs";
import path from "node:path";
import type { JsonObject } from "../../shared/types.js";
import {
  clearApprovalRecordsForTestInRegistry,
  createApprovalRecordInRegistry,
  getApprovalRecordFromRegistry,
  importApprovalsJsonIfNeededFromRegistry,
  listApprovalRecordsFromRegistry,
  resolveApprovalRecordInRegistry,
  type ApprovalRegistryDeps,
} from "../registry-approvals.js";

const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-registry-approvals-");

type Reg = typeof import("../registry.js");

let reg: Reg;
let deps: ApprovalRegistryDeps;

/**
 * Seed a minimal session row with an explicit id. Approvals now carry a FOREIGN
 * KEY to sessions(id) (enforced via PRAGMA foreign_keys=ON), so a referenced
 * session must exist before an approval can be inserted.
 */
function seedSession(id: string): void {
  const db = reg.initDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO sessions (id, engine, source, source_ref, status, created_at, last_activity)
     VALUES (?, 'claude', 'web', ?, 'idle', ?, ?)`,
  ).run(id, `web:${id}`, now, now);
}

beforeAll(async () => {
  reg = await import("../registry.js");
  reg.initDb();
  // FK target rows for the approvals used across this suite.
  seedSession("sess-1");
  seedSession("sess-legacy");
  deps = {
    getDb: reg.initDb,
    getMeta: (database, key) => {
      const row = database.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
      return row?.value ?? null;
    },
    setMeta: (database, key, value) => {
      database
        .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(key, value);
    },
    parseJsonObject: (value) => {
      if (typeof value !== "string" || !value.trim()) return null;
      try {
        const parsed = JSON.parse(value) as JsonObject;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
  };
});

describe("registry approvals helper", () => {
  it("creates, dedupes, lists, and resolves approvals through the extracted helper", () => {
    clearApprovalRecordsForTestInRegistry(deps);

    const first = createApprovalRecordInRegistry({
      sessionId: "sess-1",
      type: "fallback",
      payload: { reason: "quota" },
    }, deps);
    const second = createApprovalRecordInRegistry({
      sessionId: "sess-1",
      type: "fallback",
      payload: { reason: "retry" },
    }, deps);

    expect(second.id).toBe(first.id);
    expect(getApprovalRecordFromRegistry(first.id, deps)?.payload.reason).toBe("retry");
    expect(listApprovalRecordsFromRegistry(undefined, deps)).toHaveLength(1);

    const resolved = resolveApprovalRecordInRegistry(first.id, "approved", "tester", null, null, deps);
    expect(resolved?.state).toBe("approved");
    expect(listApprovalRecordsFromRegistry({ state: "pending" }, deps)).toHaveLength(0);
    expect(listApprovalRecordsFromRegistry({ state: "approved" }, deps)[0]?.actor).toBe("tester");
  });

  it("imports a legacy approvals json file once", () => {
    clearApprovalRecordsForTestInRegistry(deps);
    const filePath = path.join(tmp, "approvals-import.json");
    fs.writeFileSync(filePath, JSON.stringify([
      {
        id: "legacy-1",
        sessionId: "sess-legacy",
        type: "fallback",
        payload: { hello: "world" },
        state: "pending",
        createdAt: "2026-06-25T00:00:00.000Z",
        resolvedAt: null,
        actor: null,
      },
    ]));

    importApprovalsJsonIfNeededFromRegistry(filePath, deps);
    importApprovalsJsonIfNeededFromRegistry(filePath, deps);

    const rows = listApprovalRecordsFromRegistry({ state: "all" }, deps);
    expect(rows.filter((row) => row.id === "legacy-1")).toHaveLength(1);
  });
});
