import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the DB at a throwaway dir BEFORE importing the registry (SESSIONS_DB is
// resolved from CUTTLEFISH_HOME at module load).
const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-delq-");

type Reg = typeof import("../registry.js");
let reg: Reg;

beforeAll(async () => {
  reg = await import("../registry.js");
  reg.initDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function queueRowCount(sessionId: string): number {
  const db = reg.initDb();
  const row = db
    .prepare("SELECT COUNT(*) as count FROM queue_items WHERE session_id = ?")
    .get(sessionId) as { count: number };
  return row.count;
}

function messageRowCount(sessionId: string): number {
  const db = reg.initDb();
  const row = db
    .prepare("SELECT COUNT(*) as count FROM messages WHERE session_id = ?")
    .get(sessionId) as { count: number };
  return row.count;
}

function sessionExists(sessionId: string): boolean {
  return Boolean(reg.getSession(sessionId));
}

describe("deleteSession/deleteSessions queue_items cleanup", () => {
  it("deleteSession removes the session's queue_items rows", () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:delq-1" });
    reg.enqueueQueueItem(session.id, session.sessionKey, "queued prompt");
    expect(queueRowCount(session.id)).toBe(1);

    expect(reg.deleteSession(session.id)).toBe(true);
    expect(queueRowCount(session.id)).toBe(0);
  });

  it("deleteSessions removes queue_items for every deleted session", () => {
    const a = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:delq-2" });
    const b = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:delq-3" });
    reg.enqueueQueueItem(a.id, a.sessionKey, "a-1");
    reg.enqueueQueueItem(b.id, b.sessionKey, "b-1");

    expect(reg.deleteSessions([a.id, b.id])).toBe(2);
    expect(queueRowCount(a.id)).toBe(0);
    expect(queueRowCount(b.id)).toBe(0);
  });

  it("deleteSession rolls back if a child-table delete fails mid-transaction", () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:delq-rollback" });
    reg.insertMessage(session.id, "user", "keep me");
    reg.enqueueQueueItem(session.id, session.sessionKey, "queued prompt");

    expect(sessionExists(session.id)).toBe(true);
    expect(messageRowCount(session.id)).toBe(1);
    expect(queueRowCount(session.id)).toBe(1);

    const db = reg.initDb();
    const originalPrepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql === "DELETE FROM queue_items WHERE session_id = ?") {
        throw new Error("injected queue delete failure");
      }
      return originalPrepare(sql);
    });

    expect(() => reg.deleteSession(session.id)).toThrow(/injected queue delete failure/);
    expect(sessionExists(session.id)).toBe(true);
    expect(messageRowCount(session.id)).toBe(1);
    expect(queueRowCount(session.id)).toBe(1);
  });
});

describe("deleteSession approvals + email cleanup (orphan regression)", () => {
  function insertApproval(id: string, sessionId: string): void {
    const db = reg.initDb();
    db.prepare(
      "INSERT INTO approvals (id, session_id, type, payload, state, created_at) VALUES (?, ?, 'checkpoint', '{}', 'pending', ?)",
    ).run(id, sessionId, new Date().toISOString());
  }
  function approvalCount(sessionId: string): number {
    const db = reg.initDb();
    return (db.prepare("SELECT COUNT(*) c FROM approvals WHERE session_id = ?").get(sessionId) as { c: number }).c;
  }
  function insertEmail(id: string, sessionId: string): void {
    const db = reg.initDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO email_messages (id, inbox_id, provider_message_id, thread_key, to_addresses,
        cc_addresses, text_body, headers_json, attachments_json, status, session_id, created_at, updated_at)
       VALUES (?, 'inbox', ?, 'thread', '[]', '[]', 'body', '{}', '[]', 'processed', ?, ?, ?)`,
    ).run(id, id, sessionId, now, now);
  }
  function emailRow(id: string): { exists: boolean; sessionId: string | null } {
    const db = reg.initDb();
    const row = db.prepare("SELECT session_id as s FROM email_messages WHERE id = ?").get(id) as { s: string | null } | undefined;
    return { exists: Boolean(row), sessionId: row ? row.s : null };
  }

  it("deletes owned approvals so the session leaves no orphans", () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:del-appr" });
    insertApproval("appr-1", session.id);
    expect(approvalCount(session.id)).toBe(1);

    expect(reg.deleteSession(session.id)).toBe(true);
    expect(approvalCount(session.id)).toBe(0);
  });

  it("unlinks (does not delete) cached emails when their session is deleted", () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:del-email" });
    insertEmail("email-1", session.id);

    expect(reg.deleteSession(session.id)).toBe(true);
    const row = emailRow("email-1");
    expect(row.exists).toBe(true);      // email record preserved
    expect(row.sessionId).toBeNull();   // but unlinked from the removed session
  });

  it("deleteSessions also cleans approvals and unlinks emails for every id", () => {
    const a = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:del-bulk-a" });
    const b = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:del-bulk-b" });
    insertApproval("appr-a", a.id);
    insertApproval("appr-b", b.id);
    insertEmail("email-a", a.id);

    expect(reg.deleteSessions([a.id, b.id])).toBe(2);
    expect(approvalCount(a.id)).toBe(0);
    expect(approvalCount(b.id)).toBe(0);
    expect(emailRow("email-a").sessionId).toBeNull();
  });

  it("enforces the approvals.session_id foreign key (RDC-R01)", () => {
    const db = reg.initDb();
    // foreign_keys pragma is ON for the connection.
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    // Inserting an approval for a non-existent session is rejected.
    expect(() => insertApproval("appr-orphan", "no-such-session")).toThrow(/FOREIGN KEY/i);
  });

  it("cascades approval deletion when the session row is deleted directly (ON DELETE CASCADE)", () => {
    const session = reg.createSession({ engine: "claude", source: "web", sourceRef: "web:cascade" });
    insertApproval("appr-cascade", session.id);
    expect(approvalCount(session.id)).toBe(1);
    // Delete the session row directly (bypassing deleteSession's explicit cleanup)
    // — the FK cascade must remove the approval.
    reg.initDb().prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
    expect(approvalCount(session.id)).toBe(0);
  });
});
