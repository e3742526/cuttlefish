import { describe, it, expect, beforeAll } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

// Point the DB at a throwaway dir BEFORE importing the registry (SESSIONS_DB is
// resolved from CUTTLEFISH_HOME at module load).
const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-cwd-");

type Reg = typeof import("../registry.js");
let reg: Reg;

beforeAll(async () => {
  reg = await import("../registry.js");
  reg.initDb();
});

const base = { engine: "claude", source: "web", sourceRef: "web:cwd" } as const;

describe("createSession cwd persistence", () => {
  it("persists and hydrates a provided cwd", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-"));
    const s = reg.createSession({ ...base, prompt: "hi", cwd: dir });
    expect(s.cwd).toBe(dir);
    expect(reg.getSession(s.id)?.cwd).toBe(dir);
  });

  it("defaults cwd to null when omitted (backward-compatible)", () => {
    const s = reg.createSession({ ...base, prompt: "hi" });
    expect(s.cwd ?? null).toBeNull();
    expect(reg.getSession(s.id)?.cwd ?? null).toBeNull();
  });

  it("a forked/duplicated session inherits the parent's cwd", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-fork-"));
    const parent = reg.createSession({ ...base, prompt: "hi", cwd: dir });
    // duplicateSession requires an engineSessionId; set one directly.
    reg.updateSession(parent.id, { engineSessionId: "eng-1" });
    const { session: copy } = reg.duplicateSession(parent.id);
    expect(copy.cwd).toBe(dir);
    expect(reg.getSession(copy.id)?.cwd).toBe(dir);
  });

  it("a duplicated session preserves the source session's user_id and prompt_excerpt (DAT-SESS-004)", () => {
    const parent = reg.createSession({
      ...base,
      sourceRef: "web:ownership",
      prompt: "some prompt for the excerpt",
      userId: "user-42",
    });
    expect(parent.userId).toBe("user-42");
    expect(parent.promptExcerpt).toBeTruthy();

    reg.updateSession(parent.id, { engineSessionId: "eng-2" });
    const { session: copy } = reg.duplicateSession(parent.id);

    expect(copy.userId).toBe(parent.userId);
    expect(copy.promptExcerpt).toBe(parent.promptExcerpt);
    // Persisted row (not just the in-memory return value) must carry it too.
    const reloaded = reg.getSession(copy.id);
    expect(reloaded?.userId).toBe(parent.userId);
    expect(reloaded?.promptExcerpt).toBe(parent.promptExcerpt);
  });
});

describe("migrateSessionsSchema is idempotent for cwd", () => {
  it("adds cwd once and tolerates repeated runs", () => {
    const db = new Database(":memory:");
    db.exec(
      `CREATE TABLE sessions (
        id TEXT PRIMARY KEY, engine TEXT, source TEXT, source_ref TEXT,
        status TEXT, created_at TEXT, last_activity TEXT
      )`,
    );
    reg.migrateSessionsSchema(db);
    reg.migrateSessionsSchema(db); // second run must not throw (column exists)
    const cols = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain("cwd");
    db.close();
  });
});
